/**
 * Тесты валидации email. Значения не выдуманные: домены взяты из выгрузки задания,
 * а проверяемые случаи — те, на которых пайплайн ошибался бы молча.
 *
 * Запуск: npm test
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkOffline,
  checkSyntax,
  deriveCandidates,
  domainFromSite,
  finalStatus,
  fixDomainTypo,
  interpretSmtp,
  isDisposable,
  isRoleAccount,
} from './lib/email';

test('домен из сайта: схема, www, путь, порт и регистр отбрасываются', () => {
  assert.equal(domainFromSite('https://modul-plus-452.ru'), 'modul-plus-452.ru');
  assert.equal(domainFromSite('http://www.Nord-Trade-364.RU/kontakty'), 'nord-trade-364.ru');
  assert.equal(domainFromSite('https://ip-73.ru:8080/?utm=1'), 'ip-73.ru');
  // Опечатка схемы уже вылечена загрузчиком, но домен всё равно должен разобраться.
  assert.equal(domainFromSite('http://sintez-service-453.ru'), 'sintez-service-453.ru');
  // Не домены.
  assert.equal(domainFromSite('нет сайта'), null);
  assert.equal(domainFromSite('https://'), null);
  assert.equal(domainFromSite('localhost'), null);
});

test('кандидаты выводятся ровно из домена и помечаются как догадки', () => {
  assert.deepEqual(deriveCandidates('zenit-lab-152.ru'), [
    'info@zenit-lab-152.ru',
    'sales@zenit-lab-152.ru',
    'contact@zenit-lab-152.ru',
  ]);
});

test('опечатки в домене чинятся только по списку, похожие домены не трогаются', () => {
  assert.equal(fixDomainTypo('ivan@gmial.com').email, 'ivan@gmail.com');
  assert.equal(fixDomainTypo('ivan@mial.ru').email, 'ivan@mail.ru');
  assert.equal(fixDomainTypo('ivan@example..com').email, 'ivan@example.com');
  // Настоящий домен компании похож на опечатку, но им не является — не трогаем.
  const untouched = fixDomainTypo('info@modul-plus-452.ru');
  assert.equal(untouched.email, 'info@modul-plus-452.ru');
  assert.equal(untouched.fixed, false);
});

test('синтаксис: пропускает валидное и ловит типовой мусор', () => {
  assert.deepEqual(checkSyntax('info@zenit-lab-152.ru'), []);
  assert.deepEqual(checkSyntax('a.b-c+d@sub.example.com'), []);
  assert.ok(checkSyntax('без-собаки.ru').includes('syntax_no_at'));
  assert.ok(checkSyntax('two@@example.com').includes('syntax_multiple_at'));
  assert.ok(checkSyntax('a b@example.com').includes('syntax_whitespace'));
  assert.ok(checkSyntax('@example.com').includes('syntax_empty_local'));
  assert.ok(checkSyntax('a@example').includes('syntax_domain_without_dot'));
  assert.ok(checkSyntax('.a@example.com').includes('syntax_bad_dots_in_local'));
  assert.ok(checkSyntax('a@-example.com').includes('syntax_bad_hyphen_in_domain'));
  assert.ok(checkSyntax('a@example.123').includes('syntax_bad_tld'));
});

test('ролевые ящики и одноразовые домены опознаются', () => {
  assert.equal(isRoleAccount('info@example.com'), true);
  assert.equal(isRoleAccount('sales+spb@example.com'), true);
  assert.equal(isRoleAccount('nikita@example.com'), false);
  assert.equal(isDisposable('a@mailinator.com'), true);
  assert.equal(isDisposable('a@zenit-lab-152.ru'), false);
});

test('ролевой ящик НЕ останавливает пайплайн — иначе про домен ничего не узнаем', () => {
  const v = checkOffline('info@zenit-lab-152.ru');
  assert.equal(v.stageFailed, null, 'ролевой адрес обязан дойти до сетевых этапов');
  assert.ok(v.issues.includes('role_account'));
  assert.equal(v.status, 'unknown');
});

test('нет MX — отказ на пятом этапе, независимо от того, ролевой адрес или нет', () => {
  const offline = checkOffline('info@zenit-lab-152.ru');
  const final = finalStatus(offline, { hasMx: false });
  assert.equal(final.status, 'rejected');
  assert.equal(final.stageFailed, 'mx');
  assert.ok(final.issues.includes('domain_has_no_mx'));
});

test('ролевой адрес не может стать valid даже при успешном SMTP', () => {
  const role = finalStatus(checkOffline('info@example.com'), { hasMx: true, smtp: 'accepted' });
  assert.equal(role.status, 'quarantined');
  const person = finalStatus(checkOffline('nikita@example.com'), { hasMx: true, smtp: 'accepted' });
  assert.equal(person.status, 'valid');
});

test('catch-all опознаётся по контрольному несуществующему адресу', () => {
  // Домен принял и нужный ящик, и заведомо выдуманный — значит принимает всё.
  assert.equal(interpretSmtp('accepted', 'accepted'), 'catch_all');
  // Нужный принят, выдуманный отвергнут — вот это подтверждение.
  assert.equal(interpretSmtp('accepted', 'rejected'), 'accepted');
  // Про контрольный не смогли спросить — подтверждением считать нельзя,
  // но и хоронить адрес не за что: остаётся accepted по первому ответу.
  assert.equal(interpretSmtp('accepted', 'unknown'), 'accepted');
  // Если отвергнут сам адрес, контрольный уже ничего не меняет.
  assert.equal(interpretSmtp('rejected', 'accepted'), 'rejected');
  assert.equal(interpretSmtp('unknown', 'accepted'), 'unknown');
});

test('catch-all и unknown не считаются подтверждением', () => {
  const catchAll = finalStatus(checkOffline('nikita@example.com'), {
    hasMx: true, smtp: 'catch_all',
  });
  assert.equal(catchAll.status, 'quarantined', 'catch-all соглашается на любой адрес');

  const notChecked = finalStatus(checkOffline('nikita@example.com'), { hasMx: true });
  assert.equal(notChecked.status, 'unknown', '«не проверяли» — это не «плохой адрес»');
  assert.notEqual(notChecked.status, 'rejected');
});

test('одноразовый домен и битый синтаксис до сети не доходят', () => {
  const disposable = checkOffline('user@mailinator.com');
  assert.equal(disposable.status, 'rejected');
  assert.equal(disposable.stageFailed, 'disposable');

  const broken = checkOffline('совсем не адрес');
  assert.equal(broken.status, 'rejected');
  assert.equal(broken.stageFailed, 'syntax');
});
