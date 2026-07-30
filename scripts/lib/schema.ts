import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';

/** Применяет db/schema.sql. Идемпотентно: все объекты создаются через IF NOT EXISTS. */
export async function applySchema(client: PoolClient): Promise<void> {
  const sql = readFileSync(resolve(process.cwd(), 'db/schema.sql'), 'utf8');
  await client.query(sql);
}
