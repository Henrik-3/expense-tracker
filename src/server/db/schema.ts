import { boolean, date, integer, jsonb, numeric, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import type { ReceiptStatus } from "../../shared/contracts";

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  archived: boolean("archived").notNull().default(false),
});

export const merchantRules = pgTable("merchant_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchName: text("match_name").notNull(),
  merchantName: text("merchant_name").notNull(),
  matchType: text("match_type").$type<"exact" | "prefix">().notNull(),
});

export const receipts = pgTable("receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").$type<ReceiptStatus>().notNull().default("queued"),
  merchantName: text("merchant_name"),
  purchasedAt: date("purchased_at"),
  currency: text("currency"),
  total: numeric("total", { precision: 14, scale: 4 }),
  notes: text("notes").notNull().default(""),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  error: text("error"),
  revision: integer("revision").notNull().default(0),
  imagePath: text("image_path").notNull(),
  imageMime: text("image_mime").notNull(),
  originalFilename: text("original_filename").notNull(),
  imageSha256: text("image_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("receipts_purchase_idx").on(t.purchasedAt), index("receipts_status_idx").on(t.status)]);

export const receiptItems = pgTable("receipt_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull().references(() => receipts.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  productName: text("product_name"),
  quantity: numeric("quantity", { precision: 14, scale: 4 }),
  unit: text("unit"),
  unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
  lineTotal: numeric("line_total", { precision: 14, scale: 4 }),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  brand: text("brand"),
  manufacturer: text("manufacturer"),
}, (t) => [index("receipt_items_receipt_idx").on(t.receiptId)]);

export const receiptAdjustments = pgTable("receipt_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull().references(() => receipts.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  kind: text("kind").$type<"discount" | "fee" | "deposit" | "rounding" | "other">().notNull(),
  amount: numeric("amount", { precision: 14, scale: 4 }),
}, (t) => [index("receipt_adjustments_receipt_idx").on(t.receiptId)]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull().unique().references(() => receipts.id, { onDelete: "cascade" }),
  state: text("state").$type<"pending" | "running" | "completed" | "failed">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  lastError: text("last_error"),
}, (t) => [index("jobs_claim_idx").on(t.state, t.availableAt)]);

export const extractionRuns = pgTable("extraction_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull().references(() => receipts.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  raw: jsonb("raw").$type<unknown>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
