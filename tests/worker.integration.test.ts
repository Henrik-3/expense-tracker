import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/server/db";
import { extractionRuns, jobs, receipts, receiptItems } from "../src/server/db/schema";
import { loadConfig } from "../src/server/config";
import { processOneJob } from "../src/server/worker";

// Requires a migrated, dedicated test database; no global deletes or truncation.
const url = process.env.TEST_DATABASE_URL;
const integration = url ? test : test.skip;
const connection = url ? createDatabase(url) : undefined;
const db = connection?.db;
let uploadDir = "";
const ids: string[] = [];
const extraction = {
  merchantName: "Test", purchasedAt: "2026-01-01", currency: "USD", total: "0.30",
  items: [{ description: "Test item", productName: null, quantity: "1", unit: null, unitPrice: "0.30", lineTotal: "0.30", categoryId: null, brand: null, manufacturer: null }],
  adjustments: [], warnings: [],
};
const successFetch = (() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extraction) } }] })))) as unknown as typeof fetch;
const config = () => loadConfig({ DATABASE_URL: url, UPLOAD_DIR: uploadDir, AI_API_KEY: "test-only", AI_MODEL: "mock" });

beforeAll(async () => {
  if (!url) return;
  await mkdir(resolve("data"), { recursive: true });
  uploadDir = await mkdtemp(resolve("data/receipt-worker-"));
  await writeFile(join(uploadDir, "test.png"), new Uint8Array([1, 2, 3]));
});
afterAll(async () => {
  if (!db || !connection) return;
  try {
    for (const id of ids) await db.delete(receipts).where(eq(receipts.id, id));
  } finally {
    await connection.sql.end();
    await rm(uploadDir, { recursive: true, force: true });
  }
});
async function enqueue(attempts = 0, expired = false) {
  const id = crypto.randomUUID();
  ids.push(id);
  await db!.insert(receipts).values({
    id, imagePath: "test.png", imageMime: "image/png", originalFilename: "test.png", imageSha256: "test",
    status: expired ? "processing" : "queued",
  });
  await db!.insert(jobs).values({
    receiptId: id, attempts, state: expired ? "running" : "pending",
    lockedBy: expired ? "crashed-worker" : null,
    leaseExpiresAt: expired ? new Date(Date.now() - 10_000) : null,
  });
  return id;
}
async function state(id: string) {
  const [receipt] = await db!.select().from(receipts).where(eq(receipts.id, id));
  const [job] = await db!.select().from(jobs).where(eq(jobs.receiptId, id));
  const runs = await db!.select().from(extractionRuns).where(eq(extractionRuns.receiptId, id));
  const items = await db!.select().from(receiptItems).where(eq(receiptItems.receiptId, id));
  return { receipt: receipt!, job: job!, runs, items };
}

integration("worker commits validated extraction, items, run and completed job", async () => {
  const id = await enqueue();
  expect(await processOneJob(db!, config(), successFetch)).toBe(true);
  const result = await state(id);
  expect(result.receipt.status).toBe("ready");
  expect(result.receipt.total).toBe("0.3000");
  expect(result.job.state).toBe("completed");
  expect(result.job.attempts).toBe(1);
  expect(result.items).toHaveLength(1);
  expect(result.runs).toHaveLength(1);
  expect(result.runs[0]!.raw).toHaveProperty("choices");
  expect(result.runs[0]!.schemaVersion).toBe(1);
});

integration("expired third-attempt lease is recovered to failed", async () => {
  const id = await enqueue(3, true);
  await processOneJob(db!, config(), successFetch);
  const result = await state(id);
  expect(result.job.state).toBe("failed");
  expect(result.receipt.status).toBe("failed");
  expect(result.job.attempts).toBe(3);
  expect(result.runs).toHaveLength(1);
});

integration("network/provider retries are bounded at three", async () => {
  const id = await enqueue();
  const unavailable = (() => Promise.resolve(new Response("private provider diagnostics", { status: 429 }))) as unknown as typeof fetch;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await db!.update(jobs).set({ availableAt: new Date(Date.now() - 1000) }).where(eq(jobs.receiptId, id));
    await processOneJob(db!, config(), unavailable);
    const result = await state(id);
    expect(result.job.attempts).toBe(attempt);
    expect(result.job.state).toBe(attempt < 3 ? "pending" : "failed");
    expect(result.receipt.status).toBe(attempt < 3 ? "queued" : "failed");
    expect(result.receipt.error).not.toContain("private");
    expect(result.runs).toHaveLength(attempt);
  }
});

integration("lease fencing discards stale completion after another worker wins", async () => {
  const id = await enqueue();
  let entered!: () => void;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  let release!: (response: Response) => void;
  const delayed = ((_input: unknown) => { entered(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
  const first = processOneJob(db!, config(), delayed);
  await fetching;
  expect(await processOneJob(db!, config(), successFetch)).toBe(false);
  await db!.update(jobs).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(jobs.receiptId, id));
  await processOneJob(db!, config(), successFetch);
  release(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...extraction, merchantName: "Stale result" }) } }] })));
  await first;
  const result = await state(id);
  expect(result.receipt.merchantName).toBe("Test");
  expect(result.job.attempts).toBe(2);
  expect(result.runs).toHaveLength(1);
});

integration("revision fencing preserves a correction made during extraction", async () => {
  const id = await enqueue();
  let entered!: () => void;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  let release!: (response: Response) => void;
  const delayed = (() => { entered(); return new Promise<Response>(resolve => { release = resolve; }); }) as unknown as typeof fetch;
  const pending = processOneJob(db!, config(), delayed);
  await fetching;
  // Simulate a defensive out-of-band edit; normal API blocks processing edits.
  await db!.transaction(async tx => {
    await tx.select().from(jobs).where(eq(jobs.receiptId, id)).for("update");
    await tx.select().from(receipts).where(eq(receipts.id, id)).for("update");
    await tx.update(receipts).set({ revision: 1, status: "ready", merchantName: "Corrected" }).where(eq(receipts.id, id));
  });
  release(await successFetch("http://unused"));
  await pending;
  const result = await state(id);
  expect(result.receipt.merchantName).toBe("Corrected");
  expect(result.receipt.revision).toBe(1);
  expect(result.job.state).toBe("failed");
  expect(result.runs).toHaveLength(0);
  expect(result.items).toHaveLength(0);
});
