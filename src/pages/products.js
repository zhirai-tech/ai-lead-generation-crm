/**
 * Product catalogue page.
 *
 * Products are the single source of truth for outward claims. Certifications,
 * capacity, MOQ, pricing and lead time are stored exactly as entered; the UI
 * never generates or suggests facts. Media (main image + PDF documents) and
 * keywords are supplementary and always user-approved before saving.
 */
import { append, clear, el } from '../utils/dom.mjs';
import { api, queryString } from '../app/api.mjs';
import { can } from '../app/state.mjs';
import { formatDateTime, relativeTime, truncate } from '../utils/format.mjs';
import {
  badge,
  button,
  confirmDialog,
  dataTable,
  emptyState,
  field,
  helpTip,
  icon,
  input,
  loadingBlock,
  notice,
  openModal,
  pageHeader,
  pagination,
  searchInput,
  select,
  textarea,
  toast,
  toolbar,
} from '../components/ui.mjs';
import { splitList } from './companies.js';

export const meta = {
  title: '产品资料',
  help: '产品参数、认证、MOQ、交付条件、图片/PDF 资料与关键词。所有对外承诺（认证、产能、价格、交期）必须来自这里的已确认资料；AI 只扩展关键词，不得编造事实。',
};

const PAGE_SIZE = 12;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const PDF_MIME = 'application/pdf';
const MAX_KEYWORDS = 30;
const KEYWORD_MAX_LENGTH = 80;

const PRODUCT_STATUS = {
  active: ['在售', 'green'],
  draft: ['草稿', 'yellow'],
  archived: ['已归档', 'gray'],
};

const STATUS_OPTIONS = [
  ['active', '在售'],
  ['draft', '草稿'],
  ['archived', '已归档'],
];

const TEMPLATE_STATUS = {
  draft: ['草稿', 'gray'],
  pending_approval: ['待确认', 'yellow'],
  approved: ['已生效', 'green'],
  disabled: ['已停用', 'gray'],
};

