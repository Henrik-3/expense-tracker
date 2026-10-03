import { describe, expect, test } from "bun:test";
import { dateSchema, decimalSchema, extractionSchema, receiptRevisionSchema } from "../src/shared/contracts";
import { loadConfig } from "../src/server/config";

describe("shared boundaries", () => {
  test("receipt actions require an explicit nonnegative integer revision", () => {
    for (const revision of [0, 1, 42]) {
      expect(receiptRevisionSchema.parse({ revision })).toEqual({ revision });
    }
    for (const input of [{}, null, { revision: -1 }, { revision: 0.5 }, { revision: "1" }, { revision: null }]) {
      expect(receiptRevisionSchema.safeParse(input).success).toBe(false);
    }
  });
  test("decimal strings preserve fractions, negatives and database precision", () => {
    for (const value of ["0", "-1.25", "0.125", "9999999999.9999"]) {
      expect(decimalSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["", "NaN", "1e5", "1,25", "10000000000", "0.12345", 0.1]) {
      expect(decimalSchema.safeParse(value).success).toBe(false);
    }
  });
  test("calendar dates must exist", () => {
    expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(dateSchema.safeParse("2025-02-29").success).toBe(false);
    expect(dateSchema.safeParse("2026-13-01").success).toBe(false);
  });
  test("missing amounts stay null, rather than coercing to zero", () => {
    const parsed = extractionSchema.parse({
      merchantName: null, purchasedAt: null, currency: null, total: null,
      items: [], adjustments: [], warnings: ["Unreadable"],
    });
    expect(parsed.total).toBeNull();
  });
  test("environment configuration is bounded and normalizes provider base URL", () => {
    const parsed = loadConfig({ DATABASE_URL: "postgresql://localhost/test", AI_API_BASE_URL: "http://localhost:8080/v1/" });
    expect(parsed.ai.baseUrl).toBe("http://localhost:8080/v1");
    expect(parsed.maxUploadBytes).toBe(15 * 1024 * 1024);
    expect(() => loadConfig({ DATABASE_URL: "postgresql://localhost/test", AI_MAX_CONCURRENCY: "100" })).toThrow();
  });
});
