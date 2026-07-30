/**
 * Валидация email по шести этапам: опечатки в домене → синтаксис → ролевые ящики →
 * одноразовые домены → MX → SMTP. Порядок взят из курса заказчика по холодным
 * рассылкам (t.me/shmrkt/328) — он же и правильный по стоимости: дешёвые проверки
 * идут первыми, сетевые последними, чтобы не дёргать DNS ради строки без «собаки».
 *
 * В этом файле только то, что считается без сети, — его можно покрыть тестами.
 * MX и SMTP живут в scripts/enrich_emails.ts, потому что требуют DNS и сокета.
 */

export type EmailStage =
  | 'domain_typo'
  | 'syntax'
  | 'role'
  | 'disposable'
  | 'mx'
  | 'smtp';

export type EmailStatus = 'valid' | 'quarantined' | 'rejected' | 'unknown';

export interface EmailVerdict {
  email: string;
  /** Адрес после исправления опечаток — именно он идёт дальше по этапам. */
  normalized: string;
  localPart: string;
  domain: string;
  status: EmailStatus;
  /** Этап, на котором адрес перестал быть кандидатом. null — дошёл до конца. */
  stageFailed: EmailStage | null;
  issues: string[];
}

/**
 * Ролевые ящики. Для холодной рассылки это не «плохой адрес», а адрес с другим
 * поведением: попадает в общий почтовый ящик, читается дежурным, чаще помечается
 * спамом. Поэтому не отбрасываем, а отправляем в карантин — решение о рассылке
 * по ним принимает человек, а не загрузчик.
 */
const ROLE_LOCAL_PARTS = new Set([
  'info', 'sales', 'support', 'admin', 'office', 'mail', 'contact', 'help',
  'noreply', 'no-reply', 'postmaster', 'abuse', 'webmaster', 'hr', 'jobs',
  'marketing', 'billing', 'accounting', 'zakaz', 'sekretar', 'director',
]);

/** Одноразовые почтовые домены: адрес живёт минуты, писать по нему бессмысленно. */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
  'sharklasers.com', 'getnada.com', 'maildrop.cc', 'dropmail.me',
  'fakeinbox.com', 'mailnesia.com', 'tempmailo.com', 'emailondeck.com',
]);

/**
 * Опечатки в популярных доменах. Список намеренно короткий и явный: подставлять
 * «похожий» домен по расстоянию Левенштейна опасно — так письмо уедет чужой
 * компании. Правим только то, что заведомо опечатка.
 */
const DOMAIN_TYPOS = new Map([
  ['gmial.com', 'gmail.com'], ['gmai.com', 'gmail.com'], ['gmail.co', 'gmail.com'],
  ['gmail.ru', 'gmail.com'], ['gnail.com', 'gmail.com'], ['gmaill.com', 'gmail.com'],
  ['yandex.ru.com', 'yandex.ru'], ['yandx.ru', 'yandex.ru'], ['yamdex.ru', 'yandex.ru'],
  ['mial.ru', 'mail.ru'], ['mai.ru', 'mail.ru'], ['maill.ru', 'mail.ru'],
  ['outlok.com', 'outlook.com'], ['hotmial.com', 'hotmail.com'],
  ['yaho.com', 'yahoo.com'], ['ranbler.ru', 'rambler.ru'],
]);

/** Локальные части, которые пробуем вывести из домена компании. */
export const DERIVED_LOCAL_PARTS = ['info', 'sales', 'contact'] as const;

/** Домен сайта → домен для почты. Убираем схему, путь, порт и www. */
export function domainFromSite(site: string): string | null {
  const cleaned = site.trim().toLowerCase().replace(/^https?:\/\//, '');
  const beforePath = cleaned.split(/[/?#]/)[0] ?? '';
  const host = (beforePath.split(':')[0] ?? '').replace(/^www\./, '');
  if (!host || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
  return host;
}

/**
 * Кандидаты в адреса для домена. Это ДОГАДКИ, а не найденные адреса: ни один
 * из них не подтверждён источником. Помечать их так и обязаны — рассылка
 * по угаданным адресам без проверки сжигает домен отправителя.
 */
export function deriveCandidates(domain: string): string[] {
  return DERIVED_LOCAL_PARTS.map((local) => `${local}@${domain}`);
}

/** Этап 1: чиним заведомые опечатки в домене. Не угадываем — только по списку. */
export function fixDomainTypo(email: string): { email: string; fixed: boolean } {
  const at = email.lastIndexOf('@');
  if (at === -1) return { email, fixed: false };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  const corrected = DOMAIN_TYPOS.get(domain);
  if (corrected) return { email: `${local}@${corrected}`, fixed: true };
  // Двойные точки и точка на краю домена — тоже опечатка, но чинится механически.
  const squeezed = domain.replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '');
  if (squeezed !== domain) return { email: `${local}@${squeezed}`, fixed: true };
  return { email, fixed: false };
}

/**
 * Этап 2: синтаксис. Намеренно строже RFC 5322 — тот разрешает кавычки, пробелы
 * и комментарии в адресе, но в базе для рассылки такой адрес почти наверняка
 * мусор, а не редкий валидный случай.
 */
export function checkSyntax(email: string): string[] {
  const issues: string[] = [];
  const at = email.lastIndexOf('@');
  if (at === -1) return ['syntax_no_at'];

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (email.length > 254) issues.push('syntax_too_long');
  if (local.length === 0) issues.push('syntax_empty_local');
  if (local.length > 64) issues.push('syntax_local_too_long');
  if (domain.length === 0) issues.push('syntax_empty_domain');
  if (/\s/.test(email)) issues.push('syntax_whitespace');
  if (email.split('@').length > 2) issues.push('syntax_multiple_at');
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    issues.push('syntax_bad_dots_in_local');
  }
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) issues.push('syntax_bad_local_chars');
  if (!domain.includes('.')) issues.push('syntax_domain_without_dot');
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) issues.push('syntax_bad_domain_chars');
  if (/(^-)|(-$)|(\.-)|(-\.)/.test(domain)) issues.push('syntax_bad_hyphen_in_domain');

  const tld = domain.split('.').pop() ?? '';
  if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) issues.push('syntax_bad_tld');

  return issues;
}

