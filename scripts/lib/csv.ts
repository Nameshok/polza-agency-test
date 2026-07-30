/**
 * Разбор CSV по RFC 4180: кавычки, запятые внутри кавычек, "" как экранированная кавычка,
 * CRLF и LF. Внешний парсер тут не нужен, а свой заодно даёт то, чего у готовых обычно нет:
 * номер физической строки файла для каждой записи — он потом попадает в отчёт об аномалиях.
 *
 * Парсер намеренно строгий в двух местах, потому что «мягкий» разбор здесь опаснее ошибки:
 *  - файл, кончившийся внутри открытой кавычки;
 *  - мусор после закрывающей кавычки (`"ООО Ромашка"x`) — по RFC там допустимы только
 *    запятая или конец записи, а склеивание дало бы имя «ООО Ромашкаx», и такая компания
 *    молча уехала бы в базу.
 * Обе ситуации попадают в malformed с причиной, а не исправляются на глаз.
 */

export interface CsvRow {
  /** номер строки в файле, считая заголовок первой строкой */
  line: number;
  values: string[];
}

export interface MalformedRow {
  line: number;
  expected: number;
  actual: number;
  values: string[];
  /** почему строка не принята: пригодится в отчёте об аномалиях */
  reason: string;
}

export interface CsvFile {
  header: string[];
  rows: CsvRow[];
  malformed: MalformedRow[];
}

interface RawRecord {
  line: number;
  values: string[];
  /** нарушение синтаксиса внутри записи, а не просто неверное число колонок */
  reason?: string;
}

export function parseCsv(text: string): CsvFile {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: RawRecord[] = [];

  let field = '';
  let values: string[] = [];
  let inQuotes = false;
  let justClosedQuote = false;
  let recordReason: string | undefined;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const pushField = () => {
    values.push(field);
    field = '';
    justClosedQuote = false;
  };
  const pushRecord = () => {
    pushField();
    records.push({ line: recordStartLine, values, reason: recordReason });
    values = [];
    recordReason = undefined;
    recordStartLine = line + 1;
  };

  for (let i = 0; i < withoutBom.length; i += 1) {
    const char = withoutBom[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (withoutBom[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (char === ',') {
      pushField();
      sawAnyChar = true;
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      pushRecord();
      line += 1;
      sawAnyChar = false;
      continue;
    }

    // Обычный символ. Если он идёт сразу за закрывающей кавычкой — запись битая.
    if (justClosedQuote) {
      recordReason ??= 'junk_after_closing_quote';
      justClosedQuote = false;
    }
    field += char;
    sawAnyChar = true;
  }

  if (inQuotes) recordReason ??= 'unterminated_quote';
  if (sawAnyChar || field !== '' || values.length > 0 || recordReason) pushRecord();

  const first = records.shift();
  if (!first) return { header: [], rows: [], malformed: [] };

  const header = first.values.map((h) => h.trim());
  const rows: CsvRow[] = [];
  const malformed: MalformedRow[] = [];

  for (const record of records) {
    if (record.reason || record.values.length !== header.length) {
      malformed.push({
        line: record.line,
        expected: header.length,
        actual: record.values.length,
        values: record.values,
        reason:
          record.reason ?? `column_count_${record.values.length}_expected_${header.length}`,
      });
      continue;
    }
    rows.push(record);
  }

  return { header, rows, malformed };
}

/**
 * Значения намеренно НЕ подрезаются: хвостовой пробел в «Москва » — это дефект
 * выгрузки, и он должен дойти до нормализации, чтобы попасть в отчёт.
 */
export function toObject(header: string[], row: CsvRow): Record<string, string> {
  const result: Record<string, string> = {};
  header.forEach((key, index) => {
    result[key] = row.values[index] ?? '';
  });
  return result;
}

/** true, если в строке нет ни одного непустого поля (хвостовые «,,,,,,,,») */
export function isBlankRow(row: CsvRow): boolean {
  return row.values.every((value) => value.trim() === '');
}
