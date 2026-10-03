import type { MerchantRule } from "../../shared/contracts";

export function normalizeMerchant(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Compile once per response snapshot, never cache across rule edits. */
export function merchantResolver(rules: MerchantRule[]) {
  const ordered = rules.map((rule) => ({ ...rule, match: normalizeMerchant(rule.matchName) }))
    .sort((a, b) => Number(b.matchType === "exact") - Number(a.matchType === "exact")
      || b.match.length - a.match.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return (printedName: string | null): string | null => {
    if (!printedName) return null;
    const name = normalizeMerchant(printedName);
    return ordered.find((rule) => name === rule.match
      || (rule.matchType === "prefix" && name.startsWith(`${rule.match} `)))?.merchantName ?? null;
  };
}
