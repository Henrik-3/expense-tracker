import { z } from "zod";

// Keep decimal values as strings across database, API and editing boundaries.
export const decimalSchema = z.string().regex(/^-?\d{1,10}(?:\.\d{1,4})?$/, "Use a decimal with at most 4 decimal places");
export const dateSchema = z.iso.date();
export const receiptStatusSchema = z.enum(["queued", "processing", "ready", "needs_review", "failed"]);
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;

export const itemInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  productName: z.string().trim().max(500).nullable(),
  quantity: decimalSchema.nullable(),
  unit: z.string().trim().max(40).nullable(),
  unitPrice: decimalSchema.nullable(),
  lineTotal: decimalSchema.nullable(),
  categoryId: z.uuid().nullable(),
  brand: z.string().trim().max(200).nullable(),
  manufacturer: z.string().trim().max(200).nullable(),
});
export type ItemInput = z.infer<typeof itemInputSchema>;
export type ReceiptItem = ItemInput & { id: string };

export const adjustmentInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  kind: z.enum(["discount", "fee", "deposit", "rounding", "other"]),
  amount: decimalSchema.nullable(),
});
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;
export type ReceiptAdjustment = AdjustmentInput & { id: string };

export const receiptFieldsSchema = z.object({
  merchantName: z.string().trim().max(200).nullable(),
  purchasedAt: dateSchema.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  total: decimalSchema.nullable(),
  notes: z.string().max(4000),
});
export const receiptUpdateSchema = receiptFieldsSchema.extend({
  revision: z.number().int().nonnegative(),
  status: z.enum(["ready", "needs_review"]),
  items: z.array(itemInputSchema).max(500),
  adjustments: z.array(adjustmentInputSchema).max(100),
});
export type ReceiptUpdate = z.infer<typeof receiptUpdateSchema>;

export interface ReceiptSummary extends z.infer<typeof receiptFieldsSchema> {
  merchantGroup: string | null;
  id: string;
  status: ReceiptStatus;
  warnings: string[];
  error: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ReceiptDetail extends ReceiptSummary {
  imageUrl: string;
  items: ReceiptItem[];
  adjustments: ReceiptAdjustment[];
}
export interface ReceiptListResponse {
  receipts: ReceiptSummary[];
  total: number;
}
export interface Category {
  id: string;
  name: string;
  archived: boolean;
}
export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  archived: z.boolean().optional(),
});

export const merchantRuleInputSchema = z.object({
  matchName: z.string().transform((value) => value.trim().replace(/\s+/g, " ")).pipe(z.string().min(1).max(200)),
  merchantName: z.string().transform((value) => value.trim().replace(/\s+/g, " ")).pipe(z.string().min(1).max(200)),
  matchType: z.enum(["exact", "prefix"]),
});
export type MerchantRule = z.infer<typeof merchantRuleInputSchema> & { id: string };

// This is the validated application shape, not a provider-specific wire schema.
export const extractionSchema = receiptFieldsSchema.omit({ notes: true }).extend({
  items: z.array(itemInputSchema).max(500),
  adjustments: z.array(adjustmentInputSchema).max(100),
  warnings: z.array(z.string().max(1000)).max(100),
});
export type Extraction = z.infer<typeof extractionSchema>;

export interface Breakdown {
  name: string;
  total: string;
}
export interface CurrencyStats {
  currency: string;
  receiptCount: number;
  total: string;
  basis: "receipts" | "items";
  timeline: Breakdown[];
  merchants: Breakdown[];
  categories: Breakdown[];
  brands: Breakdown[];
  manufacturers: Breakdown[];
}
export interface StatsResponse {
  currencies: CurrencyStats[];
  excludedReceipts: number;
}

// HTTP contract:
// GET /api/receipts?limit=50&offset=0 -> ReceiptListResponse
// POST /api/receipts (multipart: image File, receiptId client UUID) -> { receipt: ReceiptDetail }
// GET /api/receipts/:id -> { receipt: ReceiptDetail }
// PATCH /api/receipts/:id (ReceiptUpdate) -> { receipt: ReceiptDetail }
// POST /api/receipts/:id/retry -> { receipt: ReceiptDetail }
// GET /api/receipts/:id/image -> original image
// GET /api/categories -> { categories: Category[] } (includes archived)
// POST /api/categories (categoryInputSchema) -> { category: Category }
// PATCH /api/categories/:id (categoryInputSchema) -> { category: Category }
// GET /api/merchant-rules -> { rules: MerchantRule[] }
// POST /api/merchant-rules (merchantRuleInputSchema) -> { rule: MerchantRule }
// PATCH /api/merchant-rules/:id (merchantRuleInputSchema, all fields required) -> { rule: MerchantRule }
// DELETE /api/merchant-rules/:id -> 204
// Receipt summaries/details expose merchantGroup (null when no rule matches);
// merchantName remains the printed name. Merchant stats use group or printed name.
// GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month
//   &merchant=...&categoryId=...&brand=...&manufacturer=...&includeNeedsReview=true -> StatsResponse
// Errors: { error: string }, with appropriate 4xx/5xx HTTP status.
