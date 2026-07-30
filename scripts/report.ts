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

  // Каждое число, названное в ANOMALIES.md, должно пересчитываться командой, а не
  // приниматься на веру. Иначе документ — это утверждения о работе, а не сама работа.
  section('Сверка чисел из ANOMALIES.md');
  console.table(
    await query(`
      SELECT 'компаний всего' AS показатель, count(*)::text AS значение, '1183' AS в_документе FROM companies
UNION ALL SELECT 'с сайтом', count(*)::text, '890' FROM companies WHERE site IS NOT NULL
UNION ALL SELECT 'без сайта', count(*)::text, '293' FROM companies WHERE site IS NULL
UNION ALL SELECT 'сайтов через https', count(*)::text, '748' FROM companies WHERE site LIKE 'https://%'
UNION ALL SELECT 'сайтов через http', count(*)::text, '142' FROM companies WHERE site LIKE 'http://%'
UNION ALL SELECT 'разных улиц', count(DISTINCT split_part(address, ', д.', 1))::text, '18'
       FROM companies WHERE address IS NOT NULL
UNION ALL SELECT 'макс. номер дома', max((regexp_match(address, 'д\\. (\\d+)'))[1]::int)::text, '120'
       FROM companies WHERE address ~ 'д\\. \\d+'
UNION ALL SELECT 'адресов с офисом', count(*)::text, '420' FROM companies WHERE address LIKE '%офис%'
UNION ALL SELECT 'отзывы есть, рейтинга нет', count(*)::text, '81'
       FROM companies WHERE rating IS NULL AND reviews_count > 0
UNION ALL SELECT 'рейтинг есть, отзывов ноль', count(*)::text, '7'
       FROM companies WHERE rating IS NOT NULL AND reviews_count = 0
UNION ALL SELECT 'рейтинг неизвестен всего', count(*)::text, '100' FROM companies WHERE rating IS NULL
UNION ALL SELECT '  из них пришли из API', count(*)::text, '79'
       FROM companies WHERE rating IS NULL AND external_id < 'c_001001'
UNION ALL SELECT '  из них новые из CSV', count(*)::text, '21'
       FROM companies WHERE rating IS NULL AND external_id >= 'c_001001'
UNION ALL SELECT 'кандидатов email', count(*)::text, '2670' FROM email_candidates
UNION ALL SELECT 'из них valid', count(*)::text, '0' FROM email_candidates WHERE status = 'valid'
UNION ALL SELECT 'из них unknown', count(*)::text, '9' FROM email_candidates WHERE status = 'unknown'
UNION ALL SELECT 'отвергнуто на этапе MX', count(*)::text, '2661'
       FROM email_candidates WHERE stage_failed = 'mx'
UNION ALL SELECT 'доменов не существует', count(DISTINCT domain)::text, '877'
       FROM email_candidates WHERE 'domain_does_not_exist' = ANY(issues)
UNION ALL SELECT 'компаний на мёртвых доменах', count(DISTINCT external_id)::text, '884'
       FROM email_candidates WHERE 'domain_does_not_exist' = ANY(issues)
    `),
  );

  section('Один домен у нескольких компаний — сколько именно');
  console.table(
    await query(`
      WITH d AS (SELECT lower(regexp_replace(regexp_replace(site, '^https?://', ''), '^www\\.', '')) AS dom
                   FROM companies WHERE site IS NOT NULL),
           s AS (SELECT dom, count(*) AS n FROM d GROUP BY dom HAVING count(*) > 1)
      SELECT count(*)::text AS доменов_повторно, sum(n)::text AS компаний_на_них,
             (sum(n) - count(*))::text AS лишних_записей FROM s`),
  );

  section('Коды телефонов против городов');
  console.table(
    await query(`
      WITH t AS (
        SELECT city_key, substring(phone_e164 from 3 for 3) AS code
          FROM companies WHERE phone_e164 IS NOT NULL AND city_key IS NOT NULL),
      m (code, city) AS (VALUES
        ('495','Москва'),('499','Москва'),('812','Санкт-Петербург'),('843','Казань'),
        ('831','Нижний Новгород'),('383','Новосибирск'),('863','Ростов-на-Дону'),
        ('846','Самара'),('351','Челябинск'),('861','Краснодар'),('343','Екатеринбург'),
        ('473','Воронеж'),('342','Пермь'),('347','Уфа'),('381','Омск'),('345','Тюмень'),
        ('844','Волгоград'),('862','Сочи'),('484','Калуга'),('487','Тула'),('485','Ярославль'))
      SELECT count(*) FILTER (WHERE t.code LIKE '9%')::text                       AS мобильных,
             count(*) FILTER (WHERE t.code NOT LIKE '9%')::text                   AS городских,
             count(*) FILTER (WHERE m.city = t.city_key)::text                    AS код_совпал,
             count(*) FILTER (WHERE t.code NOT LIKE '9%' AND m.city IS DISTINCT FROM t.city_key)::text
                                                                                  AS код_не_совпал,
             count(DISTINCT t.code) FILTER (WHERE t.code NOT LIKE '9%')::text     AS разных_кодов
        FROM t LEFT JOIN m ON m.code = t.code`),
  );

  await getPool().end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
