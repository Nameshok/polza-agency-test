/**
 * Задача 1: загрузка постраничной выгрузки API (page_001.json … page_020.json) в Postgres.
 *
 * Что делает помимо самой вставки:
 *  - проверяет конверт страницы (page / per_page / total) и сходится ли арифметика;
 *  - находит дубли и пропуски id — у этой выгрузки они есть, см. ANOMALIES.md;
 *  - нормализует поля и складывает замечания по каждой строке в import_rows.
 *
 * Запуск: npm run load:json
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPool } from '../lib/db';
import { loadEnv, requireEnv } from './lib/env';
import { normalizeCompany, type RawCompany } from './lib/normalize';
import {
  countIssues,
  emptyStats,
  finishRun,
  recordRow,
  startRun,
  upsertCompany,
  type LoadStats,
} from './lib/store';

interface PageEnvelope {
  page?: unknown;
  per_page?: unknown;
  total?: unknown;
  items?: unknown;
}

const SOURCE = 'api_pages';

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DATABASE_URL');
  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? './data');

  const files = readdirSync(dataDir)
    .filter((name) => /^page_\d+\.json$/.test(name))
    .sort();

  if (files.length === 0) throw new Error(`В ${dataDir} нет файлов page_*.json`);

  // ── шаг 1: читаем всё в память и проверяем конверты ────────────────────────
  const pages: Array<{ file: string; page: number; perPage: number; total: number; items: RawCompany[] }> = [];
  const envelopeProblems: string[] = [];

  for (const file of files) {
    const parsed = JSON.parse(readFileSync(resolve(dataDir, file), 'utf8')) as PageEnvelope;
    if (!Array.isArray(parsed.items)) {
      envelopeProblems.push(`${file}: нет массива items`);
      continue;
    }
    const page = Number(parsed.page);
    const perPage = Number(parsed.per_page);
    const total = Number(parsed.total);
    if (!Number.isInteger(page)) envelopeProblems.push(`${file}: page = ${String(parsed.page)}`);
    if (parsed.items.length !== perPage) {
      envelopeProblems.push(`${file}: items = ${parsed.items.length}, per_page = ${perPage}`);
    }
    pages.push({ file, page, perPage, total, items: parsed.items as RawCompany[] });
  }

  const declaredTotals = new Set(pages.map((p) => p.total));
  if (declaredTotals.size > 1) {
    envelopeProblems.push(`разные total в страницах: ${[...declaredTotals].join(', ')}`);
  }
  const pageNumbers = pages.map((p) => p.page).sort((a, b) => a - b);
  for (let i = 0; i < pageNumbers.length; i += 1) {
    if (pageNumbers[i] !== i + 1) {
      envelopeProblems.push(`нарушена нумерация страниц около page = ${String(pageNumbers[i])}`);
      break;
    }
  }

  const declaredTotal = pages[0]?.total ?? 0;
  const collected = pages.reduce((sum, p) => sum + p.items.length, 0);

  // ── шаг 2: дубли и пропуски id ─────────────────────────────────────────────
  const idCounts = new Map<string, number>();
  for (const page of pages) {
    for (const item of page.items) {
      const id = typeof item.id === 'string' ? item.id : '';
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
  }
  const duplicatedIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
  const numericIds = [...idCounts.keys()]
    .map((id) => Number(id.replace(/\D/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  const maxId = Math.max(...numericIds);
  const present = new Set(numericIds);
  const missingIds: number[] = [];
  for (let n = 1; n <= maxId; n += 1) if (!present.has(n)) missingIds.push(n);

  console.log(`Файлов: ${pages.length}`);
  console.log(`Заявлено total: ${declaredTotal}, собрано записей: ${collected}`);
  console.log(`Уникальных id: ${idCounts.size}`);
  if (duplicatedIds.length) console.log(`Дублей id: ${duplicatedIds.length} → ${duplicatedIds.join(', ')}`);
  if (missingIds.length) console.log(`Пропущено id в диапазоне 1…${maxId}: ${missingIds.join(', ')}`);
  for (const problem of envelopeProblems) console.log(`Конверт: ${problem}`);

  // Города из API считаю доверенным справочником — по нему потом чиню CSV.
  const cityDictionary = [
    ...new Set(
      pages.flatMap((p) => p.items.map((i) => (typeof i.city === 'string' ? i.city.trim() : ''))),
    ),
  ].filter(Boolean);

  // ── шаг 3: запись ──────────────────────────────────────────────────────────
  const stats: LoadStats = emptyStats();
  stats.files = pages.length;
  const seen = new Set<string>();

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const runId = await startRun(client, SOURCE);

    for (const page of pages) {
      for (const [index, item] of page.items.entries()) {
        stats.rowsRead += 1;
        const sourceRow = index + 1;
        const { company, issues, rejected } = normalizeCompany(item, cityDictionary);
        countIssues(stats, issues);

        if (rejected || !company) {
          stats.rejected += 1;
          await recordRow(client, {
            runId,
            sourceFile: page.file,
            sourceRow,
            externalId: null,
            raw: item,
            status: 'rejected',
            issues,
          });
          continue;
        }

        // Тот же id второй раз внутри одной выгрузки — дубль пагинации, а не обновление.
        if (seen.has(company.externalId)) {
          stats.unchanged += 1;
          await recordRow(client, {
            runId,
            sourceFile: page.file,
            sourceRow,
            externalId: company.externalId,
            raw: item,
            status: 'duplicate',
            issues: [...issues, 'duplicate_id_in_source'],
          });
          continue;
        }
        seen.add(company.externalId);

        const result = await upsertCompany(client, company, {
          source: SOURCE,
          sourceFile: page.file,
          sourceRow,
        });
        if (result === 'inserted') stats.inserted += 1;
        else if (result === 'updated') stats.updated += 1;
        else stats.unchanged += 1;

        await recordRow(client, {
          runId,
          sourceFile: page.file,
          sourceRow,
          externalId: company.externalId,
          raw: item,
          status: result === 'unchanged' ? 'unchanged' : 'applied',
          issues,
        });
      }
    }

    await finishRun(client, runId, stats);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log('\nИтог загрузки JSON:');
  console.log(`  вставлено:      ${stats.inserted}`);
  console.log(`  обновлено:      ${stats.updated}`);
  console.log(`  без изменений:  ${stats.unchanged}`);
  console.log(`  отброшено:      ${stats.rejected}`);
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
