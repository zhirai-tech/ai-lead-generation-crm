/** OWNER: t-data. CSV import and company export routes. */
import { asBool, asCountry, asEnum, asInt, asString, parsePagination } from '../core/validate.mjs';
import { validationError } from '../core/errors.mjs';
import * as importsService from '../services/imports.mjs';
import * as exportsService from '../services/exports.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const IMPORT = { auth: 'required', capability: 'import.run' };
const EXPORT = { auth: 'required', capability: 'export.run' };

function context(ctx) {
  return { actorId: ctx.user?.id || null, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
}

function exportFilters(query) {
  const list = (name) => {
    const value = asString(query.get(name), { max: 200 });
    return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
  };
  const intOrNull = (name) => {
    const raw = query.get(name);
    return raw === null || raw === '' ? null : asInt(raw, { min: 0, max: 100, label: name });
  };
  return {
    q: asString(query.get('q'), { max: 120 }),
    statuses: list('status'),
    countries: list('country').map((code) => asCountry(code)),
    tag: asString(query.get('tag'), { max: 40 }),
    icpId: asString(query.get('icpId'), { max: 100 }) || null,
    productId: asString(query.get('productId'), { max: 100 }) || null,
    companyType: asString(query.get('companyType'), { max: 80 }) || null,
    industry: asString(query.get('industry'), { max: 120 }) || null,
    minScore: intOrNull('minScore'),
    maxScore: intOrNull('maxScore'),
    hasEmail: query.get('hasEmail') === null || query.get('hasEmail') === '' ? null : asBool(query.get('hasEmail')),
  };
}

export function mount(router) {
  router.post(
    '/api/v1/imports',
    async (ctx) => {
      const body = ctx.body || {};
      const kind = asEnum(body.kind, importsService.IMPORT_KINDS, { required: true, label: '导入类型' });
      const filename = body.filename ? asString(body.filename, { max: 255 }) : null;
      const text = typeof body.text === 'string' ? body.text : typeof body.csv === 'string' ? body.csv : null;
      if (typeof text !== 'string') throw validationError('导入内容必须是 CSV 文本');
      return importsService.runImport(ctx.workspace.id, { kind, filename, text }, context(ctx));
    },
    IMPORT,
  );

  router.get(
    '/api/v1/imports',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      return importsService.listImportRuns(ctx.workspace.id, {
        kind: ctx.query.get('kind') ? asEnum(ctx.query.get('kind'), importsService.IMPORT_KINDS, { label: '导入类型' }) : null,
        status: asString(ctx.query.get('status'), { max: 20 }) || null,
        ...pagination,
      });
    },
    READ,
  );

  router.get('/api/v1/imports/:id', async (ctx) => importsService.getImportRunOrThrow(ctx.workspace.id, ctx.params.id), READ);

  router.get(
    '/api/v1/export/companies',
    async (ctx) => exportsService.exportCompaniesCsv(ctx.workspace.id, exportFilters(ctx.query)),
    EXPORT,
  );
}
