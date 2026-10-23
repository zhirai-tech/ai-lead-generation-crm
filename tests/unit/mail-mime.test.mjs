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
  parseContentDisposition,
  parseMimeMessage,
  parseHeaderBlock,
  prepareAttachments,
  sanitizeAttachmentFilename,
  splitMultipart,
  splitRawMessage,
  textToHtml,
  MIME_ATTACHMENT_MAX_BYTES,
  MIME_ATTACHMENTS_TOTAL_MAX_BYTES,
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

// ------------------------------------------------------------------ attachments
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n\u0000\u00ff binary\n%%EOF\n', 'binary');

test('attachments build multipart/mixed with a nested multipart/alternative body', () => {
  const built = buildSample({ attachments: [{ filename: 'catalogue.pdf', mimeType: 'application/pdf', content: PDF_BYTES }] });
  assert.match(built.raw, /^Content-Type: multipart\/mixed; boundary="[^"]+"$/m);
  assert.ok(built.mixedBoundary);
  assert.ok(built.alternativeBoundary);
  assert.match(built.raw, /Content-Disposition: attachment; filename="catalogue\.pdf"/);
  assert.match(built.raw, /Content-Type: application\/pdf; name="catalogue\.pdf"/);
  assert.equal(built.attachments.length, 1);
  assert.equal(built.attachments[0].sizeBytes, PDF_BYTES.length);

  // Structural check: first mixed part is the alternative body, second is the PDF.
  const { bodyText } = splitRawMessage(built.raw);
  const parts = splitMultipart(bodyText, built.mixedBoundary);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /Content-Type: multipart\/alternative; boundary="/);
  const attachmentPart = splitRawMessage(parts[1]);
  assert.match(attachmentPart.headerText, /Content-Disposition: attachment; filename="catalogue\.pdf"/);
  const base64Body = attachmentPart.bodyText.replace(/\r\n/g, '\n').trim();
  assert.ok(base64Body.split('\n').every((line) => line.length <= 76), 'base64 lines are <= 76 chars');
  assert.deepEqual(Buffer.from(base64Body.replace(/\s+/g, ''), 'base64'), PDF_BYTES);

  // Parser round-trip: body text/html preserved and the binary attachment decodes.
  const parsed = parseMimeMessage(built.raw);
  assert.equal(parsed.attachments, 1);
  assert.equal(parsed.attachment.filename, 'catalogue.pdf');
  assert.equal(parsed.attachment.mimeType, 'application/pdf');
  assert.deepEqual(parsed.attachment.content, PDF_BYTES);
  assert.ok(parsed.text.includes('中德合资的工业零部件供应商'));
});

