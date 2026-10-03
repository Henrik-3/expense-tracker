import { describe, expect, test } from "bun:test";
import { imageMime, paginationSchema, receiptListQuerySchema, statsQuerySchema } from "../src/server/api/validation";

describe("API boundary validation", () => {
  test("pagination is bounded", () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 50, offset: 0 });
    for (const limit of ["0", "-1", "101", "1.5", "no"]) expect(paginationSchema.safeParse({ limit }).success).toBe(false);
  });
  test("receipt reviewed filter is optional and accepts only literal booleans", () => {
    expect(receiptListQuerySchema.parse({}).reviewed).toBeUndefined();
    expect(receiptListQuerySchema.parse({ reviewed: "true", limit: "2", offset: "1" })).toEqual({ reviewed: true, limit: 2, offset: 1 });
    expect(receiptListQuerySchema.parse({ reviewed: "false" }).reviewed).toBe(false);
    for (const reviewed of ["", "yes", "1", "0", "TRUE", true, false]) {
      expect(receiptListQuerySchema.safeParse({ reviewed }).success).toBe(false);
    }
    expect(receiptListQuerySchema.safeParse({ reviewed: "false", offset: "-1" }).success).toBe(false);
  });
  test("statistics rejects invalid dates, ranges, identifiers and booleans", () => {
    for (const input of [{ from: "2025-02-30" }, { from: "2025-02-02", to: "2025-01-01" }, { categoryId: "../x" }, { includeNeedsReview: "yes" }, { groupBy: "year" }]) expect(statsQuerySchema.safeParse(input).success).toBe(false);
    expect(statsQuerySchema.parse({ includeNeedsReview: "false" }).includeNeedsReview).toBe(false);
  });
  test("image signatures are required", () => {
    expect(imageMime(new Uint8Array([255,216,255]))).toBe("image/jpeg");
    expect(imageMime(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe("image/png");
    expect(imageMime(new TextEncoder().encode("RIFF0000WEBP"))).toBe("image/webp");
    expect(imageMime(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(imageMime(new Uint8Array([137,80]))).toBeNull();
  });
});
