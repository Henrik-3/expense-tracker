CREATE TABLE merchant_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_name text NOT NULL CHECK (length(btrim(match_name)) > 0),
  merchant_name text NOT NULL CHECK (length(btrim(merchant_name)) > 0),
  match_type text NOT NULL CHECK (match_type IN ('exact', 'prefix'))
);
CREATE UNIQUE INDEX merchant_rules_match_unique ON merchant_rules
  (match_type, lower(regexp_replace(btrim(match_name), '[[:space:]]+', ' ', 'g')));
INSERT INTO merchant_rules (match_name, merchant_name, match_type)
VALUES ('REWE', 'REWE', 'prefix');
