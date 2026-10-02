import { expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";
import type { Database } from "../src/server/db";
import { processOneJob, retryDelayMs, startWorker } from "../src/server/worker";
import { jobs, receipts, extractionRuns } from "../src/server/db/schema";

test("disabled AI neither accesses database nor consumes queued receipts", async () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unused" });
  const db = new Proxy({}, { get() { throw new Error("Database must not be accessed"); } }) as Database;
  expect(await processOneJob(db, config)).toBe(false);
  await startWorker(db, config).stop();
});

test("backoff is exponential and bounded", () => {
  expect([1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000]);
  expect(retryDelayMs(100)).toBe(60_000);
});

// These tests exercise transactional control flow, not PostgreSQL's lock implementation.
function scriptedDatabase(rows: unknown[][]) {
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const locks: { table: unknown; options: unknown }[] = [];
  const tx = {
    select() {
      let table: unknown;
      const chain = {
        from(value: unknown) { table = value; return chain; },
        where() { return chain; },
        orderBy() { return chain; },
        limit() { return chain; },
        for(_mode: unknown, options?: unknown) {
          locks.push({ table, options });
          return Promise.resolve(rows.shift() ?? []);
        },
      };
      return chain;
    },
    update(table: unknown) {
      return { set(values: Record<string, unknown>) {
        writes.push({ table, values });
        return { where: async () => {} };
      } };
    },
    insert(table: unknown) {
      return { values: async (values: Record<string, unknown>) => { writes.push({ table, values }); } };
    },
  };
  const db = { transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as Database;
  return { db, writes, locks };
}
const enabledConfig = loadConfig({ DATABASE_URL: "postgres://unused", AI_API_KEY: "test", AI_MODEL: "vision" });
const receipt = { id: crypto.randomUUID(), status: "processing", revision: 0, imagePath: "../unsafe" };
const job = { id: crypto.randomUUID(), receiptId: receipt.id, attempts: 3 };

test("expired final attempt becomes failed without contacting provider", async () => {
  const { db, writes, locks } = scriptedDatabase([[job], [receipt]]);
  expect(await processOneJob(db, enabledConfig)).toBe(true);
  expect(locks.map(lock => lock.table)).toEqual([jobs, receipts]);
  expect(locks[0]!.options).toEqual({ skipLocked: true });
  expect(writes.find(write => write.table === jobs)!.values.state).toBe("failed");
  expect(writes.find(write => write.table === receipts)!.values.status).toBe("failed");
  expect(writes.find(write => write.table === extractionRuns)!.values.model).toBe("vision");
});

test("manual revision is never overwritten or extracted", async () => {
  const { db, writes } = scriptedDatabase([[{ ...job, attempts: 0 }], [{ ...receipt, revision: 1 }]]);
  expect(await processOneJob(db, enabledConfig)).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.table).toBe(jobs);
  expect(writes[0]!.values.state).toBe("failed");
});

test("stale fencing token prevents completion writes", async () => {
  const { db, writes } = scriptedDatabase([
    [{ ...job, attempts: 0 }], [receipt],
    [{ ...job, state: "running", lockedBy: "new-owner", leaseExpiresAt: new Date(Date.now() + 1_000_000) }],
  ]);
  // Unsafe image filename fails before fetch, then attempts a fenced failure transaction.
  expect(await processOneJob(db, enabledConfig)).toBe(true);
  expect(writes).toHaveLength(2); // Claim updates only.
  expect(writes[0]!.values.attempts).toBe(1);
  expect(writes[0]!.values.lockedBy).toBeString();
  expect((writes[0]!.values.leaseExpiresAt as Date).getTime() - Date.now()).toBeGreaterThan(enabledConfig.ai.timeoutMs);
});
