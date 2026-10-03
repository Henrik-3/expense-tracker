// Frontend-only regression checks. API fixtures never touch PostgreSQL or an AI provider.
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReceiptDetail, ReceiptListResponse, StatsResponse } from "../src/shared/contracts";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=", "base64");
const receipt: ReceiptDetail = {
  id: "11111111-1111-4111-8111-111111111111", merchantName: "The Daily Coffee",
  purchasedAt: "2026-06-01", currency: "EUR", total: "7.50", notes: "",
  status: "ready", warnings: [], error: null, revision: 1,
  createdAt: "2026-06-01T10:00:00Z", updatedAt: "2026-06-01T10:00:00Z",
  imageUrl: "/api/receipts/example/image",
  items: [{ id: "item-1", description: "Coffee and croissant", productName: null,
    quantity: "1", unit: null, unitPrice: "7.50", lineTotal: "7.50", categoryId: null,
    brand: null, manufacturer: null }],
  adjustments: [],
};
const receipts: ReceiptListResponse = {
  receipts: [receipt, { ...receipt, id: "second", merchantName: "A very long merchant name that should wrap without hiding the amount",
    status: "needs_review", total: "125.40" }, { ...receipt, id: "third", merchantName: null, total: null, status: "failed" }],
  total: 3,
};
const stats: StatsResponse = {
  excludedReceipts: 0,
  currencies: [{ currency: "EUR", receiptCount: 1, total: "7.50", basis: "receipts",
    timeline: [{ name: "2026-06", total: "7.50" }], merchants: [{ name: "The Daily Coffee", total: "7.50" }],
    categories: [{ name: "Food & drink", total: "7.50" }], brands: [], manufacturers: [] }],
};
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(Bun.file("dist/index.html"));
    if (/^\/assets\/[\w.-]+$/.test(path)) return new Response(Bun.file(`dist${path}`));
    return new Response("Not found", { status: 404 });
  },
});
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
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
    await page.getByRole("button", { name: "Categories", exact: true }).click();
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
