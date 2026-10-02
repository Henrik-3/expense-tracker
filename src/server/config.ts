import { z } from "zod";
import { resolve } from "node:path";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  UPLOAD_DIR: z.string().default("./data/uploads"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(15),
  AI_API_BASE_URL: z.url().default("https://api.openai.com/v1"),
  AI_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default(""),
  AI_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(90),
  AI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  AI_RESPONSE_FORMAT: z.enum(["json_schema", "json_object"]).default("json_schema"),
});

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.HOST,
    port: parsed.PORT,
    uploadDir: resolve(parsed.UPLOAD_DIR),
    maxUploadBytes: parsed.MAX_UPLOAD_MB * 1024 * 1024,
    ai: {
      baseUrl: parsed.AI_API_BASE_URL.replace(/\/+$/, ""),
      apiKey: parsed.AI_API_KEY,
      model: parsed.AI_MODEL,
      timeoutMs: parsed.AI_TIMEOUT_SECONDS * 1000,
      concurrency: parsed.AI_MAX_CONCURRENCY,
      responseFormat: parsed.AI_RESPONSE_FORMAT,
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