test('no attachments keeps the previous multipart/alternative structure', () => {
  const built = buildSample();
  assert.match(built.raw, /^Content-Type: multipart\/alternative; boundary="/m);
  assert.equal(built.mixedBoundary, null);
  assert.deepEqual(built.attachments, []);
});

test('non-ASCII attachment filenames use RFC 2231 encoding and parse back', () => {
  const built = buildSample({ attachments: [{ filename: '产品目录 2026.pdf', mimeType: 'application/pdf', content: PDF_BYTES }] });
  assert.match(built.raw, /filename\*=UTF-8''%E4%BA%A7%E5%93%81%E7%9B%AE%E5%BD%95%202026\.pdf/);
  const parsed = parseMimeMessage(built.raw);
  assert.equal(parsed.attachment.filename, '产品目录 2026.pdf');
});

test('attachment filenames are sanitised (path traversal, CRLF injection, NUL)', () => {
  assert.equal(sanitizeAttachmentFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeAttachmentFilename('C:\\Windows\\evil.pdf'), 'evil.pdf');
  const sanitised = sanitizeAttachmentFilename('evil\r\nBcc: attacker@evil.example\x00.pdf');
  assert.ok(!/[\r\n\u0000]/.test(sanitised), 'control characters removed');
  assert.ok(sanitised.endsWith('.pdf'));
  const built = buildSample({
    attachments: [{ filename: 'evil\r\nBcc: attacker@evil.example\x00.pdf', mimeType: 'application/pdf', content: PDF_BYTES }],
  });
  assert.ok(!/^Bcc:/m.test(built.raw), 'no injected Bcc header');
  const parsed = parseMimeMessage(built.raw);
  assert.ok(parsed.attachment.filename.endsWith('.pdf'));
  assert.equal(parseContentDisposition('attachment; filename="a b.pdf"').params.filename, 'a b.pdf');
});

test('prepareAttachments enforces per-file and total limits with warnings', () => {
  const small = { filename: 'a.pdf', mimeType: 'application/pdf', content: Buffer.alloc(1024, 1) };
  const oversized = { filename: 'huge.pdf', mimeType: 'application/pdf', content: Buffer.alloc(MIME_ATTACHMENT_MAX_BYTES + 1, 1) };
  const invalid = { filename: 'bad.pdf', mimeType: 'application/pdf', content: 'not-a-buffer' };
  const empty = { filename: 'empty.pdf', mimeType: 'application/pdf', content: Buffer.alloc(0) };

  const one = prepareAttachments([small]);
  assert.equal(one.attachments.length, 1);
  assert.equal(one.warnings.length, 0);
  assert.equal(one.totalBytes, 1024);

  const rejected = prepareAttachments([oversized, invalid, empty]);
  assert.equal(rejected.attachments.length, 0);
  assert.deepEqual(rejected.warnings.map((warning) => warning.code), [
    'MIME_ATTACHMENT_TOO_LARGE',
    'MIME_INVALID_ATTACHMENT',
    'MIME_EMPTY_ATTACHMENT',
  ]);

  // Total > 8MB: first ~4.5MB file accepted, second skipped.
  const chunk = () => Buffer.alloc(4_600_000, 2);
  const total = prepareAttachments([
    { filename: 'one.pdf', mimeType: 'application/pdf', content: chunk() },
    { filename: 'two.pdf', mimeType: 'application/pdf', content: chunk() },
  ]);
  assert.equal(total.attachments.length, 1);
  assert.equal(total.attachments[0].filename, 'one.pdf');
  assert.equal(total.warnings[0].code, 'MIME_ATTACHMENTS_TOTAL_TOO_LARGE');
  assert.ok(total.totalBytes <= MIME_ATTACHMENTS_TOTAL_MAX_BYTES);

  assert.throws(() => prepareAttachments('nope'), (error) => error.code === 'MIME_INVALID_ATTACHMENTS');
  assert.throws(
    () => prepareAttachments(Array.from({ length: 21 }, (_, index) => ({ filename: `f${index}.pdf`, content: Buffer.from('x') }))),
    (error) => error.code === 'MIME_TOO_MANY_ATTACHMENTS',
  );
});

test('buildMimeMessage rejects oversized attachments when called directly', () => {
  assert.throws(
    () => buildSample({ attachments: [{ filename: 'huge.pdf', mimeType: 'application/pdf', content: Buffer.alloc(MIME_ATTACHMENT_MAX_BYTES + 1) }] }),
    (error) => error.code === 'MIME_ATTACHMENT_REJECTED' && /单文件上限/.test(error.message),
  );
});

test('multiple attachments are all encoded with scoped boundaries', () => {
  const built = buildSample({
    attachments: [
      { filename: 'catalogue.pdf', mimeType: 'application/pdf', content: PDF_BYTES },
      { filename: 'spec.png', mimeType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ],
  });
  const parsed = parseMimeMessage(built.raw);
  assert.equal(parsed.attachments, 2);
  assert.deepEqual(parsed.attachmentList.map((item) => item.filename), ['catalogue.pdf', 'spec.png']);
  assert.deepEqual(parsed.attachmentList[1].content, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const closingBoundaries = built.raw.split(`--${built.mixedBoundary}--`).length - 1;
  assert.equal(closingBoundaries, 1);
});
