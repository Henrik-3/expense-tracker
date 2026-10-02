/** Callers supply operational metadata only, never secrets or receipt contents. */
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  console[level](JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

export interface ExtractionContext {
  receiptId?: string;
  jobId?: string;
  attempt?: number;
}
