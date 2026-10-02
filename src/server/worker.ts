import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Database } from "./db";
import type { Config } from "./config";
import { categories, extractionRuns, jobs, receiptAdjustments, receiptItems, receipts } from "./db/schema";
import { ExtractionError, extractReceipt, SCHEMA_VERSION } from "./ai/extractor";
import { assessExtraction } from "./services/reconciliation";
import { logEvent } from "./logging";

export const retryDelayMs = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));

export async function processOneJob(db: Database, config: Config, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!config.ai.apiKey || !config.ai.model) return false;
  const claim = await db.transaction(async tx => {
    // All worker transactions lock jobs before receipts. Expired final attempts
    // are selected too, so a crash on attempt three cannot strand a receipt.
    const [job] = await tx.select().from(jobs).where(sql`
      (${jobs.state} = 'pending' AND ${jobs.availableAt} <= now())
      OR (${jobs.state} = 'running' AND ${jobs.leaseExpiresAt} <= now())
    `).orderBy(jobs.availableAt).limit(1).for("update", { skipLocked: true });
    if (!job) return null;
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, job.receiptId)).for("update");
    if (!receipt || receipt.revision !== 0 || !["queued", "processing"].includes(receipt.status)) {
      await tx.update(jobs).set({ state: "failed", lockedBy: null, leaseExpiresAt: null, lastError: "Receipt is no longer eligible for extraction." }).where(eq(jobs.id, job.id));
      return { skipped: true, job, reason: "stale_revision" } as const;
    }
    if (job.attempts >= 3) {
      const error = "Extraction stopped after three attempts. Retry the receipt to try again.";
      await tx.update(jobs).set({ state: "failed", lockedBy: null, leaseExpiresAt: null, lastError: error }).where(eq(jobs.id, job.id));
      await tx.update(receipts).set({ status: "failed", error, updatedAt: new Date() }).where(eq(receipts.id, receipt.id));
      await tx.insert(extractionRuns).values({ receiptId: receipt.id, model: config.ai.model, schemaVersion: SCHEMA_VERSION, error });
      return { skipped: true, job, reason: "exhausted_recovered_lease", message: error } as const;
    }
    const token = crypto.randomUUID();
    await tx.update(jobs).set({ state: "running", attempts: job.attempts + 1, lockedBy: token, leaseExpiresAt: new Date(Date.now() + config.ai.timeoutMs + 120_000) }).where(eq(jobs.id, job.id));
    await tx.update(receipts).set({ status: "processing", error: null, updatedAt: new Date() }).where(eq(receipts.id, receipt.id));
    return { skipped: false, job, receipt, token } as const;
  });
  if (!claim) return false;
  if (claim.skipped) {
    logEvent("warn", "receipt.job.skipped", { receiptId: claim.job.receiptId, jobId: claim.job.id, attempt: claim.job.attempts, reason: claim.reason });
    if (claim.reason === "exhausted_recovered_lease") {
      logEvent("error", "receipt.job.failed", { receiptId: claim.job.receiptId, jobId: claim.job.id, attempt: claim.job.attempts, message: claim.message });
    }
    return true;
  }
  const context = { receiptId: claim.receipt.id, jobId: claim.job.id, attempt: claim.job.attempts + 1 };
  logEvent("info", "receipt.job.started", context);
  let result: Awaited<ReturnType<typeof extractReceipt>> | undefined;
  let failure: ExtractionError | undefined;
  let image: Buffer | undefined;
  try {
    if (basename(claim.receipt.imagePath) !== claim.receipt.imagePath || /[\\/:]/.test(claim.receipt.imagePath) || [".", "..", ""].includes(claim.receipt.imagePath)) throw new Error();
    image = await readFile(resolve(config.uploadDir, claim.receipt.imagePath));
    if (image.length > config.maxUploadBytes) throw new Error();
  } catch {
    failure = new ExtractionError("Receipt image could not be read. Check upload storage.");
  }
  if (!failure) {
    const active = await db.select().from(categories).where(eq(categories.archived, false));
    try {
      result = await extractReceipt(image!, claim.receipt.imageMime, active, config, fetcher, context);
    } catch (error) {
      failure = error instanceof ExtractionError ? error : new ExtractionError("Receipt extraction failed unexpectedly.");
    }
  }
  const outcome = await db.transaction(async tx => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, claim.job.id)).for("update");
    if (!job || job.state !== "running" || job.lockedBy !== claim.token || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) return { event: "receipt.job.skipped", reason: "stale_ownership" } as const;
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, claim.receipt.id)).for("update");
    if (!receipt || receipt.revision !== claim.receipt.revision || receipt.revision !== 0 || receipt.status !== "processing") {
      await tx.update(jobs).set({ state: "failed", lockedBy: null, leaseExpiresAt: null, lastError: "Receipt changed during extraction." }).where(eq(jobs.id, job.id));
      return { event: "receipt.job.skipped", reason: "stale_revision" } as const;
    }
    await tx.insert(extractionRuns).values({ receiptId: receipt.id, model: config.ai.model, schemaVersion: SCHEMA_VERSION, raw: result?.raw ?? failure?.raw ?? null, error: failure?.message ?? null });
    if (result) {
      const assessment = assessExtraction(result.extraction);
      await tx.delete(receiptItems).where(eq(receiptItems.receiptId, receipt.id));
      await tx.delete(receiptAdjustments).where(eq(receiptAdjustments.receiptId, receipt.id));
      if (result.extraction.items.length) await tx.insert(receiptItems).values(result.extraction.items.map((item, position) => ({ ...item, receiptId: receipt.id, position })));
      if (result.extraction.adjustments.length) await tx.insert(receiptAdjustments).values(result.extraction.adjustments.map((item, position) => ({ ...item, receiptId: receipt.id, position })));
      const { items, adjustments, warnings, ...fields } = result.extraction;
      await tx.update(receipts).set({ ...fields, ...assessment, error: null, updatedAt: new Date() }).where(eq(receipts.id, receipt.id));
      await tx.update(jobs).set({ state: "completed", lockedBy: null, leaseExpiresAt: null, lastError: null }).where(eq(jobs.id, job.id));
      return { event: "receipt.job.completed", status: assessment.status } as const;
    } else {
      const retry = failure!.retryable && job.attempts < 3;
      const delayMs = retryDelayMs(job.attempts);
      await tx.update(jobs).set({ state: retry ? "pending" : "failed", availableAt: new Date(Date.now() + delayMs), lockedBy: null, leaseExpiresAt: null, lastError: failure!.message }).where(eq(jobs.id, job.id));
      await tx.update(receipts).set({ status: retry ? "queued" : "failed", error: failure!.message, updatedAt: new Date() }).where(eq(receipts.id, receipt.id));
      return retry
        ? { event: "receipt.job.retry_scheduled", delayMs, message: failure!.message } as const
        : { event: "receipt.job.failed", message: failure!.message } as const;
    }
  });
  const { event, ...fields } = outcome;
  logEvent(event === "receipt.job.completed" ? "info" : event === "receipt.job.failed" ? "error" : "warn", event, { ...context, ...fields });
  return true;
}

export function startWorker(db: Database, config: Config): { stop(): Promise<void> } {
  let stopping = false;
  const wakeups = new Set<() => void>();
  const pause = () => new Promise<void>(resolve => {
    const wake = () => { clearTimeout(timer); wakeups.delete(wake); resolve(); };
    const timer = setTimeout(wake, 1000);
    wakeups.add(wake);
    if (stopping) wake();
  });
  if (!config.ai.apiKey || !config.ai.model) {
    console.info("Receipt extraction is disabled. Set AI_API_KEY and AI_MODEL; queued receipts are preserved.");
    return { stop: async () => {} };
  }
  const loops = Array.from({ length: config.ai.concurrency }, async () => {
    while (!stopping) {
      try { if (!await processOneJob(db, config)) await pause(); }
      catch { console.error("Receipt worker database operation failed; retrying after a pause."); await pause(); }
    }
  });
  return { async stop() { stopping = true; for (const wake of wakeups) wake(); await Promise.all(loops); } };
}
