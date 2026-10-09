import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config";
import { createDatabase } from "./db";
import { migrate } from "./db/migrate";
import { createServer } from "./server";
import { startWorker } from "./worker";

async function main() {
  const config = loadConfig();
  await mkdir(config.uploadDir, { recursive: true });
  await migrate(config.databaseUrl);
  const { db, sql } = createDatabase(config.databaseUrl);
  const app = createServer(db, config);
  const worker = startWorker(db, config);
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    maxRequestBodySize: config.maxUploadBytes + 1024 * 1024,
    fetch: app.fetch,
  });
  console.info(`Receipt Ledger listening on port ${server.port}. Put authentication at your reverse proxy.`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.info("Stopping HTTP server and draining receipt processing.");
    await server.stop();
    await worker.stop();
    await sql.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const e = error as { name?: string; code?: string; message?: string };
    console.error(`Startup error: ${e?.name ?? "Error"}${e?.code ? ` [${e.code}]` : ""}: ${String(e?.message ?? error).replace(/\/\/[^@\s/]*@/g, "//***@")}`);
    // Configuration/connection errors may include credentials; don't dump them.
    console.error("Startup failed. Check DATABASE_URL, database availability, and environment configuration.");
    process.exitCode = 1;
  });
}
