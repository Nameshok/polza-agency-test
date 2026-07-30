/**
 * Запись в базу: журнал прогонов, сырые строки, upsert компаний и поиск бизнес-дублей.
 *
 * Главное свойство — идемпотентность: второй запуск того же файла не создаёт новых
 * записей и не меняет значения, а честно отвечает «unchanged». Это первое, что я
 * проверяю после любой правки загрузчика.
 */

import type { PoolClient } from 'pg';
import type { Issue, NormalizedCompany } from './normalize';

export type RowStatus = 'applied' | 'unchanged' | 'duplicate' | 'quarantined' | 'rejected';

export interface LoadStats {
  files: number;
  rowsRead: number;
  inserted: number;
  updated: number;
  unchanged: number;
  quarantined: number;
  rejected: number;
  duplicateCandidates: number;
  issues: Record<string, number>;
}

export function emptyStats(): LoadStats {
  return {
    files: 0,
    rowsRead: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    quarantined: 0,
    rejected: 0,
    duplicateCandidates: 0,
    issues: {},
  };
}

export function countIssues(stats: LoadStats, issues: Issue[]): void {
  for (const issue of issues) {
    stats.issues[issue] = (stats.issues[issue] ?? 0) + 1;
  }
}

export async function startRun(client: PoolClient, source: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO import_runs (source) VALUES ($1) RETURNING id`,
    [source],
  );
  return Number(rows[0]!.id);
}

export async function finishRun(
  client: PoolClient,
  runId: number,
  stats: LoadStats,
): Promise<void> {
  await client.query(
    `UPDATE import_runs SET finished_at = clock_timestamp(), stats = $2::jsonb WHERE id = $1`,
    [runId, JSON.stringify(stats)],
  );
}

export async function recordRow(
  client: PoolClient,
  params: {
    runId: number;
    sourceFile: string;
    sourceRow: number;
    externalId: string | null;
    raw: unknown;
    status: RowStatus;
    issues: Issue[];
  },
): Promise<void> {
  await client.query(
    `INSERT INTO import_rows (run_id, source_file, source_row, external_id, raw, status, issues)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (source_file, source_row) DO UPDATE
       SET run_id = EXCLUDED.run_id,
           external_id = EXCLUDED.external_id,
           raw = EXCLUDED.raw,
           status = EXCLUDED.status,
           issues = EXCLUDED.issues`,
    [
      params.runId,
      params.sourceFile,
      params.sourceRow,
      params.externalId,
      JSON.stringify(params.raw),
      params.status,
      params.issues,
    ],
  );
}

const COMPARED_FIELDS = [
  'name',
  'name_key',
  'category',
  'city',
  'city_key',
  'address',
  'rating',
  'reviews_count',
  'site',
  'phone',
  'phone_e164',
] as const;

type StoredCompany = Record<(typeof COMPARED_FIELDS)[number], unknown>;

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

/**
 * Вставка или обновление компании по external_id — единственному надёжному ключу
 * (по названию склеивать нельзя: «Восток Групп» в разных городах — разные компании).
 *
 * Политика обновления: пустое значение в новых данных НЕ затирает непустое старое.
 * Свежая выгрузка часто беднее исходной — терять из-за неё телефон или сайт нельзя.
 */
export async function upsertCompany(
  client: PoolClient,
  company: NormalizedCompany,
  origin: { source: string; sourceFile: string; sourceRow: number },
): Promise<UpsertResult> {
  const existing = await client.query<StoredCompany>(
    `SELECT ${COMPARED_FIELDS.join(', ')} FROM companies WHERE external_id = $1`,
    [company.externalId],
  );

  if (existing.rowCount === 0) {
    await client.query(
      `INSERT INTO companies (
         external_id, name, name_key, category, city, city_key, address,
         rating, reviews_count, site, phone, phone_e164,
         source, source_file, source_row
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        company.externalId,
        company.name,
        company.nameKey,
        company.category,
        company.city,
        company.cityKey,
        company.address,
        company.rating,
        company.reviewsCount,
        company.site,
        company.phone,
        company.phoneE164,
        origin.source,
        origin.sourceFile,
        origin.sourceRow,
      ],
    );
    return 'inserted';
  }

  const current = existing.rows[0]!;
  const merged: StoredCompany = {
    name: company.name,
    name_key: company.nameKey,
    category: company.category ?? current.category,
    city: company.city ?? current.city,
    city_key: company.cityKey ?? current.city_key,
    address: company.address ?? current.address,
    rating: company.rating ?? current.rating,
    reviews_count: company.reviewsCount ?? current.reviews_count,
    site: company.site ?? current.site,
    phone: company.phone ?? current.phone,
    phone_e164: company.phoneE164 ?? current.phone_e164,
  };

  const changed = COMPARED_FIELDS.some((field) => !sameValue(current[field], merged[field]));
  if (!changed) return 'unchanged';

  await client.query(
    `UPDATE companies SET
       name = $2, name_key = $3, category = $4, city = $5, city_key = $6, address = $7,
       rating = $8, reviews_count = $9, site = $10, phone = $11, phone_e164 = $12,
       source_file = $13, source_row = $14, updated_at = now()
     WHERE external_id = $1`,
    [
      company.externalId,
      merged.name,
      merged.name_key,
      merged.category,
      merged.city,
      merged.city_key,
      merged.address,
      merged.rating,
      merged.reviews_count,
      merged.site,
      merged.phone,
      merged.phone_e164,
      origin.sourceFile,
      origin.sourceRow,
    ],
  );
  return 'updated';
}