/** Этап 3: ролевой ли ящик. */
export function isRoleAccount(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase();
  return ROLE_LOCAL_PARTS.has(local.replace(/[.+].*$/, ''));
}

/** Этап 4: одноразовый ли домен. */
export function isDisposable(email: string): boolean {
  return DISPOSABLE_DOMAINS.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
}

/**
 * Этапы 1–4 одним проходом. Возвращает вердикт, которому ещё предстоят MX и SMTP.
 * Адрес, отвергнутый здесь, до сети не доходит вообще.
 */
export function checkOffline(email: string): EmailVerdict {
  const issues: string[] = [];
  const raw = email.trim();

  const { email: normalized, fixed } = fixDomainTypo(raw.toLowerCase());
  if (fixed) issues.push('domain_typo_fixed');

  const at = normalized.lastIndexOf('@');
  const localPart = at === -1 ? normalized : normalized.slice(0, at);
  const domain = at === -1 ? '' : normalized.slice(at + 1);

  const syntax = checkSyntax(normalized);
  if (syntax.length > 0) {
    return {
      email: raw, normalized, localPart, domain,
      status: 'rejected', stageFailed: 'syntax', issues: [...issues, ...syntax],
    };
  }

  if (isDisposable(normalized)) {
    return {
      email: raw, normalized, localPart, domain,
      status: 'rejected', stageFailed: 'disposable',
      issues: [...issues, 'disposable_domain'],
    };
  }

  // Ролевой ящик — ПРИЗНАК, а не приговор: проверку доставимости он не отменяет.
  // Останавливать на нём пайплайн нельзя, иначе про домен мы так и не узнаем,
  // существует ли он вообще. Итоговый статус ролевого адреса — не выше карантина.
  if (isRoleAccount(normalized)) issues.push('role_account');

  return {
    email: raw, normalized, localPart, domain,
    status: 'unknown', stageFailed: null, issues,
  };
}

/**
 * Разбор SMTP-этапа: сервер спрашивают дважды — про нужный ящик и про заведомо
 * несуществующий адрес того же домена. Если приняты оба, домен catch-all,
 * и согласие по первому адресу ничего не подтверждает.
 *
 * Вынесено отдельной функцией, потому что без этого правило проверялось бы только
 * подстановкой готового значения в finalStatus, а сама ветка обнаружения catch-all
 * оставалась бы непокрытой — на это указало независимое ревью.
 */
export function interpretSmtp(
  real: 'accepted' | 'rejected' | 'unknown',
  control: 'accepted' | 'rejected' | 'unknown',
): 'accepted' | 'rejected' | 'catch_all' | 'unknown' {
  if (real !== 'accepted') return real;
  return control === 'accepted' ? 'catch_all' : 'accepted';
}

/**
 * Итоговый статус после сетевых этапов. Вынесен отдельно, чтобы правило
 * «ролевой адрес не бывает valid» лежало в одном месте и проверялось тестом.
 */
export function finalStatus(
  offline: EmailVerdict,
  network: { hasMx: boolean; smtp?: 'accepted' | 'rejected' | 'catch_all' | 'unknown' },
): { status: EmailStatus; stageFailed: EmailStage | null; issues: string[] } {
  const issues = [...offline.issues];

  if (!network.hasMx) {
    issues.push('domain_has_no_mx');
    return { status: 'rejected', stageFailed: 'mx', issues };
  }

  const role = issues.includes('role_account');

  if (network.smtp === 'rejected') {
    issues.push('smtp_mailbox_rejected');
    return { status: 'rejected', stageFailed: 'smtp', issues };
  }
  if (network.smtp === 'catch_all') {
    // Домен отвечает согласием на любой адрес — подтверждением это не является.
    issues.push('smtp_catch_all');
    return { status: 'quarantined', stageFailed: 'smtp', issues };
  }
  if (network.smtp === 'accepted') {
    return role
      ? { status: 'quarantined', stageFailed: null, issues }
      : { status: 'valid', stageFailed: null, issues };
  }

  // SMTP не запускали или ответ невнятный. «Неизвестно» — не то же самое, что «плохой».
  issues.push('smtp_not_checked');
  return { status: 'unknown', stageFailed: null, issues };
}
