/**
 * Нормализация и валидация полей компании.
 *
 * Правила, которых придерживаюсь везде:
 *  - пустая строка и «N/A» — это NULL, а не значение;
 *  - неизвестный рейтинг остаётся NULL и никогда не превращается в 0
 *    (иначе средний рейтинг по городу поедет вниз);
 *  - исходное значение не выбрасывается: рядом с нормализованным всегда
 *    остаётся то, что пришло, и список замечаний.
 */

import iconv from 'iconv-lite';

export type Issue = string;

export interface NormalizedCompany {
  externalId: string;
  name: string;
  nameKey: string;
  category: string | null;
  city: string | null;
  cityKey: string | null;
  address: string | null;
  rating: number | null;
  reviewsCount: number | null;
  site: string | null;
  phone: string | null;
  phoneE164: string | null;
}

export interface NormalizeResult {
  company: NormalizedCompany | null;
  issues: Issue[];
  /** true — строку нельзя пускать в companies даже с оговорками */
  rejected: boolean;
}

/* ─────────────────────────── строки и кодировка ─────────────────────────── */

const EMPTY_MARKERS = new Set(['', '-', '—', 'n/a', 'na', 'null', 'нет', 'нет данных']);

export function cleanString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (EMPTY_MARKERS.has(s.toLowerCase())) return null;
  return s;
}

/**
 * Ремонт mojibake: UTF-8, прочитанный как windows-1251.
 * Выглядит так: «РћРћРћ В«Р—Р°СЂСЏ РўРµС…В»» вместо «ООО «Заря Тех»».
 * Лечится обратной операцией — закодировать обратно в cp1251 и прочитать как UTF-8.
 * Ремонт применяю только если результат стал «чище» исходника, иначе возвращаю как было.
 */
export function repairMojibake(input: string): { value: string; repaired: boolean } {
  if (suspicionScore(input) === 0) return { value: input, repaired: false };
  try {
    const bytes = iconv.encode(input, 'win1251');
    // Если в строке был символ, которого нет в cp1251, iconv подставит '?' —
    // значит это не mojibake, и трогать строку нельзя.
    if (iconv.decode(bytes, 'win1251') !== input) return { value: input, repaired: false };

    const decoded = iconv.decode(bytes, 'utf8');
    if (decoded.includes('\uFFFD')) return { value: input, repaired: false };
    const looksCyrillic = /[а-яёА-ЯЁ]/.test(decoded);
    if (looksCyrillic && suspicionScore(decoded) < suspicionScore(input)) {
      return { value: decoded, repaired: true };
    }
  } catch {
    /* не смогли — оставляем как пришло */
  }
  return { value: input, repaired: false };
}

/**
 * Подпись mojibake: заглавная Р/С/В/Т, за которой без пробела идёт символ из верхней
 * половины cp1251. Такие пары в живом русском тексте не встречаются — это первый байт
 * UTF-8-последовательности, прочитанный как отдельная буква.
 */
const MOJIBAKE_LEAD = new Set(['Р', 'С', 'В', 'Т']);

function isMojibakeTail(code: number): boolean {
  return (
    (code >= 0x0098 && code <= 0x00bf) || // ‹управляющие›, ¤, «, », µ, · и прочая верхняя половина
    (code >= 0x0402 && code <= 0x040f) || // Ђ … Џ
    (code >= 0x0452 && code <= 0x045f) || // ђ … џ
    (code >= 0x2013 && code <= 0x2122)    // –, —, ‚, „, …, ‹, ›, €, ™
  );
}

function suspicionScore(value: string): number {
  let hits = 0;
  for (let i = 0; i + 1 < value.length; i += 1) {
    if (MOJIBAKE_LEAD.has(value[i]!) && isMojibakeTail(value.charCodeAt(i + 1))) hits += 1;
  }
  return hits;
}

/* ─────────────────────────────── название ──────────────────────────────── */

// Границу слова тут нельзя писать как \b: в JS без флага /u \b считается по [A-Za-z0-9_],
// и между «ооо» и пробелом её нет — форма не срезалась вообще. Нашлось тестом.
const LEGAL_FORMS = /^(ооо|оао|зао|пао|нао|ао|ип)(?![а-яё])\.?\s*/i;

/**
 * Ключ названия — только для поиска дублей, в companies.name он не пишется.
 * Снимает кавычки любого вида и организационно-правовую форму:
 *   «АО «Флагман Лаб»» и «АО Флагман Лаб» → «флагман лаб».
 */