/** numeric из Postgres приходит строкой — сравниваем по значению, а не по типу. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

export interface DuplicateHit {
  duplicateOf: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  details: Record<string, unknown>;
}

/**
 * Поиск «той же компании под другим id». Автоматически ничего не склеиваем —
 * пишем кандидатов в отдельную таблицу на ручную проверку.
 *
 * Признаки, по убыванию силы:
 *   1. совпал телефон И пара «город + адрес» — это одна и та же организация;
 *   2. совпал только телефон — возможен общий контакт-центр;
 *   3. совпали город+адрес и ключ названия — переоформление или опечатка в id.
 */
export async function findDuplicates(
  client: PoolClient,
  company: NormalizedCompany,
): Promise<DuplicateHit[]> {
  const { rows } = await client.query<{
    external_id: string;
    name: string;
    name_key: string;
    phone_e164: string | null;
    city_key: string | null;
    address: string | null;
  }>(
    `SELECT external_id, name, name_key, phone_e164, city_key, address
       FROM companies
      WHERE external_id <> $1
        AND (
          ($2::text IS NOT NULL AND phone_e164 = $2)
          OR ($3::text IS NOT NULL AND $4::text IS NOT NULL AND city_key = $3 AND address = $4)
        )`,
    [company.externalId, company.phoneE164, company.cityKey, company.address],
  );

  return rows.map((row) => {
    const samePhone = !!company.phoneE164 && row.phone_e164 === company.phoneE164;
    const samePlace =
      !!company.cityKey &&
      !!company.address &&
      row.city_key === company.cityKey &&
      row.address === company.address;
    const sameName = row.name_key === company.nameKey;

    let reason = samePhone ? 'phone' : 'city_address';
    let confidence: DuplicateHit['confidence'] = 'medium';
    if (samePhone && samePlace) {
      reason = 'phone+city_address';
      confidence = 'high';
    } else if (samePlace && sameName) {
      reason = 'city_address+name';
      confidence = 'high';
    } else if (samePlace) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    return {
      duplicateOf: row.external_id,
      reason,
      confidence,
      details: {
        new_name: company.name,
        existing_name: row.name,
        name_key_match: sameName,
        phone: company.phoneE164,
        city: company.cityKey,
        address: company.address,
      },
    };
  });
}

export async function saveDuplicate(
  client: PoolClient,
  externalId: string,
  hit: DuplicateHit,
): Promise<void> {
  await client.query(
    `INSERT INTO duplicate_candidates (external_id, duplicate_of, match_reason, confidence, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (external_id, duplicate_of, match_reason) DO UPDATE
       SET confidence = EXCLUDED.confidence, details = EXCLUDED.details`,
    [externalId, hit.duplicateOf, hit.reason, hit.confidence, JSON.stringify(hit.details)],
  );
}

export async function distinctCities(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ city_key: string }>(
    `SELECT DISTINCT city_key FROM companies WHERE city_key IS NOT NULL ORDER BY city_key`,
  );
  return rows.map((row) => row.city_key);
}
