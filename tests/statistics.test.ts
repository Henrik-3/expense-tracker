import { describe, expect, test } from "bun:test";
import type { ReceiptDetail } from "../src/shared/contracts";
import { aggregateStatistics } from "../src/server/services/statistics";

const receipt = (changes: Partial<ReceiptDetail> = {}): ReceiptDetail => ({
  id: "test", status: "ready", merchantName: "Shop", purchasedAt: "2025-01-05", currency: "EUR", total: "0.3", notes: "", warnings: [], error: null, revision: 0,
  createdAt: "", updatedAt: "", imageUrl: "", adjustments: [], merchantGroup: null,
  items: [{ id: "item", description: "Food", productName: null, quantity: "1", unit: null, unitPrice: "0.4", lineTotal: "0.4", categoryId: "food", brand: "Brand", manufacturer: "Maker" }], ...changes,
});
describe("exact statistics", () => {
  test("canonical groups merge totals and filters match canonical or printed names", () => {
    const rows = [
      receipt({ merchantName: "REWE Viettz ihr Frischemarkt", merchantGroup: "Groceries", total: "0.1" }),
      receipt({ merchantName: "REWE Other", merchantGroup: "Groceries", total: "0.2" }),
      receipt({ merchantName: "REWEX", total: "1" }),
    ];
    const result = aggregateStatistics(rows, new Map(), { merchant: "GROCERIES" });
    expect(result.currencies[0]!.merchants).toEqual([{ name: "Groceries", total: "0.3" }]);
    expect(result.currencies[0]!.receiptCount).toBe(2);
    expect(aggregateStatistics(rows, new Map(), { merchant: "viettz   IHR" }).currencies[0]!.total).toBe("0.1");
    expect(aggregateStatistics(rows, new Map(), { merchant: "groceries", brand: "brand" }).currencies[0]!.total).toBe("0.8");
  });
  test("printed totals and item breakdowns differ; currencies never mix", () => {
    const result = aggregateStatistics([receipt({ total: "0.1" }), receipt({ total: "0.2" }), receipt({ currency: "USD", total: "2" })], new Map([["food", "Food"]]), {});
    expect(result.currencies[0]!.total).toBe("0.3");
    expect(result.currencies[0]!.categories[0]!.total).toBe("0.8");
    expect(result.currencies[1]!.total).toBe("2");
  });
  test("item filters change main basis without allocating discounts", () => {
    const result = aggregateStatistics([receipt()], new Map(), { brand: "brand", manufacturer: "MAKER", categoryId: "food" });
    expect(result.currencies[0]!.basis).toBe("items");
    expect(result.currencies[0]!.total).toBe("0.4");
    expect(aggregateStatistics([receipt()], new Map(), { brand: "other" }).currencies).toEqual([]);
  });
  test("DATE bounds are inclusive and weeks start Monday", () => {
    const result = aggregateStatistics([receipt()], new Map(), { from: "2025-01-05", to: "2025-01-05", groupBy: "week" });
    expect(result.currencies[0]!.timeline[0]!.name).toBe("2024-12-30");
    expect(aggregateStatistics([receipt()], new Map(), { from: "2025-01-06" }).currencies).toEqual([]);
  });
  test("needs_review opt-in and exact exclusion meaning", () => {
    const rows = [receipt({ status: "needs_review" }), receipt({ status: "needs_review", currency: null }), receipt({ status: "failed" })];
    expect(aggregateStatistics(rows, new Map(), {})).toEqual({ currencies: [], excludedReceipts: 0 });
    const result = aggregateStatistics(rows, new Map(), { includeNeedsReview: true });
    expect(result.excludedReceipts).toBe(1);
    expect(result.currencies[0]!.receiptCount).toBe(1);
    expect(aggregateStatistics([receipt({ purchasedAt: null })], new Map(), { from: "2025-01-01" }).excludedReceipts).toBe(0);
  });
  test("incomplete receipts are only exclusions when item filters match", () => {
    const rows = [receipt({ status: "needs_review", currency: null })];
    expect(aggregateStatistics(rows, new Map(), { includeNeedsReview: true, brand: "Other" }).excludedReceipts).toBe(0);
    expect(aggregateStatistics(rows, new Map(), { includeNeedsReview: true, brand: "Brand" }).excludedReceipts).toBe(1);
    expect(aggregateStatistics(rows, new Map(), { includeNeedsReview: true, categoryId: "other" }).excludedReceipts).toBe(0);
  });
});
