/**
 * t-worker unit tests: IMAP client against a local in-process IMAP server.
 * No real mail service or external network is contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  imapFetchMessages,
  testImapConnection,
  parseImapDate,
  parseSearchResponse,
  formatImapSearchDate,
  escapeImapString,
  ImapError,
} from '../../server/mail/imap.mjs';
import { buildMimeMessage } from '../../server/mail/mime.mjs';

const CHINESE_SUBJECT = 'Re: 产品报价与样品申请';
const CHINESE_TEXT = '您好，我们对贵司的工业零部件很感兴趣，请提供报价与交期。\n谢谢！';

function sampleRaw({ inReplyTo = '<parent@zhirai.example>', references = '<root@zhirai.example> <parent@zhirai.example>' } = {}) {
  return buildMimeMessage({
    from: { name: 'Max Mustermann', address: 'max@kunde.example' },
    to: [{ name: 'ZHIRAI', address: 'sales@zhirai.example' }],
    subject: CHINESE_SUBJECT,
    text: CHINESE_TEXT,
    date: new Date('2026-10-22T10:30:00.000Z'),
    inReplyTo,
    references: references ? references.split(/\s+/) : [],
  }).raw;
}

/**
 * Minimal scripted IMAP4rev1 server. Only the commands the client uses are
 * implemented; every received line is recorded for assertions.
 */
