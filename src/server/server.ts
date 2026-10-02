import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/bun";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import type { Config } from "./config";
import type { Database } from "./db";

export function createServer(db: Database, config: Config) {
  const server = new Hono();
  server.use("*", secureHeaders({
    // The reverse proxy owns TLS/HSTS. Keep this service usable over local HTTP.
    strictTransportSecurity: false,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  }));
  server.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      // Do not trust forwarded-host headers. Configure the proxy to preserve Host.
      if (origin) {
        try {
          if (new URL(origin).host !== c.req.header("Host")) {
            return c.json({ error: "Cross-origin writes are not allowed." }, 403);
          }
        } catch {
          return c.json({ error: "Invalid request origin." }, 403);
        }
      }
    }
    await next();
  });
  server.get("/api/health", async (c) => {
    try {
      await db.execute(sql`SELECT 1`);
      return c.json({ status: "ok", aiConfigured: Boolean(config.ai.apiKey && config.ai.model) });
    } catch {
      return c.json({ status: "unavailable", error: "Database is unavailable." }, 503);
    }
  });
  server.route("/", createApp(db, config));
  server.all("/api/*", (c) => c.json({ error: "Not found." }, 404));
  server.use("/assets/*", serveStatic({ root: "./dist" }));
  server.get("*", serveStatic({ path: "./dist/index.html" }));
  server.onError((_error, c) => c.json({ error: "An unexpected server error occurred." }, 500));
  return server;
}
