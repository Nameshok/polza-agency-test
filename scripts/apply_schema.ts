/** Применяет db/schema.sql. Запуск: npm run db:schema */
import { getPool } from '../lib/db';
import { loadEnv, requireEnv } from './lib/env';
import { applySchema } from './lib/schema';

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DATABASE_URL');

  const client = await getPool().connect();
  try {
    await applySchema(client);
    console.log('Схема применена: db/schema.sql');
  } finally {
    client.release();
    await getPool().end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
