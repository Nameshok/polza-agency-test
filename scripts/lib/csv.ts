/**
 * Разбор CSV по RFC 4180: кавычки, запятые внутри кавычек, "" как экранированная кавычка,
 * CRLF и LF. Внешний парсер тут не нужен, а свой заодно даёт то, чего у готовых обычно нет:
 * номер физической строки файла для каждой записи — он потом попадает в отчёт об аномалиях.
 */

export interface CsvRow {
  /** номер строки в файле, считая заголовок первой строкой */
  line: number;
  values: string[];
}

export interface CsvFile {
  header: string[];
  rows: CsvRow[];
  /** строки, где число колонок не совпало с заголовком */
  malformed: Array<{ line: number; expected: number; actual: number; values: string[] }>;
}

export function parseCsv(text: string): CsvFile {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: Array<{ line: number; values: string[] }> = [];

  let field = '';
  let values: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const pushField = () => {
    values.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    records.push({ line: recordStartLine, values });
    values = [];
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
    field += char;
    sawAnyChar = true;
  }

  // последняя строка без завершающего перевода строки
  const unterminatedQuote = inQuotes;
  if (sawAnyChar || field !== '' || values.length > 0) pushRecord();

  const first = records.shift();
  if (!first) return { header: [], rows: [], malformed: [] };

  const header = first.values.map((h) => h.trim());
  const rows: CsvRow[] = [];
  const malformed: CsvFile['malformed'] = [];

  // Файл кончился внутри открытой кавычки: последняя запись собрана из остатка файла
  // и данными считаться не может. Молча принять её — значит загрузить мусор как компанию.
  if (unterminatedQuote) {
    const broken = records.pop();
    if (broken) {
      malformed.push({
        line: broken.line,
        expected: header.length,
        actual: broken.values.length,
        values: broken.values,
      });
    }
  }

  for (const record of records) {
    if (record.values.length !== header.length) {
      malformed.push({
        line: record.line,
        expected: header.length,
        actual: record.values.length,
        values: record.values,
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
