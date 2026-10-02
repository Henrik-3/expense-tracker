import Decimal from "decimal.js";
import type { Extraction } from "../../shared/contracts";

export function assessExtraction(extraction: Extraction): { status: "ready" | "needs_review"; warnings: string[] } {
  const warnings = [...extraction.warnings];
  if (!extraction.purchasedAt) warnings.push("Purchase date is missing.");
  if (!extraction.currency) warnings.push("Currency is missing.");
  if (extraction.total === null) warnings.push("Printed total is missing.");
  if (!extraction.items.length) warnings.push("No purchased items were extracted.");
  const amounts = [...extraction.items.map((item) => item.lineTotal), ...extraction.adjustments.map((item) => item.amount)];
  if (amounts.some((amount) => amount === null)) warnings.push("An item or adjustment amount is missing.");
  // Permit one cent of printed rounding; never use binary floating point.
  if (extraction.total !== null && amounts.every((amount) => amount !== null)) {
    const sum = amounts.reduce<Decimal>((total, amount) => total.plus(amount!), new Decimal(0));
    if (sum.minus(extraction.total).abs().gt("0.01")) warnings.push("Items and separate adjustments do not reconcile with the printed total.");
  }
  return { status: warnings.length ? "needs_review" : "ready", warnings: [...new Set(warnings)] };
}