async function startImapServer(options = {}) {
  const { messages = { 101: sampleRaw() }, extraUids = [], password = 'imap-secret', failLogin = false, exists = 3 } = options;
  const commands = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.write('* OK [CAPABILITY IMAP4rev1] test IMAP ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        commands.push(line);
        const match = /^(\S+)\s+(.+)$/.exec(line);
        if (!match) continue;
        const [, tag, rest] = match;
        const upper = rest.toUpperCase();
        if (upper.startsWith('LOGIN')) {
          const quoted = rest.match(/"((?:[^"\\]|\\.)*)"/g) || [];
          const user = quoted[0] ? quoted[0].slice(1, -1) : '';
          const given = quoted[1] ? quoted[1].slice(1, -1) : '';
          if (failLogin || given !== password) socket.write(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);
          else socket.write(`${tag} OK LOGIN completed\r\n`);
          void user;
          continue;
        }
        if (upper.startsWith('SELECT')) {
          socket.write(`* ${exists} EXISTS\r\n* FLAGS (\\Seen \\Unseen)\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
          continue;
        }
        if (upper.startsWith('UID SEARCH')) {
          const uids = [...Object.keys(messages).map(Number), ...extraUids].sort((a, b) => a - b);
          socket.write(`* SEARCH ${uids.join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
          continue;
        }
        if (upper.startsWith('UID FETCH')) {
          const setMatch = /UID FETCH ([0-9,]+)/i.exec(rest);
          const uids = (setMatch ? setMatch[1] : '').split(',').map(Number).filter(Boolean);
          uids.forEach((uid, index) => {
            const raw = messages[uid] || `From: unknown@example.com\r\nSubject: uid ${uid}\r\n\r\nbody ${uid}`;
            const bytes = Buffer.from(raw, 'utf8');
            socket.write(
              `* ${index + 1} FETCH (UID ${uid} INTERNALDATE "22-Oct-2026 12:00:00 +0000" ENVELOPE ("subject" "date" "from" "sender" "reply-to" "to" "cc" "bcc" "in-reply-to" "message-id") BODY[] {${bytes.length}}\r\n`,
            );
            socket.write(bytes);
            socket.write(')\r\n');
          });
          socket.write(`${tag} OK FETCH completed\r\n`);
          continue;
        }
        if (upper.startsWith('LOGOUT')) {
          socket.write(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
          socket.end();
          continue;
        }
        if (upper.startsWith('CAPABILITY')) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
          continue;
        }
        socket.write(`${tag} OK ${rest.split(' ')[0]} completed\r\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    commands,
    close: () => new Promise((resolve) => server.close(resolve)),
    findCommand: (prefix) => commands.find((line) => line.toUpperCase().includes(prefix.toUpperCase())),
  };
}

test('imapFetchMessages logs in, selects INBOX, searches and parses a Chinese reply message', async () => {
  const server = await startImapServer();
  try {
    const result = await imapFetchMessages({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      username: 'sales@zhirai.example',
      password: 'imap-secret',
      unseen: true,
      limit: 50,
      timeoutMs: 5000,
    });
    assert.equal(result.exists, 3);
    assert.deepEqual(result.uids, [101]);
    assert.equal(result.messages.length, 1);
    const message = result.messages[0];
    assert.equal(message.uid, 101);
    assert.equal(message.subject, CHINESE_SUBJECT);
    assert.equal(message.from.address, 'max@kunde.example');
    assert.equal(message.from.name, 'Max Mustermann');
    assert.equal(message.to[0].address, 'sales@zhirai.example');
    assert.match(message.messageId, /^<.+@kunde\.example>$/);
    assert.equal(message.inReplyTo, '<parent@zhirai.example>');
    assert.deepEqual(message.references, ['<root@zhirai.example>', '<parent@zhirai.example>']);
    assert.ok(message.text.includes('工业零部件'), message.text);
    // The normalized message prefers the RFC 5322 Date header over INTERNALDATE.
    assert.equal(message.date, '2026-10-22T10:30:00.000Z');

    assert.ok(server.findCommand('LOGIN "sales@zhirai.example" "imap-secret"'), 'LOGIN uses quoted strings');
    assert.ok(server.findCommand('SELECT "INBOX"'));
    assert.ok(server.findCommand('UID SEARCH UNSEEN'));
    assert.ok(server.findCommand('BODY.PEEK[]'), 'BODY.PEEK[] is used so messages stay unread');
    assert.ok(!server.findCommand('BODY[]'));
    assert.ok(server.findCommand('LOGOUT'));
  } finally {
    await server.close();
  }
});

test('fetch is capped at 50 messages per sync', async () => {
  const messages = {};
  for (let uid = 1; uid <= 60; uid += 1) {
    messages[uid] = `From: sender${uid}@example.com\r\nTo: sales@zhirai.example\r\nSubject: message ${uid}\r\n\r\nbody ${uid}`;
  }
  const server = await startImapServer({ messages });
  try {
    await imapFetchMessages({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      username: 'sales@zhirai.example',
      password: 'imap-secret',
      unseen: false,
      limit: 50,
      timeoutMs: 5000,
    });
    const fetch = server.findCommand('UID FETCH');
    assert.ok(fetch, 'FETCH issued');
    const set = /UID FETCH ([0-9,]+)/i.exec(fetch)[1].split(',').map(Number);
    assert.equal(set.length, 50);
    assert.equal(set[0], 11);
    assert.equal(set[set.length - 1], 60);
  } finally {
    await server.close();
  }
});

test('SINCE search date is formatted for IMAP', async () => {
  const server = await startImapServer();
  try {
    await imapFetchMessages({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      username: 'sales@zhirai.example',
      password: 'imap-secret',
      since: new Date('2026-10-01T00:00:00.000Z'),
      limit: 5,
      timeoutMs: 5000,
    });
    assert.ok(server.findCommand('UID SEARCH SINCE 01-Oct-2026'));
    assert.equal(formatImapSearchDate(new Date('2026-01-05T12:00:00Z')), '05-Jan-2026');
  } finally {
    await server.close();
  }
});

test('login failure is a clear non-transient IMAP error', async () => {
  const server = await startImapServer({ failLogin: true });
  try {
    await assert.rejects(
      imapFetchMessages({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        username: 'sales@zhirai.example',
        password: 'wrong-password',
        timeoutMs: 5000,
      }),
      (error) => error instanceof ImapError && error.code === 'IMAP_LOGIN_FAILED',
    );
  } finally {
    await server.close();
  }
});

test('testImapConnection reports success and authentication failure', async () => {
  const server = await startImapServer();
  try {
    const ok = await testImapConnection(
      { address: 'sales@zhirai.example', imapHost: '127.0.0.1', imapPort: server.port, imapSecure: false, username: 'sales@zhirai.example' },
      { password: 'imap-secret' },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.exists, 3);
    const bad = await testImapConnection(
      { address: 'sales@zhirai.example', imapHost: '127.0.0.1', imapPort: server.port, imapSecure: false, username: 'sales@zhirai.example' },
      { password: 'nope' },
    );
    assert.equal(bad.ok, false);
    assert.match(bad.error, /登录失败/);
  } finally {
    await server.close();
  }
});

test('IMAP helpers parse dates, search responses and escape quoted strings', () => {
  assert.equal(parseImapDate('22-Oct-2026 12:00:00 +0200'), '2026-10-22T10:00:00.000Z');
  assert.equal(parseImapDate('22-Oct-2026 12:00:00 -0500'), '2026-10-22T17:00:00.000Z');
  assert.equal(parseImapDate('not a date'), null);
  assert.deepEqual(parseSearchResponse([{ line: '* SEARCH 3 1 2' }, { line: '* SEARCH 2 4' }]), [1, 2, 3, 4]);
  assert.deepEqual(parseSearchResponse([{ line: '* SEARCH' }]), []);
  assert.equal(escapeImapString('a"b\\c\r\nd'), '"a\\"b\\\\c  d"');
});
