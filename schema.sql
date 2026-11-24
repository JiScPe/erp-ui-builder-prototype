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

ALTER TABLE erp_prototype
  ADD COLUMN IF NOT EXISTS published_config jsonb,
  ADD COLUMN IF NOT EXISTS draft_config jsonb,
  ADD COLUMN IF NOT EXISTS draft_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_draft_revision integer;

UPDATE erp_prototype AS prototype
SET published_config = (
  SELECT jsonb_build_object(
    'schema', COALESCE(jsonb_agg(jsonb_build_object(
      'id', item->'id', 'label', item->'label', 'type', item->'type',
      'required', item->'required', 'options', item->'options'
    ) ORDER BY position)
      FILTER (WHERE item->>'type' <> 'heading'), '[]'::jsonb),
    'table', jsonb_build_object('columns', COALESCE(jsonb_agg(item->>'id' ORDER BY position)
      FILTER (WHERE item->>'type' <> 'heading'), '[]'::jsonb)),
    'form', jsonb_build_object('items', COALESCE(jsonb_agg(
      CASE WHEN item->>'type' = 'heading'
        THEN jsonb_build_object('kind', 'heading', 'id', item->'id', 'label', item->'label', 'width', item->'width')
        ELSE jsonb_build_object('kind', 'field', 'fieldId', item->'id', 'width', item->'width')
      END ORDER BY position), '[]'::jsonb)),
    'query', '{"filters":[],"sort":[]}'::jsonb
  )
  FROM jsonb_array_elements(prototype.layout) WITH ORDINALITY AS fields(item, position)
)
WHERE prototype.published_config IS NULL AND prototype.layout IS NOT NULL;
