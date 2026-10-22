/**
 * t-worker unit tests: MIME construction (RFC 2047/2045), header injection
 * rejection, multiple recipients, unsubscribe headers, encodings and parsing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMimeMessage,
  buildUnsubscribeHeaders,
  base64Lines,
  decodeHeaderValue,
  encodeQuotedPrintable,
  decodeQuotedPrintable,
  formatAddress,
  formatAddressList,
  formatRfc5322Date,
  generateMessageId,
  parseAddressHeader,
  parseMimeMessage,
  parseHeaderBlock,
  textToHtml,
} from '../../server/mail/mime.mjs';

const CHINESE_SUBJECT = '合作询价：工业零部件供应（2026 春季）';
const CHINESE_BODY = '您好，我们是一家中德合资的工业零部件供应商。\n\n期待与贵司合作。\n\n价格与交期可进一步沟通。';

function buildSample(overrides = {}) {
  return buildMimeMessage({
    from: { name: 'ZHIRAI 销售团队', address: 'sales@zhirai.example' },
    to: [{ name: 'Max Mustermann', address: 'max@kunde.example' }, 'buyer@kunde.example'],
    subject: CHINESE_SUBJECT,
    text: CHINESE_BODY,
    html: textToHtml(CHINESE_BODY),
    date: new Date('2026-10-22T19:00:00.000Z'),
    inReplyTo: '<parent@zhirai.example>',
    references: ['<root@zhirai.example>', '<parent@zhirai.example>'],
    unsubscribe: { url: 'https://zhirai.cloud/u/abc', mailto: 'unsubscribe@zhirai.cloud' },
    headers: { 'X-ZHIRAI-Draft': 'drf_123' },
    ...overrides,
  });
}

test('Chinese subject and body are encoded per RFC 2047/2045 and parse back', () => {
  const built = buildSample();
  assert.match(built.raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(built.raw, /^MIME-Version: 1\.0$/m);
  assert.match(built.raw, /Content-Type: multipart\/alternative; boundary="/);
  const subjectHeader = built.headers.Subject;
  assert.equal(decodeHeaderValue(subjectHeader), CHINESE_SUBJECT);
  const parsed = parseMimeMessage(built.raw);
  assert.ok(parsed.text.includes('中德合资的工业零部件供应商'));
  assert.ok(parsed.html.includes('中德合资的工业零部件供应商'));
  assert.equal(parsed.attachments, 0);
});

test('multiple recipients and display names are formatted correctly', () => {
  const built = buildSample();
  assert.match(built.raw, /^To: Max Mustermann <max@kunde\.example>, <buyer@kunde\.example>$/m);
  const parsedTo = parseAddressHeader(built.headers.To);
  assert.equal(parsedTo.length, 2);
  assert.equal(parsedTo[0].address, 'max@kunde.example');
  assert.equal(parsedTo[0].name, 'Max Mustermann');
  assert.equal(parsedTo[1].address, 'buyer@kunde.example');
  // Names with specials must be quoted
  assert.match(formatAddress({ name: 'Doe, John', address: 'john@x.example' }), /^"Doe, John" <john@x\.example>$/);
  assert.equal(formatAddressList(['a@x.example', 'b@y.example']), '<a@x.example>, <b@y.example>');
});

test('unsubscribe headers include one-click post and mailto', () => {
  const built = buildSample();
  assert.match(built.raw, /^List-Unsubscribe: <mailto:unsubscribe@zhirai\.cloud>, <https:\/\/zhirai\.cloud\/u\/abc>$/m);
  assert.match(built.raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  const mailtoOnly = buildUnsubscribeHeaders({ mailto: 'unsubscribe@zhirai.cloud' });
  assert.equal(mailtoOnly['List-Unsubscribe-Post'], undefined);
  assert.throws(() => buildUnsubscribeHeaders({ url: 'ftp://x' }), /http\(s\)/);
  assert.throws(() => buildUnsubscribeHeaders({ url: 'https://x\r\nBcc: evil@x' }), /非法换行/);
});

test('header injection via CRLF is rejected (subject, name, address, custom header)', () => {
  assert.throws(
    () => buildSample({ subject: 'Hello\r\nBcc: attacker@evil.example' }),
    (error) => error.code === 'MIME_HEADER_INJECTION',
  );
  assert.throws(
    () => buildSample({ from: { name: 'Evil\r\nBcc: attacker@evil.example', address: 'sales@zhirai.example' } }),
    (error) => error.code === 'MIME_HEADER_INJECTION',
  );
  assert.throws(
    () => buildSample({ to: ['ok@x.example\r\nBcc: attacker@evil.example'] }),
    (error) => error.code === 'MIME_HEADER_INJECTION',
  );
  assert.throws(
    () => buildSample({ headers: { 'X-Test': 'value\r\nInjected: yes' } }),
    (error) => error.code === 'MIME_HEADER_INJECTION',
  );
  assert.throws(() => buildSample({ headers: { 'Bad Header': 'x' } }), (error) => error.code === 'MIME_INVALID_HEADER');
});

test('invalid addresses and empty bodies are rejected', () => {
  assert.throws(() => buildSample({ to: [] }), (error) => error.code === 'MIME_NO_RECIPIENTS');
  assert.throws(() => buildSample({ to: ['not-an-email'] }), (error) => error.code === 'MIME_INVALID_ADDRESS');
  assert.throws(() => buildSample({ to: ['a@x.example'], text: '', html: '' }), (error) => error.code === 'MIME_EMPTY_BODY');
});

test('message length limits are enforced', () => {
  const hugeBody = 'x'.repeat(600 * 1024);
  assert.throws(() => buildSample({ text: hugeBody }), (error) => error.code === 'MIME_BODY_TOO_LARGE');
  assert.throws(() => buildSample({ subject: 'x'.repeat(5000) }), (error) => error.code === 'MIME_SUBJECT_TOO_LONG');
});

test('base64 bodies use CRLF and stay within SMTP line length', () => {
  const encoded = base64Lines(Buffer.from(CHINESE_BODY.repeat(50), 'utf8'));
  const lines = encoded.split('\r\n');
  assert.ok(lines.every((line) => line.length <= 76));
  assert.match(encoded, /\r\n/);
});

test('quoted-printable round-trips UTF-8, equals signs and trailing spaces', () => {
  const source = '价格 = 100€（含税）  \n第二行\t测试';
  const encoded = encodeQuotedPrintable(source);
  assert.match(encoded, /=[0-9A-F]{2}/);
  assert.equal(decodeQuotedPrintable(encoded), `${source.replace(/\n/g, '\r\n')}\r\n`);
});

test('RFC 2047 Q-encoding, adjacent encoded words and unfolding decode correctly', () => {
  assert.equal(decodeHeaderValue('=?UTF-8?Q?=E4=B8=AD=E6=96=87?='), '中文');
  assert.equal(
    decodeHeaderValue('=?UTF-8?Q?=E4=B8=AD?= =?UTF-8?Q?=E6=96=87?='),
    '中文',
  );
  assert.equal(decodeHeaderValue('plain ascii'), 'plain ascii');
  const headers = parseHeaderBlock('Subject: one\r\n  two\r\nFrom: a@b.example\r\nX-Test: 1');
  assert.equal(headers.subject, 'one two');
  assert.equal(headers.from, 'a@b.example');
});

test('Message-ID, Date and References headers are RFC-shaped', () => {
  const built = buildSample();
  assert.match(built.messageId, /^<[^<>\s]+@zhirai\.example>$/);
  assert.match(built.raw, /^Date: Thu, 22 Oct 2026 19:00:00 \+0000$/m);
  assert.match(built.raw, /^In-Reply-To: <parent@zhirai\.example>$/m);
  assert.match(built.raw, /^References: <root@zhirai\.example> <parent@zhirai\.example>$/m);
  assert.equal(formatRfc5322Date(new Date('2026-01-02T03:04:05.000Z')), 'Fri, 02 Jan 2026 03:04:05 +0000');
  assert.match(generateMessageId('a@b.example'), /^<[^<>]+@b\.example>$/);
});

test('HTML escaping and plain-text to HTML conversion', () => {
  const html = textToHtml('<script>alert(1)</script>\nline2');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<br>'));
});
