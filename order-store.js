import { validConfiguration } from './metadata.js';
import { readPublished } from './metadata-store.js';

const pageSize = 50;
const comparisons = new Map([
  ['eq', '='], ['ne', '<>'], ['lt', '<'], ['lte', '<='], ['gt', '>'], ['gte', '>='],
]);

function orderListQuery(config, revision, page) {
  const params = [revision];
  const bind = value => '$' + params.push(value);
  const fields = new Map(config.schema.map(field => [field.id, field]));
  const expressions = new Map();

  function fieldExpression(fieldId) {
    if (expressions.has(fieldId)) return expressions.get(fieldId);
    const field = fields.get(fieldId);
    const raw = `(submission.values_json ->> ${bind(field.id)}::text)`;
    let expression = raw;
    if (field.type === 'number') {
      expression = `CASE WHEN ${raw} ~ '[0-9]' AND pg_input_is_valid(${raw}, 'numeric') THEN ${raw}::numeric END`;
    } else if (field.type === 'date') {
      const date = `CASE WHEN left(${raw}, 4) = '0000' THEN '0400' || substr(${raw}, 5) ELSE ${raw} END`;
      expression = `CASE WHEN ${raw} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND pg_input_is_valid(${date}, 'date') THEN ${raw} END`;
    }
    expressions.set(fieldId, expression);
    return expression;
  }

  const filters = config.query.filters.map(({ fieldId, operator, value }) => {
    const expression = fieldExpression(fieldId);
    const parameter = bind(value);
    if (operator === 'contains') return `strpos(${expression}, ${parameter}::text) > 0`;
    const type = fields.get(fieldId).type === 'number' ? 'numeric' : 'text';
    return `${expression} ${comparisons.get(operator)} ${parameter}::${type}`;
  });
  const ordering = config.query.sort.map(({ fieldId, direction }) =>
    `${fieldExpression(fieldId)} ${direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
  ordering.push('submission.id DESC');
  const offset = bind(((BigInt(page) - 1n) * BigInt(pageSize)).toString());

  return {
    query: `
      SELECT COALESCE((
        SELECT jsonb_agg(result)
        FROM (
          SELECT submission.id::text AS id, submission.values_json AS values,
                 submission.created_at AS "createdAt", submission.xmin::text AS version
          FROM erp_prototype_submissions AS submission
          ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
          ORDER BY ${ordering.join(', ')}
          LIMIT ${pageSize + 1} OFFSET ${offset}::bigint
        ) AS result
      ), '[]'::jsonb) AS records
      FROM erp_prototype
      WHERE id = 1 AND revision = $1::integer
    `,
    params,
  };
}

export async function listOrders(sql, page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const published = await readPublished(sql);
    if (!published.config) return { ...published, records: [], hasMore: false };
    if (!validConfiguration(published.config)) throw new Error('Invalid published order configuration');
    const { query, params } = orderListQuery(published.config, published.revision, page);
    const [pageData] = await sql.query(query, params);
    if (pageData) {
      return { ...published, records: pageData.records.slice(0, pageSize), hasMore: pageData.records.length > pageSize };
    }
  }
  return null;
}

export async function readOrder(sql, id) {
  const [order] = await sql`
    SELECT prototype.published_config AS config, prototype.revision,
           jsonb_build_object('id', submission.id::text, 'values', submission.values_json,
             'createdAt', submission.created_at, 'version', submission.xmin::text) AS record
    FROM erp_prototype AS prototype CROSS JOIN erp_prototype_submissions AS submission
    WHERE prototype.id = 1 AND submission.id = ${id}::bigint
  `;
  return order;
}

export async function insertOrder(sql, revision, layout, values) {
  const [record] = await sql`
    WITH live AS (
      SELECT id FROM erp_prototype WHERE id = 1 AND revision = ${revision} FOR SHARE
    )
    INSERT INTO erp_prototype_submissions (layout, values_json)
    SELECT ${JSON.stringify(layout)}::jsonb, ${JSON.stringify(values)}::jsonb FROM live
    RETURNING id::text, values_json AS values, created_at AS "createdAt", xmin::text AS version
  `;
  return record;
}

export async function updateOrder(sql, { id, revision, version, values }) {
  const [record] = await sql`
    WITH live AS (
      SELECT id FROM erp_prototype WHERE id = 1 AND revision = ${revision} FOR SHARE
    )
    UPDATE erp_prototype_submissions AS submission
    SET values_json = submission.values_json || ${JSON.stringify(values)}::jsonb
    FROM live
    WHERE submission.id = ${id}::bigint AND submission.xmin::text = ${version}
    RETURNING submission.id::text, submission.values_json AS values,
              submission.created_at AS "createdAt", submission.xmin::text AS version
  `;
  return record;
}

export async function deleteOrder(sql, id, version) {
  const [record] = await sql`
    WITH live AS (
      SELECT id FROM erp_prototype WHERE id = 1 FOR SHARE
    )
    DELETE FROM erp_prototype_submissions AS submission USING live
    WHERE submission.id = ${id}::bigint AND submission.xmin::text = ${version}
    RETURNING submission.id::text
  `;
  return record;
}
