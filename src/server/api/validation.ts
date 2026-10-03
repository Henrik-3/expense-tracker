import { z } from "zod";

export const uuidSchema = z.uuid();
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export const receiptListQuerySchema = paginationSchema.extend({
  reviewed: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
});
export const statsQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  groupBy: z.enum(["day", "week", "month"]).default("day"),
  merchant: z.string().trim().min(1).max(200).optional(),
  categoryId: uuidSchema.optional(),
  brand: z.string().trim().min(1).max(200).optional(),
  manufacturer: z.string().trim().min(1).max(200).optional(),
  includeNeedsReview: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
}).refine((value) => !value.from || !value.to || value.from <= value.to, "from must not exceed to");

export function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0,4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8,12)) === "WEBP") return "image/webp";
  return null;
}
