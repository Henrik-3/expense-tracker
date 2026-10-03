import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/server/db";
import { migrate } from "../src/server/db/migrate";
import { categories, jobs, receipts, merchantRules, extractionRuns, receiptItems, receiptAdjustments } from "../src/server/db/schema";
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
  const action = (id: string, method: "POST" | "DELETE", body: unknown, suffix = "") => request(`/api/receipts/${id}${suffix}`, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const detected: Extraction = {
    merchantName: "Redetected shop", purchasedAt: "2026-06-02", currency: "EUR", total: "2.50",
    items: [{ description: "NEW ITEM", productName: null, quantity: "1", unit: null, unitPrice: "3.00", lineTotal: "3.00", categoryId: null, brand: null, manufacturer: null }],
    adjustments: [{ description: "New coupon", kind: "discount", amount: "-0.50" }], warnings: [],
  };
  const detectionFetch = (async () => Response.json({
    choices: [{ message: { content: JSON.stringify(detected) } }],
  })) as unknown as typeof fetch;

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

  test("merchant rules persist and dynamically regroup old receipts, with consistent errors", async () => {
    const name = `Rule test ${randomUUID()}`;
    const canonical = `Canonical ${randomUUID()}`;
    const ruleIds: string[] = [];
    const write = (path: string, method: string, body: unknown) => request(path, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      for (const suffix of ["Branch", "Other"]) {
        const receiptId = randomUUID();
        receiptIds.push(receiptId);
        await database.db.insert(receipts).values({
          id: receiptId, status: "ready", merchantName: `${name} ${suffix}`, purchasedAt: "2026-06-01",
          currency: "EUR", total: suffix === "Branch" ? "0.1" : "0.2",
          imagePath: "unused.png", imageMime: "image/png", imageSha256: "unused", originalFilename: "unused.png",
        });
        expect((await getReceipt(receiptId)).merchantGroup).toBeNull();
      }
      const input = { matchName: name, merchantName: canonical, matchType: "prefix" };
      const created = await write("/api/merchant-rules", "POST", input);
      expect(created.status).toBe(201);
      const { rule } = await created.json();
      ruleIds.push(rule.id);
      // A fresh application instance reads persisted rules, not process-local state.
      const fresh = createServer(database.db, config);
      const persisted = await (await fresh.request("http://localhost/api/merchant-rules")).json();
      expect(persisted.rules).toContainEqual(rule);
      const branchId = receiptIds[receiptIds.length - 2]!;
      expect((await getReceipt(branchId)).merchantGroup).toBe(canonical);
      expect((await getReceipt(branchId)).merchantName).toBe(`${name} Branch`);
      const listed = await (await request("/api/receipts?limit=100")).json();
      expect(listed.receipts.find((row: ReceiptDetail) => row.id === branchId)?.merchantGroup).toBe(canonical);
      const stats = await (await request(`/api/stats?merchant=${encodeURIComponent(canonical)}`)).json();
      expect(stats.currencies[0].merchants).toEqual([{ name: canonical, total: "0.3" }]);
      expect(stats.currencies[0].receiptCount).toBe(2);
      const printed = await (await request(`/api/stats?merchant=${encodeURIComponent(`${name} Branch`)}`)).json();
      expect(printed.currencies[0].total).toBe("0.1");
      // Force a concurrent committed rule edit after the read snapshot begins.
      // The response must still filter and aggregate with the original rule set.
      const snapshotTransaction: typeof database.db.transaction = (callback, options) =>
        database.db.transaction(async (tx) => {
          await tx.select().from(receipts).limit(1);
          await database.db.update(merchantRules).set({ merchantName: `${canonical} concurrent` }).where(eq(merchantRules.id, rule.id));
          return callback(tx);
        }, options);
      const snapshotDatabase = new Proxy(database.db, {
        get(target, property) {
          if (property === "transaction") return snapshotTransaction;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const snapshotApp = createServer(snapshotDatabase, config);
      const snapshotStats = await (await snapshotApp.request(`http://localhost/api/stats?merchant=${encodeURIComponent(canonical)}`)).json();
      expect(snapshotStats.currencies[0].merchants).toEqual([{ name: canonical, total: "0.3" }]);
      expect((await getReceipt(branchId)).merchantGroup).toBe(`${canonical} concurrent`);
      await database.db.update(merchantRules).set({ merchantName: canonical }).where(eq(merchantRules.id, rule.id));
      const duplicates = await Promise.all([
        write("/api/merchant-rules", "POST", { ...input, matchName: name.toUpperCase().replaceAll(" ", "\t ") }),
        write("/api/merchant-rules", "POST", input),
      ]);
      expect(duplicates.map((response) => response.status)).toEqual([409, 409]);
      const racing = await Promise.all([
        write("/api/merchant-rules", "POST", { ...input, matchName: `${name} Race` }),
        write("/api/merchant-rules", "POST", { ...input, matchName: `${name} RACE` }),
      ]);
      for (const response of racing) if (response.status === 201) ruleIds.push((await response.json()).rule.id);
      expect(racing.map((response) => response.status).sort()).toEqual([201, 409]);
      const exactResponse = await write("/api/merchant-rules", "POST", { ...input, matchType: "exact" });
      expect(exactResponse.status).toBe(201);
      const exact = (await exactResponse.json()).rule;
      ruleIds.push(exact.id);
      expect((await write(`/api/merchant-rules/${exact.id}`, "PATCH", input)).status).toBe(409);
      expect((await write("/api/merchant-rules", "POST", { ...input, matchName: " " })).status).toBe(400);
      expect((await write("/api/merchant-rules", "POST", { ...input, merchantName: "" })).status).toBe(400);
      expect((await write("/api/merchant-rules", "POST", { ...input, matchType: "contains" })).status).toBe(400);
      expect((await write("/api/merchant-rules", "POST", {})).status).toBe(400);
      expect((await write(`/api/merchant-rules/${randomUUID()}`, "PATCH", input)).status).toBe(404);
      expect((await request("/api/merchant-rules/invalid", { method: "DELETE" })).status).toBe(400);
      const edited = await write(`/api/merchant-rules/${rule.id}`, "PATCH", { ...input, merchantName: `${canonical} edited` });
      expect(edited.status).toBe(200);
      expect((await getReceipt(branchId)).merchantGroup).toBe(`${canonical} edited`);
      expect((await request(`/api/merchant-rules/${rule.id}`, { method: "DELETE" })).status).toBe(204);
      expect((await request(`/api/merchant-rules/${rule.id}`, { method: "DELETE" })).status).toBe(404);
      expect((await getReceipt(branchId)).merchantGroup).toBeNull();
    } finally {
      if (ruleIds.length) await database.db.delete(merchantRules).where(inArray(merchantRules.id, ruleIds));
    }
  });

  test("the seeded REWE prefix can be edited/deleted without migrations recreating it", async () => {
    const [seed] = await database.db.select().from(merchantRules).where(eq(merchantRules.matchName, "REWE"));
    expect(seed).toBeDefined();
    if (!seed) return;
    try {
      const edited = await request(`/api/merchant-rules/${seed.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchName: seed.matchName, merchantName: "Edited REWE group", matchType: "prefix" }),
      });
      expect(edited.status).toBe(200);
      await migrate(url!);
      const [persisted] = await database.db.select().from(merchantRules).where(eq(merchantRules.id, seed.id));
      expect(persisted?.merchantName).toBe("Edited REWE group");
      expect((await request(`/api/merchant-rules/${seed.id}`, { method: "DELETE" })).status).toBe(204);
      await migrate(url!);
      expect(await database.db.select().from(merchantRules).where(eq(merchantRules.id, seed.id))).toHaveLength(0);
    } finally {
      await database.db.insert(merchantRules).values(seed).onConflictDoUpdate({
        target: merchantRules.id, set: { matchName: seed.matchName, merchantName: seed.merchantName, matchType: seed.matchType },
      });
    }
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

  test("redetection of an edited receipt reserves a revision and replaces data only on success", async () => {
    const receiptId = randomUUID();
    receiptIds.push(receiptId);
    await upload(receiptId);
    await processOneJob(database.db, config, detectionFetch);
    const original = await getReceipt(receiptId);
    const edited = { ...update(original), merchantName: "Manually corrected", notes: "Keep my notes" };
    edited.items[0] = { ...edited.items[0]!, description: "Manual item" };
    expect((await patch(receiptId, edited)).status).toBe(200);
    const saved = await getReceipt(receiptId);
    const queuedResponse = await action(receiptId, "POST", { revision: saved.revision }, "/redetect");
    expect(queuedResponse.status).toBe(200);
    const queued: ReceiptDetail = (await queuedResponse.json()).receipt;
    expect(queued.status).toBe("queued");
    expect(queued.revision).toBe(saved.revision + 1);
    expect(queued.merchantName).toBe(saved.merchantName);
    expect(queued.items).toEqual(saved.items);
    expect(queued.adjustments).toEqual(saved.adjustments);
    expect(queued.notes).toBe(saved.notes);
    expect((await action(receiptId, "POST", { revision: queued.revision }, "/redetect")).status).toBe(409);
    expect((await action(receiptId, "DELETE", { revision: saved.revision })).status).toBe(409);
    expect((await patch(receiptId, update(saved))).status).toBe(409);
    await processOneJob(database.db, config, detectionFetch);
    const completed = await getReceipt(receiptId);
    expect(completed.status).toBe("ready");
    expect(completed.revision).toBe(queued.revision);
    expect(completed.merchantName).toBe(detected.merchantName);
    expect(completed.items[0]?.description).toBe("NEW ITEM");
    expect(completed.items[0]?.id).not.toBe(saved.items[0]?.id);
    expect(completed.notes).toBe(saved.notes);
    expect((await patch(receiptId, update(saved))).status).toBe(409);
    expect((await action(receiptId, "POST", { revision: saved.revision }, "/redetect")).status).toBe(409);
  });

  test("failed redetection preserves saved data and legacy retry handles nonzero revisions", async () => {
    const receiptId = randomUUID();
    receiptIds.push(receiptId);
    await upload(receiptId);
    await processOneJob(database.db, config, detectionFetch);
    expect((await patch(receiptId, { ...update(await getReceipt(receiptId)), status: "needs_review", total: "9.99" })).status).toBe(200);
    const saved = await getReceipt(receiptId);
    expect((await action(receiptId, "POST", { revision: saved.revision }, "/redetect")).status).toBe(200);
    const invalidFetch = (async () => Response.json({ choices: [{ message: { content: "{}" } }] })) as unknown as typeof fetch;
    await processOneJob(database.db, config, invalidFetch);
    const failed = await getReceipt(receiptId);
    expect(failed.status).toBe("failed");
    expect(failed.revision).toBe(saved.revision + 1);
    expect(failed.items).toEqual(saved.items);
    expect(failed.adjustments).toEqual(saved.adjustments);
    expect(failed.total).toBe(saved.total);
    const retried = await request(`/api/receipts/${receiptId}/retry`, { method: "POST" });
    expect(retried.status).toBe(200);
    expect((await retried.json()).receipt.revision).toBe(failed.revision + 1);
    await processOneJob(database.db, config, detectionFetch);
    expect((await getReceipt(receiptId)).status).toBe("ready");
  });

  test("receipt actions validate revisions and missing IDs", async () => {
    const receiptId = randomUUID();
    for (const [method, suffix] of [["POST", "/redetect"], ["DELETE", ""]] as const) {
      for (const revision of [undefined, null, -1, 0.5, "0"]) {
        expect((await action(receiptId, method, { revision }, suffix)).status).toBe(400);
      }
      expect((await action(receiptId, method, { revision: 0 }, suffix)).status).toBe(404);
      expect((await action("invalid", method, { revision: 0 }, suffix)).status).toBe(400);
      expect((await request(`/api/receipts/${receiptId}${suffix}`, { method, body: "not json" })).status).toBe(400);
    }
  });

  test("deletion cascades data and removes image; a late processing worker cannot resurrect it", async () => {
    const receiptId = randomUUID();
    receiptIds.push(receiptId);
    await upload(receiptId);
    await processOneJob(database.db, config, detectionFetch);
    const saved = await getReceipt(receiptId);
    const [row] = await database.db.select().from(receipts).where(eq(receipts.id, receiptId));
    const imagePath = resolve(uploadDir, row!.imagePath);
    expect((await stat(imagePath)).isFile()).toBe(true);
    expect((await action(receiptId, "POST", { revision: saved.revision }, "/redetect")).status).toBe(200);
    let entered!: () => void;
    const fetching = new Promise<void>(resolve => { entered = resolve; });
    let release!: (response: Response) => void;
    const delayed = (async () => {
      entered();
      return new Promise<Response>(resolve => { release = resolve; });
    }) as unknown as typeof fetch;
    const worker = processOneJob(database.db, config, delayed);
    await fetching;
    try {
      const current = await getReceipt(receiptId);
      expect(current.status).toBe("processing");
      expect((await action(receiptId, "POST", { revision: current.revision }, "/redetect")).status).toBe(409);
      const deleted = await action(receiptId, "DELETE", { revision: current.revision });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true, imageCleanup: "removed" });
      expect((await request(saved.imageUrl)).status).toBe(404);
      await expect(stat(imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release(await detectionFetch("http://unused"));
      await worker;
    }
    for (const table of [jobs, extractionRuns, receiptItems, receiptAdjustments]) {
      expect(await database.db.select().from(table).where(eq(table.receiptId, receiptId))).toHaveLength(0);
    }
    expect((await request(`/api/receipts/${receiptId}`)).status).toBe(404);
    expect((await action(receiptId, "DELETE", { revision: saved.revision + 1 })).status).toBe(404);
  });

  test("post-commit unlink failure reports successful deletion and unsafe image paths never unlink", async () => {
    const receiptId = randomUUID();
    receiptIds.push(receiptId);
    const imagePath = `${receiptId}.png`;
    // A directory at the validated image path forces unlink to fail on all platforms.
    await mkdir(resolve(uploadDir, imagePath));
    await database.db.insert(receipts).values({
      id: receiptId, imagePath, imageMime: "image/png", imageSha256: "test", originalFilename: "test.png",
    });
    const deleted = await action(receiptId, "DELETE", { revision: 0 });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, imageCleanup: "failed" });
    expect((await request(`/api/receipts/${receiptId}`)).status).toBe(404);
    const unsafeId = randomUUID();
    receiptIds.push(unsafeId);
    await database.db.insert(receipts).values({
      id: unsafeId, imagePath: "../outside.png", imageMime: "image/png", imageSha256: "test", originalFilename: "test.png",
    });
    expect((await action(unsafeId, "DELETE", { revision: 0 })).status).toBe(500);
    expect((await getReceipt(unsafeId)).status).toBe("queued");
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