const EMAIL_LANGUAGES = [
  ['en', 'English'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['it', 'Italiano'],
  ['es', 'Español'],
  ['nl', 'Nederlands'],
  ['pl', 'Polski'],
];

const TEMPLATE_VARIABLES = ['{{companyName}}', '{{contactFirstName}}', '{{country}}', '{{productCatalogueUrl}}'];

let disposed = false;
let cleanup = [];

function errorMessage(error) {
  return error && error.message ? error.message : '请求失败，请稍后重试';
}

function unwrapList(data) {
  if (Array.isArray(data)) return { items: data, total: data.length };
  const items = Array.isArray(data && data.items) ? data.items : [];
  const total = Number(data && data.total);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function productStatusBadge(status) {
  const found = PRODUCT_STATUS[status] || [status || '未知', 'gray'];
  return badge(found[0], found[1]);
}

function isImageFile(file) {
  return Boolean(file) && (file.kind === 'image' || String(file.mimeType || '').startsWith('image/'));
}

function isPdfFile(file) {
  return Boolean(file) && (file.kind === 'document' || file.mimeType === PDF_MIME);
}

function productFiles(product) {
  return safeArray(product && product.files);
}

/** Main image URL: explicit mainImageUrl, then the isMain image, then first image. */
function productImageUrl(product) {
  if (!product) return '';
  if (product.mainImageUrl) return product.mainImageUrl;
  const files = productFiles(product);
  const main = files.find((file) => isImageFile(file) && file.isMain);
  const first = main || files.find((file) => isImageFile(file));
  return first ? first.url || '' : '';
}

function placeholderThumb() {
  const thumb = el('span', 'page-product-thumb placeholder');
  thumb.appendChild(icon('box', 18));
  return thumb;
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function detectMime(file) {
  const type = String((file && file.type) || '').toLowerCase();
  if (type) return type;
  const ext = String((file && file.name) || '').split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'pdf') return 'application/pdf';
  return '';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function dataUrlBase64(dataUrl) {
  const text = String(dataUrl || '');
  const index = text.indexOf(',');
  return index >= 0 ? text.slice(index + 1) : text;
}

function absoluteUrl(path) {
  const value = String(path || '').trim();
  if (!value) return '';
  try {
    return new URL(value, window.location.origin).href;
  } catch {
    return value;
  }
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return false;
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard unavailable');
    }
    await navigator.clipboard.writeText(text);
    toast('公开链接已复制', 'success', 1800);
    return true;
  } catch {
    toast('复制失败，请手动选择链接', 'error');
    return false;
  }
}

/** Clean keyword input: trim, drop blanks/duplicates, cap length and count. */
function sanitizeKeywords(value) {
  const seen = new Set();
  const out = [];
  for (const item of splitList(value)) {
    const word = item.trim().slice(0, KEYWORD_MAX_LENGTH);
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

// ------------------------------------------------------- email templates
function templateStatusBadge(status) {
  const found = TEMPLATE_STATUS[status] || [status || '未知', 'gray'];
  return badge(found[0], found[1], { dot: true });
}

function languageLabel(value) {
  const found = EMAIL_LANGUAGES.find(([key]) => key === value);
  return found ? found[1] : value || '—';
}

function normalizeTemplateAttachment(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    productFileId: item.productFileId || item.fileId || item.id || null,
    filename: item.filename || item.name || '附件',
    mimeType: item.mimeType || item.type || '',
    sizeBytes: Number(item.sizeBytes ?? item.size ?? 0),
    publicUrl: item.publicUrl || item.url || '',
  };
}

function attachmentLabel(file) {
  const mimeType = String((file && file.mimeType) || '').toLowerCase();
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return '图片';
  return mimeType || '文件';
}

function normalizeTemplate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.templateId || raw.template_id || null;
  if (!id) return null;
  const bodyText = raw.bodyText ?? raw.body ?? raw.body_text ?? '';
  return {
    id,
    version: raw.version ?? null,
    subject: raw.subject || '',
    bodyText: String(bodyText || ''),
    language: raw.language || 'en',
    status: raw.status || 'draft',
    variables: safeArray(raw.variables || raw.variables_json),
    attachments: safeArray(raw.attachments || raw.attachments_json)
      .map(normalizeTemplateAttachment)
      .filter(Boolean),
    generatedBy: raw.generatedBy || null,
    approvedBy: raw.approvedBy || null,
    approvedAt: raw.approvedAt || null,
    createdBy: raw.createdBy || null,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

/** Accept {template, approved}, {item}, an array, or a bare template object. */
function parseTemplatePayload(data) {
  if (Array.isArray(data)) {
    const items = data.map(normalizeTemplate).filter(Boolean);
    return { template: items[0] || null, approved: items.find((item) => item.status === 'approved') || null };
  }
  const payload = data && typeof data === 'object' ? data : {};
  const template = normalizeTemplate(payload.template) || normalizeTemplate(payload.item) || normalizeTemplate(payload);
  const approved =
    normalizeTemplate(payload.approved) || (template && template.status === 'approved' ? template : null);
  return { template, approved };
}

// ------------------------------------------------------------------ page
export async function render(root, params, ctx) {
  clear(root);
  disposed = false;
  cleanup = [];
  let searchTimer = null;

  const state = {
    q: '',
    status: '',
    page: 1,
    items: [],
    total: 0,
  };
  const listHost = el('div', 'stack');
  const paginationHost = el('div', '');
  const writable = can('data.write');
  const canDelete = can('data.delete');

  function openProductForm(product = null) {
    const editing = Boolean(product && product.id);
    const specsValue = product && product.specs && Object.keys(product.specs).length ? JSON.stringify(product.specs, null, 2) : '';
    const controls = {
      name: input({ value: product ? product.name || '' : '', placeholder: '例如 陶瓷刹车片 Ceramic Brake Pads' }),
      category: input({ value: product ? product.category || '' : '', placeholder: '例如 Automotive Aftermarket' }),
      sku: input({ value: product ? product.sku || '' : '', placeholder: '例如 BP-2024-CER' }),
      status: select({
        value: product && product.status ? product.status : 'active',
        options: STATUS_OPTIONS.map(([value, label]) => ({ value, label })),
      }),
      description: textarea({ value: product ? product.description || '' : '', rows: 3 }),
      materials: input({ value: product ? product.materials || '' : '', placeholder: '例如 陶瓷纤维、钢背' }),
      capacity: input({ value: product ? product.capacity || '' : '', placeholder: '例如 月产 50,000 套' }),
      moq: input({ value: product ? product.moq || '' : '', placeholder: '例如 500 套 / 型号' }),
      pricingTerms: input({ value: product ? product.pricingTerms || '' : '', placeholder: '例如 FOB Shanghai，30% 预付' }),
      samples: input({ value: product ? product.samples || '' : '', placeholder: '例如 可提供付费样品，7 天寄出' }),
      leadTime: input({ value: product ? product.leadTime || '' : '', placeholder: '例如 30-45 天' }),
      certifications: textarea({
        value: product ? safeArray(product.certifications).join('\n') : '',
        rows: 3,
        placeholder: '每行一项，例如\nE-Mark\nISO 9001:2015',
      }),
      applications: textarea({
        value: product ? safeArray(product.applications).join(', ') : '',
        rows: 2,
        placeholder: '逗号分隔，例如 乘用车, 商用车, 售后维修',
      }),
      specs: textarea({ value: specsValue, rows: 5, placeholder: '{"voltage":"12V","thickness":"18mm"}' }),
      keywords: textarea({
        value: product ? safeArray(product.keywords).join(', ') : '',
        rows: 2,
        placeholder: '逗号或换行分隔，例如 brake pads, aftermarket, distributor',
      }),
    };

    // ---------------------------------------------------------- media state
    const media = {
      files: [],
      pending: [],
      loading: editing,
      error: null,
      busy: false,
      changed: false,
    };
    let saved = false;
    let keywordsNoteHost = null;
    let mediaListHost = null;
    let aiLabel = null;
    let aiBtn = null;
    const imageInput = input({ type: 'file', className: 'hidden' });
    imageInput.accept = 'image/png,image/jpeg,image/webp';
    const pdfInput = input({ type: 'file', className: 'hidden' });
    pdfInput.accept = 'application/pdf';

    async function loadFiles() {
      if (!editing) {
        media.loading = false;
        renderMedia();
        return;
      }
      media.loading = true;
      renderMedia();
      try {
        const data = await api.get(`/api/v1/products/${encodeURIComponent(product.id)}/files`);
        media.files = unwrapList(data).items.filter((file) => isImageFile(file) || isPdfFile(file));
        media.error = null;
      } catch (error) {
        media.files = [];
        media.error = errorMessage(error);
      } finally {
        media.loading = false;
        renderMedia();
      }
    }

    async function uploadFile(payload) {
      if (!product || !product.id) return false;
      try {
        await api.post(`/api/v1/products/${encodeURIComponent(product.id)}/files`, payload);
        media.changed = true;
        await loadFiles();
        return true;
      } catch (error) {
        toast(`文件「${payload.filename}」上传失败：${errorMessage(error)}`, 'error');
        return false;
      }
    }

    function setBusy(value) {
      media.busy = value;
      imageInput.disabled = value;
      pdfInput.disabled = value;
      renderMedia();
    }

    async function handlePicked(file, kind) {
      if (!file || media.busy) return;
      const mimeType = detectMime(file);
      const expected = kind === 'image' ? IMAGE_MIMES : [PDF_MIME];
      if (!expected.includes(mimeType)) {
        toast(kind === 'image' ? '仅支持 PNG / JPEG / WebP 图片' : '仅支持 PDF 文档', 'warning');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast(`文件大小不能超过 8MB（当前 ${formatFileSize(file.size)}）`, 'warning');
        return;
      }
      let dataUrl;
      try {
        dataUrl = await readFileAsDataUrl(file);
      } catch (error) {
        toast(errorMessage(error), 'error');
        return;
      }
      const payload = {
        filename: file.name || (kind === 'image' ? 'image' : 'document.pdf'),
        mimeType,
        dataBase64: dataUrlBase64(dataUrl),
        sizeBytes: file.size,
        kind,
      };
      if (!editing) {
        media.pending.push({ ...payload, kind, dataUrl });
        renderMedia();
        return;
      }
      setBusy(true);
      const ok = await uploadFile(payload);
      setBusy(false);
      if (ok) toast('文件已上传', 'success');
    }

    imageInput.addEventListener('change', () => {
      const file = imageInput.files && imageInput.files[0];
      imageInput.value = '';
      void handlePicked(file, 'image');
    });
    pdfInput.addEventListener('change', () => {
      const file = pdfInput.files && pdfInput.files[0];
      pdfInput.value = '';
      void handlePicked(file, 'document');
    });

    async function setMainImage(file) {
      try {
        await api.post(
          `/api/v1/products/${encodeURIComponent(product.id)}/files/${encodeURIComponent(file.id)}/main`,
          {},
        );
        toast('已设为主图', 'success');
        media.changed = true;
        await loadFiles();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }

    async function removeUploadedFile(file) {
      const confirmed = await confirmDialog({
        title: '删除文件',
        message: `确认删除「${file.filename}」？删除后不会再作为邮件附件或公开链接使用。`,
        confirmText: '删除',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api.delete(
          `/api/v1/products/${encodeURIComponent(product.id)}/files/${encodeURIComponent(file.id)}`,
        );
        toast('文件已删除', 'success');
        media.changed = true;
        await loadFiles();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }

    function mediaActions(file) {
      const row = el('div', 'row');
      append(row, [
        button('复制链接', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'copy',
          disabled: !file.publicUrl,
          title: file.publicUrl ? '复制公开链接' : '该文件没有公开链接',
          onClick: () => copyText(absoluteUrl(file.publicUrl)),
        }),
        button('删除', {
          size: 'sm',
          variant: 'ghost',
          iconName: 'trash',
          disabled: media.busy,
          onClick: () => removeUploadedFile(file),
        }),
      ]);
      return row;
    }

    function renderImageItem({ url, filename, sizeBytes, isMain, onRemove, onSetMain }) {
      const item = el('div', 'page-media-item');
      const img = el('img', '');
      img.src = url;
      img.alt = filename || '产品图片';
      img.loading = 'lazy';
      const name = el('div', 'page-media-name', filename || '图片');
      const meta = el('div', 'page-media-meta', `${formatFileSize(sizeBytes)}${isMain ? ' · 当前主图' : ''}`);
      const actions = el('div', 'row page-media-actions');
      if (onSetMain && !isMain) {
        append(actions, [
          button('设为主图', { size: 'sm', variant: 'ghost', iconName: 'star', onClick: onSetMain }),
        ]);
      }
      append(actions, [
        onRemove
          ? button('移除', { size: 'sm', variant: 'ghost', iconName: 'trash', onClick: onRemove })
          : button('删除', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'trash',
              disabled: media.busy,
              onClick: () => removeUploadedFile({ id: '', filename }),
            }),
      ]);
      append(item, [img, name, meta, actions]);
      return item;
    }

    function renderMedia() {
      if (!mediaListHost) return;
      clear(mediaListHost);
      if (media.loading) {
        mediaListHost.appendChild(loadingBlock('正在加载文件…'));
        return;
      }
      if (media.error) {
        const errorBox = el('div', 'page-media-error');
        append(errorBox, [
          notice(`文件接口暂不可用：${media.error}。可先编辑并保存其他字段。`, 'warn'),
          button('重试加载文件', { size: 'sm', iconName: 'refresh', onClick: () => loadFiles() }),
        ]);
        mediaListHost.appendChild(errorBox);
      }

      const images = media.files.filter(isImageFile);
      const documents = media.files.filter(isPdfFile);

      if (images.length) {
        const group = el('div', 'page-media-group');
        const thumbs = el('div', 'page-media-thumbs');
        for (const file of images) {
          thumbs.appendChild(
            renderImageItem({
              url: file.url || '',
              filename: file.filename,
              sizeBytes: file.sizeBytes,
              isMain: Boolean(file.isMain),
              onSetMain: () => setMainImage(file),
              onRemove: () => removeUploadedFile(file),
            }),
          );
        }
        append(group, [el('span', 'page-media-label', '已上传图片'), thumbs]);
        mediaListHost.appendChild(group);
      }
      if (media.pending.filter((item) => item.kind === 'image').length) {
        const group = el('div', 'page-media-group');
        const thumbs = el('div', 'page-media-thumbs');
        media.pending
          .filter((item) => item.kind === 'image')
          .forEach((item) => {
            thumbs.appendChild(
              renderImageItem({
                url: item.dataUrl,
                filename: item.filename,
                sizeBytes: item.sizeBytes,
                isMain: false,
                onRemove: () => {
                  media.pending.splice(media.pending.indexOf(item), 1);
                  renderMedia();
                },
              }),
            );
          });
        append(group, [
          el('span', 'page-media-label', '待上传图片'),
          thumbs,
        ]);
        mediaListHost.appendChild(group);
      }

      if (documents.length) {
        const group = el('div', 'page-media-group');
        const docs = el('div', 'page-media-docs');
        for (const file of documents) {
          const row = el('div', 'page-media-doc');
          const info = el('div', 'page-media-doc-info');
          append(info, [
            el('b', '', file.filename || 'PDF 文档'),
            el('span', 'muted', formatFileSize(file.sizeBytes)),
          ]);
          append(row, [info, mediaActions(file)]);
          docs.appendChild(row);
        }
        append(group, [el('span', 'page-media-label', '已上传 PDF'), docs]);
        mediaListHost.appendChild(group);
      }
      if (media.pending.filter((item) => item.kind === 'document').length) {
        const group = el('div', 'page-media-group');
        const docs = el('div', 'page-media-docs');
        media.pending
          .filter((item) => item.kind === 'document')
          .forEach((item) => {
            const row = el('div', 'page-media-doc');
            const info = el('div', 'page-media-doc-info');
            append(info, [el('b', '', item.filename), el('span', 'muted', formatFileSize(item.sizeBytes))]);
            append(row, [
              info,
              el('div', 'row', [
                button('移除', {
                  size: 'sm',
                  variant: 'ghost',
                  iconName: 'trash',
                  onClick: () => {
                    media.pending.splice(media.pending.indexOf(item), 1);
                    renderMedia();
                  },
                }),
              ]),
            ]);
            docs.appendChild(row);
          });
        append(group, [el('span', 'page-media-label', '待上传 PDF'), docs]);
        mediaListHost.appendChild(group);
      }

      if (!media.files.length && !media.pending.length && !media.error) {
        mediaListHost.appendChild(
          el('div', 'page-media-empty', editing ? '还没有图片或 PDF 资料' : '还没有选择文件，保存产品后会自动上传'),
        );
      }
    }

    async function generateKeywords() {
      if (!editing || !product || !product.id) {
        toast('请先保存产品，再生成关键词', 'warning');
        return;
      }
      aiBtn.disabled = true;
      aiLabel.textContent = '生成中…';
      try {
        const result = await api.post(
          `/api/v1/products/${encodeURIComponent(product.id)}/generate-keywords`,
          {},
        );
        const keywords = sanitizeKeywords(safeArray(result && result.keywords).join(', '));
        if (!keywords.length) {
          toast('AI 未返回可用关键词，请稍后重试', 'warning');
          return;
        }
        controls.keywords.value = keywords.join(', ');
        toast(`已生成 ${keywords.length} 个关键词`, 'success');
        clear(keywordsNoteHost);
        const negativeKeywords = safeArray(result && result.negativeKeywords);
        const notes = (result && result.notes) || '仅基于已填产品资料扩展关键词';
        const noteParts = [`AI 说明：${notes}`];
        if (negativeKeywords.length) noteParts.push(`建议排除词：${negativeKeywords.slice(0, 12).join('、')}`);
        keywordsNoteHost.appendChild(helpTip(noteParts.join('；')));
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        aiBtn.disabled = false;
        aiLabel.textContent = 'AI 生成关键词';
      }
    }

    // ---------------------------------------------------------- form layout
    const descriptionField = field('产品描述', controls.description, {
      help: '只写已确认的参数与用途；描述会作为匹配与写信的事实依据。',
    });
    descriptionField.classList.add('span-2');
    const certField = field('认证', controls.certifications, {
      help: '每行一项，仅填写已获得的认证；不允许编造。',
    });
    certField.classList.add('span-2');
    const appField = field('应用场景', controls.applications, { help: '逗号分隔；用于规则匹配产品与企业业务。' });
    appField.classList.add('span-2');
    const specsField = field('规格（JSON）', controls.specs, {
      help: '必须是合法 JSON 对象，例如 {"material":"ceramic"}；保存前会校验格式。',
    });
    specsField.classList.add('span-2');

    // Keywords -------------------------------------------------------------
    aiLabel = el('span', '', 'AI 生成关键词');
    aiBtn = button(null, {
      size: 'sm',
      variant: 'outline',
      iconName: 'sparkles',
      disabled: !editing || !writable,
      title: editing ? '基于已填产品资料生成关键词' : '保存产品后可生成关键词',
      onClick: generateKeywords,
    });
    aiBtn.appendChild(aiLabel);
    keywordsNoteHost = el('span', 'row');
    const keywordActions = el('div', 'page-keyword-actions');
    append(keywordActions, [aiBtn, keywordsNoteHost]);
    const keywordWrap = el('div', 'page-keyword-field');
    append(keywordWrap, [controls.keywords, keywordActions]);
    const keywordField = field('关键词', keywordWrap, {
      help: '逗号或换行分隔，最多 30 个、每个 ≤80 字符；可手动填写或使用 AI 生成后核对再保存。AI 只基于已填资料扩展，不编造认证或客户。',
    });
    keywordField.classList.add('span-2');

    // Media ---------------------------------------------------------------
    mediaListHost = el('div', 'page-media-list');
    const pickImageBtn = button('选择图片', {
      size: 'sm',
      variant: 'outline',
      iconName: 'upload',
      disabled: !writable,
      onClick: () => imageInput.click(),
    });
    const pickPdfBtn = button('选择 PDF', {
      size: 'sm',
      variant: 'outline',
      iconName: 'upload',
      disabled: !writable,
      onClick: () => pdfInput.click(),
    });
    const uploadRow = el('div', 'page-media-uploads');
    append(uploadRow, [
      pickImageBtn,
      pickPdfBtn,
      imageInput,
      pdfInput,
      helpTip('图片支持 PNG / JPEG / WebP，PDF 仅支持 application/pdf，单文件 ≤8MB。新建产品时选择的文件会在保存后自动上传；上传失败不影响其他字段保存。'),
    ]);
    const mediaWrap = el('div', 'page-media');
    append(mediaWrap, [uploadRow, mediaListHost]);
    const mediaField = field('图片与 PDF 资料', mediaWrap, {
      help: '第一张图片会自动设为主图，也可手动切换；PDF 会用于开发信附件与公开链接。文件接口未就绪时会提示，不影响其余编辑。',
    });
    mediaField.classList.add('span-2');

    const form = el('div', 'form-grid');
    append(form, [
      field('产品名称', controls.name, { required: true }),
      field('分类', controls.category),
      field('SKU', controls.sku),
      field('状态', controls.status),
      field('材料', controls.materials),
      field('产能', controls.capacity),
      field('MOQ', controls.moq),
      field('报价条件', controls.pricingTerms),
      field('样品', controls.samples),
      field('交期', controls.leadTime),
      descriptionField,
      keywordField,
      mediaField,
      certField,
      appField,
      specsField,
    ]);

    let saving = false;
    const dialog = openModal({
      title: editing ? '编辑产品' : '新建产品',
      body: form,
      size: 'lg',
      onClose: () => {
        if (!saved && media.changed) load();
      },
      actions: [
        { label: '取消' },
        {
          label: editing ? '保存修改' : '创建产品',
          variant: 'primary',
          onClick: async (done) => {
            if (saving) return;
            const name = String(controls.name.value || '').trim();
            if (!name) {
              toast('产品名称不能为空', 'warning');
              controls.name.focus();
              return;
            }
            const specsText = String(controls.specs.value || '').trim();
            let specs = {};
            if (specsText) {
              try {
                const parsed = JSON.parse(specsText);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  throw new Error('规格必须是 JSON 对象');
                }
                specs = parsed;
              } catch (error) {
                toast(`规格 JSON 格式错误：${errorMessage(error)}`, 'error');
                controls.specs.focus();
                return;
              }
            }
            const payload = {
              name,
              category: String(controls.category.value || '').trim() || null,
              sku: String(controls.sku.value || '').trim() || null,
              status: controls.status.value,
              description: String(controls.description.value || '').trim() || null,
              materials: String(controls.materials.value || '').trim() || null,
              capacity: String(controls.capacity.value || '').trim() || null,
              moq: String(controls.moq.value || '').trim() || null,
              pricingTerms: String(controls.pricingTerms.value || '').trim() || null,
              samples: String(controls.samples.value || '').trim() || null,
              leadTime: String(controls.leadTime.value || '').trim() || null,
              certifications: splitList(controls.certifications.value),
              applications: splitList(controls.applications.value),
              keywords: sanitizeKeywords(controls.keywords.value),
              specs,
            };
            const saveBtn = dialog.modal.querySelector('.modal-foot .btn:last-child');
            saving = true;
            if (saveBtn) saveBtn.disabled = true;
            try {
              if (editing) {
                await api.patch(`/api/v1/products/${encodeURIComponent(product.id)}`, payload);
                saved = true;
                toast('产品已更新', 'success');
                done();
                load();
                return;
              }
              const created = await api.post('/api/v1/products', payload);
              const createdId =
                (created && (created.id || (created.product && created.product.id))) || null;
              const pending = [...media.pending];
              let uploaded = 0;
              const failed = [];
              if (createdId && pending.length) {
                for (const item of pending) {
                  try {
                    await api.post(`/api/v1/products/${encodeURIComponent(createdId)}/files`, {
                      filename: item.filename,
                      mimeType: item.mimeType,
                      dataBase64: item.dataBase64,
                      kind: item.kind,
                    });
                    uploaded += 1;
                  } catch (error) {
                    failed.push(`${item.filename}：${errorMessage(error)}`);
                  }
                }
              }
              saved = true;
              if (failed.length) {
                toast(`产品已创建；${uploaded} 个文件上传成功，${failed.length} 个失败（${failed[0]}）`, 'warning');
              } else if (uploaded) {
                toast(`产品已创建，已上传 ${uploaded} 个文件`, 'success');
              } else {
                toast('产品已创建', 'success');
              }
              done();
              load();
            } catch (error) {
              toast(errorMessage(error), 'error');
            } finally {
              saving = false;
              if (saveBtn) saveBtn.disabled = false;
            }
          },
        },
      ],
    });
    renderMedia();
    if (editing) loadFiles();
    void dialog;
  }

  // ------------------------------------------------------- email templates
  function openEmailTemplateDialog(product) {
    const templateState = {
      loading: true,
      error: null,
      template: null,
      approved: null,
      versions: [],
      versionsLoading: false,
      versionsError: null,
      preview: null,
      busy: false,
      generating: false,
    };
    let editorFields = null;
    let generateFields = null;

    const bodyHost = el('div', 'stack page-template');
    const statusHost = el('div', 'stack');
    const editorHost = el('div', 'stack');
    const versionsHost = el('div', '');
    const actionsHost = el('div', 'page-template-actions');
    append(bodyHost, [statusHost, editorHost, versionsHost, actionsHost]);

    const dialog = openModal({
      title: `产品邮件模板 · ${product.name || '未命名产品'}`,
      body: bodyHost,
      size: 'lg',
      actions: [{ label: '关闭' }],
    });
    cleanup.push(() => {
      try {
        dialog.close();
      } catch {
        // dialog may already be closed
      }
    });

    function renderTemplate() {
      if (disposed) return;
      renderTemplateStatus();
      renderTemplateEditor();
      renderTemplateVersions();
      renderTemplateActions();
    }

    function renderTemplateStatus() {
      clear(statusHost);
      const current = templateState.preview || templateState.template;
      const head = el('div', 'page-template-head');
      const info = el('div', 'page-template-info');
      append(info, [
        el('b', '', product.name || '产品'),
        el('span', 'muted', '邮件模板'),
        helpTip('只有状态为「已生效」的模板会被用于批量外发。编辑已生效模板会生成新的待确认版本，需重新确认。'),
      ]);
      if (current) {
        append(info, [templateStatusBadge(current.status), el('span', 'page-template-version', `v${current.version ?? '—'}`)]);
        if (templateState.preview) append(info, [badge('只读预览', 'gray')]);
      } else {
        append(info, [badge('无模板', 'gray')]);
      }
      append(head, [info]);
      if (current && current.approvedAt) {
        append(head, [el('span', 'muted', `生效于 ${formatDateTime(current.approvedAt)}`)]);
      }
      statusHost.appendChild(head);
      if (
        !templateState.preview &&
        templateState.approved &&
        (!templateState.template || templateState.approved.id !== templateState.template.id)
      ) {
        const row = el('div', 'page-template-approved-line');
        append(row, [
          templateStatusBadge('approved'),
          el('span', 'muted', `当前已生效版本 v${templateState.approved.version ?? '—'}；编辑中的版本确认后才会替换。`),
        ]);
        statusHost.appendChild(row);
      }
    }

    function insertTemplateVariable(token) {
      const fieldNode = editorFields && editorFields.bodyText;
      if (!fieldNode) return;
      const value = String(fieldNode.value || '');
      const start = Number.isInteger(fieldNode.selectionStart) ? fieldNode.selectionStart : value.length;
      const end = Number.isInteger(fieldNode.selectionEnd) ? fieldNode.selectionEnd : start;
      fieldNode.value = `${value.slice(0, start)}${token}${value.slice(end)}`;
      const cursor = start + token.length;
      try {
        fieldNode.selectionStart = cursor;
        fieldNode.selectionEnd = cursor;
      } catch {
        // selection is best-effort only
      }
      fieldNode.focus();
    }

    function buildTemplateAttachments(template) {
      const wrap = el('div', 'page-template-attachments');
      const head = el('div', 'row');
      append(head, [
        el('b', '', '模板附件（只读）'),
        helpTip('附件来自产品资料中的 PDF / 图片文件，发送时会随邮件附带；模板中不能单独修改附件。'),
      ]);
      wrap.appendChild(head);
      const attachments = safeArray(template.attachments);
      if (!attachments.length) {
        wrap.appendChild(el('div', 'muted', '暂无附件；可在产品资料的「图片与 PDF 资料」中添加 PDF。'));
        return wrap;
      }
      for (const file of attachments) {
        const row = el('div', 'page-template-attachment');
        const info = el('div', 'page-template-attachment-info');
        append(info, [
          el('b', '', file.filename),
          el('span', 'muted', `${attachmentLabel(file)} · ${formatFileSize(file.sizeBytes)}`),
        ]);
        const actions = el('div', 'row');
        if (file.publicUrl) {
          append(actions, [
            button('复制链接', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'copy',
              onClick: () => copyText(absoluteUrl(file.publicUrl)),
            }),
          ]);
        } else {
          append(actions, [el('span', 'muted', '无公开链接')]);
        }
        append(row, [info, actions]);
        wrap.appendChild(row);
      }
      return wrap;
    }

    function buildTemplateEmpty() {
      const wrap = el('div', 'page-template-empty');
      wrap.appendChild(
        emptyState({
          iconName: 'mail',
          title: '还没有邮件模板',
          description: '让 AI 基于产品资料生成第一版草稿，人工核对并确认后才能用于批量外发。',
        }),
      );
      const language = select({
        value: 'en',
        options: EMAIL_LANGUAGES.map(([value, label]) => ({ value, label })),
      });
      const instructions = input({ placeholder: '可选：强调认证、交期、目标市场…' });
      const label = el('span', '', 'AI 生成模板');
      const generateBtn = button(null, {
        variant: 'primary',
        iconName: 'sparkles',
        disabled: !writable || templateState.generating || templateState.busy,
        onClick: () => generateTemplate({ language: language.value, instructions: String(instructions.value || '').trim() }),
      });
      generateBtn.appendChild(label);
      generateFields = { language, instructions, button: generateBtn, label };
      const generate = el('div', 'page-template-generate');
      append(generate, [
        field('生成语言', language),
        field('生成备注（可选）', instructions, {
          help: '可补充目标市场、需要强调的卖点等要求；AI 只基于已确认产品资料生成，不编造事实。',
        }),
        el('div', 'row', [
          generateBtn,
          helpTip('AI 生成的是待确认草稿；请核对主题、正文、变量与附件后再确认生效。'),
        ]),
      ]);
      wrap.appendChild(generate);
      return wrap;
    }

    function buildTemplateEditor(template) {
      const wrap = el('div', 'stack page-template-editor');
      const meta = el('div', 'page-template-meta');
      append(meta, [
        templateStatusBadge(template.status),
        el('span', 'muted', `版本 v${template.version ?? '—'}`),
        el('span', 'muted', `更新于 ${formatDateTime(template.updatedAt || template.createdAt)}`),
      ]);
      wrap.appendChild(meta);

      const subject = input({ value: template.subject || '' });
      const bodyText = textarea({ value: template.bodyText || '', rows: 12 });
      const language = select({
        value: template.language || 'en',
        options: EMAIL_LANGUAGES.map(([value, label]) => ({ value, label })),
      });
      if (!writable) {
        subject.disabled = true;
        bodyText.disabled = true;
        language.disabled = true;
      }
      editorFields = { subject, bodyText, language };
      const subjectField = field('邮件主题 Subject', subject, {
        required: true,
        help: '变量会在发送时替换为真实企业与联系人信息；不要写死具体公司名。',
      });
      subjectField.classList.add('span-2');
      const bodyField = field('正文 Body', bodyText, {
        required: true,
        help: '只有已生效模板会用于批量外发；变量请使用下方提供的占位符。',
      });
      bodyField.classList.add('span-2');
      const grid = el('div', 'form-grid');
      append(grid, [subjectField, field('语言 Language', language), bodyField]);
      wrap.appendChild(grid);

      const variables = el('div', 'page-template-variables');
      append(variables, [el('span', 'muted', '可用变量')]);
      for (const token of TEMPLATE_VARIABLES) {
        const chip = el('button', 'page-template-var', token);
        chip.type = 'button';
        chip.title = `插入 ${token}`;
        chip.addEventListener('click', () => insertTemplateVariable(token));
        variables.appendChild(chip);
      }
      variables.appendChild(
        helpTip('发送时由服务端替换：{{companyName}} 企业名、{{contactFirstName}} 联系人名、{{country}} 国家、{{productCatalogueUrl}} 产品 PDF 公开链接。点击变量可插入到正文光标处。'),
      );
      wrap.appendChild(variables);
      wrap.appendChild(buildTemplateAttachments(template));
      if (!writable) wrap.appendChild(notice('当前角色为只读，不能编辑或确认模板。', 'info'));
      return wrap;
    }

    function buildTemplatePreview(template) {
      const wrap = el('div', 'stack page-template-preview');
      append(wrap, [
        el('div', 'row', [
          badge('只读预览', 'gray'),
          templateStatusBadge(template.status),
          el('span', 'muted', `版本 v${template.version ?? '—'}`),
        ]),
        field('邮件主题', el('div', 'page-template-readonly', template.subject || '—')),
        field('正文', el('div', 'page-template-readonly page-template-body', template.bodyText || '—')),
        field('语言', el('div', 'page-template-readonly', languageLabel(template.language))),
        buildTemplateAttachments(template),
        el('div', 'row', [
          button('返回当前模板', {
            size: 'sm',
            variant: 'primary',
            iconName: 'arrowRight',
            onClick: () => {
              templateState.preview = null;
              renderTemplate();
            },
          }),
        ]),
      ]);
      return wrap;
    }

    function renderTemplateEditor() {
      clear(editorHost);
      editorFields = null;
      generateFields = null;
      if (templateState.loading) {
        editorHost.appendChild(loadingBlock('正在加载邮件模板…'));
        return;
      }
      if (templateState.error) {
        const box = el('div', 'page-template-error');
        append(box, [
          notice(`邮件模板加载失败：${templateState.error}`, 'danger'),
          el('div', 'row', [
            button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => loadTemplate() }),
          ]),
          helpTip('若后端模板接口尚未就绪，可稍后重试；产品其他编辑不受影响。'),
        ]);
        editorHost.appendChild(box);
        return;
      }
      if (templateState.preview) {
        editorHost.appendChild(buildTemplatePreview(templateState.preview));
        return;
      }
      if (!templateState.template) {
        editorHost.appendChild(buildTemplateEmpty());
        return;
      }
      editorHost.appendChild(buildTemplateEditor(templateState.template));
    }

    function renderTemplateVersions() {
      clear(versionsHost);
      const section = el('div', 'page-template-history');
      const head = el('div', 'row-between');
      append(head, [
        el('b', '', '版本历史'),
        el('span', 'muted', templateState.versions.length ? `共 ${templateState.versions.length} 个版本` : ''),
      ]);
      section.appendChild(head);
      if (templateState.versionsLoading) {
        section.appendChild(loadingBlock('正在加载版本…'));
      } else if (templateState.versionsError) {
        const box = el('div', 'page-template-history-error');
        append(box, [
          notice(`版本历史加载失败：${templateState.versionsError}`, 'warn'),
          button('重试', { size: 'sm', iconName: 'refresh', onClick: () => loadVersions() }),
        ]);
        section.appendChild(box);
      } else if (!templateState.versions.length) {
        section.appendChild(el('div', 'muted', '暂无版本记录'));
      } else {
        const list = el('div', 'page-template-versions');
        for (const version of templateState.versions) {
          const active = templateState.preview
            ? templateState.preview.id === version.id
            : templateState.template && templateState.template.id === version.id;
          const row = el('div', `page-template-version-row${active ? ' active' : ''}`);
          const main = el('div', 'page-template-version-main');
          append(main, [
            el('b', '', `v${version.version ?? '—'}`),
            templateStatusBadge(version.status),
            version.status === 'approved' ? badge('当前生效', 'green') : null,
            el('span', 'muted', formatDateTime(version.updatedAt || version.createdAt)),
          ]);
          const actions = el('div', 'row');
          append(actions, [
            button(templateState.preview && templateState.preview.id === version.id ? '正在查看' : '查看', {
              size: 'sm',
              variant: 'ghost',
              iconName: 'eye',
              disabled: Boolean(templateState.preview && templateState.preview.id === version.id),
              onClick: () => {
                templateState.preview = version;
                renderTemplate();
              },
            }),
          ]);
          append(row, [main, actions]);
          list.appendChild(row);
        }
        section.appendChild(list);
      }
      versionsHost.appendChild(section);
    }

    function renderTemplateActions() {
      clear(actionsHost);
      const closeBtn = button('关闭', { variant: 'ghost', onClick: () => dialog.close() });
      if (templateState.loading) return;
      if (templateState.error) {
        append(actionsHost, [
          button('重试加载', { variant: 'primary', iconName: 'refresh', onClick: () => loadTemplate() }),
          closeBtn,
        ]);
        return;
      }
      if (templateState.preview) {
        append(actionsHost, [
          button('返回当前模板', {
            variant: 'primary',
            iconName: 'arrowRight',
            onClick: () => {
              templateState.preview = null;
              renderTemplate();
            },
          }),
          closeBtn,
        ]);
        return;
      }
      if (!templateState.template) {
        append(actionsHost, [closeBtn]);
        return;
      }
      const template = templateState.template;
      append(actionsHost, [
        button('保存修改', {
          variant: 'primary',
          iconName: 'check',
          disabled: !writable || templateState.busy || templateState.generating,
          onClick: saveTemplate,
        }),
        button(template.status === 'approved' ? '已生效' : '确认模板', {
          variant: 'outline',
          iconName: 'shield',
          disabled: !writable || templateState.busy || templateState.generating || template.status === 'approved',
          onClick: approveTemplate,
        }),
        button(templateState.generating ? '生成中…' : 'AI 重新生成', {
          variant: 'ghost',
          iconName: 'sparkles',
          disabled: !writable || templateState.busy || templateState.generating,
          onClick: () => generateTemplate({}),
        }),
        closeBtn,
      ]);
    }

    async function loadTemplate() {
      templateState.loading = true;
      templateState.error = null;
      renderTemplate();
      try {
        const data = await api.get(`/api/v1/products/${encodeURIComponent(product.id)}/email-template`);
        const parsed = parseTemplatePayload(data);
        templateState.template = parsed.template;
        templateState.approved = parsed.approved;
        templateState.preview = null;
      } catch (error) {
        templateState.template = null;
        templateState.approved = null;
        templateState.error = errorMessage(error);
      } finally {
        templateState.loading = false;
        renderTemplate();
      }
      void loadVersions();
    }

    async function loadVersions() {
      templateState.versionsLoading = true;
      renderTemplateVersions();
      try {
        const data = await api.get(`/api/v1/products/${encodeURIComponent(product.id)}/email-templates`);
        const items = Array.isArray(data) ? data : safeArray(data && data.items);
        templateState.versions = items.map(normalizeTemplate).filter(Boolean);
        templateState.versionsError = null;
      } catch (error) {
        templateState.versions = [];
        templateState.versionsError = errorMessage(error);
      } finally {
        templateState.versionsLoading = false;
        renderTemplateVersions();
      }
    }

    async function generateTemplate(options = {}) {
      if (!writable || templateState.generating || templateState.busy) return;
      const language = options.language || (templateState.template && templateState.template.language) || 'en';
      const instructions = options.instructions || '';
      templateState.generating = true;
      if (generateFields && generateFields.label) generateFields.label.textContent = '生成中…';
      if (generateFields && generateFields.button) generateFields.button.disabled = true;
      renderTemplateActions();
      try {
        const payload = { language };
        if (instructions) payload.instructions = instructions;
        const data = await api.post(
          `/api/v1/products/${encodeURIComponent(product.id)}/email-template/generate`,
          payload,
        );
        const parsed = parseTemplatePayload(data);
        if (!parsed.template && !parsed.approved) {
          toast('AI 未返回模板内容，请稍后重试', 'warning');
          return;
        }
        toast('已生成模板草稿，请核对后确认', 'success');
        templateState.preview = null;
        await loadTemplate();
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        templateState.generating = false;
        if (generateFields && generateFields.label) generateFields.label.textContent = 'AI 生成模板';
        if (generateFields && generateFields.button) generateFields.button.disabled = false;
        renderTemplateActions();
      }
    }

    async function saveTemplate() {
      const template = templateState.template;
      const fields = editorFields;
      if (!template || !fields || templateState.busy || templateState.generating) return;
      const subject = String(fields.subject.value || '').trim();
      const bodyText = String(fields.bodyText.value || '').trim();
      const language = fields.language.value;
      if (!subject || !bodyText) {
        toast('邮件主题与正文不能为空', 'warning');
        return;
      }
      const approvedEdit = template.status === 'approved';
      if (approvedEdit) {
        const confirmed = await confirmDialog({
          title: '保存为新版本',
          message:
            '当前模板已生效。保存会生成新的待确认版本，原已生效版本保留在版本历史中；需要重新确认后才能用于批量外发。',
          confirmText: '保存并生成新版本',
        });
        if (!confirmed) return;
      }
      templateState.busy = true;
      renderTemplateActions();
      try {
        await api.patch(
          `/api/v1/products/${encodeURIComponent(product.id)}/email-template/${encodeURIComponent(template.id)}`,
          { subject, bodyText, language },
        );
        toast(approvedEdit ? '已生成新版本，请确认后使用' : '模板已保存', 'success');
        await loadTemplate();
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        templateState.busy = false;
        renderTemplateActions();
      }
    }

    async function approveTemplate() {
      const template = templateState.template;
      if (!template || templateState.busy || templateState.generating) return;
      const confirmed = await confirmDialog({
        title: '确认模板',
        message: `确认 v${template.version ?? '—'} 模板生效？确认后该模板将用于批量外发，此前已生效版本会自动停用。`,
        confirmText: '确认生效',
      });
      if (!confirmed) return;
      templateState.busy = true;
      renderTemplateActions();
      try {
        await api.post(
          `/api/v1/products/${encodeURIComponent(product.id)}/email-template/${encodeURIComponent(template.id)}/approve`,
          {},
        );
        toast('模板已生效', 'success');
        await loadTemplate();
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        templateState.busy = false;
        renderTemplateActions();
      }
    }

    renderTemplate();
    void loadTemplate();
  }

  async function setStatus(product, status) {
    try {
      await api.patch(`/api/v1/products/${encodeURIComponent(product.id)}`, { status });
      toast(status === 'archived' ? '产品已归档' : '产品已恢复', 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function removeProduct(product) {
    const confirmed = await confirmDialog({
      title: '删除产品',
      message: `确认删除「${product.name}」？删除后不再参与评分与外联；历史评分记录保留。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/v1/products/${encodeURIComponent(product.id)}`);
      toast('产品已删除', 'success');
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function productCard(product) {
    const node = el('article', 'page-product-card');
    const head = el('div', 'page-product-head');
    const imageUrl = productImageUrl(product);
    let thumb;
    if (imageUrl) {
      thumb = el('img', 'page-product-thumb');
      thumb.src = imageUrl;
      thumb.alt = product.name || '产品图片';
      thumb.loading = 'lazy';
      thumb.addEventListener('error', () => {
        const placeholder = placeholderThumb();
        if (thumb.parentNode) thumb.parentNode.replaceChild(placeholder, thumb);
      });
    } else {
      thumb = placeholderThumb();
    }
    const titleBlock = el('div', 'page-product-title');
    append(titleBlock, [
      el('b', '', product.name || '未命名产品'),
      el('span', 'cell-sub', [product.category, product.sku].filter(Boolean).join(' · ') || '未分类'),
    ]);
    append(head, [thumb, titleBlock, productStatusBadge(product.status)]);
    node.appendChild(head);
    if (product.description) {
      node.appendChild(el('p', 'page-product-desc', truncate(product.description, 150)));
    }
    const meta = el('div', 'page-product-meta');
    const certificationCount = safeArray(product.certifications).length;
    const keywordCount = safeArray(product.keywords).length;
    const files = productFiles(product);
    const imageCount = files.filter(isImageFile).length;
    const pdfCount = files.filter(isPdfFile).length;
    const facts = [
      ['MOQ', product.moq || '—'],
      ['认证', `${certificationCount} 项`],
      ['交期', product.leadTime || '—'],
      ['关键词', `${keywordCount} 个`],
      ['图片 / PDF', `${imageCount} / ${pdfCount}`],
      ['匹配企业', String(product.matchCount ?? 0)],
    ];
    for (const [label, value] of facts) {
      append(meta, [el('div', 'page-product-fact', [el('span', 'k', label), el('span', 'v', String(value))])]);
    }
    node.appendChild(meta);
    const foot = el('div', 'page-product-foot');
    const actions = el('div', 'row page-row-actions');
    append(actions, [
      button('编辑', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'edit',
        disabled: !writable,
        onClick: () => openProductForm(product),
      }),
      button('邮件模板', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'mail',
        onClick: () => openEmailTemplateDialog(product),
      }),
      product.status === 'archived'
        ? button('恢复', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'refresh',
            disabled: !writable,
            onClick: () => setStatus(product, 'active'),
          })
        : button('归档', {
            size: 'sm',
            variant: 'ghost',
            iconName: 'archive',
            disabled: !writable,
            onClick: () => setStatus(product, 'archived'),
          }),
      button('删除', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'trash',
        disabled: !canDelete,
        onClick: () => removeProduct(product),
      }),
    ]);
    append(foot, [el('span', 'muted', `更新于 ${relativeTime(product.updatedAt)}`), actions]);
    node.appendChild(foot);
    return node;
  }

  function renderEmpty() {
    const filtered = Boolean(state.q || state.status);
    if (filtered) {
      return emptyState({
        iconName: 'search',
        title: '没有匹配的产品',
        description: '尝试调整搜索关键词或状态筛选。',
        action: button('清除筛选', { size: 'sm', onClick: () => ctx?.refresh?.() }),
      });
    }
    return emptyState({
      iconName: 'box',
      title: '还没有产品资料',
      description: '创建第一个产品，登记已确认的参数、认证、图片/PDF 与交付条件；评分与写信都以此为事实来源。',
      action: button('创建第一个产品', {
        variant: 'primary',
        iconName: 'plus',
        disabled: !writable,
        onClick: () => openProductForm(),
      }),
    });
  }

  function renderPagination() {
    clear(paginationHost);
    if (!state.total) return;
    paginationHost.appendChild(
      pagination({
        page: state.page,
        pageSize: PAGE_SIZE,
        total: state.total,
        onChange: (nextPage) => {
          state.page = Math.max(1, Number(nextPage) || 1);
          load();
        },
      }),
    );
  }

  async function load() {
    if (disposed) return;
    clear(listHost);
    listHost.appendChild(dataTable({ columns: [{ key: 'name', label: '产品' }], rows: [], loading: true }));
    clear(paginationHost);
    try {
      const data = await api.get(
        `/api/v1/products${queryString({ page: state.page, pageSize: PAGE_SIZE, q: state.q, status: state.status })}`,
      );
      if (disposed) return;
      const { items, total } = unwrapList(data);
      state.items = items;
      state.total = total;
      clear(listHost);
      if (!items.length) {
        listHost.appendChild(el('div', 'page-state', [renderEmpty()]));
      } else {
        const grid = el('div', 'page-product-grid');
        for (const product of items) grid.appendChild(productCard(product));
        listHost.appendChild(grid);
      }
      renderPagination();
    } catch (error) {
      if (disposed) return;
      clear(listHost);
      const box = el('div', 'page-state');
      append(box, [
        notice(`加载失败：${errorMessage(error)}`, 'danger'),
        el('div', 'row', [
          button('重试', { variant: 'primary', size: 'sm', iconName: 'refresh', onClick: () => load() }),
        ]),
      ]);
      listHost.appendChild(box);
      clear(paginationHost);
    }
  }

  const refreshBtn = button('刷新', { iconName: 'refresh', onClick: () => load() });
  const newBtn = button('新建产品', {
    variant: 'primary',
    iconName: 'plus',
    disabled: !writable,
    onClick: () => openProductForm(),
  });
  const searchNode = searchInput({
    placeholder: '搜索产品名称 / SKU / 分类…',
    onInput: (value) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = String(value || '').trim();
        state.page = 1;
        load();
      }, 300);
    },
  });
  cleanup.push(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
  const statusSelect = select({
    value: '',
    options: STATUS_OPTIONS.map(([value, label]) => ({ value, label })),
    placeholder: '全部状态',
    className: 'select filter-select',
    onChange: (value) => {
      state.status = value;
      state.page = 1;
      load();
    },
  });

  append(root, [
    pageHeader({ title: meta.title, help: meta.help, actions: [refreshBtn, newBtn] }),
    toolbar(searchNode, statusSelect, el('span', 'grow')),
    listHost,
    paginationHost,
  ]);

  await load();
}

export function destroy() {
  disposed = true;
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // cleanup must never break navigation
    }
  }
}
