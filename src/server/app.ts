import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { and, eq, desc, count, gte, lte, inArray } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, unlink, readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import type { Database } from "./db";
import type { Config } from "./config";
import { receipts, receiptItems, receiptAdjustments, jobs, categories, merchantRules } from "./db/schema";
import { receiptUpdateSchema, receiptRevisionSchema, receiptReviewSchema, categoryInputSchema, merchantRuleInputSchema, type ReceiptDetail } from "../shared/contracts";
import { merchantResolver } from "./services/merchant-grouping";
import { assessExtraction } from "./services/reconciliation";
import { aggregateStatistics } from "./services/statistics";
import { writeDurableImage } from "./services/storage";
import { uuidSchema, receiptListQuerySchema, statsQuerySchema, imageMime } from "./api/validation";
import { logEvent } from "./logging";

type Reader = Pick<Database, "select">;
function fail(status: 400 | 404 | 409 | 413 | 415, message: string): never { throw new HTTPException(status, { message }); }
function id(value: string) { const parsed = uuidSchema.safeParse(value); if (!parsed.success) fail(400, "Invalid UUID"); return parsed.data; }
function summary(row: typeof receipts.$inferSelect, resolveMerchant: ReturnType<typeof merchantResolver>) {
  return { id: row.id, status: row.status, reviewed: row.reviewed, merchantName: row.merchantName, merchantGroup: resolveMerchant(row.merchantName), purchasedAt: row.purchasedAt, currency: row.currency, total: row.total, notes: row.notes, warnings: row.warnings, error: row.error, revision: row.revision, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
async function detail(db: Reader, receiptId: string): Promise<ReceiptDetail> {
  const resolveMerchant = merchantResolver(await db.select().from(merchantRules));
  const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  if (!row) fail(404, "Receipt not found");
  const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId)).orderBy(receiptItems.position);
  const adjustments = await db.select().from(receiptAdjustments).where(eq(receiptAdjustments.receiptId, receiptId)).orderBy(receiptAdjustments.position);
  return { ...summary(row, resolveMerchant), imageUrl: `/api/receipts/${row.id}/image`, items: items.map(({ receiptId: _, position: __, ...item }) => item), adjustments: adjustments.map(({ receiptId: _, position: __, ...item }) => item) };
}

