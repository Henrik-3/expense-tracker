import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/server/db";
import { migrate } from "../src/server/db/migrate";
import { categories, jobs, receipts } from "../src/server/db/schema";
import { loadConfig } from "../src/server/config";
import { createServer } from "../src/server/server";
import { processOneJob } from "../src/server/worker";
import type { Extraction, ReceiptDetail, ReceiptUpdate, StatsResponse } from "../src/shared/contracts";

// Use a dedicated test database. No live provider calls or credentials are used.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("application with PostgreSQL", () => {
  let database: ReturnType<typeof createDatabase>;
  let config: ReturnType<typeof loadConfig>;
  let app: ReturnType<typeof createServer>;
  let uploadDir: string;
  const receiptIds: string[] = [];
  const categoryIds: string[] = [];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=", "base64");

  beforeAll(async () => {
    await migrate(url!);
    await migrate(url!); // Startup migrations are repeatable.
    database = createDatabase(url!);
    await mkdir(resolve("data"), { recursive: true });
    uploadDir = await mkdtemp(resolve("data/integration-uploads-"));
    config = loadConfig({
      DATABASE_URL: url,
      UPLOAD_DIR: uploadDir,
      AI_API_KEY: "test-only-not-a-real-key",
      AI_MODEL: "mock-vision",
    });
    app = createServer(database.db, config);
  });

  afterAll(async () => {
    if (database) {
      if (receiptIds.length) await database.db.delete(receipts).where(inArray(receipts.id, receiptIds));
      if (categoryIds.length) await database.db.delete(categories).where(inArray(categories.id, categoryIds));
      await database.sql.end();
    }
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  const request = (path: string, init?: RequestInit) => app.request(`http://localhost${path}`, init);
  function upload(receiptId: string, bytes: Uint8Array = png) {
    const form = new FormData();
    form.set("receiptId", receiptId);
    form.set("image", new File([new Uint8Array(bytes)], "receipt.png", { type: "image/png" }));
    return request("/api/receipts", { method: "POST", body: form });
  }
  async function getReceipt(id: string): Promise<ReceiptDetail> {
    const response = await request(`/api/receipts/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()).receipt;
  }
  function update(receipt: ReceiptDetail): ReceiptUpdate {
    return {
      revision: receipt.revision,
      status: "ready",
      merchantName: receipt.merchantName,
      purchasedAt: receipt.purchasedAt,
      currency: receipt.currency,
      total: receipt.total,
      notes: receipt.notes,
      items: receipt.items,
      adjustments: receipt.adjustments,
    };
  }
  const patch = (id: string, body: ReceiptUpdate) => request(`/api/receipts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  test("capture, durable extraction, corrections, and item-level statistics", async () => {
    const receiptId = randomUUID();
    receiptIds.push(receiptId);
    const categoryResponse = await request("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Integration ${randomUUID()}` }),
    });
    expect(categoryResponse.status).toBe(201);
    const { category } = await categoryResponse.json();
    categoryIds.push(category.id);

    const responses = await Promise.all(Array.from({ length: 4 }, () => upload(receiptId)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(await readdir(uploadDir)).toHaveLength(1);
    expect(await database.db.select().from(jobs).where(eq(jobs.receiptId, receiptId))).toHaveLength(1);
    expect((await getReceipt(receiptId)).status).toBe("queued");

    const altered = Buffer.concat([png, Buffer.from("different")]);
    expect((await upload(receiptId, altered)).status).toBe(409);
    expect(await readdir(uploadDir)).toHaveLength(1);

    const extraction: Extraction = {
      merchantName: `Integration shop ${receiptId}`,
      purchasedAt: "2026-06-01",
      currency: "EUR",
      total: "2.50",
      items: [{
        description: "APPLES",
        productName: "Apples",
        quantity: "1",
        unit: "kg",
        unitPrice: "3.00",
        lineTotal: "3.00",
        categoryId: category.id,
        brand: null,
        manufacturer: null,
      }],
      adjustments: [{ description: "Coupon", kind: "discount", amount: "-0.50" }],
      warnings: [],
    };
    const fakeFetch = async () => Response.json({
      choices: [{ message: { content: JSON.stringify(extraction) } }],
    });
    await processOneJob(database.db, config, fakeFetch as unknown as typeof fetch);
    const extracted = await getReceipt(receiptId);
    expect(extracted.status).toBe("ready");
    expect(extracted.items[0]?.description).toBe("APPLES");
    expect(extracted.total).toBe("2.5000");

    const image = await request(extracted.imageUrl);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);

    const edited = update(extracted);
    edited.items[0] = { ...edited.items[0]!, brand: "Corrected brand", manufacturer: "Printed manufacturer" };
    edited.notes = "Checked against original";
    const saved = await patch(receiptId, edited);
    expect(saved.status).toBe(200);
    expect((await saved.json()).receipt.revision).toBe(1);
    expect((await patch(receiptId, edited)).status).toBe(409);
    expect((await request(`/api/receipts/${receiptId}/retry`, { method: "POST" })).status).toBe(409);

    const merchant = encodeURIComponent(extraction.merchantName!);
    const summary: StatsResponse = await (await request(`/api/stats?merchant=${merchant}&from=2026-06-01&to=2026-06-01`)).json();
    expect(summary.currencies[0]?.basis).toBe("receipts");
    expect(Number(summary.currencies[0]?.total)).toBe(2.5);
    const filtered: StatsResponse = await (await request(`/api/stats?merchant=${merchant}&categoryId=${category.id}&groupBy=week`)).json();
    expect(filtered.currencies[0]?.basis).toBe("items");
    expect(Number(filtered.currencies[0]?.total)).toBe(3);

    const current = await getReceipt(receiptId);
    const inconsistent = { ...update(current), total: "9.99" };
    expect((await patch(receiptId, inconsistent)).status).toBe(400);
    expect((await patch(receiptId, { ...inconsistent, status: "needs_review" })).status).toBe(200);
    const excluded: StatsResponse = await (await request(`/api/stats?merchant=${merchant}`)).json();
    expect(excluded.currencies).toHaveLength(0);
  });

  test("browser writes are same-origin and health does not expose credentials", async () => {
    const result = await request("/api/categories", {
      method: "POST",
      headers: { Origin: "https://other.example", Host: "localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Must not be created" }),
    });
    expect(result.status).toBe(403);
    const health = await request("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", aiConfigured: true });
    expect((await request("/api/does-not-exist")).status).toBe(404);
  });

  test("an uncertain commit acknowledgement never removes a committed original", async () => {
    const receiptId = randomUUID();
    receiptIds.push(receiptId);
    const uncertainTransaction: typeof database.db.transaction = async (callback) => {
      await database.db.transaction(callback);
      // Model a COMMIT accepted by PostgreSQL with its acknowledgement lost.
      throw new Error("Simulated connection loss after commit");
    };
    const uncertainDatabase = new Proxy(database.db, {
      get(target, property) {
        if (property === "transaction") return uncertainTransaction;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const uncertainApp = createServer(uncertainDatabase, config);
    const form = new FormData();
    form.set("receiptId", receiptId);
    form.set("image", new File([png], "receipt.png", { type: "image/png" }));
    const result = await uncertainApp.request("http://localhost/api/receipts", { method: "POST", body: form });
    expect(result.status).toBe(500);
    const receipt = await getReceipt(receiptId);
    expect((await request(receipt.imageUrl)).status).toBe(200);
    expect((await upload(receiptId)).status).toBe(200);
    expect(Buffer.from(await (await request(receipt.imageUrl)).arrayBuffer())).toEqual(png);
  });
});
