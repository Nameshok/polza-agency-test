/**
 * Проверки, которые нельзя сделать без базы. Всё происходит внутри транзакции,
 * которая в конце откатывается, — скрипт ничего не меняет и запускается на живой базе.
 *
 * Проверяет два правила, на которых легко обмануться:
 *   1. Пустое значение из новой выгрузки НЕ затирает непустое старое.
 *   2. Повторная загрузка той же записи возвращает 'unchanged', а не 'updated'.
 *
 * Запуск: npm run test:db (после npm run load:all)
 */
import assert from 'node:assert/strict';

import { getPool } from '../lib/db';
import { loadEnv, requireEnv } from './lib/env';
import type { NormalizedCompany } from './lib/normalize';
import { upsertCompany } from './lib/store';

interface Row {
  external_id: string;
  name: string;
  name_key: string;
  category: string | null;
  city: string | null;
  city_key: string | null;
  address: string | null;
  rating: string | null;
  reviews_count: number | null;
  site: string | null;
  phone: string | null;
  phone_e164: string | null;
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DATABASE_URL');

  const client = await getPool().connect();
  let failures = 0;

  const check = (label: string, condition: boolean, detail = '') => {
    if (condition) {
      console.log(`  ok   ${label}`);
    } else {
      failures += 1;
      console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
  };

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<Row>(
      `SELECT external_id, name, name_key, category, city, city_key, address,
              rating, reviews_count, site, phone, phone_e164
         FROM companies
        WHERE reviews_count IS NOT NULL AND site IS NOT NULL AND phone_e164 IS NOT NULL
          AND rating IS NOT NULL
        ORDER BY external_id
        LIMIT 1`,
    );
    const before = rows[0];
    assert.ok(before, 'В companies нет подходящей записи. Сначала выполните npm run load:all.');

    console.log(`Проверяю на записи ${before.external_id} (${before.name})`);

    // ── 1. Повторная загрузка тех же данных не должна считаться обновлением ──
    const same: NormalizedCompany = {
      externalId: before.external_id,
      name: before.name,
      nameKey: before.name_key,
      category: before.category,
      city: before.city,
      cityKey: before.city_key,
      address: before.address,
      rating: before.rating === null ? null : Number(before.rating),
      reviewsCount: before.reviews_count,
      site: before.site,
      phone: before.phone,
      phoneE164: before.phone_e164,
    };
    const repeat = await upsertCompany(client, same, {
      source: 'db_check',
      sourceFile: 'db.check.ts',
      sourceRow: 1,
    });
    check('повторная загрузка тех же данных → unchanged', repeat === 'unchanged', `получено ${repeat}`);

    // ── 2. Пустые значения из «свежей» выгрузки не затирают заполненные ──
    const poorer: NormalizedCompany = {
      ...same,
      rating: null,
      reviewsCount: null,
      site: null,
      phone: null,
      phoneE164: null,
      category: null,
      address: null,
    };
    await upsertCompany(client, poorer, {
      source: 'db_check',
      sourceFile: 'db.check.ts',
      sourceRow: 2,
    });

    const after = (
      await client.query<Row>(
        `SELECT external_id, name, name_key, category, city, city_key, address,
                rating, reviews_count, site, phone, phone_e164
           FROM companies WHERE external_id = $1`,
        [before.external_id],
      )
    ).rows[0]!;

    check('rating не затёрт', after.rating === before.rating, `${before.rating} → ${after.rating}`);
    check(
      'reviews_count не затёрт',
      after.reviews_count === before.reviews_count,
      `${before.reviews_count} → ${after.reviews_count}`,
    );
    check('site не затёрт', after.site === before.site, `${before.site} → ${after.site}`);
    check('phone не затёрт', after.phone === before.phone, `${before.phone} → ${after.phone}`);
    check(
      'category не затёрта',
      after.category === before.category,
      `${before.category} → ${after.category}`,
    );
    check(
      'address не затёрт',
      after.address === before.address,
      `${before.address} → ${after.address}`,
    );

    // ── 3. Настоящий ноль — это значение, и он ДОЛЖЕН перезаписать старое ──
    // Без этой проверки регрессия вида `новое || старое` вместо `новое ?? старое`
    // прошла бы и юнит-тесты, и проверку выше: она ловит только NULL.
    await client.query('SAVEPOINT zero_case');
    await upsertCompany(
      client,
      { ...same, reviewsCount: 0, rating: null },
      { source: 'db_check', sourceFile: 'db.check.ts', sourceRow: 3 },
    );
    const zeroed = (
      await client.query<{ reviews_count: number | null }>(
        `SELECT reviews_count FROM companies WHERE external_id = $1`,
        [before.external_id],
      )
    ).rows[0]!;
    check(
      'настоящий ноль отзывов перезаписывает старое значение',
      zeroed.reviews_count === 0,
      `ожидал 0, получил ${zeroed.reviews_count}`,
    );
    await client.query('ROLLBACK TO SAVEPOINT zero_case');

    // ── 4. Ограничения схемы действительно работают ──
    for (const [label, sql] of [
      ['rating > 5 отвергается схемой', `UPDATE companies SET rating = 7.2 WHERE external_id = $1`],
      [
        'отрицательное reviews_count отвергается схемой',
        `UPDATE companies SET reviews_count = -10 WHERE external_id = $1`,
      ],
    ] as const) {
      await client.query('SAVEPOINT constraint_check');
      let rejected = false;
      try {
        await client.query(sql, [before.external_id]);
      } catch {
        rejected = true;
      }
      await client.query('ROLLBACK TO SAVEPOINT constraint_check');
      check(label, rejected);
    }
  } finally {
    // Ничего не сохраняем: проверка не должна менять базу.
    await client.query('ROLLBACK');
    client.release();
    await getPool().end();
  }

  if (failures > 0) {
    console.error(`\nПровалено проверок: ${failures}`);
    process.exit(1);
  }
  console.log('\nВсе проверки прошли, база не изменена (транзакция откатана).');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
