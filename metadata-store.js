import { layoutFor, validConfiguration } from './metadata.js';

export async function readPublished(sql) {
  const [published] = await sql`
    SELECT published_config AS config, revision FROM erp_prototype WHERE id = 1
  `;
  return published;
}

export async function readDraft(sql) {
  const [draft] = await sql`
    SELECT COALESCE(draft_config, published_config) AS config,
           draft_revision AS "draftRevision"
    FROM erp_prototype WHERE id = 1
  `;
  return draft;
}

export async function saveDraft(sql, config, draftRevision) {
  const payload = JSON.stringify(config);
  const [draft] = await sql`
    UPDATE erp_prototype
    SET draft_config = ${payload}::jsonb,
        draft_revision = CASE WHEN draft_config = ${payload}::jsonb
          THEN draft_revision ELSE draft_revision + 1 END
    WHERE id = 1 AND (
      draft_revision = ${draftRevision}
      OR (draft_revision = ${draftRevision + 1}::bigint AND draft_config = ${payload}::jsonb)
    )
    RETURNING draft_config AS config, draft_revision AS "draftRevision"
  `;
  return draft;
}

export async function publishDraft(sql, draftRevision) {
  const [state] = await sql`
    SELECT draft_config AS draft, draft_revision AS "draftRevision",
           published_config AS config, revision, published_draft_revision AS "publishedDraftRevision"
    FROM erp_prototype WHERE id = 1
  `;
  if (state.publishedDraftRevision === draftRevision) {
    return { status: 'published', config: state.config, revision: state.revision };
  }
  if (!state.draft || state.draftRevision !== draftRevision) {
    return { status: 'stale' };
  }
  if (!validConfiguration(state.draft)) return { status: 'invalid' };

  const form = layoutFor(state.draft);
  const formFields = new Set(form.filter(item => item.type !== 'heading').map(item => item.id));
  const missingFields = state.draft.schema
    .filter(field => field.required && !formFields.has(field.id))
    .map(field => field.id);
  if (missingFields.length) return { status: 'missing-fields', fields: missingFields };

  const layout = JSON.stringify(form);
  const [, [result]] = await sql.transaction([
    sql`SELECT id FROM erp_prototype WHERE id = 1 FOR UPDATE`,
    sql`
      WITH candidate AS (
        SELECT id, published_config, draft_config
        FROM erp_prototype WHERE id = 1 AND draft_revision = ${draftRevision}
          AND published_draft_revision IS DISTINCT FROM ${draftRevision}
      ),
      current_fields AS (
        SELECT field->>'id' AS id, field->>'type' AS type
        FROM candidate, LATERAL jsonb_array_elements(published_config->'schema') AS fields(field)
      ),
      proposed_fields AS (
        SELECT field->>'id' AS id, field->>'type' AS type
        FROM candidate, LATERAL jsonb_array_elements(draft_config->'schema') AS fields(field)
      ),
      changes AS (
        SELECT id, current_fields.type AS previous_type, proposed_fields.type AS proposed_type
        FROM current_fields FULL JOIN proposed_fields USING (id)
        WHERE current_fields.type IS DISTINCT FROM proposed_fields.type
      ),
      conflicts AS (
        SELECT changes.id AS field_id
        FROM changes
        WHERE EXISTS (
          SELECT 1 FROM erp_prototype_submissions AS submission
          WHERE (submission.values_json->>changes.id) ~ '[^[:space:]]'
            AND (changes.previous_type IS NOT NULL OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(submission.layout) AS snapshot(field)
              WHERE snapshot.field->>'id' = changes.id
                AND snapshot.field->>'type' <> changes.proposed_type
            ))
        )
      ),
      published AS (
        UPDATE erp_prototype AS prototype
        SET published_config = candidate.draft_config,
            published_draft_revision = ${draftRevision},
            layout = ${layout}::jsonb,
            revision = prototype.revision + 1
        FROM candidate WHERE prototype.id = candidate.id
          AND NOT EXISTS (SELECT 1 FROM conflicts)
        RETURNING prototype.published_config AS config, prototype.revision
      )
      SELECT COALESCE(published.config, prototype.published_config) AS config,
             COALESCE(published.revision, prototype.revision) AS revision,
             published.revision IS NOT NULL
                OR prototype.published_draft_revision IS NOT DISTINCT FROM ${draftRevision} AS published,
             (SELECT COALESCE(jsonb_agg(field_id ORDER BY field_id), '[]'::jsonb)
              FROM conflicts) AS conflicts
      FROM erp_prototype AS prototype LEFT JOIN published ON true
      WHERE prototype.id = 1
    `,
  ], { isolationLevel: 'ReadCommitted' });

  if (result.published) {
    return { status: 'published', config: result.config, revision: result.revision };
  }
  return result.conflicts.length
    ? { status: 'conflict', fields: result.conflicts }
    : { status: 'stale' };
}
