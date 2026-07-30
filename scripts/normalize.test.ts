/**
 * Тесты нормализации — на реальных значениях из выгрузки, а не на выдуманных фикстурах.
 * У каждого кейса в комментарии номер строки review.csv, откуда он взят.
 *
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCsv } from './lib/csv';
import {
  canonicalCity,
  nameKey,
  normalizePhone,
  normalizeSite,
  parseRating,
  parseReviewsCount,
  repairMojibake,
} from './lib/normalize';

const CITIES = ['Москва', 'Санкт-Петербург', 'Екатеринбург', 'Сочи', 'Пермь'];

test('mojibake: чинит битые строки и не трогает нормальные', () => {
  // строка 113 CSV
  assert.equal(repairMojibake('РћРћРћ В«Р—Р°СЂСЏ РўРµС…В»').value, 'ООО «Заря Тех»');
  // строка 155 CSV
  assert.equal(repairMojibake('РњРѕСЃРєРІР°').value, 'Москва');
  assert.equal(repairMojibake('РћРћРћ В«Р—Р°СЂСЏ РўРµС…В»').repaired, true);

  // Живые названия с теми же буквами Р/С/В/Т трогать нельзя.
  for (const clean of [
    'ООО «Ростов Трейд»',
    'АО «Восток Сервис»',
    'ИП Виноградов С. П.',
    'Санкт-Петербург',
    'ООО «Вертикаль Тех»',
  ]) {
    assert.equal(repairMojibake(clean).value, clean, `испортил чистую строку: ${clean}`);
    assert.equal(repairMojibake(clean).repaired, false);
  }
});

test('рейтинг: запятая, N/A и выход за шкалу', () => {
  assert.deepEqual(parseRating(4.1), { value: 4.1, issues: [] });
  // строка 14 CSV
  assert.equal(parseRating('4,5').value, 4.5);
  assert.ok(parseRating('4,5').issues.includes('rating_decimal_comma'));
  // строка 9 CSV
  assert.equal(parseRating('N/A').value, null);
  // строка 197 CSV — не подтягиваем к 5.0
  assert.equal(parseRating('7.2').value, null);
  assert.ok(parseRating('7.2').issues.includes('rating_out_of_range'));
  // строка 96 CSV
  assert.equal(parseRating('-3').value, null);
  // пустое — это просто «неизвестно», без замечания
  assert.deepEqual(parseRating(''), { value: null, issues: [] });
});

test('число отзывов: неизвестное — NULL, а не 0', () => {
  assert.deepEqual(parseReviewsCount(191), { value: 191, issues: [] });
  assert.equal(parseReviewsCount(0).value, 0); // ноль как настоящее значение остаётся нулём
  // строка 200 CSV
  assert.equal(parseReviewsCount('много').value, null);
  // строка 61 CSV
  assert.equal(parseReviewsCount('-10').value, null);
  assert.ok(parseReviewsCount('-10').issues.includes('reviews_negative'));
  // строка 98 CSV
  assert.equal(parseReviewsCount('45.5').value, 46);
  assert.equal(parseReviewsCount('').value, null);
});

test('город: регистр, транслит, опечатка, пробел и адрес в поле города', () => {
  assert.equal(canonicalCity('Москва', CITIES).cityKey, 'Москва');
  assert.equal(canonicalCity('москва', CITIES).cityKey, 'Москва'); // строка 166
  assert.equal(canonicalCity('Moscow', CITIES).cityKey, 'Москва'); // строка 127
  assert.equal(canonicalCity('Москва ', CITIES).cityKey, 'Москва'); // строка 148
  assert.ok(canonicalCity('Москва ', CITIES).issues.includes('city_whitespace'));
  // строка 22 — опечатка в одну букву
  assert.equal(canonicalCity('Санкат-Петербург', CITIES).cityKey, 'Санкт-Петербург');

  // строка 37 — съехавшие колонки: адрес попал в город. Угадывать нельзя.
  const shifted = canonicalCity('ул. Советская, д. 89, офис 43', CITIES);
  assert.equal(shifted.cityKey, null);
  assert.ok(shifted.issues.includes('city_looks_like_address'));

  // Незнакомый город не превращается в похожий.
  const unknown = canonicalCity('Улан-Удэ', CITIES);
  assert.equal(unknown.cityKey, null);
  assert.ok(unknown.issues.includes('city_unknown'));
});

test('сайт: «нет сайта» это NULL, опечатка схемы лечится', () => {
  assert.equal(normalizeSite('https://sfera-group-229.ru').value, 'https://sfera-group-229.ru');
  // строка 130
  assert.equal(normalizeSite('нет сайта').value, null);
  // строка 141
  assert.equal(normalizeSite('htp://sintez-service-453.ru').value, 'http://sintez-service-453.ru');
  assert.ok(normalizeSite('htp://sintez-service-453.ru').issues.includes('site_scheme_typo'));
  assert.equal(normalizeSite('').value, null);
});

test('телефон: E.164 только из настоящих 11 цифр', () => {
  assert.equal(normalizePhone('+7 (495) 248-44-40').e164, '+74952484440');
  assert.equal(normalizePhone('8 (925) 706-60-19').e164, '+79257066019');
  // строка 28 — буквы вместо цифр
  assert.equal(normalizePhone('8 (925) abc-12-34').e164, null);
  assert.ok(normalizePhone('8 (925) abc-12-34').issues.includes('phone_contains_letters'));
  // строка 199 — обрубок
  assert.equal(normalizePhone('+7').e164, null);
  // исходное значение всегда сохраняется
  assert.equal(normalizePhone('+7').phone, '+7');
});

test('ключ названия: кавычки и правовая форма не влияют на сравнение', () => {
  // именно на этом ловятся дубли c_900006…c_900011
  assert.equal(nameKey('АО «Флагман Лаб»'), nameKey('АО Флагман Лаб'));
  assert.equal(nameKey('«Прайм Плюс»'), nameKey('Прайм Плюс'));
  assert.equal(nameKey('ООО «Восток Групп»'), 'восток групп');
  // разные компании остаются разными
  assert.notEqual(nameKey('АО «Сокол»'), nameKey('АО «Сокол Лаб»'));
});

test('CSV: кавычки, CRLF, пустые строки, битая кавычка в конце', () => {
  const ok = parseCsv('id,name,city\r\nc_1,"ООО «А, Б»",Москва\r\nc_2,Б,Сочи\r\n');
  assert.deepEqual(ok.header, ['id', 'name', 'city']);
  assert.equal(ok.rows.length, 2);
  assert.deepEqual(ok.rows[0]!.values, ['c_1', 'ООО «А, Б»', 'Москва']);
  assert.equal(ok.rows[0]!.line, 2, 'номер строки файла нужен для отчёта об аномалиях');

  const withBlank = parseCsv('id,name\r\nc_1,А\r\n,\r\n');
  assert.equal(withBlank.rows.length, 2);
  assert.equal(withBlank.rows[1]!.values.every((v) => v === ''), true);

  const shortRow = parseCsv('id,name,city\r\nc_1,А\r\n');
  assert.equal(shortRow.rows.length, 0);
  assert.equal(shortRow.malformed.length, 1);

  const unterminated = parseCsv('id,name\r\nc_1,"незакрытая кавычка');
  assert.equal(unterminated.rows.length, 0);
  assert.equal(unterminated.malformed.length, 1, 'файл кончился внутри кавычки');
});
