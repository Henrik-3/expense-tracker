CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  archived boolean NOT NULL DEFAULT false
);

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS paid_by_id uuid REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS receipts_paid_by_idx ON receipts(paid_by_id);
