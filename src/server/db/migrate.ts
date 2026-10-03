import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { loadConfig } from "../config";

const migrations = ["001_initial.sql", "002_merchant_rules.sql", "003_receipt_review.sql"];

export async function migrate(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      // Serialize startup migrations across application replicas.
      await tx`SELECT pg_advisory_xact_lock(701492830)`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      for (const name of migrations) {
        const source = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
        const checksum = createHash("sha256").update(source).digest("hex");
        const [existing] = await tx`SELECT checksum FROM schema_migrations WHERE name = ${name}`;
        if (existing) {
          if (existing.checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`);
          continue;
        }
        await tx.unsafe(source);
        await tx`INSERT INTO schema_migrations(name, checksum) VALUES (${name}, ${checksum})`;
      }
    });
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await migrate(loadConfig().databaseUrl);
  console.info("Database migrations applied.");
}