export function createApp(db: Database, config: Config) {
  const app = new Hono();
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Internal server error" }, 500));
  app.use("/api/*", bodyLimit({ maxSize: config.maxUploadBytes + 65536, onError: (c) => c.json({ error: "Request body too large" }, 413) }));
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "PATCH" || c.req.method === "DELETE" || (c.req.method === "POST" && c.req.path !== "/api/receipts")) {
      const bytes = await c.req.arrayBuffer();
      if (bytes.byteLength > 1024 * 1024) return c.json({ error: "Request body too large" }, 413);
    }
    await next();
  });
  const json = async (c: { req: { json: () => Promise<unknown> } }) => { try { return await c.req.json(); } catch { fail(400, "Invalid JSON"); } };
  app.get("/api/receipts", async (c) => {
    const query = receiptListQuerySchema.safeParse(c.req.query());
    if (!query.success) fail(400, "Invalid receipt list query");
    return db.transaction(async (tx) => {
      const resolveMerchant = merchantResolver(await tx.select().from(merchantRules));
      const filter = query.data.reviewed === undefined ? undefined : eq(receipts.reviewed, query.data.reviewed);
      const rows = await tx.select().from(receipts).where(filter).orderBy(desc(receipts.createdAt), receipts.id).limit(query.data.limit).offset(query.data.offset);
      const [total] = await tx.select({ value: count() }).from(receipts).where(filter);
      return c.json({ receipts: rows.map((row) => summary(row, resolveMerchant)), total: total!.value });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });
  app.post("/api/receipts", async (c) => {
    let form: FormData;
    try { form = await c.req.formData(); } catch { fail(400, "Invalid multipart request"); }
    const receiptId = id(String(form.get("receiptId") ?? ""));
    const file = form.get("image");
    if (!(file instanceof File) || form.getAll("image").length !== 1 || form.getAll("receiptId").length !== 1) fail(400, "Supply one image and receiptId");
    if (!file.size || file.size > config.maxUploadBytes) fail(413, "Invalid image size");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = imageMime(bytes);
    if (!mime || mime !== file.type) fail(415, "Only JPEG, PNG and WebP images are supported");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const filename = `${randomUUID()}.${mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp"}`;
    await mkdir(config.uploadDir, { recursive: true });
    const path = resolve(config.uploadDir, filename);
    let keep = false;
    try {
      await writeDurableImage(path, bytes);
      // Once a transaction might reference this file, retain it on uncertain
      // failures. A lost COMMIT acknowledgement must never delete a saved image.
      // An orphan is recoverable; deleting a committed original is not.
      keep = true;
      const result = await db.transaction(async (tx) => {
        const inserted = await tx.insert(receipts).values({ id: receiptId, imagePath: filename, imageMime: mime, imageSha256: hash, originalFilename: basename(file.name).slice(0,255) }).onConflictDoNothing().returning();
        if (!inserted.length) {
          keep = false; // This generated file is definitely not referenced.
          const [existing] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
          if (!existing || existing.imageSha256 !== hash) fail(409, "Receipt ID already used for a different image");
          return false;
        }
        await tx.insert(jobs).values({ receiptId });
        return true;
      });
      const receipt = await db.transaction((tx) => detail(tx, receiptId), { isolationLevel: "repeatable read", accessMode: "read only" });
      return c.json({ receipt }, result ? 201 : 200);
    } finally { if (!keep) await unlink(path).catch(() => {}); }
  });
  app.get("/api/receipts/:id", async (c) => {
    const receiptId = id(c.req.param("id"));
    const receipt = await db.transaction((tx) => detail(tx, receiptId), { isolationLevel: "repeatable read", accessMode: "read only" });
    return c.json({ receipt });
  });
  app.get("/api/receipts/:id/image", async (c) => {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id(c.req.param("id"))));
    if (!row) fail(404, "Receipt not found");
    if (!/^[0-9a-f-]+\.(jpg|png|webp)$/.test(row.imagePath) || !["image/jpeg", "image/png", "image/webp"].includes(row.imageMime)) throw new Error("Unsafe image metadata");
    const bytes = await readFile(resolve(config.uploadDir, row.imagePath));
    return new Response(bytes, { headers: { "Content-Type": row.imageMime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } });
  });
  app.patch("/api/receipts/:id", async (c) => {
    const receiptId = id(c.req.param("id"));
    const parsed = receiptUpdateSchema.safeParse(await json(c));
    if (!parsed.success) fail(400, "Invalid receipt fields");
    const input = parsed.data;
    const assessment = assessExtraction({ ...input, warnings: [] });
    if (input.status === "ready" && assessment.status !== "ready") fail(400, "Receipt is incomplete or unreconciled; save as needs_review");
    const receipt = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
      if (!current) fail(404, "Receipt not found");
      if (current.revision !== input.revision || ["queued", "processing"].includes(current.status)) fail(409, "Receipt changed or is being processed");
      const categoryIds = [...new Set(input.items.flatMap((item) => item.categoryId ? [item.categoryId] : []))];
      if (categoryIds.length) {
        const found = await tx.select().from(categories).where(inArray(categories.id, categoryIds));
        if (found.length !== categoryIds.length) fail(400, "Unknown category");
      }
      const { items, adjustments, revision, ...fields } = input;
      await tx.update(receipts).set({ ...fields, revision: revision + 1, warnings: assessment.warnings, error: null, updatedAt: new Date() }).where(eq(receipts.id, receiptId));
      await tx.delete(receiptItems).where(eq(receiptItems.receiptId, receiptId));
      await tx.delete(receiptAdjustments).where(eq(receiptAdjustments.receiptId, receiptId));
      if (items.length) await tx.insert(receiptItems).values(items.map((item, position) => ({ ...item, position, receiptId })));
      if (adjustments.length) await tx.insert(receiptAdjustments).values(adjustments.map((item, position) => ({ ...item, position, receiptId })));
      return detail(tx, receiptId);
    });
    return c.json({ receipt });
  });
  app.patch("/api/receipts/:id/review", async (c) => {
    const receiptId = id(c.req.param("id"));
    const parsed = receiptReviewSchema.safeParse(await json(c));
    if (!parsed.success) fail(400, "Invalid receipt review");
    const receipt = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
      if (!current) fail(404, "Receipt not found");
      if (current.revision !== parsed.data.revision || ["queued", "processing"].includes(current.status)) fail(409, "Receipt changed or is being processed");
      if (current.reviewed !== parsed.data.reviewed) {
        await tx.update(receipts).set({ reviewed: parsed.data.reviewed, revision: current.revision + 1, updatedAt: new Date() }).where(eq(receipts.id, receiptId));
      }
      return detail(tx, receiptId);
    });
    return c.json({ receipt });
  });
  const enqueue = (receiptId: string, revision?: number) =>
    db.transaction(async (tx) => {
      // Match the worker's jobs-before-receipts locking order.
      await tx.select().from(jobs).where(eq(jobs.receiptId, receiptId)).for("update");
      const [row] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
      if (!row) fail(404, "Receipt not found");
      if (revision === undefined) {
        if (row.status !== "failed") fail(409, "Only failed receipts can be retried");
      } else if (row.revision !== revision || ["queued", "processing"].includes(row.status)) {
        fail(409, "Receipt changed or is being processed");
      }
      // Reserve a new revision now, rather than at completion, so editors from
      // before this extraction remain stale even after it finishes. Keep all
      // extracted fields, warnings and child records until successful replacement.
      await tx.update(receipts).set({ status: "queued", reviewed: false, revision: row.revision + 1, error: null, updatedAt: new Date() }).where(eq(receipts.id, receiptId));
      const reset = { state: "pending" as const, attempts: 0, availableAt: new Date(), leaseExpiresAt: null, lockedBy: null, lastError: null };
      await tx.insert(jobs).values({ receiptId, ...reset }).onConflictDoUpdate({ target: jobs.receiptId, set: reset });
      return detail(tx, receiptId);
    });
  app.post("/api/receipts/:id/retry", async (c) => c.json({ receipt: await enqueue(id(c.req.param("id"))) }));
  app.post("/api/receipts/:id/redetect", async (c) => {
    const receiptId = id(c.req.param("id"));
    const parsed = receiptRevisionSchema.safeParse(await json(c));
    if (!parsed.success) fail(400, "Invalid revision");
    return c.json({ receipt: await enqueue(receiptId, parsed.data.revision) });
  });
  app.delete("/api/receipts/:id", async (c) => {
    const receiptId = id(c.req.param("id"));
    const parsed = receiptRevisionSchema.safeParse(await json(c));
    if (!parsed.success) fail(400, "Invalid revision");
    const path = await db.transaction(async (tx) => {
      await tx.select().from(jobs).where(eq(jobs.receiptId, receiptId)).for("update");
      const [row] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
      if (!row) fail(404, "Receipt not found");
      if (row.revision !== parsed.data.revision) fail(409, "Receipt changed");
      if (!/^[0-9a-f-]+\.(jpg|png|webp)$/.test(row.imagePath)) throw new Error("Unsafe image metadata");
      const imagePath = resolve(config.uploadDir, row.imagePath);
      // Foreign keys cascade jobs, extraction runs, items and adjustments.
      await tx.delete(receipts).where(eq(receipts.id, receiptId));
      return imagePath;
    });
    let imageCleanup: "removed" | "failed" = "removed";
    try { await unlink(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        imageCleanup = "failed";
        // The database deletion has committed. Report it truthfully and retain
        // an operational breadcrumb for orphan cleanup; do not return a 500
        // that would suggest the receipt still exists.
        logEvent("error", "receipt.image.cleanup_failed", { receiptId, imagePath: path });
      }
    }
    return c.json({ deleted: true as const, imageCleanup });
  });
  app.get("/api/categories", async (c) => c.json({ categories: await db.select().from(categories).orderBy(categories.name) }));
  app.get("/api/merchant-rules", async (c) => c.json({ rules: await db.select().from(merchantRules).orderBy(merchantRules.matchType, merchantRules.matchName, merchantRules.id) }));
  for (const method of ["post", "patch"] as const) app[method](method === "post" ? "/api/merchant-rules" : "/api/merchant-rules/:id", async (c) => {
    const parsed = merchantRuleInputSchema.safeParse(await json(c));
    if (!parsed.success) fail(400, "Invalid merchant rule");
    const ruleId = method === "patch" ? id(c.req.param("id")!) : undefined;
    try {
      const rows = method === "post" ? await db.insert(merchantRules).values(parsed.data).returning()
        : await db.update(merchantRules).set(parsed.data).where(eq(merchantRules.id, ruleId!)).returning();
      if (!rows[0]) fail(404, "Merchant rule not found");
      return c.json({ rule: rows[0] }, method === "post" ? 201 : 200);
    } catch (error) {
      const cause = error as { code?: string; cause?: { code?: string } };
      if (cause.code === "23505" || cause.cause?.code === "23505") fail(409, "Merchant match rule already exists");
      throw error;
    }
  });
  app.delete("/api/merchant-rules/:id", async (c) => {
    const rows = await db.delete(merchantRules).where(eq(merchantRules.id, id(c.req.param("id")))).returning();
    if (!rows.length) fail(404, "Merchant rule not found");
    return c.body(null, 204);
  });
  for (const method of ["post", "patch"] as const) app[method](method === "post" ? "/api/categories" : "/api/categories/:id", async (c) => {
    const parsed = categoryInputSchema.safeParse(await json(c));
    if (!parsed.success) fail(400, "Invalid category");
    try {
      const rows = method === "post" ? await db.insert(categories).values(parsed.data).returning() : await db.update(categories).set(parsed.data).where(eq(categories.id, id(c.req.param("id")!))).returning();
      if (!rows[0]) fail(404, "Category not found");
      return c.json({ category: rows[0] }, method === "post" ? 201 : 200);
    } catch (error) {
      const cause = error as { code?: string; cause?: { code?: string } };
      if (cause.code === "23505" || cause.cause?.code === "23505") fail(409, "Category name already exists");
      throw error;
    }
  });
  app.get("/api/stats", async (c) => {
    const parsed = statsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) fail(400, "Invalid statistics filters");
    return db.transaction(async (tx) => {
      const filters = parsed.data;
      const eligible = and(
        filters.includeNeedsReview ? inArray(receipts.status, ["ready", "needs_review"]) : eq(receipts.status, "ready"),
        filters.from ? gte(receipts.purchasedAt, filters.from) : undefined,
        filters.to ? lte(receipts.purchasedAt, filters.to) : undefined,
      );
      const rows = await tx.select().from(receipts).where(eligible);
      // A subquery avoids one query parameter per receipt and the driver's
      // parameter ceiling, even for large date ranges.
      const selectedIds = tx.select({ id: receipts.id }).from(receipts).where(eligible);
      const items = rows.length ? await tx.select().from(receiptItems).where(inArray(receiptItems.receiptId, selectedIds)) : [];
      const itemsByReceipt = new Map<string, ReceiptDetail["items"]>();
      for (const { receiptId, position: _, ...item } of items) {
        const list = itemsByReceipt.get(receiptId) ?? [];
        list.push(item);
        itemsByReceipt.set(receiptId, list);
      }
      const resolveMerchant = merchantResolver(await tx.select().from(merchantRules));
      const details: ReceiptDetail[] = rows.map((row) => ({ ...summary(row, resolveMerchant), imageUrl: "", items: itemsByReceipt.get(row.id) ?? [], adjustments: [] }));
      const names = new Map((await tx.select().from(categories)).map((category) => [category.id, category.name]));
      return c.json(aggregateStatistics(details, names, parsed.data));
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
