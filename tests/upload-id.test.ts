import { expect, test } from "bun:test";
import { z } from "zod";
import { createUploadId } from "../src/client/upload-id";

test("capture IDs are valid random UUIDs without secure-context randomUUID", () => {
  const ids = Array.from({ length: 100 }, () => createUploadId());
  expect(ids.every(id => z.uuid().safeParse(id).success)).toBe(true);
  expect(new Set(ids).size).toBe(100);
  expect(ids.every(id => id[14] === "4" && /[89ab]/.test(id[19]!))).toBe(true);
});
