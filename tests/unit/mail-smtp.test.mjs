/**
 * t-worker unit tests: SMTP client against a local in-process SMTP server.
 * No real mail service or external network is contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { smtpSend, testSmtpConnection, dotStuff, SmtpError, parseSmtpResponse, parseEhlo } from '../../server/mail/smtp.mjs';
import { buildMimeMessage } from '../../server/mail/mime.mjs';

/**
 * Minimal scripted SMTP server. Records the exact command sequence and DATA
 * payloads so the test can assert what went on the wire.
 */
async function startSmtpServer(options = {}) {
  const {
    failAuth = false,
    authMechanisms = ['PLAIN', 'LOGIN'],
    greeting = 220,
    rejectRecipients = [],
    silent = false,
  } = options;
  const commands = [];
  const dataBodies = [];
  const server = net.createServer((socket) => {
    if (silent) return;
    let buffer = '';
    let inData = false;
    let authState = null;
    let data = '';
    socket.write(`${greeting} test ESMTP ready\r\n`);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          dataBodies.push(data);
          commands.push({ command: 'DATA_BODY', value: data });
          data = '';
          inData = false;
          socket.write('250 2.0.0 Ok: queued\r\n');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        commands.push({ command: line });
        const upper = line.toUpperCase();
        if (authState === 'user') {
          authState = 'pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authState === 'pass') {
          authState = null;
          socket.write(failAuth ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 authenticated\r\n');
          continue;
        }
        if (upper.startsWith('EHLO')) {
          const lines = ['test.example', 'SIZE 10240000', `AUTH ${authMechanisms.join(' ')}`, 'OK'];
          socket.write(lines.map((item, index) => `250${index === lines.length - 1 ? ' ' : '-'}${item}`).join('\r\n') + '\r\n');
          continue;
        }
        if (upper.startsWith('HELO')) {
          socket.write('250 test.example\r\n');
          continue;
        }
        if (upper === 'STARTTLS') {
          socket.write('454 TLS not available\r\n');
          continue;
        }
        if (upper.startsWith('AUTH PLAIN')) {
          socket.write(failAuth ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 authenticated\r\n');
          continue;
        }
        if (upper === 'AUTH LOGIN') {
          authState = 'user';
          socket.write('334 VXNlcm5hbWU6\r\n');
          continue;
        }
        if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 Ok\r\n');
          continue;
        }
        if (upper.startsWith('RCPT TO')) {
          const match = /<([^>]+)>/.exec(line);
          const address = (match ? match[1] : '').toLowerCase();
          socket.write(rejectRecipients.includes(address) ? '550 5.1.1 mailbox unavailable\r\n' : '250 2.1.5 Ok\r\n');
          continue;
        }
        if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          continue;
        }
        if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          continue;
        }
        socket.write('250 Ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    commands,
    dataBodies,
    close: () => new Promise((resolve) => server.close(resolve)),
    commandNames: () => commands.map((entry) => entry.command.split(' ')[0].toUpperCase()),
  };
}

function sampleRaw() {
  return buildMimeMessage({
    from: { name: 'ZHIRAI', address: 'sales@zhirai.example' },
    to: [{ name: 'Max', address: 'max@kunde.example' }],
    subject: '你好，供应商合作',
    text: '您好，附件是我们的产品目录。',
    date: new Date('2026-10-22T19:00:00.000Z'),
  }).raw;
}

test('smtpSend performs EHLO/AUTH MAIL/RCPT/DATA/QUIT and reports accepted recipients', async () => {
  const server = await startSmtpServer();
  try {
    const raw = sampleRaw();
    const result = await smtpSend({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      username: 'sales@zhirai.example',
      password: 'super-secret-password',
      from: 'sales@zhirai.example',
      to: ['max@kunde.example', 'buyer@kunde.example'],
      raw,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.accepted, ['max@kunde.example', 'buyer@kunde.example']);
    assert.deepEqual(result.rejected, []);
    const names = server.commandNames();
    assert.equal(names[0], 'EHLO');
    assert.ok(server.commands.some((entry) => entry.command.startsWith('AUTH PLAIN ')), 'AUTH PLAIN used');
    assert.ok(server.commands.some((entry) => entry.command === 'MAIL FROM:<sales@zhirai.example>'));
    assert.ok(server.commands.some((entry) => entry.command === 'RCPT TO:<max@kunde.example>'));
    assert.ok(server.commands.some((entry) => entry.command === 'DATA'));
    assert.ok(names.includes('QUIT'));
    assert.equal(server.dataBodies.length, 1);
    assert.match(server.dataBodies[0], /^Subject: =\?UTF-8\?B\?/m);
  } finally {
    await server.close();
  }
});

test('dotStuff escapes leading dots and normalises CRLF', () => {
  assert.equal(dotStuff('a\r\n.b\r\n..c'), 'a\r\n..b\r\n...c\r\n');
  assert.equal(dotStuff('no trailing newline'), 'no trailing newline\r\n');
});

test('dot-stuffed lines are what arrives on the wire (DATA transparency)', async () => {
  const server = await startSmtpServer();
  try {
    await smtpSend({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      from: 'sales@zhirai.example',
      to: ['max@kunde.example'],
      raw: 'From: sales@zhirai.example\r\nTo: max@kunde.example\r\nSubject: dots\r\n\r\nline1\r\n.hidden line\r\n..two dots',
      timeoutMs: 5000,
    });
    assert.match(server.dataBodies[0], /\.\.hidden line/);
    assert.match(server.dataBodies[0], /\.\.\.two dots/);
  } finally {
    await server.close();
  }
});

test('AUTH LOGIN is used when the server only advertises LOGIN; credentials never logged', async () => {
  const server = await startSmtpServer({ authMechanisms: ['LOGIN'] });
  const logLines = [];
  const logger = { debug: (...args) => logLines.push(args), info: () => {}, warn: () => {}, error: () => {} };
  try {
    const result = await smtpSend({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      username: 'sales@zhirai.example',
      password: 'super-secret-password',
      from: 'sales@zhirai.example',
      to: ['max@kunde.example'],
      raw: sampleRaw(),
      timeoutMs: 5000,
      logger,
    });
    assert.equal(result.ok, true);
    assert.ok(server.commands.some((entry) => entry.command === 'AUTH LOGIN'));
    const userLine = server.commands.find((entry) => entry.command === Buffer.from('sales@zhirai.example').toString('base64'));
    assert.ok(userLine, 'username sent base64 encoded');
    const serialisedLogs = JSON.stringify(logLines);
    assert.equal(serialisedLogs.includes('super-secret-password'), false, 'password must never be logged');
    assert.equal(serialisedLogs.includes(Buffer.from('super-secret-password').toString('base64')), false);
  } finally {
    await server.close();
  }
});

test('partial RCPT rejection still delivers to accepted recipients', async () => {
  const server = await startSmtpServer({ rejectRecipients: ['bad@kunde.example'] });
  try {
    const result = await smtpSend({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      from: 'sales@zhirai.example',
      to: ['ok@kunde.example', 'bad@kunde.example'],
      raw: sampleRaw(),
      timeoutMs: 5000,
    });
    assert.deepEqual(result.accepted, ['ok@kunde.example']);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].code, 550);
  } finally {
    await server.close();
  }
});

