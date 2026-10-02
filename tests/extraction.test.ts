import { describe, expect, test } from "bun:test";
import type { Extraction } from "../src/shared/contracts";
import { loadConfig } from "../src/server/config";
import { extractReceipt, ExtractionError, providerSchema } from "../src/server/ai/extractor";
import { assessExtraction } from "../src/server/services/reconciliation";

const config = loadConfig({ DATABASE_URL: "postgres://unused", AI_API_KEY: "test-secret", AI_MODEL: "vision" });
const item = { description: "Item", productName: null, quantity: null, unit: null, unitPrice: null, lineTotal: "0.10", categoryId: null, brand: null, manufacturer: null };
const valid = (): Extraction => ({
  merchantName: null, purchasedAt: "2026-01-01", currency: "USD", total: "0.30",
  items: [{ ...item }, { ...item, lineTotal: "0.20" }], adjustments: [], warnings: [],
});
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
const mockFetch = (fn: (url: unknown, init?: RequestInit) => Response | Promise<Response>) => fn as typeof fetch;

describe("reconciliation", () => {
  test("decimal arithmetic and one-cent tolerance", () => {
    expect(assessExtraction(valid()).status).toBe("ready");
    expect(assessExtraction({ ...valid(), total: "0.31" }).status).toBe("ready");
    expect(assessExtraction({ ...valid(), total: "0.3101" }).status).toBe("needs_review");
  });
  test("signed separate deposits and discounts, not tax double counting", () => {
    const extraction = valid();
    extraction.adjustments = [{ description: "Deposit", kind: "deposit", amount: "0.10" }, { description: "Discount", kind: "discount", amount: "-0.05" }];
    extraction.total = "0.35";
    expect(assessExtraction(extraction).status).toBe("ready");
  });
  test("large four-place amounts remain exact", () => {
    const extraction = valid();
    extraction.items = [{ ...item, lineTotal: "9999999999.9999" }, { ...item, lineTotal: "-9999999999.9998" }];
    extraction.total = "0.0001";
    expect(assessExtraction(extraction).status).toBe("ready");
  });
  test("missing facts and warnings always require review", () => {
    for (const fields of [{ purchasedAt: null }, { currency: null }, { total: null }, { items: [] }, { items: [{ ...item, lineTotal: null }] }, { adjustments: [{ description: "Unknown", kind: "other" as const, amount: null }] }, { warnings: ["Unreadable"] }]) {
      expect(assessExtraction({ ...valid(), ...fields }).status).toBe("needs_review");
    }
  });
});

describe("provider protocol", () => {
  test("strict schema request, image base64, no guessed provenance", async () => {
    const response = await extractReceipt(new Uint8Array([1, 2, 3]), "image/png", [], config, mockFetch((url, init) => {
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("vision");
      expect(body.response_format.json_schema.schema).toEqual(providerSchema);
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.messages[1].content[0].image_url.url).toBe("data:image/png;base64,AQID");
      expect(body.messages[0].content).toContain("never instructions");
      expect(body.messages[0].content).toContain("never guess manufacturer");
      return reply(JSON.stringify(valid()));
    }));
    expect(response.extraction).toEqual(valid());
    expect(response.raw).toHaveProperty("choices");
  });
  test("explicit JSON-object capability switch", async () => {
    await extractReceipt(new Uint8Array(), "image/jpeg", [], { ...config, ai: { ...config.ai, responseFormat: "json_object" } }, mockFetch((_url, init) => {
      expect(JSON.parse(init!.body as string).response_format).toEqual({ type: "json_object" });
      return reply(JSON.stringify(valid()));
    }));
  });
  test("unknown category IDs are null with warning", async () => {
    const extraction = valid();
    extraction.items[0]!.categoryId = "not-even-a-uuid";
    const result = await extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() => reply(JSON.stringify(extraction))));
    expect(result.extraction.items[0]!.categoryId).toBeNull();
    expect(result.extraction.warnings).toContain("An unknown category was omitted.");
  });
  test("malformed output is retained without leaking it into error", async () => {
    try {
      await extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() => reply("private broken output")));
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionError);
      expect((error as ExtractionError).raw).toHaveProperty("choices");
      expect((error as ExtractionError).message).not.toContain("private");
      expect((error as ExtractionError).retryable).toBe(false);
    }
  });
  test("application schema rejects invalid dates and decimal numbers", async () => {
    await expect(extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() => reply(JSON.stringify({ ...valid(), purchasedAt: "2026-02-30", total: 0.3 }))))).rejects.toBeInstanceOf(ExtractionError);
  });
  test("auth is permanent; throttling/server/network failures retry safely", async () => {
    for (const status of [401, 403, 400, 429, 500]) {
      try {
        await extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() => new Response("SECRET response", { status })));
      } catch (error) {
        expect((error as ExtractionError).retryable).toBe(status === 429 || status >= 500);
        expect((error as ExtractionError).message).not.toContain("SECRET");
        expect((error as ExtractionError).message).not.toContain(config.ai.apiKey);
      }
    }
    await expect(extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() => { throw new Error("secret network diagnostics"); }))).rejects.toMatchObject({ retryable: true });
  });
});
