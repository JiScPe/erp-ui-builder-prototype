CREATE TABLE IF NOT EXISTS erp_prototype (
  id integer PRIMARY KEY CHECK (id = 1),
  layout jsonb,
  revision integer NOT NULL DEFAULT 0
);
INSERT INTO erp_prototype (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS erp_prototype_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  layout jsonb NOT NULL,
  values_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
