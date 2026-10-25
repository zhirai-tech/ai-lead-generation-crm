/**
 * OWNER: t-worker. RFC 5322 / RFC 2045 MIME builder and a small MIME parser.
 *
 * Everything is implemented on top of node built-ins (no third-party libs).
 * Security requirements:
 *  - header injection: any CR/LF inside a header value, address or display name
 *    is rejected with a MIME_HEADER_INJECTION error (never silently stripped);
 *  - all non-ASCII headers are encoded as RFC 2047 encoded-words;
 *  - all bodies are base64 encoded with CRLF line endings so 8-bit content and
 *    SMTP line-length limits can never corrupt a message;
 *  - List-Unsubscribe / List-Unsubscribe-Post headers are supported (one-click
 *    unsubscribe) and are emitted by the send pipeline for every outgoing mail.
 *
 * The parser side is intentionally "simple MIME" (multipart + base64 + QP +
 * RFC 2047 headers) which is what IMAP inbox sync needs.
 */
import { id } from '../core/ids.mjs';
import { normalizeEmail } from '../core/validate.mjs';

export const MIME_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MIME_MAX_BODY_BYTES = 512 * 1024;
/** Attachment limits from docs/MEDIA-ATTACHMENTS-CONTRACT.md section 4. */
export const MIME_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const MIME_ATTACHMENTS_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const MIME_MAX_ATTACHMENTS = 20;
const ATTACHMENT_FILENAME_MAX_LENGTH = 160;
const MAX_SUBJECT_LENGTH = 4000;

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,78}$/;
const CRLF_RE = /[\r\n]/;

export function mimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.name = 'MimeError';
  return error;
}

/** Reject CR/LF (and NUL) inside a header value — header injection guard. */
export function assertHeaderSafe(value, label = '邮件头') {
  const text = String(value ?? '');
  if (CRLF_RE.test(text) || text.includes('\u0000')) {
    throw mimeError('MIME_HEADER_INJECTION', `${label}包含非法换行符，已拒绝构建邮件`);
  }
  return text;
}

function assertAddress(address, label = '邮件地址') {
  const text = assertHeaderSafe(address, label).trim();
  if (!text || !EMAIL_RE.test(text)) {
    throw mimeError('MIME_INVALID_ADDRESS', `${label}不合法：${text.slice(0, 120)}`);
  }
  return text;
}

function needsEncodedWord(text) {
  return /[^\x20-\x7E]/.test(text);
}

/** RFC 2047 B-encoded word(s). ASCII values are returned unchanged. */
export function encodeHeaderValue(value) {
  const text = assertHeaderSafe(value, '邮件头值');
  if (!text) return '';
  if (!needsEncodedWord(text)) return text;
  const words = [];
  let current = '';
  let currentBytes = 0;
  for (const char of Array.from(text)) {
    const bytes = Buffer.byteLength(char, 'utf8');
    // 45 raw bytes => 60 base64 chars, plus `=?UTF-8?B?` (10) and `?=` (2) = 72 < 76.
    if (currentBytes + bytes > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current) words.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
  return words.join('\r\n ');
}

/** Format one address as `"显示名" <local@domain>` or `<local@domain>`. */
export function formatAddress(value) {
  if (!value) return '';
  const source = typeof value === 'string' ? { address: value } : value;
  const address = assertAddress(source.address, '收件人地址');
  const name = source.name === undefined || source.name === null ? '' : assertHeaderSafe(source.name, '显示名').trim();
  if (!name) return `<${address}>`;
  if (needsEncodedWord(name)) return `${encodeHeaderValue(name)} <${address}>`;
  if (/["()<>@,;:\\.[\]]/.test(name)) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${address}>`;
  }
  return `${name} <${address}>`;
}

export function formatAddressList(list) {
  const values = (Array.isArray(list) ? list : [list]).filter(Boolean);
  return values.map(formatAddress).join(', ');
}

export function normalizeAddressList(list) {
  const values = (Array.isArray(list) ? list : list ? [list] : []).map((item) => {
    const address = typeof item === 'string' ? item : item && item.address;
    return normalizeEmail(address);
  });
  return [...new Set(values.filter(Boolean))];
}

/** RFC 5322 date, e.g. `Thu, 22 Oct 2026 21:00:00 +0000`. */
export function formatRfc5322Date(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw mimeError('MIME_INVALID_DATE', '邮件日期不合法');
  return date.toUTCString().replace(/GMT$/, '+0000');
}

export function generateMessageId(fromAddress = '', now = Date.now()) {
  let domain = 'zhirai.local';
  const match = /@([^@>\s]+)>?$/.exec(String(fromAddress || ''));
  if (match) domain = match[1].toLowerCase();
  const stamp = new Date(now).getTime().toString(36);
  return `<${stamp}.${id('m').slice(-18).toLowerCase()}@${domain}>`;
}

// ------------------------------------------------------------------ encodings
/** Base64 with CRLF every `width` characters (no trailing CRLF). */
export function base64Lines(input, width = 76) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let index = 0; index < encoded.length; index += width) {
    lines.push(encoded.slice(index, index + width));
  }
  return lines.join('\r\n');
}

