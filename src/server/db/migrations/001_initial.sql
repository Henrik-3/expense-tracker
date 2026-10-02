CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  archived boolean NOT NULL DEFAULT false
);

CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'needs_review', 'failed')),
  merchant_name text,
  purchased_at date,
  currency text,
  total numeric(14,4),
  notes text NOT NULL DEFAULT '',
  warnings jsonb NOT NULL DEFAULT '[]',
  error text,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  image_path text NOT NULL,
  image_mime text NOT NULL,
  original_filename text NOT NULL,
  image_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_purchase_idx ON receipts(purchased_at);
CREATE INDEX receipts_status_idx ON receipts(status);

CREATE TABLE receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position integer NOT NULL,
  description text NOT NULL,
  product_name text,
  quantity numeric(14,4),
  unit text,
  unit_price numeric(14,4),
  line_total numeric(14,4),
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  brand text,
  manufacturer text
);
CREATE INDEX receipt_items_receipt_idx ON receipt_items(receipt_id);

CREATE TABLE receipt_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position integer NOT NULL,
  description text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discount', 'fee', 'deposit', 'rounding', 'other')),
  amount numeric(14,4)
);
CREATE INDEX receipt_adjustments_receipt_idx ON receipt_adjustments(receipt_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL UNIQUE REFERENCES receipts(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  locked_by text,
  last_error text
);
CREATE INDEX jobs_claim_idx ON jobs(state, available_at);

CREATE TABLE extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  model text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  raw jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO categories(name) VALUES
  ('Groceries'), ('Dining out'), ('Household'), ('Health'),
  ('Transport'), ('Clothing'), ('Electronics'), ('Other');
