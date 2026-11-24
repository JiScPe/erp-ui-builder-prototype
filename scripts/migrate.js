import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connection) {
  console.error('DATABASE_URL is missing. Run neon deploy or neon env pull first.');
  process.exit(1);
}

try {
  const sql = neon(connection);
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  const statements = schema.split(';').map(statement => statement.trim()).filter(Boolean);
  await sql.transaction(statements.map(statement => sql.query(statement)));
  console.log('Neon Postgres schema migration completed.');
} catch (error) {
  console.error('Neon Postgres migration failed:', error.code || error.name);
  process.exitCode = 1;
}