/** Quoted-printable encoder (RFC 2045). Exported for completeness/tests. */
export function encodeQuotedPrintable(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const chunks = [];
  let line = '';
  const pushLine = (soft) => {
    chunks.push(`${line}${soft ? '=' : ''}\r\n`);
    line = '';
  };
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === 0x0d) continue; // normalised below
    if (byte === 0x0a) {
      pushLine(false);
      continue;
    }
    let token;
    if ((byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9) token = String.fromCharCode(byte);
    else token = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    // Trailing whitespace must be encoded to survive transport.
    if ((byte === 32 || byte === 9) && (index + 1 >= buffer.length || buffer[index + 1] === 0x0a || buffer[index + 1] === 0x0d)) {
      token = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    if (line.length + token.length > 75) pushLine(true);
    line += token;
  }
  if (line.length) pushLine(false);
  return chunks.join('');
}

/** Decode RFC 2047 encoded-words. */
export function decodeHeaderValue(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (!text.includes('=?')) return text.replace(/\r?\n[ \t]+/g, ' ').trim();
  const decoded = text.replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, data) => {
    try {
      let buffer;
      if (encoding.toUpperCase() === 'B') buffer = Buffer.from(data, 'base64');
      else buffer = decodeQuotedPrintableBuffer(data.replace(/_/g, ' '));
      const label = String(charset || 'utf-8').toLowerCase();
      if (label.includes('iso-8859-1') || label.includes('latin1')) return buffer.toString('latin1');
      return buffer.toString('utf8');
    } catch {
      return match;
    }
  });
  return decoded.replace(/\r?\n[ \t]+/g, ' ').trim();
}

function decodeQuotedPrintableBuffer(value) {
  const text = String(value).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function decodeQuotedPrintable(value) {
  return decodeQuotedPrintableBuffer(value).toString('utf8');
}

export function decodeBase64(value) {
  const cleaned = String(value).replace(/\s+/g, '');
  return Buffer.from(cleaned, 'base64');
}

export function decodeTransferEncoding(body, encoding) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'binary');
  switch (String(encoding || '7bit').trim().toLowerCase()) {
    case 'base64':
      return decodeBase64(buffer.toString('ascii'));
    case 'quoted-printable':
      return decodeQuotedPrintableBuffer(buffer.toString('ascii'));
    case 'binary':
    case '8bit':
    case '7bit':
    default:
      return buffer;
  }
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function textToHtml(text) {
  const escaped = escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>\n');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">${escaped}</div>`;
}

/**
 * Build List-Unsubscribe headers. The one-click POST header is only emitted when
 * an HTTPS URL is supplied (RFC 8058).
 */
