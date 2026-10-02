import Decimal from "decimal.js";
import type { ReceiptDetail, StatsResponse, CurrencyStats, Breakdown } from "../../shared/contracts";

// A local constructor avoids changing precision for extraction reconciliation.
// 40 digits accommodates exact sums of all representable input amounts.
const Money = Decimal.clone({ precision: 40 });

export interface StatsFilters {
  from?: string;
  to?: string;
  merchant?: string;
  categoryId?: string;
  brand?: string;
  manufacturer?: string;
  includeNeedsReview?: boolean;
  groupBy?: "day" | "week" | "month";
}

/** excludedReceipts counts status-eligible receipts matching merchant/date filters
 * that lack date, currency, or total. Date-less receipts cannot match date filters.
 * Nonmatching statuses and nonmatching item filters are not exclusions. */
export function aggregateStatistics(receipts: ReceiptDetail[], categories: Map<string, string>, filters: StatsFilters): StatsResponse {
  const groups = new Map<string, CurrencyStats>();
  let excludedReceipts = 0;
  const itemBasis = Boolean(filters.categoryId || filters.brand || filters.manufacturer);
  const add = (rows: Breakdown[], name: string, value: string) => {
    const existing = rows.find((row) => row.name === name);
    if (existing) existing.total = new Money(existing.total).plus(value).toString();
    else rows.push({ name, total: new Money(value).toString() });
  };
  for (const receipt of receipts) {
    if (receipt.status !== "ready" && !(filters.includeNeedsReview && receipt.status === "needs_review")) continue;
    if (filters.merchant && !(receipt.merchantName ?? "").toLowerCase().includes(filters.merchant.toLowerCase())) continue;
    if (filters.from && (!receipt.purchasedAt || receipt.purchasedAt < filters.from)) continue;
    if (filters.to && (!receipt.purchasedAt || receipt.purchasedAt > filters.to)) continue;
    const items = receipt.items.filter((item) =>
      (!filters.categoryId || item.categoryId === filters.categoryId) &&
      (!filters.brand || (item.brand ?? "").toLowerCase() === filters.brand.toLowerCase()) &&
      (!filters.manufacturer || (item.manufacturer ?? "").toLowerCase() === filters.manufacturer.toLowerCase()));
    if (itemBasis && !items.length) continue;
    if (!receipt.purchasedAt || !receipt.currency || receipt.total === null) { excludedReceipts++; continue; }
    if (itemBasis && !items.some((item) => item.lineTotal !== null)) continue;
    let group = groups.get(receipt.currency);
    if (!group) {
      group = { currency: receipt.currency, receiptCount: 0, total: "0", basis: itemBasis ? "items" : "receipts", timeline: [], merchants: [], categories: [], brands: [], manufacturers: [] };
      groups.set(receipt.currency, group);
    }
    const total = itemBasis ? items.reduce((sum, item) => sum.plus(item.lineTotal ?? "0"), new Money(0)).toString() : receipt.total;
    group.receiptCount++;
    group.total = new Money(group.total).plus(total).toString();
    let bucket = receipt.purchasedAt;
    if (filters.groupBy === "month") bucket = bucket.slice(0, 7);
    if (filters.groupBy === "week") {
      const date = new Date(`${bucket}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      bucket = date.toISOString().slice(0, 10);
    }
    add(group.timeline, bucket, total);
    add(group.merchants, receipt.merchantName || "Unknown", total);
    for (const item of items) {
      if (item.lineTotal === null) continue;
      add(group.categories, item.categoryId ? categories.get(item.categoryId) ?? "Uncategorized" : "Uncategorized", item.lineTotal);
      add(group.brands, item.brand || "Unknown", item.lineTotal);
      add(group.manufacturers, item.manufacturer || "Unknown", item.lineTotal);
    }
  }
  for (const group of groups.values()) for (const rows of [group.timeline, group.merchants, group.categories, group.brands, group.manufacturers]) rows.sort((a, b) => a.name.localeCompare(b.name));
  return { currencies: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)), excludedReceipts };
}
