/**
 * Короткий отчёт по данным (задача 3): что в базе, что отвергнуто, что в карантине
 * и какие замечания встречаются чаще всего. Отчёт читает БД, а не файлы, —
 * то есть показывает результат загрузки, а не мои ожидания от неё.
 *
 * Запуск: npm run report
 */
import { getPool, query } from '../lib/db';
import { loadEnv, requireEnv } from './lib/env';

function section(title: string): void {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DATABASE_URL');

  section('Прогоны загрузчика');
  console.table(
    await query(`SELECT id, source, started_at, finished_at,
                        stats->>'rowsRead'   AS rows_read,
                        stats->>'inserted'   AS inserted,
                        stats->>'updated'    AS updated,
                        stats->>'unchanged'  AS unchanged,
                        stats->>'quarantined' AS quarantined,
                        stats->>'rejected'   AS rejected
                   FROM import_runs ORDER BY id`),
  );

  section('Компании в базе');
  console.table(
    await query(`SELECT source,
                        count(*)                                  AS companies,
                        count(rating)                             AS with_rating,
                        count(reviews_count)                      AS with_reviews_count,
                        count(site)                               AS with_site,
                        count(phone_e164)                         AS with_valid_phone,
                        count(DISTINCT city_key)                  AS cities,
                        count(DISTINCT category)                  AS categories
                   FROM companies GROUP BY source ORDER BY source`),
  );

  section('Строки по статусам');
  console.table(
    await query(`SELECT source_file ~ '^page_' AS from_api, status, count(*)
                   FROM import_rows GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`),
  );

  section('Замечания по полям (топ-20)');
  console.table(
    await query(`SELECT issue, count(*) AS rows
                   FROM import_rows, unnest(issues) AS issue
                  GROUP BY issue ORDER BY rows DESC, issue LIMIT 20`),
  );

  section('Карантин: что не пустили в companies');
  console.table(
    await query(`SELECT source_row AS csv_line, external_id, raw->>'name' AS name,
                        array_to_string(issues, ', ') AS issues
                   FROM import_rows WHERE status = 'quarantined'
                  ORDER BY source_row`),
  );

  // Группировать надо по ДОМЕНУ, а не по строке site. Пока группировка шла по site,
  // пара c_000219 / c_000829 не находилась: у одной компании домен записан как
  // https://ip-715.ru, у другой — http://ip-715.ru. Сайтов в выгрузке 142 через http
  // и 748 через https, так что промах был не единичной случайностью, а системным.
  section('Один домен у нескольких компаний');
  console.table(
    await query(`SELECT lower(regexp_replace(regexp_replace(site, '^https?://', ''), '^www\\.', ''))
                          AS domain,
                        count(*) AS companies,
                        string_agg(external_id || ' (' || coalesce(city_key, '?') || ')', ', '
                                   ORDER BY external_id) AS who
                   FROM companies
                  WHERE site IS NOT NULL
                  GROUP BY 1
                 HAVING count(*) > 1
                  ORDER BY count(*) DESC, 1`),
  );

  section('Кандидаты в дубли (одна компания под разными id)');
  console.table(
    await query(`SELECT d.external_id AS new_id, d.duplicate_of AS existing_id,
                        d.match_reason, d.confidence,
                        d.details->>'new_name'      AS new_name,
                        d.details->>'existing_name' AS existing_name
                   FROM duplicate_candidates d
                  ORDER BY d.confidence, d.external_id`),
  );

  section('Отвергнутые строки');
  console.table(
    await query(`SELECT source_file, source_row, array_to_string(issues, ', ') AS issues
                   FROM import_rows WHERE status = 'rejected'
                  ORDER BY source_file, source_row`),
  );

  section('Проверка на идемпотентность');
  const runs = await query<{ source: string; runs: string }>(
    `SELECT source, count(*)::text AS runs FROM import_runs GROUP BY source`,
  );
  for (const row of runs) {
    console.log(`  ${row.source}: прогонов ${row.runs}`);
  }
  console.log(
    '  Повторный запуск загрузчиков не должен менять число компаний:\n' +
      '  npm run load:json && npm run load:csv && npm run report',
  );

  await getPool().end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
