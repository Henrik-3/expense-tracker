import { describe, expect, spyOn, test } from "bun:test";
import { extractionSchema, receiptFieldsSchema, type Extraction } from "../src/shared/contracts";
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
  for (const responseFormat of ["json_schema", "json_object"] as const) {
    test(`${responseFormat}: date-only instructions and safe datetime normalization`, async () => {
      for (const [purchasedAt, expected] of [
        ["2026-01-01", "2026-01-01"],
        [null, null],
        ["2026-01-01T14:30:00Z", "2026-01-01"],
        ["2026-01-01T00:30:00+14:00", "2026-01-01"],
        ["2026-01-01T23:30:00-12:00", "2026-01-01"],
        ["2026-12-31T23:30:00-12:00", "2026-12-31"],
        ["2026-03-01T00:30:00+14:00", "2026-03-01"],
        ["2024-02-29T23:30:00-12:00", "2024-02-29"],
        ["2026-01-01T14:30:00.123", "2026-01-01"],
        ["2026-01-01T14:30", "2026-01-01"],
        [" 2026-01-01 14:30:00 ", "2026-01-01"],
        ["2024-02-29T14:30:00Z", "2024-02-29"],
      ]) {
        const content = JSON.stringify({ ...valid(), purchasedAt });
        const result = await extractReceipt(new Uint8Array(), "image/png", [],
          { ...config, ai: { ...config.ai, responseFormat } }, mockFetch((_url, init) => {
            const prompt = JSON.parse(init!.body as string).messages[0].content;
            expect(prompt).toContain("purchasedAt must be a calendar date string exactly YYYY-MM-DD");
            expect(prompt).toContain("without timezone conversion");
            expect(prompt).toContain("Never include a time or timezone.");
            expect(prompt).toContain("never convert to UTC, server or browser timezone, or shift the day");
            expect(prompt).toContain("Do not infer a timezone from currency, upload time, or server location");
            expect(prompt).toContain("A missing timezone alone does not make a legible local purchase date ambiguous");
            expect(prompt).toContain("If the purchase date itself is unreadable or genuinely ambiguous, use null and add a warning");
            expect(prompt).toContain('printed "2026-01-01T00:30:00+14:00" -> "2026-01-01" (not UTC date "2025-12-31")');
            expect(prompt).toContain('printed "2026-12-31T23:30:00-12:00" -> "2026-12-31" (not UTC date "2027-01-01")');
            expect(prompt).toContain('printed "2026-06-01 14:30" with no timezone -> "2026-06-01"');
            expect(prompt).toContain(JSON.stringify(providerSchema));
            return reply(content);
          }));
        expect(result.extraction).toEqual({ ...valid(), purchasedAt: expected });
        expect(result.raw).toEqual({ choices: [{ message: { content } }] });
      }
    });
    test(`${responseFormat}: original-language instructions and multilingual text preservation`, async () => {
      const extraction: Extraction = {
        ...valid(), merchantName: "Épicerie Müller",
        items: [
          { ...item, description: "CRÈME FRAÎCHE", productName: "Crème fraîche", brand: "Président" },
          { ...item, description: "Bio Hafer Drink", productName: "Bio Hafer Drink", manufacturer: "Müller", unit: "Stück" },
          { ...item, description: "抹茶 Latte 大", productName: "抹茶 Latte 大" },
          { ...item, description: "ÄPF.?", productName: null },
        ],
        adjustments: [{ description: "Réduction fidélité", kind: "discount", amount: "-0.10" }],
      };
      const result = await extractReceipt(new Uint8Array(), "image/png", [],
        { ...config, ai: { ...config.ai, responseFormat } }, mockFetch((_url, init) => {
          const prompt = JSON.parse(init!.body as string).messages[0].content;
          expect(prompt).toContain("original language in item descriptions and productName; never translate or reinterpret them into English or another language");
          expect(prompt).toContain("retaining accents, diacritics, original script, and mixed-language text");
          expect(prompt).toContain("keep uncertain wording as printed or use null rather than invent a name");
          expect(prompt).toContain("preserve the printed language and spelling of merchantName, brand, manufacturer, unit, and adjustment descriptions");
          expect(prompt).toContain('"CRÈME FRAÎCHE" stays "CRÈME FRAÎCHE", not "Fresh cream"');
          expect(prompt).toContain("not JSON keys, required enum values, ISO currency codes, or category IDs");
          expect(prompt).toContain(JSON.stringify(providerSchema));
          return reply(JSON.stringify(extraction));
        }));
      expect(result.extraction).toEqual(extraction);
    });
  }
  test("date normalization does not guess or hide invalid timestamps", async () => {
    for (const purchasedAt of [
      "01/02/2026", "2026-02-30", "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z",
      "2026-01-01T25:00:00Z", "2026-01-01T12:00:00+99:00", "2026-01-01garbage",
      "2026-01-01T12:00:00Z trailing text", "", 1767225600000, {},
    ]) {
      await expect(extractReceipt(new Uint8Array(), "image/png", [], config,
        mockFetch(() => reply(JSON.stringify({ ...valid(), purchasedAt })))))
        .rejects.toMatchObject({ diagnostics: { stage: "application_schema" } });
    }
  });
  test("application and editing contracts remain date-only", () => {
    const extraction = { ...valid(), purchasedAt: "2026-01-01T12:00:00Z" };
    expect(extractionSchema.safeParse(extraction).success).toBe(false);
    expect(receiptFieldsSchema.safeParse({ ...extraction, notes: "" }).success).toBe(false);
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

async function captureLogs(run: (logs: Record<string, unknown>[]) => Promise<void>) {
  const logs: Record<string, unknown>[] = [];
  const capture = (line: unknown) => { logs.push(JSON.parse(String(line))); };
  const info = spyOn(console, "info").mockImplementation(capture);
  const error = spyOn(console, "error").mockImplementation(capture);
  try { await run(logs); } finally { info.mockRestore(); error.mockRestore(); }
}

describe("safe provider diagnostics", () => {
  test("request and response metadata correlate without credentials or receipt contents", async () => {
    await captureLogs(async logs => {
      const privateConfig = {
        ...config,
        ai: { ...config.ai, baseUrl: "https://username:password@openrouter.ai/api/v1?token=query-secret#fragment-secret" },
      };
      await extractReceipt(Buffer.from("private image bytes"), "image/png", [], privateConfig, mockFetch(() =>
        Response.json({ id: "gen-test", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ...valid(), merchantName: "PRIVATE STORE" }) } }] },
          { headers: { "x-request-id": "provider-request-123" } })),
      { receiptId: "receipt-123", jobId: "job-123", attempt: 2 });
      expect(logs.map(log => log.event)).toEqual(["ai.request.started", "ai.response.received", "ai.request.completed"]);
      expect(logs[0]).toMatchObject({ endpoint: "https://openrouter.ai/api/v1", receiptId: "receipt-123", attempt: 2, model: "vision", responseFormat: "json_schema" });
      expect(logs[1]).toMatchObject({ httpStatus: 200, providerRequestId: "provider-request-123" });
      expect(logs[2]).toMatchObject({ providerGenerationId: "gen-test", finishReason: "stop", itemCount: 2 });
      expect(new Set(logs.map(log => log.requestId)).size).toBe(1);
      for (const privateValue of [config.ai.apiKey, "username", "password", "query-secret", "fragment-secret", "PRIVATE STORE", Buffer.from("private image bytes").toString("base64")]) {
        expect(JSON.stringify(logs)).not.toContain(privateValue);
      }
    });
  });

  test("schema failure prints field paths and expected types, not rejected values", async () => {
    await captureLogs(async logs => {
      const output = { ...valid(), merchantName: "PRIVATE STORE", total: 0.3, purchasedAt: "private-invalid-date" };
      await expect(extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() => reply(JSON.stringify(output)))))
        .rejects.toMatchObject({
          diagnostics: {
            stage: "application_schema",
            issues: [
              { path: "purchasedAt", code: "invalid_format" },
              { path: "total", code: "invalid_type", expected: "string" },
            ],
          },
        });
      const failure = logs.find(log => log.event === "ai.request.failed")!;
      expect(failure.error).toContain("AI output did not match the receipt schema.");
      expect(failure.error).toContain("total (invalid_type; expected string)");
      expect(failure.stage).toBe("application_schema");
      expect(failure.retryable).toBe(false);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE STORE");
      expect(JSON.stringify(logs)).not.toContain("private-invalid-date");
      expect(logs.some(log => log.event === "ai.request.completed")).toBe(false);
    });
  });

  test("distinguishes malformed JSON, missing content, truncation, refusal and provider errors", async () => {
    const cases: [unknown, string, boolean][] = [
      ["private-not-json", "response_json", false],
      [{ choices: [{ message: { content: "private-invalid-output" } }] }, "content_json", false],
      [{ choices: [{ message: { content: null } }] }, "message_content", false],
      [{ choices: [{ finish_reason: "length", message: { content: "{}" } }] }, "truncated", false],
      [{ choices: [{ message: { refusal: "private refusal text" } }] }, "refusal", false],
      [{ error: { code: 503, message: "private provider diagnostics" } }, "provider_error", true],
    ];
    for (const [body, stage, retryable] of cases) {
      await captureLogs(async logs => {
        await expect(extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() =>
          typeof body === "string" ? new Response(body) : Response.json(body))))
          .rejects.toMatchObject({ diagnostics: { stage }, retryable });
        expect(logs.at(-1)).toMatchObject({ event: "ai.request.failed", stage, httpStatus: 200 });
        expect(JSON.stringify(logs)).not.toContain("private");
      });
    }
  });

  test("network and HTTP errors log safe actionable outcomes, including empty error bodies", async () => {
    await captureLogs(async logs => {
      await expect(extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() => {
        throw new Error(`secret transport diagnostics ${config.ai.apiKey}`);
      }))).rejects.toMatchObject({ diagnostics: { stage: "network" }, retryable: true });
      expect(logs.map(log => log.event)).toEqual(["ai.request.started", "ai.request.failed"]);
      expect(JSON.stringify(logs)).not.toContain(config.ai.apiKey);
      expect(JSON.stringify(logs)).not.toContain("secret transport");
    });
    await captureLogs(async logs => {
      await expect(extractReceipt(new Uint8Array(), "image/png", [], config, mockFetch(() =>
        new Response(null, { status: 401 })))).rejects.toMatchObject({ diagnostics: { stage: "http" }, retryable: false });
      expect(logs.at(-1)).toMatchObject({ httpStatus: 401, stage: "http" });
    });
  });
});
