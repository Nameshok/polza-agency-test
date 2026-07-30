/**
 * Задача 3: загрузка review.csv — «якобы свежей выгрузки для той же базы».
 *
 * Файл оказался грязным (полный разбор — в ANOMALIES.md), поэтому загрузчик построен так,
 * чтобы не испортить уже загруженное:
 *
 *  - CSV — дельта, а не замена: ничего не удаляем, компании вне файла не трогаем;
 *  - каждая строка попадает в import_rows с номером строки файла и списком замечаний;
 *  - пустое значение из CSV не затирает непустое старое (см. upsertCompany);
 *  - строки с id из чужого диапазона (c_9xxxxx) и явные дубли существующих компаний
 *    в companies НЕ попадают: статус quarantined плюс запись в duplicate_candidates;
 *  - справочник городов берётся из уже загруженных данных API, а не выдумывается.
 *
 * Запуск: npm run load:csv
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPool } from '../lib/db';
import { isBlankRow, parseCsv, toObject } from './lib/csv';
import { loadEnv, requireEnv } from './lib/env';
import { normalizeCompany } from './lib/normalize';
import {
  countIssues,
  distinctCities,
  emptyStats,
  findDuplicates,
  finishRun,
  recordRow,
  saveDuplicate,
  startRun,
  upsertCompany,
  type LoadStats,
} from './lib/store';

const SOURCE = 'review_csv';
const FILE = 'review.csv';

/** id основной выгрузки — c_000001…c_001000, свежие — c_001001…c_001200. */
const FOREIGN_ID_RANGE = /^c_9\d{5}$/;

/**
 * Замечания, после которых строку нельзя считать данными о компании: это не «грязное
 * значение», а поехавшая структура строки. Такие в companies не пускаем.
 */
const STRUCTURAL_ISSUES = new Set(['city_looks_like_address']);

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DATABASE_URL');
  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? './data');

  const text = readFileSync(resolve(dataDir, FILE), 'utf8');
  const csv = parseCsv(text);
  console.log(`Колонки: ${csv.header.join(', ')}`);
  console.log(`Строк данных: ${csv.rows.length}, кривых по числу колонок: ${csv.malformed.length}`);

  const stats: LoadStats = emptyStats();
  stats.files = 1;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const runId = await startRun(client, SOURCE);
    const cityDictionary = await distinctCities(client);
    if (cityDictionary.length === 0) {
      throw new Error('В companies нет данных. Сначала выполните npm run load:json.');
    }

    for (const bad of csv.malformed) {
      stats.rowsRead += 1;
      stats.rejected += 1;
      await recordRow(client, {
        runId,
        sourceFile: FILE,
        sourceRow: bad.line,
        externalId: null,
        raw: { values: bad.values },
        status: 'rejected',
        issues: [bad.reason],
      });
    }

    const seen = new Map<string, number>();

    for (const row of csv.rows) {
      stats.rowsRead += 1;
      const raw = toObject(csv.header, row);

      if (isBlankRow(row)) {
        stats.rejected += 1;
        countIssues(stats, ['blank_row']);
        await recordRow(client, {
          runId,
          sourceFile: FILE,
          sourceRow: row.line,
          externalId: null,
          raw,
          status: 'rejected',
          issues: ['blank_row'],
        });
        continue;
      }

      const { company, issues, rejected } = normalizeCompany(raw, cityDictionary);
      countIssues(stats, issues);

      if (rejected || !company) {
        stats.rejected += 1;
        await recordRow(client, {
          runId,
          sourceFile: FILE,
          sourceRow: row.line,
          externalId: null,
          raw,
          status: 'rejected',
          issues,
        });
        continue;
      }

      // Дубль строки внутри самого CSV.
      const firstSeenAt = seen.get(company.externalId);
      if (firstSeenAt !== undefined) {
        stats.unchanged += 1;
        await recordRow(client, {
          runId,
          sourceFile: FILE,
          sourceRow: row.line,
          externalId: company.externalId,
          raw,
          status: 'duplicate',
          issues: [...issues, `duplicate_of_line_${firstSeenAt}`],
        });
        continue;
      }
      seen.set(company.externalId, row.line);

      // Кандидаты в бизнес-дубли ищем ДО вставки, иначе запись найдёт саму себя.
      const hits = await findDuplicates(client, company);
      for (const hit of hits) {
        await saveDuplicate(client, company.externalId, hit);
        stats.duplicateCandidates += 1;
      }
      const strongDuplicate = hits.some((hit) => hit.confidence === 'high');
      const foreignId = FOREIGN_ID_RANGE.test(company.externalId);
      const structurallyBroken = issues.some((issue) => STRUCTURAL_ISSUES.has(issue));

      if (foreignId || strongDuplicate || structurallyBroken) {
        stats.quarantined += 1;
        const reasons: string[] = [...issues];
        if (foreignId) reasons.push('id_outside_known_range');
        if (structurallyBroken) reasons.push('broken_row_structure');
        if (strongDuplicate) {
          reasons.push(`duplicate_of_${hits.find((h) => h.confidence === 'high')!.duplicateOf}`);
        }
        countIssues(stats, reasons.slice(issues.length));
        await recordRow(client, {
          runId,
          sourceFile: FILE,
          sourceRow: row.line,
          externalId: company.externalId,
          raw,
          status: 'quarantined',
          issues: reasons,
        });
        continue;
      }

      const result = await upsertCompany(client, company, {
        source: SOURCE,
        sourceFile: FILE,
        sourceRow: row.line,
      });
      if (result === 'inserted') stats.inserted += 1;
      else if (result === 'updated') stats.updated += 1;
      else stats.unchanged += 1;

      await recordRow(client, {
        runId,
        sourceFile: FILE,
        sourceRow: row.line,
        externalId: company.externalId,
        raw,
        status: result === 'unchanged' ? 'unchanged' : 'applied',
        issues,
      });
    }

    await finishRun(client, runId, stats);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log('\nИтог загрузки review.csv:');
  console.log(`  прочитано строк:      ${stats.rowsRead}`);
  console.log(`  вставлено:            ${stats.inserted}`);
  console.log(`  обновлено:            ${stats.updated}`);
  console.log(`  без изменений:        ${stats.unchanged}`);
  console.log(`  в карантине:          ${stats.quarantined}`);
  console.log(`  отброшено:            ${stats.rejected}`);
  console.log(`  кандидатов в дубли:   ${stats.duplicateCandidates}`);
  const issues = Object.entries(stats.issues).sort((a, b) => b[1] - a[1]);
  if (issues.length) {
    console.log('  замечания по полям:');
    for (const [issue, count] of issues) console.log(`    ${issue}: ${count}`);
  }

  await getPool().end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
