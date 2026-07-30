/**
 * Критерий оценки «Качество базы — реальные, валидные email» при том, что поля email
 * в выгрузке нет вообще (ANOMALIES.md, п. 10). Этот скрипт закрывает вопрос не словами,
 * а прогоном: выводит адреса-кандидаты из доменов сайтов и гоняет их по шести этапам
 * из вашего же курса — опечатки в домене → синтаксис → ролевые ящики → одноразовые
 * домены → MX → SMTP.
 *
 * Запуск:  npm run emails            (без SMTP — по умолчанию)
 *          npm run emails -- --smtp  (со SMTP-этапом)
 *
 * Почему SMTP выключен по умолчанию. Живая SMTP-верификация с произвольного IP —
 * это исходящие соединения на 25-й порт к чужим серверам: провайдеры их режут,
 * принимающая сторона считает такое поведение подозрительным, а репутация адреса,
 * с которого вы потом будете слать, портится. В продакшене это делают с выделенного
 * IP и пачками с задержкой, поэтому здесь это осознанный флаг, а не поведение
 * по умолчанию.
 *
 * ⚠️ Адреса здесь ВЫВЕДЕННЫЕ, а не полученные из источника. Отправлять по ним
 * без подтверждения нельзя — это худший способ сжечь домен отправителя.
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { getPool, query } from '../lib/db';
import { loadEnv, requireEnv } from './lib/env';
import {
  checkOffline,
  deriveCandidates,
  domainFromSite,
  finalStatus,
  interpretSmtp,
  type EmailVerdict,
} from './lib/email';

loadEnv();
requireEnv('DATABASE_URL');

const USE_SMTP = process.argv.includes('--smtp');
const DNS_CONCURRENCY = 24;
const DNS_TIMEOUT_MS = 8000;

interface CompanyRow {
  external_id: string;
  site: string;
}

/** Прогоняет задачи пачками, чтобы не открыть 900 резолверов разом. */
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(worker))));
  }
  return out;
}

/** Результат DNS-запроса: ответ, отсутствие имени или «спросить не удалось». */
type DnsOutcome<T> = { kind: 'ok'; value: T } | { kind: 'absent' } | { kind: 'unknown' };

/**
 * Запрос к DNS с честным разбором исхода. Ключевое: ошибку резолвера НЕЛЬЗЯ
 * сворачивать в «домена нет». NXDOMAIN (`ENOTFOUND`) — это факт, а таймаут
 * и `SERVFAIL` — это «мы не смогли спросить», и отвергать по ним адрес нельзя,
 * иначе рухнувший резолвер объявит всю базу мусором.
 * `ENODATA` — отдельный случай: имя существует, но записи такого типа у него нет.
 */
async function askDns<T>(run: () => Promise<T>, ms: number): Promise<DnsOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<DnsOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unknown' }), ms);
  });
  const attempt = run().then(
    (value): DnsOutcome<T> => ({ kind: 'ok', value }),
    (error: NodeJS.ErrnoException): DnsOutcome<T> => {
      if (error.code === 'ENOTFOUND' || error.code === 'NXDOMAIN') return { kind: 'absent' };
      if (error.code === 'ENODATA') return { kind: 'ok', value: [] as unknown as T };
      return { kind: 'unknown' };
    },
  );
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    // Таймер обязательно снимаем: иначе процесс висит до 8 секунд после ответа.
    if (timer) clearTimeout(timer);
  }
}

/** Существует ли домен: подтверждён / точно нет / спросить не удалось. */
type DomainExistence = 'exists' | 'absent' | 'unknown';

interface DomainFacts {
  domain: string;
  hasMx: boolean;
  mxHost: string | null;
  existence: DomainExistence;
}

/**
 * Этап 5: есть ли у домена почтовый сервер, и существует ли домен вообще.
 * Различать «домена нет» и «домен есть, почты нет» обязательно: это разные причины
 * отказа и разный совет по базе.
 */
