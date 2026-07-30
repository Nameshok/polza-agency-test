/**
 * Тесты SMTP-этапа против локального поддельного почтового сервера.
 *
 * Зачем локальный сервер, а не живая проверка: стучаться настоящими RCPT-запросами
 * в чужие почтовые серверы ради теста нельзя, а без прогона эта ветка кода вообще
 * никогда не исполнялась бы. Локальный сервер даёт то, чего живой не даст, —
 * воспроизводимый сценарий «сервер молча закрыл соединение», на котором код
 * раньше вис навсегда.
 *
 * Запуск: npm test
 */
import { strict as assert } from 'node:assert';
import net from 'node:net';
import { test } from 'node:test';

import { smtpProbe, smtpRcpt } from './lib/smtp';
import { interpretSmtp } from './lib/email';

type Behaviour = 'accept' | 'reject' | 'close-after-greeting' | 'silent' | 'catch-all';

/** Поддельный SMTP-сервер на случайном свободном порту. */
async function fakeServer(behaviour: Behaviour): Promise<{ port: number; close: () => Promise<void> }> {
  const live = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    live.add(socket);
    // Клиент рвёт соединение сразу после QUIT — сервер получает ECONNRESET.
    // Без этого обработчика ошибка всплывает наверх и роняет весь прогон тестов.
    socket.on('error', () => {});
    socket.on('close', () => live.delete(socket));
    if (behaviour === 'silent') return;                    // не отвечаем вообще
    socket.write('220 fake ESMTP\r\n');
    if (behaviour === 'close-after-greeting') {
      socket.end();
      return;
    }
    socket.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.startsWith('HELO') || line.startsWith('MAIL FROM')) {
        socket.write('250 ok\r\n');
      } else if (line.startsWith('RCPT TO')) {
        if (behaviour === 'accept') {
          // Принимаем только конкретный ящик, всё прочее отвергаем.
          socket.write(line.includes('real@') ? '250 ok\r\n' : '550 no such user\r\n');
        } else if (behaviour === 'catch-all') {
          socket.write('250 ok\r\n');                      // соглашается на что угодно
        } else {
          socket.write('550 no such user\r\n');
        }
      } else if (line.startsWith('QUIT')) {
        socket.end('221 bye\r\n');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    // server.close() лишь перестаёт принимать новые соединения и ждёт закрытия живых.
    // Живой сокет остался бы, например, после теста «сервер молчит», и прогон повис бы.
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of live) socket.destroy();
        live.clear();
        server.close(() => resolve());
      }),
  };
}

test('SMTP: существующий ящик принят, несуществующий отвергнут', async () => {
  const srv = await fakeServer('accept');
  try {
    assert.equal(
      await smtpRcpt({ host: '127.0.0.1', port: srv.port, email: 'real@example.com', deadlineMs: 4000 }),
      'accepted',
    );
    assert.equal(
      await smtpRcpt({ host: '127.0.0.1', port: srv.port, email: 'ghost@example.com', deadlineMs: 4000 }),
      'rejected',
    );
  } finally {
    await srv.close();
  }
});

test('SMTP: сервер закрыл соединение после приветствия — unknown, а не зависание', async () => {
  const srv = await fakeServer('close-after-greeting');
  try {
    const started = Date.now();
    const answer = await smtpRcpt({
      host: '127.0.0.1', port: srv.port, email: 'a@example.com', deadlineMs: 4000,
    });
    assert.equal(answer, 'unknown');
    // Главное в этом тесте — что ответ пришёл от обработчика close, а не по дедлайну.
    assert.ok(Date.now() - started < 3000, 'должно завершиться сразу, а не ждать дедлайн');
  } finally {
    await srv.close();
  }
});

test('SMTP: сервер молчит — unknown по дедлайну, промис не повисает', async () => {
  const srv = await fakeServer('silent');
  try {
    const answer = await smtpRcpt({
      host: '127.0.0.1', port: srv.port, email: 'a@example.com', deadlineMs: 700,
    });
    assert.equal(answer, 'unknown');
  } finally {
    await srv.close();
  }
});

test('SMTP: соединение отвергнуто (порт закрыт) — unknown', async () => {
  const srv = await fakeServer('accept');
  const port = srv.port;
  await srv.close();                                        // порт больше никто не слушает
  assert.equal(
    await smtpRcpt({ host: '127.0.0.1', port, email: 'a@example.com', deadlineMs: 3000 }),
    'unknown',
  );
});

test('SMTP: catch-all распознан на живой сессии, а не подстановкой значения', async () => {
  const srv = await fakeServer('catch-all');
  try {
    const answer = await smtpProbe(
      { host: '127.0.0.1', port: srv.port, email: 'real@example.com', deadlineMs: 4000 },
      interpretSmtp,
    );
    assert.equal(answer, 'catch_all', 'сервер принял и контрольный выдуманный адрес');
  } finally {
    await srv.close();
  }
});

test('SMTP: честный сервер даёт accepted, потому что контрольный адрес отвергнут', async () => {
  const srv = await fakeServer('accept');
  try {
    const answer = await smtpProbe(
      { host: '127.0.0.1', port: srv.port, email: 'real@example.com', deadlineMs: 4000 },
      interpretSmtp,
    );
    assert.equal(answer, 'accepted');
  } finally {
    await srv.close();
  }
});