test('all recipients rejected raises a permanent error', async () => {
  const server = await startSmtpServer({ rejectRecipients: ['bad@kunde.example'] });
  try {
    await assert.rejects(
      smtpSend({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        from: 'sales@zhirai.example',
        to: ['bad@kunde.example'],
        raw: sampleRaw(),
        timeoutMs: 5000,
      }),
      (error) => error instanceof SmtpError && error.code === 'SMTP_ALL_RECIPIENTS_REJECTED' && error.transient === false,
    );
  } finally {
    await server.close();
  }
});

test('535 authentication failure is classified as permanent and never retried as transient', async () => {
  const server = await startSmtpServer({ failAuth: true });
  try {
    await assert.rejects(
      smtpSend({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        username: 'sales@zhirai.example',
        password: 'wrong',
        from: 'sales@zhirai.example',
        to: ['max@kunde.example'],
        raw: sampleRaw(),
        timeoutMs: 5000,
      }),
      (error) => error instanceof SmtpError && error.code === 'SMTP_AUTH_FAILED' && error.transient === false,
    );
  } finally {
    await server.close();
  }
});

test('4xx greeting is a transient error', async () => {
  const server = await startSmtpServer({ greeting: 421 });
  try {
    await assert.rejects(
      smtpSend({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        from: 'sales@zhirai.example',
        to: ['max@kunde.example'],
        raw: sampleRaw(),
        timeoutMs: 5000,
      }),
      (error) => error instanceof SmtpError && error.code === 'SMTP_TRANSIENT' && error.transient === true,
    );
  } finally {
    await server.close();
  }
});

test('connection timeout produces a transient SmtpError', async () => {
  const server = await startSmtpServer({ silent: true });
  try {
    await assert.rejects(
      smtpSend({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        from: 'sales@zhirai.example',
        to: ['max@kunde.example'],
        raw: sampleRaw(),
        timeoutMs: 300,
      }),
      (error) => error instanceof SmtpError && (error.code === 'SMTP_TIMEOUT' || error.code === 'SMTP_NETWORK'),
    );
  } finally {
    await server.close();
  }
});

test('testSmtpConnection reports success and failure without throwing', async () => {
  const server = await startSmtpServer();
  try {
    const ok = await testSmtpConnection(
      { address: 'sales@zhirai.example', smtpHost: '127.0.0.1', smtpPort: server.port, smtpSecure: false, username: 'sales@zhirai.example' },
      { password: 'secret' },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.auth, 'PLAIN');
  } finally {
    await server.close();
  }
  const unreachable = await testSmtpConnection(
    { address: 'sales@zhirai.example', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecure: false },
    {},
    { timeoutMs: 500 },
  );
  assert.equal(unreachable.ok, false);
  assert.ok(unreachable.error);
});

test('SMTP response and EHLO parsers handle multiline replies', () => {
  const parsed = parseSmtpResponse('250-test\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n');
  assert.equal(parsed.code, 250);
  assert.deepEqual(parsed.lines, ['test', 'STARTTLS', 'AUTH PLAIN LOGIN']);
  assert.equal(parseSmtpResponse('250 partial'), null);
  const capabilities = parseEhlo(['test', 'STARTTLS', 'AUTH PLAIN LOGIN', 'SIZE 1000']);
  assert.equal(capabilities.starttls, true);
  assert.deepEqual(capabilities.auth, ['PLAIN', 'LOGIN']);
  assert.equal(capabilities.size, 1000);
});
