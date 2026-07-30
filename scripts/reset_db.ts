/**
 * Полная пересборка локальной базы: удаляет таблицы проекта и заново применяет схему.
 * Нужна, чтобы проверить загрузку «с нуля» — иначе легко принять за успех результат,
 * который остался от прошлого прогона.
 *
 * Запуск: npm run db:reset
 * Защита от глупости: работает только если DATABASE_URL смотрит на localhost.
 */
import { getPool } from '../lib/db';
import { loadEnv, requireEnv } from './lib/env';
import { applySchema } from './lib/schema';

async function main(): Promise<void> {
  loadEnv();
  const url = requireEnv('DATABASE_URL');
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`db:reset работает только с локальной базой, а в DATABASE_URL хост ${host}`);
  }

  const client = await getPool().connect();
  try {
    await client.query(
      `DROP TABLE IF EXISTS duplicate_candidates, import_rows, import_runs, companies CASCADE`,
    );
    console.log('Таблицы проекта удалены.');
    await applySchema(client);
    console.log('Схема применена заново: db/schema.sql');
  } finally {
    client.release();
    await getPool().end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
