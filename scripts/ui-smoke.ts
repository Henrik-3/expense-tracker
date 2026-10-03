// Deterministic UI coverage without PostgreSQL or a live AI provider.
// Real API/database behavior is covered by application.integration.test.ts.
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { MerchantRule, ReceiptDetail, ReceiptUpdate, ReceiptListResponse, StatsResponse } from "../src/shared/contracts";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/") && !path.includes("..")) return new Response(Bun.file(`dist${path}`));
    return new Response(Bun.file("dist/index.html"));
  },
});
const receiptId = "a01731bd-93f7-4dcb-90b7-28bac6660a68";
const ruleId = "b01731bd-93f7-4dcb-90b7-28bac6660a68";
const categoryId = "c01731bd-93f7-4dcb-90b7-28bac6660a68";
function fixture(): ReceiptDetail {
  return {
    id: receiptId, merchantName: "REWE Viettz ihr Frischemarkt", merchantGroup: "REWE",
    purchasedAt: "2026-06-01", currency: "EUR", total: "25.00", notes: "",
    status: "ready", revision: 0, warnings: [], error: null, reviewed: false,
    createdAt: "2026-06-01T12:00:00Z", updatedAt: "2026-06-01T12:00:00Z",
    imageUrl: `/api/receipts/${receiptId}/image`, adjustments: [],
    items: Array.from({ length: 25 }, (_, index) => ({
      id: `item-${index}`, description: `PRINTED ITEM ${index + 1}`, productName: `Product ${index + 1}`,
      quantity: "1", unit: "each", unitPrice: "1.00", lineTotal: "1.00",
      categoryId: null, brand: null, manufacturer: null,
    })),
  };
}

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=", "base64");
const receipt: ReceiptDetail = {
  id: "11111111-1111-4111-8111-111111111111", merchantName: "The Daily Coffee", merchantGroup: "The Daily Coffee",
  purchasedAt: "2026-06-01", currency: "EUR", total: "7.50", notes: "",
  status: "ready", warnings: [], error: null, revision: 1, reviewed: false,
  createdAt: "2026-06-01T10:00:00Z", updatedAt: "2026-06-01T10:00:00Z",
  imageUrl: "/api/receipts/example/image",
  items: [{ id: "item-1", description: "Coffee and croissant", productName: null,
    quantity: "1", unit: null, unitPrice: "7.50", lineTotal: "7.50", categoryId: null,
    brand: null, manufacturer: null }],
  adjustments: [],
};
const receipts: ReceiptListResponse = {
  receipts: [receipt, { ...receipt, id: "second", merchantName: "A very long merchant name that should wrap without hiding the amount",
    merchantGroup: "A very long merchant name that should wrap without hiding the amount",
    status: "needs_review", total: "125.40" }, { ...receipt, id: "third", merchantName: null, merchantGroup: null, total: null, status: "failed" }],
  total: 3,
};
const stats: StatsResponse = {
  excludedReceipts: 0,
  currencies: [{ currency: "EUR", receiptCount: 1, total: "7.50", basis: "receipts",
    timeline: [{ name: "2026-06", total: "7.50" }], merchants: [{ name: "The Daily Coffee", total: "7.50" }],
    categories: [{ name: "Food & drink", total: "7.50" }], brands: [], manufacturers: [] }],
};
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  // Merchant grouping and Headless UI behavior, including stateful API mutations.
  for (const width of [390, 1365]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let receipt = fixture();
    let saved: ReceiptUpdate | undefined;
    let saveGate: Promise<void> | undefined;
    let releaseSave: (() => void) | undefined;
    let deleted = false;
    let redetectCalls = 0;
    let deleteCalls = 0;
    let reviewCalls = 0;
    let actionError: string | undefined;
    let rules: MerchantRule[] = [{ id: ruleId, matchName: "REWE", merchantName: "REWE", matchType: "prefix" }];
    let categories = [{ id: categoryId, name: "Groceries", archived: false }];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (data: unknown, status = 200) => route.fulfill({ status, json: data });
      if (path === "/api/health") return respond({ aiConfigured: true, status: "ok" });
      if (path === "/api/categories") return respond({ categories });
      if (path === `/api/categories/${categoryId}`) {
        categories = [{ ...categories[0]!, ...route.request().postDataJSON() }];
        return respond({ category: categories[0] });
      }
      if (path === "/api/merchant-rules" && method === "GET") return respond({ rules });
      if (path === "/api/merchant-rules" && method === "POST") {
        const input = route.request().postDataJSON();
        if (rules.some(rule => rule.matchName === input.matchName && rule.matchType === input.matchType)) {
          return respond({ error: "A rule for this name and match type already exists" }, 409);
        }
        const rule = { ...input, id: crypto.randomUUID() };
        rules.push(rule);
        return respond({ rule }, 201);
      }
      if (path.startsWith("/api/merchant-rules/")) {
        const id = path.split("/").pop();
        if (method === "DELETE") {
          rules = rules.filter(rule => rule.id !== id);
          return route.fulfill({ status: 204 });
        }
        await saveGate;
        const rule = { id, ...route.request().postDataJSON() };
        rules = rules.map(current => current.id === id ? rule : current);
        receipt.merchantGroup = rule.merchantName;
        return respond({ rule });
      }
      if (path === "/api/receipts") {
        const reviewed = new URL(route.request().url()).searchParams.get("reviewed");
        const rows = deleted || (reviewed !== null && reviewed !== String(receipt.reviewed)) ? [] : [receipt];
        return respond({ receipts: rows, total: rows.length });
      }
      if (path === `/api/receipts/${receiptId}/review` && method === "PATCH") {
        reviewCalls++;
        const input = route.request().postDataJSON();
        expect(input.revision).toBe(receipt.revision);
        expect(typeof input.reviewed).toBe("boolean");
        if (actionError) return respond({ error: actionError }, 409);
        receipt = { ...receipt, reviewed: input.reviewed, revision: receipt.revision + 1 };
        return respond({ receipt });
      }
      if (path === `/api/receipts/${receiptId}/redetect`) {
        redetectCalls++;
        expect(route.request().postDataJSON()).toEqual({ revision: receipt.revision });
        if (actionError) return respond({ error: actionError }, 409);
        receipt = { ...receipt, revision: receipt.revision + 1, status: "queued", reviewed: false };
        return respond({ receipt });
      }
      if (path.endsWith("/image")) return route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=", "base64"),
      });
      if (path === `/api/receipts/${receiptId}`) {
        if (method === "DELETE") {
          deleteCalls++;
          expect(route.request().postDataJSON()).toEqual({ revision: receipt.revision });
          if (actionError) return respond({ error: actionError }, 500);
          deleted = true;
          return respond({ deleted: true, imageCleanup: width === 390 ? "failed" : "removed" });
        }
        if (deleted) return respond({ error: "Receipt not found" }, 404);
        if (method === "PATCH") {
          saved = route.request().postDataJSON() as ReceiptUpdate;
          receipt = { ...receipt, ...saved, revision: receipt.revision + 1,
            items: saved.items.map((item, index) => ({ ...item, id: `saved-${index}` })),
            adjustments: saved.adjustments.map((item, index) => ({ ...item, id: `adjustment-${index}` })),
          };
        }
        return respond({ receipt });
      }
      if (path === "/api/stats") return respond({
        excludedReceipts: 0, currencies: [{
          currency: "EUR", receiptCount: 1, total: "25.00", basis: "receipts",
          timeline: [], merchants: [{ name: receipt.merchantGroup, total: "25.00" }], categories: [], brands: [], manufacturers: [],
        }],
      });
      return respond({ error: `Unexpected mock route: ${method} ${path}` }, 500);
    });
    await page.goto(server.url.toString());
    const preview = page.getByRole("switch", { name: "Review photo before uploading" });
    await preview.click();
    await expect(preview).toBeChecked();
    await page.getByRole("button", { name: "Receipts", exact: true }).click();
    await expect(page.locator(".receipt-row strong").first()).toHaveText("REWE");
    await expect(page.locator(".receipt-row")).toContainText("REWE Viettz ihr Frischemarkt");
    await expect(page.locator(".receipt-row .review-badge")).toHaveText("Not reviewed");
    await page.getByLabel("Review status").selectOption("false");
    await page.locator(".receipt-row").click();
    await expect(page.getByRole("button", { name: "Mark as reviewed", exact: true })).toBeEnabled();
    expect(reviewCalls).toBe(0); // Merely opening never clears the review queue.
    actionError = "Receipt changed or is being processed";
    await page.getByRole("button", { name: "Mark as reviewed", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refresh latest version" })).toBeVisible();
    await expect(page.locator(".review-controls .badge")).toHaveText("Not reviewed");
    actionError = undefined;
    await page.getByRole("button", { name: "Refresh latest version" }).click();
    await page.getByRole("button", { name: "Mark as reviewed", exact: true }).click();
    await expect(page.locator(".review-controls .badge")).toHaveText("Reviewed");
    await page.getByRole("button", { name: "← All receipts" }).click();
    await expect(page.getByLabel("Review status")).toHaveValue("false");
    await expect(page.getByRole("heading", { name: "All caught up" })).toBeVisible();
    await expect(page.getByText("0 matching receipts")).toBeVisible();
    await page.getByLabel("Review status").selectOption("true");
    await expect(page.locator(".receipt-row .review-badge")).toHaveText("Reviewed");
    await page.reload();
    await page.getByRole("button", { name: "Receipts", exact: true }).click();
    await expect(page.locator(".receipt-row .review-badge")).toHaveText("Reviewed");
    await page.locator(".receipt-row").click();
    await page.getByRole("button", { name: "Mark as not reviewed", exact: true }).click();
    await expect(page.locator(".review-controls .badge")).toHaveText("Not reviewed");
    expect(reviewCalls).toBe(3);
    await noOverflow(page);
    await page.getByRole("button", { name: "← All receipts" }).click();
    await page.locator(".receipt-row").click();
    await expect(page.locator(".line-item-summary")).toHaveCount(25);
    await expect(page.getByLabel("Description", { exact: true })).toHaveCount(0);
    const collapsedHeight = await page.locator(".line-items").evaluate(element => element.getBoundingClientRect().height);
    expect(collapsedHeight).toBeLessThan(1700);
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("REWE Viettz ihr Frischemarkt");
    const first = page.locator(".line-item").nth(0);
    await first.getByRole("button", { name: /Edit item 1$/ }).focus();
    await page.keyboard.press("Enter");
    await first.getByLabel("Brand", { exact: true }).fill("Edited brand");
    await expect(page.getByRole("button", { name: "Mark as reviewed", exact: true })).toBeDisabled();
    await first.getByLabel("Category", { exact: true }).selectOption(categoryId);
    await first.getByRole("button", { name: /Collapse item 1$/ }).click();
    await expect(first).toContainText("Groceries");
    await first.getByRole("button", { name: /Edit item 1$/ }).click();
    await expect(first.getByLabel("Brand", { exact: true })).toHaveValue("Edited brand");
    const second = page.locator(".line-item").nth(1);
    await second.getByRole("button", { name: /Edit item 2$/ }).click();
    await second.getByLabel("Manufacturer", { exact: true }).fill("Preserved manufacturer");
    await first.getByRole("button", { name: "Remove item 1", exact: true }).click();
    await expect(page.locator(".line-item").first().getByLabel("Manufacturer", { exact: true })).toHaveValue("Preserved manufacturer");
    await page.getByRole("button", { name: "+ Add item", exact: true }).click();
    const added = page.locator(".line-item").last();
    await expect(added.getByLabel("Description", { exact: true })).toBeVisible();
    await added.getByLabel("Description", { exact: true }).fill("New product");
    await added.getByLabel("Line subtotal", { exact: true }).fill("1.00");
    await page.getByRole("button", { name: "Save · Needs review", exact: true }).click();
    await expect(page.getByText("Saved for review. Check any warnings before marking ready.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as reviewed", exact: true })).toBeEnabled();
    expect(saved?.items).toHaveLength(25);
    expect(saved?.items[0]?.manufacturer).toBe("Preserved manufacturer");
    expect(saved?.items[24]?.description).toBe("New product");
    expect(saved?.items.some(item => "editKey" in item)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    if (process.env.SCREENSHOT_PATH && width === 390) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const categoryForm = page.locator(".category-row");
    await categoryForm.getByLabel("Category name").fill("Food");
    await categoryForm.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(categoryForm.getByLabel("Category name")).toHaveValue("Food");
    await categoryForm.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(categoryForm.getByRole("button", { name: "Unarchive" })).toBeVisible();
    await page.getByRole("tab", { name: "Categories", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Merchants", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("Printed shop name").fill("Unsubmitted shop");
    await page.getByLabel("Group as").fill("Unsubmitted group");
    await page.getByRole("button", { name: "Edit rule", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Group as").fill("REWE Group");
    saveGate = new Promise(resolve => { releaseSave = resolve; });
    await dialog.getByRole("button", { name: "Save rule", exact: true }).click();
    await expect(dialog.getByLabel("Group as")).toBeDisabled();
    await expect(dialog.getByLabel("Printed shop name")).toBeDisabled();
    await expect(page.locator(".rule-row button").first()).toBeDisabled();
    releaseSave!();
    saveGate = undefined;
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Printed shop name")).toHaveValue("Unsubmitted shop");
    await expect(page.getByLabel("Group as")).toHaveValue("Unsubmitted group");
    await expect(page.getByRole("button", { name: "Edit rule", exact: true })).toBeFocused();
    await expect(page.locator(".rule-row")).toContainText("REWE Group");
    await page.getByRole("button", { name: "Receipts", exact: true }).click();
    await expect(page.locator(".receipt-row strong").first()).toHaveText("REWE Group");
    await page.getByRole("button", { name: "Insights", exact: true }).click();
    await expect(page.getByRole("rowheader", { name: "REWE Group" })).toBeVisible();
    await page.getByRole("switch", { name: "Include Needs review" }).click();
    await expect(page.getByRole("switch", { name: "Include Needs review" })).toBeChecked();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Merchants", exact: true }).click();
    await page.getByLabel("Printed shop name").fill("REWE");
    await page.getByLabel("Group as").fill("Duplicate");
    await page.getByRole("button", { name: "Add rule", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("already exists");
    await page.getByLabel("Printed shop name").fill("Local branch");
    await page.getByLabel("Group as").fill("Local group");
    await page.getByRole("button", { name: "Add rule", exact: true }).click();
    await expect(page.locator(".rule-row")).toHaveCount(2);
    const local = page.locator(".rule-row").filter({ hasText: "Local branch" });
    await local.getByRole("button", { name: "Delete rule", exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(local.getByRole("button", { name: "Delete rule", exact: true })).toBeFocused();
    await local.getByRole("button", { name: "Delete rule", exact: true }).click();
    await dialog.getByRole("button", { name: "Delete grouping", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".rule-row")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    // Processing receipts must remain locked after the Headless UI migration.
    receipt.status = "processing";
    await page.getByRole("button", { name: "Receipts", exact: true }).click();
    await page.locator(".receipt-row").click();
    await expect(page.getByLabel("Shop / merchant")).toBeDisabled();
    await expect(page.locator(".line-item-summary").first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "+ Add item", exact: true })).toBeDisabled();
    const redetect = page.getByRole("button", { name: "Redetect receipt", exact: true });
    const remove = page.getByRole("button", { name: "Delete receipt", exact: true });
    await expect(redetect).toBeDisabled();
    await expect(remove).toBeEnabled();
    receipt.status = "ready";
    await expect(redetect).toBeEnabled({ timeout: 6000 });
    await page.getByLabel("Shop / merchant").fill("Unsaved correction");
    page.once("dialog", dialog => dialog.dismiss());
    await redetect.click();
    expect(redetectCalls).toBe(0);
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Unsaved correction");
    actionError = "Receipt changed on the server";
    page.once("dialog", dialog => dialog.accept());
    await redetect.click();
    await expect(page.getByRole("alert")).toContainText(actionError);
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Unsaved correction");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Refresh latest version", exact: true }).click();
    await expect(page.getByLabel("Shop / merchant")).toHaveValue(receipt.merchantName!);
    actionError = undefined;
    await page.getByLabel("Shop / merchant").fill("Discard on redetection");
    page.once("dialog", async dialog => {
      expect(dialog.message()).toContain("Unsaved changes will be discarded");
      await dialog.accept();
    });
    await redetect.click();
    await expect(redetect).toBeDisabled();
    await expect(page.getByLabel("Shop / merchant")).toBeDisabled();
    await expect(page.getByText(/Unsaved changes/, { exact: false })).toHaveCount(0);
    expect(redetectCalls).toBe(2);
    receipt = { ...receipt, status: "ready", merchantName: "Redetected shop", merchantGroup: "Redetected shop" };
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Redetected shop", { timeout: 6000 });
    await page.getByLabel("Shop / merchant").fill("Keep if delete fails");
    page.once("dialog", dialog => dialog.dismiss());
    await remove.click();
    expect(deleteCalls).toBe(0);
    actionError = "Deletion failed";
    page.once("dialog", dialog => dialog.accept());
    await remove.click();
    await expect(page.getByRole("alert")).toContainText("Deletion failed");
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Keep if delete fails");
    actionError = undefined;
    let cleanupWarning = false;
    page.once("dialog", async dialog => {
      expect(dialog.message()).toContain("cannot be undone");
      if (width === 390) page.once("dialog", async warning => {
        expect(warning.type()).toBe("alert");
        expect(warning.message()).toContain("original image could not be removed");
        cleanupWarning = true;
        await warning.accept();
      });
      await dialog.accept();
    });
    await remove.click();
    await expect(page.getByRole("heading", { name: "A clean slate" })).toBeVisible();
    await expect(page.locator(".receipt-row")).toHaveCount(0);
    expect(deleteCalls).toBe(2);
    expect(cleanupWarning).toBe(width === 390);
    await noOverflow(page);
    expect(errors).toEqual([]);
    await page.close();
    console.info(`UI smoke passed at ${width}px: 25 compact items, edits/add/remove/save, keyboard tabs/disclosures, rule CRUD/errors/focus restoration, receipt redetection/deletion confirmations and errors, cache refresh, disabled processing state.`);
  }
  // Destructive actions must respect the displayed draft and their originating page.
  {
    const page = await browser.newPage();
    await page.clock.install();
    let first = fixture();
    const second = { ...fixture(), id: crypto.randomUUID(), merchantName: "Second receipt", merchantGroup: "Second receipt" };
    let deleted = false;
    let deleteGate: Promise<void> | undefined;
    let releaseDelete: (() => void) | undefined;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (data: unknown, status = 200) => route.fulfill({ status, json: data });
      if (path === "/api/health") return respond({ aiConfigured: true, status: "ok" });
      if (path === "/api/categories") return respond({ categories: [] });
      if (path === "/api/receipts") return respond({ receipts: deleted ? [second] : [first, second], total: deleted ? 1 : 2 });
      if (path.endsWith("/image")) return route.fulfill({ contentType: "image/png", body: image });
      if (path === `/api/receipts/${second.id}`) return respond({ receipt: second });
      if (path === `/api/receipts/${receiptId}/redetect` || (path === `/api/receipts/${receiptId}` && method === "DELETE")) {
        const revision = route.request().postDataJSON().revision;
        if (revision !== first.revision) return respond({ error: "Receipt changed" }, 409);
        // Only the delayed deletion below should reach a successful mutation.
        expect(method).toBe("DELETE");
        expect(deleteGate).toBeDefined();
        await deleteGate;
        deleted = true;
        return respond({ deleted: true, imageCleanup: "removed" });
      }
      if (path === `/api/receipts/${receiptId}`) return respond({ receipt: first });
      return respond({ error: `Unexpected route ${method} ${path}` }, 500);
    });
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "Receipts", exact: true }).click();
    await page.locator(".receipt-row").first().click();
    await page.getByLabel("Shop / merchant").fill("Local unsaved draft");
    first = { ...first, revision: 1, merchantName: "Changed in another tab" };
    await page.clock.fastForward(6000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByText("Revision 1 · Unsaved changes", { exact: true })).toBeVisible();
    for (const name of ["Redetect receipt", "Delete receipt"]) {
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText("Receipt changed");
      await expect(page.getByLabel("Shop / merchant")).toHaveValue("Local unsaved draft");
    }
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Refresh latest version", exact: true }).click();
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Changed in another tab");
    deleteGate = new Promise(resolve => { releaseDelete = resolve; });
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Delete receipt", exact: true }).click();
    await expect(page.getByRole("button", { name: "Deleting…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "← All receipts", exact: true }).click();
    await page.locator(".receipt-row").filter({ hasText: "Second receipt" }).click();
    await page.getByLabel("Shop / merchant").fill("Keep this other draft");
    const response = page.waitForResponse(response => response.request().method() === "DELETE");
    releaseDelete!();
    await response;
    await page.clock.runFor(100);
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Keep this other draft");
    // Navigation still guards the second receipt's unsaved state.
    const dialog = page.waitForEvent("dialog");
    const navigation = page.getByRole("button", { name: "Receipts", exact: true }).click();
    await (await dialog).dismiss();
    await navigation;
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Keep this other draft");
    await page.close();
    console.info("UI receipt race checks passed: dirty-draft revisions and delayed deletion after navigation.");
  }
  // Redesign coverage uses fresh pages and independent fixtures at each viewport.
  const screenshotDir = process.env.UI_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1365, height: 1000 }]) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path.endsWith("/image")) return route.fulfill({ contentType: "image/png", body: image });
      let data: unknown;
      if (path === "/api/health") data = { status: "ok", aiConfigured: true };
      else if (path === "/api/categories") data = { categories: [{ id: "22222222-2222-4222-8222-222222222222", name: "Food & drink", archived: false }] };
      else if (path === "/api/merchant-rules") data = { rules: [] };
      else if (path === "/api/stats") data = stats;
      else if (path === "/api/receipts" && method === "GET") data = receipts;
      else if (path.startsWith("/api/receipts")) data = { receipt };
      else throw new Error(`Unexpected UI request: ${method} ${path}`);
      await route.fulfill({ json: data, status: method === "POST" ? 201 : 200 });
    });
    await page.goto(server.url.toString());
    await expect(page.getByRole("heading", { name: "Less paperwork. More life." })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await noOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `capture-${viewport.width}.png`), fullPage: viewport.width > 650 });

    // Capture preference and local preview survive navigation.
    await page.getByLabel("Review photo before uploading").check();
    await page.getByLabel("Upload receipt images").setInputFiles({ name: "test-receipt.png", mimeType: "image/png", buffer: image });
    await expect(page.getByText("Awaiting confirmation", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Receipts", exact: true }).click();
    await expect(page.locator(".receipt-row")).toHaveCount(3);
    await noOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `receipts-${viewport.width}.png`), fullPage: viewport.width > 650 });
    await page.getByRole("button", { name: /The Daily Coffee/ }).click();
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("The Daily Coffee");
    await noOverflow(page);
    await page.getByLabel("Shop / merchant").fill("Changed shop");
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: "Insights", exact: true }).click();
    await expect(page.getByLabel("Shop / merchant")).toHaveValue("Changed shop");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Insights", exact: true }).click();
    await expect(page.getByRole("heading", { name: "By shop", exact: true })).toBeVisible();
    await noOverflow(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Categories", exact: true }).click();
    await expect(page.getByLabel("Category name", { exact: true })).toHaveValue("Food & drink");
    await noOverflow(page);
    await page.getByRole("button", { name: "Capture", exact: true }).click();
    await expect(page.getByLabel("Review photo before uploading")).toBeChecked();
    await expect(page.getByText("Awaiting confirmation", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm upload", exact: true }).click();
    await expect(page.getByText("Saved · background extraction", { exact: true })).toBeVisible();
    await noOverflow(page);
    expect(errors).toEqual([]);
    await page.close();
  }
  console.info("UI smoke passed at 320, 390, 844, and 1365px: navigation, receipt list/detail, unsaved edits, insights, categories, capture confirmation, keyboard skip link, and overflow.");
} finally {
  await browser?.close();
  await server.stop(true);
}
