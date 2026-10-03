import { chromium, expect, type Browser } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/server/db";
import { migrate } from "../src/server/db/migrate";
import { categories, receipts } from "../src/server/db/schema";
import { loadConfig } from "../src/server/config";
import { createServer } from "../src/server/server";
import { processOneJob } from "../src/server/worker";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.");
await migrate(url);
await mkdir(resolve("data"), { recursive: true });
const uploadDir = await mkdtemp(resolve("data/browser-uploads-"));
const { db, sql } = createDatabase(url);
const config = loadConfig({
  DATABASE_URL: url, UPLOAD_DIR: uploadDir,
  AI_API_KEY: "test-only-not-a-real-key", AI_MODEL: "mock",
});
const app = createServer(db, config);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
let browser: Browser | undefined;
const receiptIds: string[] = [];
const categoryIds: string[] = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.goto(server.url.toString());
  await expect(page.getByRole("heading", { name: "Less paperwork. More life." })).toBeVisible();
  await page.getByRole("switch", { name: "Review photo before uploading" }).click();
  await page.getByLabel("Upload receipt images").setInputFiles({
    name: "smoke-receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByText("Awaiting confirmation", { exact: true })).toBeVisible();
  const uploaded = page.waitForResponse(response => response.url().endsWith("/api/receipts") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Confirm upload" }).click();
  const response = await uploaded;
  expect(response.status()).toBe(201);
  const { receipt } = await response.json();
  receiptIds.push(receipt.id);
  await expect(page.getByText("Saved · background extraction", { exact: true })).toBeVisible();

  const fakeFetch = (async () => Response.json({
    choices: [{ message: { content: JSON.stringify({
      merchantName: "Browser test shop", purchasedAt: "2026-06-01", currency: "EUR", total: "2.50",
      items: [{ description: "APPLES", productName: "Apples", quantity: "1", unit: "kg", unitPrice: "2.50", lineTotal: "2.50", categoryId: null, brand: null, manufacturer: null }],
      adjustments: [], warnings: [],
    }) } }],
  })) as unknown as typeof fetch;
  await processOneJob(db, config, fakeFetch);
  await page.getByRole("button", { name: "View receipt", exact: true }).click();
  await expect(page.getByLabel("Shop / merchant")).toHaveValue("Browser test shop");
  await page.getByRole("button", { name: /Edit item 1$/ }).click();
  await page.getByLabel("Brand", { exact: true }).fill("Edited brand");
  await page.getByRole("button", { name: "Save · Ready", exact: true }).click();
  await expect(page.getByText("Saved as ready.", { exact: true })).toBeVisible();
  const [saved] = await db.select().from(receipts).where(eq(receipts.id, receipt.id));
  expect(saved?.revision).toBe(1);

  await page.getByRole("button", { name: "Insights", exact: true }).click();
  await page.getByLabel("Merchant", { exact: true }).fill("Browser test shop");
  await page.getByLabel("Brand", { exact: true }).fill("Edited brand");
  await expect(page.getByText("EUR · LINE SUBTOTAL BASIS", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By manufacturer", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Categories", exact: true }).click();
  const categoryName = `Browser test ${crypto.randomUUID()}`;
  await page.getByLabel("New category", { exact: true }).fill(categoryName);
  const categoryCreated = page.waitForResponse(response => response.url().endsWith("/api/categories") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create category", exact: true }).click();
  const { category } = await (await categoryCreated).json();
  categoryIds.push(category.id);
  const categoryForm = page.locator("form.category-row").filter({ has: page.locator(`input[value="${categoryName}"]`) });
  await categoryForm.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(categoryForm.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.getByLabel("Review photo before uploading")).toBeChecked();
  await page.setViewportSize({ width: 1365, height: 900 });
  await expect(page.getByRole("heading", { name: "Less paperwork. More life." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect(browserErrors).toEqual([]);
  console.info("Browser smoke passed: capture confirmation, upload, extraction, correction, filters, category archive, mobile and desktop layout.");
} finally {
  await browser?.close();
  await server.stop(true);
  if (receiptIds.length) await db.delete(receipts).where(inArray(receipts.id, receiptIds));
  if (categoryIds.length) await db.delete(categories).where(inArray(categories.id, categoryIds));
  await sql.end();
  await rm(uploadDir, { recursive: true, force: true });
}
