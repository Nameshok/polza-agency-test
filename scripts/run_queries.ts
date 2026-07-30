/**
 * Прогоняет db/queries.sql и печатает результаты таблицами.
 * Запросы разделены комментариями «-- @name …» — их же использую как заголовки.
 *
 * Запуск: npm run queries
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPool } from '../lib/db';
import { loadEnv, requireEnv } from './lib/env';

interface NamedQuery {
  name: string;
  sql: string;
}

function splitQueries(source: string): NamedQuery[] {
  const queries: NamedQuery[] = [];
  let current: NamedQuery | null = null;

  for (const line of source.split(/\r?\n/)) {
    const marker = line.match(/^--\s*@name\s+(.*)$/);
    if (marker) {
      if (current) queries.push(current);
      current = { name: marker[1]!.trim(), sql: '' };
      continue;
    }
    if (current) current.sql += `${line}\n`;
  }
  if (current) queries.push(current);

  return queries
    .map((query) => ({ ...query, sql: query.sql.trim() }))
    .filter((query) => query.sql.length > 0);
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DATABASE_URL');

  const source = readFileSync(resolve(process.cwd(), 'db/queries.sql'), 'utf8');
  const queries = splitQueries(source);

  for (const [index, query] of queries.entries()) {
    console.log(`\n─── ${index + 1}. ${query.name} ${'─'.repeat(Math.max(0, 60 - query.name.length))}`);
    const { rows } = await getPool().query(query.sql);
    if (rows.length === 0) console.log('(пусто)');
    else console.table(rows);
  }

  await getPool().end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