export function buildUnsubscribeHeaders({ url = '', mailto = '' } = {}) {
  const values = [];
  if (mailto) {
    const address = assertAddress(mailto, '退订邮箱');
    values.push(`<mailto:${address}>`);
  }
  if (url) {
    const safeUrl = assertHeaderSafe(url, '退订链接').trim();
    if (!/^https?:\/\//i.test(safeUrl)) throw mimeError('MIME_INVALID_UNSUBSCRIBE', '退订链接必须是 http(s) URL');
    if (safeUrl.includes('>')) throw mimeError('MIME_INVALID_UNSUBSCRIBE', '退订链接包含非法字符');
    values.push(`<${safeUrl}>`);
  }
  if (!values.length) return {};
  const headers = { 'List-Unsubscribe': values.join(', ') };
  if (url) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  return headers;
}

// --------------------------------------------------------------- attachments
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+\-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+\-]{0,60}$/i;

/** Strip paths / control chars from an attachment filename; never allow CRLF. */
export function sanitizeAttachmentFilename(value, fallback = 'attachment.bin') {
  let text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  text = text.replace(/^.*[\\/]/, '').replace(/["<>]/g, '');
  if (!text) return fallback;
  if (text.length > ATTACHMENT_FILENAME_MAX_LENGTH) {
    const dot = text.lastIndexOf('.');
    const extension = dot > 0 ? text.slice(dot).slice(0, 20) : '';
    text = `${text.slice(0, ATTACHMENT_FILENAME_MAX_LENGTH - extension.length)}${extension}`;
  }
  return text || fallback;
}

function normalizeMimeType(value) {
  const text = String(value || '').trim().toLowerCase();
  return MIME_TYPE_RE.test(text) ? text : 'application/octet-stream';
}

/** `filename="..."` for ASCII names, RFC 2231 `filename*=UTF-8''...` otherwise. */
export function formatAttachmentFilenameParam(filename, base = 'filename') {
  const safe = sanitizeAttachmentFilename(filename);
  if (/^[\x20-\x7E]+$/.test(safe) && !/["\\]/.test(safe)) return `${base}="${safe}"`;
  const encoded = encodeURIComponent(safe).replace(/['()*!]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${base}*=UTF-8''${encoded}`;
}

function normalizeAttachment(attachment, index) {
  if (!attachment || typeof attachment !== 'object') {
    throw mimeError('MIME_INVALID_ATTACHMENT', `附件 #${index + 1} 格式不正确`);
  }
  const content = Buffer.isBuffer(attachment.content)
    ? attachment.content
    : attachment.content instanceof Uint8Array
      ? Buffer.from(attachment.content)
      : null;
  if (!content) throw mimeError('MIME_INVALID_ATTACHMENT', `附件 #${index + 1} 缺少二进制内容`);
  return {
    filename: sanitizeAttachmentFilename(attachment.filename, `attachment-${index + 1}.bin`),
    mimeType: normalizeMimeType(attachment.mimeType),
    content,
    sizeBytes: content.length,
  };
}

/**
 * Validate + filter attachments against the size limits. Invalid / oversized
 * attachments are skipped with a structured warning so callers (send pipeline)
 * can continue without them, while `buildMimeMessage` turns warnings into a hard
 * error when used directly.
 * @returns {{attachments:Array, warnings:Array<{filename:string,code:string,message:string}>, totalBytes:number}}
 */
export function prepareAttachments(attachments) {
  if (attachments === undefined || attachments === null) return { attachments: [], warnings: [], totalBytes: 0 };
  if (!Array.isArray(attachments)) throw mimeError('MIME_INVALID_ATTACHMENTS', 'attachments 必须是数组');
  if (attachments.length > MIME_MAX_ATTACHMENTS) {
    throw mimeError('MIME_TOO_MANY_ATTACHMENTS', `附件数量超过上限（最多 ${MIME_MAX_ATTACHMENTS} 个）`);
  }
  const accepted = [];
  const warnings = [];
  let totalBytes = 0;
  attachments.forEach((attachment, index) => {
    const fallbackName = sanitizeAttachmentFilename(attachment && attachment.filename, `attachment-${index + 1}.bin`);
    let normalized;
    try {
      normalized = normalizeAttachment(attachment, index);
    } catch (error) {
      warnings.push({ filename: fallbackName, code: error.code || 'MIME_INVALID_ATTACHMENT', message: error.message });
      return;
    }
    if (normalized.sizeBytes === 0) {
      warnings.push({ filename: normalized.filename, code: 'MIME_EMPTY_ATTACHMENT', message: `附件 ${normalized.filename} 内容为空，已跳过` });
      return;
    }
    if (normalized.sizeBytes > MIME_ATTACHMENT_MAX_BYTES) {
      warnings.push({
        filename: normalized.filename,
        code: 'MIME_ATTACHMENT_TOO_LARGE',
        message: `附件 ${normalized.filename} 超过单文件上限 ${MIME_ATTACHMENT_MAX_BYTES} 字节，已跳过`,
      });
      return;
    }
    if (totalBytes + normalized.sizeBytes > MIME_ATTACHMENTS_TOTAL_MAX_BYTES) {
      warnings.push({
        filename: normalized.filename,
        code: 'MIME_ATTACHMENTS_TOTAL_TOO_LARGE',
        message: `附件总量超过上限 ${MIME_ATTACHMENTS_TOTAL_MAX_BYTES} 字节，已跳过 ${normalized.filename}`,
      });
      return;
    }
    totalBytes += normalized.sizeBytes;
    accepted.push(normalized);
  });
  return { attachments: accepted, warnings, totalBytes };
}

function attachmentPartLines(attachment) {
  return [
    `Content-Type: ${attachment.mimeType}; ${formatAttachmentFilenameParam(attachment.filename, 'name')}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; ${formatAttachmentFilenameParam(attachment.filename)}`,
    '',
    base64Lines(attachment.content),
  ];
}

// --------------------------------------------------------------------- build
/**
 * Build a complete RFC 5322 message.
 *
 * When attachments are supplied the top level becomes `multipart/mixed`; the
 * body keeps its `multipart/alternative` (text + html) or single-part form as
 * the first part. Attachment payloads are base64 encoded with 76-char lines.
 *
 * @param {object} input
 * @param {string|object} input.from
 * @param {Array<string|object>} input.to
 * @param {Array<string|object>} [input.cc]
 * @param {string} input.subject
 * @param {string} [input.text]
 * @param {string} [input.html]
 * @param {Date|string} [input.date]
 * @param {string} [input.inReplyTo]
 * @param {Array<string>} [input.references]
 * @param {{url?:string, mailto?:string}} [input.unsubscribe]
 * @param {Array<{filename:string, mimeType:string, content:Buffer}>} [input.attachments]
 * @param {object} [input.headers] additional headers (validated)
 * @returns {{raw:string, messageId:string, headers:object, boundary:string|null, mixedBoundary:string|null, alternativeBoundary:string|null, attachments:Array, attachmentBytes:number}}
 */
export function buildMimeMessage({
  from,
  to,
  cc = [],
  subject = '',
  text = '',
  html = '',
  date = new Date(),
  inReplyTo = null,
  references = [],
  unsubscribe = null,
  attachments = [],
  inlineImages = [],
  headers = {},
  messageId = null,
} = {}) {
  const fromAddress = typeof from === 'string' ? from : from && from.address;
  const fromValue = formatAddress(from);
  const toValue = formatAddressList(to);
  if (!toValue) throw mimeError('MIME_NO_RECIPIENTS', '至少需要一个收件人');
  const ccValue = formatAddressList(cc);

  const subjectText = assertHeaderSafe(String(subject ?? ''), '主题');
  if (Number(subjectText.length) > MAX_SUBJECT_LENGTH) throw mimeError('MIME_SUBJECT_TOO_LONG', '邮件主题过长');
  if (CRLF_RE.test(String(text ?? ''))) {
    // Body newlines are legal; only *header* injection is forbidden. Normalise later.
  }
  const textBody = normalizeBody(text);
  const htmlBody = normalizeBody(html);
  if (!textBody && !htmlBody) throw mimeError('MIME_EMPTY_BODY', '邮件正文不能为空');
  const totalBytes = Buffer.byteLength(textBody, 'utf8') + Buffer.byteLength(htmlBody, 'utf8');
  if (totalBytes > MIME_MAX_BODY_BYTES) throw mimeError('MIME_BODY_TOO_LARGE', '邮件正文过大');

  const finalMessageId = messageId ? assertHeaderSafe(messageId, 'Message-ID').trim() : generateMessageId(fromAddress, new Date(date).getTime());
  if (!/^<[^<>\r\n]+>$/.test(finalMessageId)) throw mimeError('MIME_INVALID_MESSAGE_ID', 'Message-ID 必须使用 <...> 形式');
  const safeInReplyTo = inReplyTo ? assertHeaderSafe(inReplyTo, 'In-Reply-To').trim() : '';
  const refs = (Array.isArray(references) ? references : references ? [references] : [])
    .filter(Boolean)
    .map((item) => assertHeaderSafe(item, 'References').trim());
  const unsubscribeHeaders = unsubscribe ? buildUnsubscribeHeaders(unsubscribe) : {};

  for (const [name, value] of Object.entries(unsubscribeHeaders)) {
    if (headers[name] === undefined) headers[name] = value;
  }

  const boundary = `=_zhirai_${Date.now().toString(36)}_${id('b').slice(-12)}`;
  const bodyEntity = buildBodyEntity({ text: textBody, html: htmlBody, boundary });

  // Inline images live in a multipart/related entity so clients can render them
  // directly from the message (no remote URL / "display images" prompt).
  const preparedInline = prepareAttachments(inlineImages);
  if (preparedInline.warnings.length) {
    throw mimeError('MIME_ATTACHMENT_REJECTED', preparedInline.warnings.map((warning) => warning.message).join('；'));
  }
  let bodyContentType = bodyEntity.contentType;
  let bodyTransferEncoding = bodyEntity.transferEncoding;
  let bodyPayload = bodyEntity.body;
  let relatedBoundary = null;
  if (preparedInline.attachments.length) {
    relatedBoundary = `=_zhirai_related_${Date.now().toString(36)}_${id('r').slice(-12)}`;
    const relatedLine = `--${relatedBoundary}`;
    const parts = [
      relatedLine,
      `Content-Type: ${bodyEntity.contentType}`,
      `Content-Transfer-Encoding: ${bodyEntity.transferEncoding}`,
      '',
      bodyEntity.body.replace(/\r\n$/, ''),
    ];
    preparedInline.attachments.forEach((image, index) => {
      const cid = inlineImages[index]?.cid || `product-image-${index + 1}`;
      parts.push(
        relatedLine,
        `Content-Type: ${image.mimeType}; ${formatAttachmentFilenameParam(image.filename, 'name')}`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${cid}>`,
        `Content-Disposition: inline; ${formatAttachmentFilenameParam(image.filename)}`,
        '',
        base64Lines(image.content),
      );
    });
    parts.push(`${relatedLine}--`, '');
    bodyContentType = `multipart/related; boundary="${relatedBoundary}"`;
    bodyTransferEncoding = '7bit';
    bodyPayload = parts.join('\r\n');
  }

  // Attachments: multipart/mixed wrapper around the body entity.
  const preparedAttachments = prepareAttachments(attachments);
  if (preparedAttachments.warnings.length) {
    throw mimeError('MIME_ATTACHMENT_REJECTED', preparedAttachments.warnings.map((warning) => warning.message).join('；'));
  }
  let contentType = bodyContentType;
  let transferEncoding = bodyTransferEncoding;
  let messageBody = bodyPayload;
  let mixedBoundary = null;
  if (preparedAttachments.attachments.length) {
    mixedBoundary = `=_zhirai_mixed_${Date.now().toString(36)}_${id('c').slice(-12)}`;
    const boundaryLine = `--${mixedBoundary}`;
    const parts = [
      boundaryLine,
      `Content-Type: ${bodyContentType}`,
      `Content-Transfer-Encoding: ${bodyTransferEncoding}`,
      '',
      bodyPayload.replace(/\r\n$/, ''),
    ];
    for (const attachment of preparedAttachments.attachments) {
      parts.push(boundaryLine, ...attachmentPartLines(attachment));
    }
    parts.push(`${boundaryLine}--`, '');
    messageBody = parts.join('\r\n');
    contentType = `multipart/mixed; boundary="${mixedBoundary}"`;
    transferEncoding = '7bit';
  }

  const lines = [
    `From: ${fromValue}`,
    `To: ${toValue}`,
    ccValue ? `Cc: ${ccValue}` : null,
    `Subject: ${encodeHeaderValue(subjectText)}`,
    `Date: ${formatRfc5322Date(date)}`,
    `Message-ID: ${finalMessageId}`,
    safeInReplyTo ? `In-Reply-To: ${normalizeMessageId(safeInReplyTo)}` : null,
    refs.length ? `References: ${refs.map(normalizeMessageId).join(' ')}` : null,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
    `Content-Transfer-Encoding: ${transferEncoding}`,
  ].filter(Boolean);

  const reserved = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding']);
  for (const [name, value] of Object.entries(headers || {})) {
    const headerName = assertHeaderSafe(name, '邮件头名称').trim();
    if (!HEADER_NAME_RE.test(headerName)) throw mimeError('MIME_INVALID_HEADER', `邮件头名称不合法：${headerName.slice(0, 80)}`);
    if (reserved.has(headerName.toLowerCase())) continue;
    const headerValue = assertHeaderSafe(value, `邮件头 ${headerName}`).replace(/\r?\n/g, ' ').trim();
    lines.push(`${headerName}: ${headerValue}`);
  }

  const raw = `${lines.join('\r\n')}\r\n\r\n${messageBody}`;
  if (Buffer.byteLength(raw, 'utf8') > MIME_MAX_MESSAGE_BYTES) throw mimeError('MIME_MESSAGE_TOO_LARGE', '邮件总大小超出限制');
  const headerMap = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index > 0) headerMap[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return {
    raw,
    messageId: finalMessageId,
    headers: headerMap,
    boundary: mixedBoundary || bodyEntity.boundary,
    mixedBoundary,
    alternativeBoundary: bodyEntity.boundary,
    attachments: preparedAttachments.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
    attachmentBytes: preparedAttachments.totalBytes,
  };
}

function normalizeBody(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

function buildBodyEntity({ text, html, boundary }) {
  if (text && html) {
    const boundaryLine = `--${boundary}`;
    const body = [
      boundaryLine,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(text),
      boundaryLine,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(html),
      `${boundaryLine}--`,
      '',
    ].join('\r\n');
    return {
      contentType: `multipart/alternative; boundary="${boundary}"`,
      transferEncoding: '7bit',
      body,
      boundary,
    };
  }
  const contentType = html ? 'text/html' : 'text/plain';
  return {
    contentType: `${contentType}; charset=UTF-8`,
    transferEncoding: 'base64',
    body: `${base64Lines(html || text)}\r\n`,
    boundary: null,
  };
}

export function normalizeMessageId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.startsWith('<') ? text : `<${text.replace(/^<|>$/g, '')}>`;
}

// --------------------------------------------------------------------- parse
/** Split raw RFC822 into `{headerText, bodyText}` at the first blank line. */
export function splitRawMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { headerText: text, bodyText: '' };
  const index = match.index;
  return { headerText: text.slice(0, index), bodyText: text.slice(index + match[0].length) };
}

/** Unfold and parse a header block into a lowercase-keyed object. */
export function parseHeaderBlock(headerText) {
  const headers = {};
  const unfolded = String(headerText || '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!name) continue;
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] = `${headers[name]}, ${value}`;
  }
  return headers;
}

/** Decode an RFC 2231 extended parameter value (`UTF-8''%E4%B8%AD.pdf`). */
export function decodeExtendedParam(value) {
  const text = String(value ?? '');
  const match = /^([^']*)'([^']*)'(.*)$/.exec(text);
  if (match) {
    try {
      return decodeURIComponent(match[3]);
    } catch {
      return match[3];
    }
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function parseContentType(value) {
  const text = String(value || 'text/plain').trim();
  const [rawType, ...rest] = text.split(';');
  const params = {};
  for (const part of rest) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const rawKey = part.slice(0, index).trim().toLowerCase();
    let paramValue = part.slice(index + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
    if (!rawKey) continue;
    const extended = rawKey.endsWith('*');
    params[extended ? rawKey.slice(0, -1) : rawKey] = extended ? decodeExtendedParam(paramValue) : paramValue;
  }
  return { type: rawType.trim().toLowerCase(), params };
}

/** Parse a Content-Disposition header into `{type, params}`. */
export function parseContentDisposition(value) {
  const text = String(value || '').trim();
  const [rawType, ...rest] = text.split(';');
  const params = {};
  for (const part of rest) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const rawKey = part.slice(0, index).trim().toLowerCase();
    let paramValue = part.slice(index + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
    if (!rawKey) continue;
    const extended = rawKey.endsWith('*');
    params[extended ? rawKey.slice(0, -1) : rawKey] = extended ? decodeExtendedParam(paramValue) : paramValue;
  }
  return { type: rawType.trim().toLowerCase(), params };
}

/** Split a multipart body on its boundary into raw part strings. */
export function splitMultipart(bodyText, boundary) {
  const text = String(bodyText || '');
  const marker = `--${boundary}`;
  const parts = [];
  let pos = text.indexOf(marker);
  while (pos >= 0) {
    let cursor = pos + marker.length;
    if (text.slice(cursor, cursor + 2) === '--') break; // closing boundary
    if (text.slice(cursor, cursor + 2) === '\r\n') cursor += 2;
    else if (text[cursor] === '\n') cursor += 1;
    let endIndex = -1;
    let nextStart = -1;
    const crlfIndex = text.indexOf(`\r\n${marker}`, cursor);
    if (crlfIndex >= 0) {
      endIndex = crlfIndex;
      nextStart = crlfIndex + 2;
    } else {
      const lfIndex = text.indexOf(`\n${marker}`, cursor);
      if (lfIndex >= 0) {
        endIndex = lfIndex;
        nextStart = lfIndex + 1;
      }
    }
    if (endIndex < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, endIndex));
    pos = nextStart;
  }
  return parts.filter((part) => part.trim());
}

/**
 * Parse one MIME entity (already separated from its parent).
 * @returns {{headers:object, text:string, html:string, attachments:number, attachment:object|null, attachmentList:Array, children:Array}}
 */
export function parseMimeEntity(headerText, bodyText) {
  const headers = parseHeaderBlock(headerText);
  const contentType = parseContentType(headers['content-type']);
  const decoded = decodeTransferEncoding(bodyText || '', headers['content-transfer-encoding']);
  const result = { headers, text: '', html: '', attachments: 0, attachment: null, attachmentList: [], children: [] };
  if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.params.boundary;
    if (!boundary) return result;
    for (const rawPart of splitMultipart(decoded.toString('binary'), boundary)) {
      const { headerText: partHeader, bodyText: partBody } = splitRawMessage(rawPart);
      const child = parseMimeEntity(partHeader, partBody);
      result.children.push(child);
      const childType = parseContentType(child.headers['content-type']).type;
      if (childType === 'text/plain' && !result.text) result.text = child.text;
      else if (childType === 'text/html' && !result.html) result.html = child.html;
      else if (!childType.startsWith('multipart/') && childType !== 'text/plain' && childType !== 'text/html') result.attachments += 1;
      if (!result.text && child.text) result.text = child.text;
      if (!result.html && child.html) result.html = child.html;
      if (child.attachment) result.attachmentList.push(child.attachment);
      else if (child.attachmentList.length) result.attachmentList.push(...child.attachmentList);
    }
    if (result.attachmentList.length === 1) result.attachment = result.attachmentList[0];
    return result;
  }
  const charset = String(contentType.params.charset || 'utf-8').toLowerCase();
  const content = charset.includes('iso-8859-1') || charset.includes('latin1') ? decoded.toString('latin1') : decoded.toString('utf8');
  if (contentType.type === 'text/html') {
    result.html = content;
    result.text = stripHtml(content);
  } else if (contentType.type === 'text/plain') {
    result.text = content;
  } else {
    result.attachments = 1;
    const disposition = parseContentDisposition(headers['content-disposition']);
    result.attachment = {
      filename: disposition.params.filename || contentType.params.name || null,
      mimeType: contentType.type,
      disposition: disposition.type || null,
      sizeBytes: decoded.length,
      content: decoded,
    };
    result.attachmentList = [result.attachment];
  }
  return result;
}

/** Parse a complete raw RFC822 message. */
export function parseMimeMessage(raw) {
  const { headerText, bodyText } = splitRawMessage(raw);
  return parseMimeEntity(headerText, bodyText);
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse an address header (`From`, `To`, …) into `[{name,address}]`. */
export function parseAddressHeader(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const chunks = splitAddressList(text);
  const addresses = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const angle = /^(.*?)<([^<>]+)>\s*$/.exec(trimmed);
    if (angle) {
      const name = decodeHeaderValue(angle[1].trim()).replace(/^"|"$/g, '').trim();
      addresses.push({ name, address: normalizeEmail(angle[2]) });
      continue;
    }
    const addr = normalizeEmail(trimmed.replace(/\([^)]*\)/g, '').trim());
    if (addr) addresses.push({ name: '', address: addr });
  }
  return addresses;
}

function splitAddressList(value) {
  const chunks = [];
  let current = '';
  let inQuotes = false;
  let depth = 0;
  for (const char of String(value)) {
    if (char === '"' && !inQuotes) inQuotes = true;
    else if (char === '"' && inQuotes) inQuotes = false;
    else if (char === '(' && !inQuotes) depth += 1;
    else if (char === ')' && !inQuotes) depth = Math.max(0, depth - 1);
    if (char === ',' && !inQuotes && depth === 0) {
      chunks.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** Build the normalized message object used by inbox sync. */
export function normalizeInboundMessage({ headers = {}, text = '', html = '', uid = null, internalDate = null } = {}) {
  const references = String(headers.references || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    uid,
    messageId: String(headers['message-id'] || '').trim() || null,
    inReplyTo: String(headers['in-reply-to'] || '').trim() || null,
    references,
    subject: decodeHeaderValue(headers.subject || ''),
    from: parseAddressHeader(headers.from)[0] || null,
    to: parseAddressHeader(headers.to),
    cc: parseAddressHeader(headers.cc),
    date: normalizeDate(headers.date, internalDate),
    text: text || (html ? stripHtml(html) : ''),
    html: html || '',
    headers,
  };
}

function normalizeDate(headerDate, fallback) {
  if (headerDate) {
    const parsed = new Date(headerDate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (fallback) {
    const parsed = new Date(fallback);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export default {
  MIME_MAX_MESSAGE_BYTES,
  MIME_MAX_BODY_BYTES,
  MIME_ATTACHMENT_MAX_BYTES,
  MIME_ATTACHMENTS_TOTAL_MAX_BYTES,
  MIME_MAX_ATTACHMENTS,
  assertHeaderSafe,
  encodeHeaderValue,
  decodeHeaderValue,
  formatAddress,
  formatAddressList,
  normalizeAddressList,
  formatRfc5322Date,
  generateMessageId,
  base64Lines,
  encodeQuotedPrintable,
  decodeQuotedPrintable,
  decodeTransferEncoding,
  escapeHtml,
  textToHtml,
  buildUnsubscribeHeaders,
  sanitizeAttachmentFilename,
  formatAttachmentFilenameParam,
  prepareAttachments,
  buildMimeMessage,
  parseMimeMessage,
  parseMimeEntity,
  splitRawMessage,
  splitMultipart,
  parseHeaderBlock,
  parseContentType,
  parseContentDisposition,
  decodeExtendedParam,
  parseAddressHeader,
  normalizeInboundMessage,
  normalizeMessageId,
  stripHtml,
};
