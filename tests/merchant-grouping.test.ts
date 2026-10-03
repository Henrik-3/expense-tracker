import { expect, test } from "bun:test";
import { merchantRuleInputSchema, type MerchantRule } from "../src/shared/contracts";
import { merchantResolver } from "../src/server/services/merchant-grouping";

const rule = (id: string, matchName: string, merchantName: string, matchType: "exact" | "prefix" = "prefix"): MerchantRule =>
  ({ id, matchName, merchantName, matchType });

test("prefix matching normalizes case and whitespace with token boundaries", () => {
  const resolve = merchantResolver([rule("1", "REWE", "REWE")]);
  expect(resolve("  reWe \t Borkold\n ihr Frischemarkt ")).toBe("REWE");
  expect(resolve("REWE")).toBe("REWE");
  expect(resolve("REWEX")).toBeNull();
  expect(resolve("Not REWE")).toBeNull();
  expect(resolve(null)).toBeNull();
  expect(resolve(" ")).toBeNull();
});

test("exact wins before longest prefix; ties are stable independently of query order", () => {
  const rules = [rule("z", "REWE", "General"), rule("b", "REWE Borkold", "Branch"),
    rule("a", "REWE Borkold", "Exact", "exact")];
  for (const ordered of [rules, [...rules].reverse()]) {
    const resolve = merchantResolver(ordered);
    expect(resolve("REWE Borkold")).toBe("Exact");
    expect(resolve("REWE Borkold ihr Frischemarkt")).toBe("Branch");
    expect(resolve("REWE Other")).toBe("General");
  }
  expect(merchantResolver([rule("b", "REWE", "B"), rule("a", "REWE", "A")])("REWE")).toBe("A");
});

test("rule input normalizes names and rejects empty, oversized and invalid values", () => {
  expect(merchantRuleInputSchema.parse({ matchName: " REWE\tBorkold ", merchantName: " My\n Shop ", matchType: "exact" }))
    .toEqual({ matchName: "REWE Borkold", merchantName: "My Shop", matchType: "exact" });
  for (const input of [
    { matchName: "\t\n", merchantName: "Shop", matchType: "prefix" },
    { matchName: "REWE", merchantName: " ", matchType: "prefix" },
    { matchName: "x".repeat(201), merchantName: "Shop", matchType: "prefix" },
    { matchName: "REWE", merchantName: "Shop", matchType: "contains" },
    { matchName: "REWE", merchantName: "Shop" },
  ]) expect(merchantRuleInputSchema.safeParse(input).success).toBe(false);
});

test("a compiled response snapshot does not mix rules if its source changes", () => {
  const rules = [rule("1", "REWE", "Before")];
  const snapshot = merchantResolver(rules);
  rules[0]!.merchantName = "After";
  expect(snapshot("REWE Branch")).toBe("Before");
  expect(merchantResolver(rules)("REWE Branch")).toBe("After");
});