export function nameKey(name: string): string {
  let s = name.toLowerCase().replace(/[«»"'“”„]/g, ' ');
  s = s.replace(LEGAL_FORMS, '');
  return s.replace(/\s+/g, ' ').trim();
}

/* ──────────────────────────────── город ────────────────────────────────── */

const CITY_ALIASES: Record<string, string> = {
  moscow: 'Москва',
  msk: 'Москва',
  'saint petersburg': 'Санкт-Петербург',
  'st petersburg': 'Санкт-Петербург',
  spb: 'Санкт-Петербург',
  питер: 'Санкт-Петербург',
  'нижний новгород': 'Нижний Новгород',
  'ростов-на-дону': 'Ростов-на-Дону',
};

/**
 * Приводит город к каноническому написанию из справочника.
 * Справочник не захардкожен — он собирается из основной выгрузки API
 * (она считается доверенным источником) и передаётся сюда.
 *
 * Порядок: точное совпадение → алиас/транслит → опечатка на 1-2 правки.
 * Если ничего не подошло, возвращает null и замечание — молча выдумывать город нельзя.
 */
export function canonicalCity(
  raw: string | null,
  dictionary: string[],
): { city: string | null; cityKey: string | null; issues: Issue[] } {
  if (!raw) return { city: null, cityKey: null, issues: ['city_missing'] };

  const issues: Issue[] = [];
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value !== raw) issues.push('city_whitespace');

  const exact = dictionary.find((c) => c === value);
  if (exact) return { city: value, cityKey: exact, issues };

  const lower = value.toLowerCase();

  const caseOnly = dictionary.find((c) => c.toLowerCase() === lower);
  if (caseOnly) {
    issues.push('city_case_mismatch');
    return { city: value, cityKey: caseOnly, issues };
  }

  const alias = CITY_ALIASES[lower];
  if (alias) {
    issues.push('city_alias_or_translit');
    return { city: value, cityKey: alias, issues };
  }

  // Адрес, попавший в поле города — признак сдвига колонок, а не опечатки.
  if (/^(ул|пр|просп|пер|ш|наб|б-р|д)\.?\s/i.test(value) || /,\s*д\.\s*\d/i.test(value)) {
    issues.push('city_looks_like_address');
    return { city: null, cityKey: null, issues };
  }

  const near = closestByEditDistance(lower, dictionary);
  if (near) {
    issues.push('city_typo_fixed');
    return { city: value, cityKey: near, issues };
  }

  issues.push('city_unknown');
  return { city: value, cityKey: null, issues };
}

function closestByEditDistance(value: string, dictionary: string[]): string | null {
  const maxDistance = value.length <= 6 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of dictionary) {
    const distance = levenshtein(value, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= maxDistance ? best : null;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/* ─────────────────────────── рейтинг и отзывы ──────────────────────────── */

export function parseRating(raw: unknown): { value: number | null; issues: Issue[] } {
  if (raw === null || raw === undefined || raw === '') return { value: null, issues: [] };

  if (typeof raw === 'number') return checkRatingRange(raw, []);

  const text = String(raw).trim();
  if (EMPTY_MARKERS.has(text.toLowerCase())) return { value: null, issues: ['rating_not_a_number'] };

  const issues: Issue[] = [];
  let normalized = text;
  if (normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
    issues.push('rating_decimal_comma');
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    issues.push('rating_not_a_number');
    return { value: null, issues };
  }
  return checkRatingRange(parsed, issues);
}

function checkRatingRange(value: number, issues: Issue[]): { value: number | null; issues: Issue[] } {
  if (value < 0 || value > 5) {
    // За пределами шкалы 0-5 значение бессмысленно: пишем NULL, а не «подтягиваем» к границе.
    return { value: null, issues: [...issues, 'rating_out_of_range'] };
  }
  return { value: Math.round(value * 10) / 10, issues };
}

/**
 * Число отзывов. Неизвестное или бессмысленное значение — это NULL, а не 0,
 * по той же причине, что и у рейтинга: ноль означает «отзывов нет», а это
 * утверждение, которого у нас нет. Плюс при обновлении такой NULL не затрёт
 * корректный счётчик, уже лежащий в базе.
 */
export function parseReviewsCount(raw: unknown): { value: number | null; issues: Issue[] } {
  if (raw === null || raw === undefined || raw === '') {
    return { value: null, issues: ['reviews_missing'] };
  }
  // Порядок проверок важен: отрицательное отсекаем ДО округления. Иначе «-10.5»
  // округлилось бы в -10 и ушло в базу отрицательным числом — а там стоит
  // CHECK (reviews_count >= 0), и весь прогон загрузки упал бы на этой строке.
  // В данных задания такого значения нет, но порядок был неверным.
  if (typeof raw === 'number') {
    if (raw < 0) return { value: null, issues: ['reviews_negative'] };
    if (!Number.isInteger(raw)) return { value: Math.round(raw), issues: ['reviews_not_integer'] };
    return { value: raw, issues: [] };
  }
  const text = String(raw).trim();
  if (!/^-?\d+(?:[.,]\d+)?$/.test(text)) return { value: null, issues: ['reviews_not_a_number'] };
  const parsed = Number(text.replace(',', '.'));
  if (parsed < 0) return { value: null, issues: ['reviews_negative'] };
  if (!Number.isInteger(parsed)) return { value: Math.round(parsed), issues: ['reviews_not_integer'] };
  return { value: parsed, issues: [] };
}

/* ──────────────────────────── сайт и телефон ───────────────────────────── */

export function normalizeSite(raw: unknown): { value: string | null; issues: Issue[] } {
  const text = cleanString(raw);
  if (!text) return { value: null, issues: [] };

  // «нет сайта» в поле URL — это отсутствие сайта, а не сайт с таким названием.
  if (!/[.:]/.test(text) || /^нет\b/i.test(text)) {
    return { value: null, issues: ['site_not_a_url'] };
  }

  const issues: Issue[] = [];
  let value = text;
  const schemeTypo = value.match(/^(h?ttp?s?|htp|htps|htt)(:\/{0,2})/i);
  if (schemeTypo && !/^https?:\/\//i.test(value)) {
    value = value.replace(/^[^:]*:\/{0,2}/, 'http://');
    issues.push('site_scheme_typo');
  } else if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
    issues.push('site_scheme_missing');
  }

  try {
    const url = new URL(value);
    if (!url.hostname.includes('.')) return { value: null, issues: [...issues, 'site_not_a_url'] };
    return { value: url.toString().replace(/\/$/, ''), issues };
  } catch {
    return { value: null, issues: [...issues, 'site_not_a_url'] };
  }
}

/** Телефон в E.164: +7XXXXXXXXXX. Всё, что не сводится к 11 цифрам, — замечание. */
export function normalizePhone(raw: unknown): {
  phone: string | null;
  e164: string | null;
  issues: Issue[];
} {
  const text = cleanString(raw);
  if (!text) return { phone: null, e164: null, issues: [] };

  if (/[a-zа-яё]/i.test(text)) {
    return { phone: text, e164: null, issues: ['phone_contains_letters'] };
  }

  const digits = text.replace(/\D/g, '');
  if (digits.length < 11) return { phone: text, e164: null, issues: ['phone_too_short'] };
  if (digits.length > 11) return { phone: text, e164: null, issues: ['phone_too_long'] };

  const national = digits.replace(/^[78]/, '');
  if (national.length !== 10) return { phone: text, e164: null, issues: ['phone_unexpected_format'] };
  return { phone: text, e164: `+7${national}`, issues: [] };
}

/* ───────────────────────── сборка целой записи ─────────────────────────── */

export interface RawCompany {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  city?: unknown;
  address?: unknown;
  rating?: unknown;
  reviews_count?: unknown;
  site?: unknown;
  phone?: unknown;
}

const EXTERNAL_ID_RE = /^c_\d{6}$/;

export function normalizeCompany(raw: RawCompany, cityDictionary: string[]): NormalizeResult {
  const issues: Issue[] = [];

  const externalId = cleanString(raw.id);
  if (!externalId) return { company: null, issues: ['id_missing'], rejected: true };
  if (!EXTERNAL_ID_RE.test(externalId)) issues.push('id_unexpected_format');

  const nameRaw = cleanString(raw.name);
  if (!nameRaw) return { company: null, issues: [...issues, 'name_missing'], rejected: true };
  const nameFixed = repairMojibake(nameRaw);
  if (nameFixed.repaired) issues.push('name_mojibake_repaired');

  const categoryRaw = cleanString(raw.category);
  const category = categoryRaw ? repairMojibake(categoryRaw).value : null;
  if (!category) issues.push('category_missing');

  // cleanString уже подрезал пробелы — но сам факт «в источнике был хвостовой пробел»
  // это тоже дефект выгрузки, и он должен попасть в отчёт.
  for (const [field, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value !== value.trim()) issues.push(`${field}_whitespace`);
  }

  const cityRaw = cleanString(raw.city);
  const cityFixed = cityRaw ? repairMojibake(cityRaw) : { value: null, repaired: false };
  if (cityFixed.repaired) issues.push('city_mojibake_repaired');
  const city = canonicalCity(cityFixed.value, cityDictionary);
  issues.push(...city.issues);

  const addressRaw = cleanString(raw.address);
  const address = addressRaw ? repairMojibake(addressRaw).value : null;
  if (!address) issues.push('address_missing');

  const rating = parseRating(raw.rating);
  issues.push(...rating.issues);

  const reviews = parseReviewsCount(raw.reviews_count);
  issues.push(...reviews.issues);

  const site = normalizeSite(raw.site);
  issues.push(...site.issues);

  const phone = normalizePhone(raw.phone);
  issues.push(...phone.issues);

  if (rating.value === null && (reviews.value ?? 0) > 0) issues.push('rating_missing_with_reviews');
  if (rating.value !== null && reviews.value === 0) issues.push('rating_without_reviews');

  return {
    company: {
      externalId,
      name: nameFixed.value,
      nameKey: nameKey(nameFixed.value),
      category,
      city: city.city,
      cityKey: city.cityKey,
      address,
      rating: rating.value,
      reviewsCount: reviews.value,
      site: site.value,
      phone: phone.phone,
      phoneE164: phone.e164,
    },
    issues,
    rejected: false,
  };
}