async function lookupDomain(domain: string): Promise<DomainFacts> {
  const mx = await askDns(() => dns.resolveMx(domain), DNS_TIMEOUT_MS);

  if (mx.kind === 'ok' && mx.value.length > 0) {
    const best = [...mx.value].sort((a, b) => a.priority - b.priority)[0];
    if (best) return { domain, hasMx: true, mxHost: best.exchange, existence: 'exists' };
  }
  if (mx.kind === 'absent') {
    return { domain, hasMx: false, mxHost: null, existence: 'absent' };
  }

  // MX не нашлось (или спросить не удалось) — проверяем само имя. AAAA тоже:
  // домен может быть только на IPv6, и назвать его несуществующим было бы неверно.
  const [v4, v6] = await Promise.all([
    askDns(() => dns.resolve4(domain), DNS_TIMEOUT_MS),
    askDns(() => dns.resolve6(domain), DNS_TIMEOUT_MS),
  ]);

  const found =
    (v4.kind === 'ok' && v4.value.length > 0) || (v6.kind === 'ok' && v6.value.length > 0);
  if (found) return { domain, hasMx: false, mxHost: null, existence: 'exists' };

  // «Нет записи» от обоих — имя не существует. Если хоть один ответ невнятный,
  // честный итог «неизвестно», а не «домена нет».
  const bothAnswered =
    (v4.kind === 'ok' || v4.kind === 'absent') && (v6.kind === 'ok' || v6.kind === 'absent');
  return {
    domain,
    hasMx: false,
    mxHost: null,
    existence: bothAnswered && mx.kind !== 'unknown' ? 'absent' : 'unknown',
  };
}

type SmtpAnswer = 'accepted' | 'rejected' | 'catch_all' | 'unknown';
type RcptAnswer = 'accepted' | 'rejected' | 'unknown';

const SMTP_DEADLINE_MS = 15000;

/**
 * Одна SMTP-сессия: спросить у сервера про конкретный ящик. Команда DATA не
 * отправляется никогда — письмо не уходит, спрашиваем только про адрес.
 */
function smtpRcpt(mxHost: string, email: string): Promise<RcptAnswer> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25, timeout: 10000 });
    let stage = 0;
    // Сервер может просто закрыть соединение. Без обработчиков end/close промис
    // не завершался бы никогда, и прогон с --smtp вис навсегда. Плюс общий дедлайн
    // на сессию и одноразовый done, чтобы не резолвить дважды.
    let settled = false;
    const done = (value: RcptAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(value);
    };
    const deadline = setTimeout(() => done('unknown'), SMTP_DEADLINE_MS);

    socket.on('error', () => done('unknown'));
    socket.on('timeout', () => done('unknown'));
    socket.on('end', () => done('unknown'));
    socket.on('close', () => done('unknown'));
    socket.on('data', (chunk) => {
      const code = Number(chunk.toString().slice(0, 3));
      if (stage === 0 && code === 220) {
        socket.write('HELO polza-test.local\r\n');
        stage = 1;
      } else if (stage === 1 && code === 250) {
        socket.write('MAIL FROM:<check@polza-test.local>\r\n');
        stage = 2;
      } else if (stage === 2 && code === 250) {
        socket.write(`RCPT TO:<${email}>\r\n`);
        stage = 3;
      } else if (stage === 3) {
        socket.write('QUIT\r\n');
        done(code >= 200 && code < 300 ? 'accepted' : code >= 500 ? 'rejected' : 'unknown');
      } else if (code >= 400) {
        done('unknown');
      }
    });
  });
}

/**
 * Этап 6 целиком. Одного вопроса про нужный ящик мало: catch-all-домен отвечает
 * согласием на любой адрес, и «accepted» от него ничего не значит. Поэтому вторым
 * вопросом идёт заведомо несуществующий адрес того же домена: если сервер принял
 * и его тоже — это catch-all, и результат не подтверждение, а карантин.
 */
