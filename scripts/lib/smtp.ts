/**
 * Этап 6 валидации адреса: спросить у почтового сервера, принимает ли он ящик.
 *
 * Вынесено из `enrich_emails.ts` отдельным модулем ровно затем, чтобы это можно было
 * покрыть тестом: тот файл запускает `main()` при импорте, и подключить его из теста
 * нельзя. А проверять тут есть что — сетевой код молча виснет, и заметно это только
 * на живом прогоне.
 *
 * Команда DATA не отправляется никогда: письмо не уходит, спрашиваем только про адрес.
 */
import net from 'node:net';

export type RcptAnswer = 'accepted' | 'rejected' | 'unknown';
export type SmtpAnswer = RcptAnswer | 'catch_all';

export interface RcptOptions {
  host: string;
  port?: number;
  email: string;
  /** Общий дедлайн на сессию. Отдельный параметр — чтобы тест не ждал 15 секунд. */
  deadlineMs?: number;
  /** Имя, которым представляемся в HELO. */
  helo?: string;
}

/**
 * Одна SMTP-сессия. Всегда завершается: по ответу сервера, по закрытию соединения
 * с его стороны, по таймауту сокета или по общему дедлайну. Без обработчиков
 * `end`/`close` промис не резолвился бы вовсе, если сервер просто закрывает канал, —
 * прогон с `--smtp` вис бы навсегда. Это находка независимого ревью, и она закрыта
 * тестом «сервер закрывает соединение сразу после приветствия».
 */
export function smtpRcpt(options: RcptOptions): Promise<RcptAnswer> {
  const { host, port = 25, email, deadlineMs = 15000, helo = 'polza-test.local' } = options;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: Math.min(10000, deadlineMs) });
    let stage = 0;
    let settled = false;

    const done = (value: RcptAnswer): void => {
      if (settled) return;         // done обязан быть одноразовым: close придёт и после ответа
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(value);
    };
    const deadline = setTimeout(() => done('unknown'), deadlineMs);

    socket.on('error', () => done('unknown'));
    socket.on('timeout', () => done('unknown'));
    socket.on('end', () => done('unknown'));
    socket.on('close', () => done('unknown'));

    socket.on('data', (chunk) => {
      const code = Number(chunk.toString().slice(0, 3));
      if (stage === 0 && code === 220) {
        socket.write(`HELO ${helo}\r\n`);
        stage = 1;
      } else if (stage === 1 && code === 250) {
        socket.write(`MAIL FROM:<check@${helo}>\r\n`);
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
 * согласием на любой адрес, и «accepted» от него ничего не подтверждает. Поэтому
 * вторым вопросом идёт заведомо несуществующий адрес того же домена.
 */
export async function smtpProbe(
  options: RcptOptions,
  interpret: (real: RcptAnswer, control: RcptAnswer) => SmtpAnswer,
): Promise<SmtpAnswer> {
  const real = await smtpRcpt(options);
  if (real !== 'accepted') return interpret(real, 'unknown');

  const domain = options.email.slice(options.email.lastIndexOf('@') + 1);
  const control = await smtpRcpt({
    ...options,
    email: `no-such-mailbox-polza-check@${domain}`,
  });
  return interpret(real, control);
}
