import { Pool } from 'pg';

/**
 * Один пул на процесс. В dev-режиме Next.js модули перезагружаются на каждое
 * изменение файла, поэтому пул кладём в globalThis — иначе за сессию накопятся
 * десятки подключений и Postgres начнёт отказывать.
 */
const globalForDb = globalThis as unknown as { polzaPool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.polzaPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL не задан. Скопируйте .env.example в .env.');
    }
    globalForDb.polzaPool = new Pool({ connectionString, max: 5 });
  }
  return globalForDb.polzaPool;
}

/** Все запросы — только параметризованные: значения передаются отдельно от текста SQL. */
export async function query<T extends object>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params as unknown[]);
  return result.rows as T[];
}