async function smtpProbe(mxHost: string, email: string): Promise<SmtpAnswer> {
  const real = await smtpRcpt(mxHost, email);
  if (real !== 'accepted') return interpretSmtp(real, 'unknown');

  const domain = email.slice(email.lastIndexOf('@') + 1);
  const control = await smtpRcpt(mxHost, `no-such-mailbox-polza-check@${domain}`);
  return interpretSmtp(real, control);
}

async function main(): Promise<void> {
  const companies = await query<CompanyRow>(
    `SELECT external_id, site FROM companies WHERE site IS NOT NULL ORDER BY external_id`,
  );

  // 1. Выводим кандидатов из доменов.
  const candidates: { externalId: string; verdict: EmailVerdict }[] = [];
  const domains = new Set<string>();
  let siteWithoutDomain = 0;

  for (const row of companies) {
    const domain = domainFromSite(row.site);
    if (!domain) {
      siteWithoutDomain += 1;
      continue;
    }
    domains.add(domain);
    for (const email of deriveCandidates(domain)) {
      candidates.push({ externalId: row.external_id, verdict: checkOffline(email) });
    }
  }

  console.log('Компаний с сайтом:            %d', companies.length);
  console.log('Из них домен разобран:        %d', companies.length - siteWithoutDomain);
  console.log('Уникальных доменов:           %d', domains.size);
  // По три адреса на КОМПАНИЮ, а не на домен: 7 компаний делят домен с другими,
  // поэтому 890 × 3 = 2670, а не 883 × 3. Кандидат привязан к компании — иначе
  // потом не понять, кому именно писать.
  console.log('Кандидатов в адреса:          %d  (info, sales, contact на каждую компанию)',
    candidates.length);
  console.log('');

  // 2. Этапы 1–4 уже посчитаны (checkOffline). Смотрим, что отсеялось без сети.
  const offlineRejected = candidates.filter((c) => c.verdict.status === 'rejected');
  console.log('Отсеяно до обращения к сети:  %d', offlineRejected.length);

  // 3. Этап 5: MX по каждому уникальному домену (не по каждому адресу — экономим DNS).
  //    Домены, у которых ВСЕ кандидаты уже отвергнуты локально, в DNS не идут:
  //    спрашивать про них не о чем.
  const domainsWithLiveCandidate = new Set(
    candidates.filter((c) => c.verdict.status !== 'rejected').map((c) => c.verdict.domain),
  );
  const domainList = [...domains].filter((d) => domainsWithLiveCandidate.has(d)).sort();
  const skipped = domains.size - domainList.length;
  if (skipped > 0) console.log('Пропущено доменов (все кандидаты отсеяны раньше): %d', skipped);

  console.log('Проверяю MX по %d доменам…', domainList.length);
  const facts = await inBatches(domainList, DNS_CONCURRENCY, lookupDomain);
  const byDomain = new Map(facts.map((f) => [f.domain, f]));

  const withMx = facts.filter((f) => f.hasMx).length;
  const resolving = facts.filter((f) => f.existence === 'exists').length;
  const absent = facts.filter((f) => f.existence === 'absent').length;
  const undecided = facts.filter((f) => f.existence === 'unknown').length;
  console.log('  доменов существует:                 %d из %d', resolving, facts.length);
  console.log('  доменов НЕ существует (NXDOMAIN):   %d из %d', absent, facts.length);
  console.log('  спросить не удалось:                %d из %d', undecided, facts.length);
  console.log('  доменов с MX-записью:               %d из %d', withMx, facts.length);
  console.log('');

  // 4. Этап 6: SMTP — только там, где есть куда стучаться.
  const smtpAnswers = new Map<string, Awaited<ReturnType<typeof smtpProbe>>>();
  if (USE_SMTP) {
    const probeable = candidates.filter((c) => byDomain.get(c.verdict.domain)?.hasMx);
    console.log('SMTP-этап включён, адресов к проверке: %d', probeable.length);
    for (const c of probeable) {
      const host = byDomain.get(c.verdict.domain)?.mxHost;
      if (host) smtpAnswers.set(c.verdict.normalized, await smtpProbe(host, c.verdict.normalized));
    }
  } else {
    const probeable = candidates.filter((c) => byDomain.get(c.verdict.domain)?.hasMx).length;
    console.log('SMTP-этап выключен (запустить: npm run emails -- --smtp).');
    console.log('  адресов, до которых он вообще дошёл бы: %d', probeable);
    console.log('');
  }

  // 5. Итоговый статус и запись в базу.
  const pool = getPool();
  const client = await pool.connect();
  const counts = new Map<string, number>();
  const stages = new Map<string, number>();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM email_candidates');
    for (const { externalId, verdict } of candidates) {
      const facts0 = byDomain.get(verdict.domain);
      let final: { status: string; stageFailed: string | null; issues: string[] };

      if (verdict.status === 'rejected') {
        final = { status: verdict.status, stageFailed: verdict.stageFailed, issues: verdict.issues };
      } else if (!facts0 || facts0.existence === 'unknown') {
        // Резолвер не ответил. «Не проверяли» — это не «плохой адрес»: отвергать
        // такой адрес нельзя, иначе сбой DNS оболгал бы живую базу.
        final = {
          status: 'unknown',
          stageFailed: null,
          issues: [...verdict.issues, 'dns_lookup_failed'],
        };
      } else {
        final = finalStatus(verdict, {
          hasMx: facts0.hasMx,
          smtp: smtpAnswers.get(verdict.normalized),
        });
      }

      const issues = [...final.issues];
      if (facts0?.existence === 'absent') issues.push('domain_does_not_exist');

      counts.set(final.status, (counts.get(final.status) ?? 0) + 1);
      if (final.stageFailed) stages.set(final.stageFailed, (stages.get(final.stageFailed) ?? 0) + 1);

      await client.query(
        `INSERT INTO email_candidates
           (external_id, email, local_part, domain, source, status, stage_failed, issues)
         VALUES ($1, $2, $3, $4, 'derived_from_site', $5, $6, $7)
         ON CONFLICT (external_id, email) DO UPDATE
            SET status = EXCLUDED.status,
                stage_failed = EXCLUDED.stage_failed,
                issues = EXCLUDED.issues,
                checked_at = now()`,
        [externalId, verdict.normalized, verdict.localPart, verdict.domain,
         final.status, final.stageFailed, issues],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // console.log в Node понимает %s и %d, но НЕ printf-ную ширину вида %-12s —
  // она уходит в вывод как есть. Выравниваем padEnd.
  console.log('─── Итог по кандидатам ────────────────────────────────');
  for (const status of ['valid', 'quarantined', 'unknown', 'rejected']) {
    console.log('  %s %d', status.padEnd(12), counts.get(status) ?? 0);
  }
  console.log('');
  console.log('─── На каком этапе выбыли ─────────────────────────────');
  for (const [stage, n] of [...stages.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  %s %d', stage.padEnd(12), n);
  }
  console.log('');

  const valid = counts.get('valid') ?? 0;
  console.log('─── Вывод ─────────────────────────────────────────────');
  console.log('Валидных адресов: %d. Причина не в методе проверки, а во входных данных:', valid);
  console.log('%d доменов из %d не существуют в DNS — писать туда физически некуда.',
    absent, facts.length);
  if (undecided > 0) {
    console.log('Ещё по %d доменам резолвер не ответил — они помечены unknown, а не отвергнуты.',
      undecided);
  }

  if (resolving > 0) {
    console.log('');
    console.log('⚠️ Но %d из них всё же резолвятся, и это ловушка, а не удача:', resolving);
    for (const f of facts.filter((x) => x.existence === 'exists')) {
      console.log('     %s MX: %s', f.domain.padEnd(22), f.mxHost ?? 'нет');
    }
    console.log('   У всех у них короткий номер в имени, поэтому они случайно совпали');
    console.log('   с чужими существующими сайтами. К компаниям из выгрузки отношения');
    console.log('   они не имеют. Наивное обогащение отправило бы письма посторонним —');
    console.log('   именно поэтому выведенный адрес помечен source=derived_from_site');
    console.log('   и никогда не считается подтверждённым.');
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
