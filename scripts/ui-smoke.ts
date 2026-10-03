// Deterministic UI coverage without PostgreSQL or a live AI provider.
// Real API/database behavior is covered by application.integration.test.ts.
import { chromium, expect, type Browser } from "@playwright/test";
import type { MerchantRule, ReceiptDetail, ReceiptUpdate } from "../src/shared/contracts";

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
    status: "ready", revision: 0, warnings: [], error: null,
    createdAt: "2026-06-01T12:00:00Z", updatedAt: "2026-06-01T12:00:00Z",
    imageUrl: `/api/receipts/${receiptId}/image`, adjustments: [],
    items: Array.from({ length: 25 }, (_, index) => ({
      id: `item-${index}`, description: `PRINTED ITEM ${index + 1}`, productName: `Product ${index + 1}`,
      quantity: "1", unit: "each", unitPrice: "1.00", lineTotal: "1.00",
      categoryId: null, brand: null, manufacturer: null,
    })),
  };
}

let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  for (const width of [390, 1365]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let receipt = fixture();
    let saved: ReceiptUpdate | undefined;
    let saveGate: Promise<void> | undefined;
    let releaseSave: (() => void) | undefined;
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
      if (path === "/api/receipts") return respond({ receipts: [receipt], total: 1 });
      if (path.endsWith("/image")) return route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=", "base64"),
      });
      if (path === `/api/receipts/${receiptId}`) {
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
    expect(errors).toEqual([]);
    await page.close();
    console.info(`UI smoke passed at ${width}px: 25 compact items, edits/add/remove/save, keyboard tabs/disclosures, rule CRUD/errors/focus restoration, cache refresh, disabled processing state.`);
  }
} finally {
  await browser?.close();
  await server.stop(true);
}
