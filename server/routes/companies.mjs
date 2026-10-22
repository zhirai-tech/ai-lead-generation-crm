/**
 * OWNER: t-data. Company routes: list/create/detail/update/delete, bulk actions,
 * scoring, enrichment, crawl, timeline, sources and nested contact creation.
 */
import { asArray, asBool, asCountry, asEmail, asEnum, asInt, asString, parsePagination, parseSort } from '../core/validate.mjs';
import { validationError } from '../core/errors.mjs';
import * as companiesService from '../services/companies.mjs';
import * as contactsService from '../services/contacts.mjs';
import * as scoringService from '../services/scoring.mjs';
import * as enrichmentService from '../services/enrichment.mjs';

export const COMPANY_STATUSES = companiesService.COMPANY_STATUSES;

const READ = { auth: 'required', capability: 'data.read' };
const WRITE = { auth: 'required', capability: 'data.write' };
const DELETE = { auth: 'required', capability: 'data.delete' };
const DISCOVERY = { auth: 'required', capability: 'discovery.run' };

function context(ctx) {
  return {
    actorId: ctx.user?.id || null,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

function listParam(query, name, { max = 120 } = {}) {
  const value = asString(query.get(name), { max, label: name });
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function intParam(query, name) {
  const raw = query.get(name);
  if (raw === null || raw === '') return null;
  return asInt(raw, { min: 0, max: 100, label: name });
}

function boolParam(query, name) {
  const raw = query.get(name);
  if (raw === null || raw === '') return null;
  return asBool(raw);
}

export function mount(router) {
  router.get(
    '/api/v1/companies',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      const sort = parseSort(
        ctx.query,
        {
          name: 'name',
          createdAt: 'createdAt',
          updatedAt: 'updatedAt',
          country: 'country',
          status: 'status',
          score: 'score',
          dataQualityScore: 'dataQualityScore',
          contactsCount: 'contactsCount',
        },
        { key: 'createdAt', direction: 'DESC' },
      );
      const filters = {
        q: asString(ctx.query.get('q'), { max: 120 }),
        countries: listParam(ctx.query, 'country', { max: 200 }).map((code) => asCountry(code)),
        statuses: listParam(ctx.query, 'status', { max: 500 }).filter((status) => COMPANY_STATUSES.includes(status)),
        tag: asString(ctx.query.get('tag'), { max: 40 }),
        icpId: asString(ctx.query.get('icpId'), { max: 100 }) || null,
        productId: asString(ctx.query.get('productId'), { max: 100 }) || null,
        ownerUserId: asString(ctx.query.get('ownerUserId'), { max: 100 }) || null,
        domain: asString(ctx.query.get('domain'), { max: 200 }) || null,
        companyType: asString(ctx.query.get('companyType'), { max: 80 }) || null,
        industry: asString(ctx.query.get('industry'), { max: 120 }) || null,
        automationState: asString(ctx.query.get('automationState'), { max: 40 }) || null,
        minScore: intParam(ctx.query, 'minScore'),
        maxScore: intParam(ctx.query, 'maxScore'),
        hasEmail: boolParam(ctx.query, 'hasEmail'),
        hasContacts: boolParam(ctx.query, 'hasContacts'),
        ...pagination,
      };
      return companiesService.listCompanies(ctx.workspace.id, filters, sort);
    },
    READ,
  );

  router.post(
    '/api/v1/companies',
    async (ctx) => {
      const body = ctx.body || {};
      const input = {
        name: asString(body.name, { required: true, max: 200, label: '企业名称' }),
        domain: body.domain ? asString(body.domain, { max: 500, label: '域名' }) : '',
        website: body.website ? asString(body.website, { max: 2000, label: '官网' }) : null,
        country: body.country ? asCountry(body.country) : null,
        region: asString(body.region, { max: 120 }) || null,
        city: asString(body.city, { max: 120 }) || null,
        address: asString(body.address, { max: 500 }) || null,
        companyType: asString(body.companyType, { max: 80 }) || null,
        industry: asString(body.industry, { max: 120 }) || null,
        employeeRange: asString(body.employeeRange, { max: 40 }) || null,
        revenueRange: asString(body.revenueRange, { max: 40 }) || null,
        description: asString(body.description, { max: 4000 }) || null,
        linkedinUrl: asString(body.linkedinUrl, { max: 2000 }) || null,
        phone: asString(body.phone, { max: 60 }) || null,
        status: body.status ? asEnum(body.status, COMPANY_STATUSES, { label: '企业状态' }) : undefined,
        tags: asArray(body.tags, { max: 30, label: '标签' }).filter((tag) => typeof tag === 'string'),
        icpId: body.icpId ? asString(body.icpId, { max: 100 }) : null,
        ownerUserId: body.ownerUserId ? asString(body.ownerUserId, { max: 100 }) : null,
        confidence: body.confidence ? asString(body.confidence, { max: 20 }) : undefined,
        source: body.source && typeof body.source === 'object' ? body.source : null,
      };
      return companiesService.createCompany(ctx.workspace.id, input, context(ctx));
    },
    WRITE,
  );

  router.post(
    '/api/v1/companies/bulk',
    async (ctx) => {
      const body = ctx.body || {};
      const action = asEnum(body.action, ['score', 'archive', 'assign', 'status'], { required: true, label: '批量操作' });
      const ids = asArray(body.ids, { required: true, max: 200, label: '企业列表' }).filter((value) => typeof value === 'string');
      if (action === 'archive') ctx.requireCapability('data.delete');
      if (action === 'status' && !COMPANY_STATUSES.includes(body.status)) throw validationError('企业状态不在允许范围内');
      return companiesService.bulkCompanyAction(
        ctx.workspace.id,
        {
          action,
          ids,
          productId: body.productId ? asString(body.productId, { max: 100 }) : null,
          ownerUserId: body.ownerUserId ? asString(body.ownerUserId, { max: 100 }) : null,
          status: action === 'status' ? body.status : undefined,
        },
        context(ctx),
      );
    },
    WRITE,
  );

  router.get(
    '/api/v1/companies/:id',
    async (ctx) => companiesService.getCompanyDetail(ctx.workspace.id, ctx.params.id),
    READ,
  );

  router.patch(
    '/api/v1/companies/:id',
    async (ctx) => {
      const body = ctx.body || {};
      const patch = {};
      const stringFields = [
        'name', 'website', 'country', 'region', 'city', 'address', 'companyType', 'industry', 'employeeRange',
        'revenueRange', 'description', 'linkedinUrl', 'phone',
      ];
      for (const field of stringFields) {
        if (body[field] === undefined) continue;
        if (field === 'country') patch[field] = body[field] ? asCountry(body[field]) : null;
        else patch[field] = body[field] === null ? null : asString(body[field], { max: field === 'description' ? 4000 : 2000 });
      }
      if (body.domain !== undefined) patch.domain = body.domain ? asString(body.domain, { max: 500 }) : '';
      if (body.status !== undefined) patch.status = asEnum(body.status, COMPANY_STATUSES, { label: '企业状态' });
      if (body.confidence !== undefined) {
        patch.confidence = asEnum(body.confidence, companiesService.CONFIDENCE_LEVELS, { label: '可信度' });
      }
      if (body.tags !== undefined) patch.tags = asArray(body.tags, { max: 30, label: '标签' }).filter((tag) => typeof tag === 'string');
      if (body.icpId !== undefined) patch.icpId = body.icpId ? asString(body.icpId, { max: 100 }) : null;
      if (body.ownerUserId !== undefined) patch.ownerUserId = body.ownerUserId ? asString(body.ownerUserId, { max: 100 }) : null;
      return companiesService.updateCompany(ctx.workspace.id, ctx.params.id, patch, context(ctx));
    },
    WRITE,
  );

  router.delete(
    '/api/v1/companies/:id',
    async (ctx) => companiesService.deleteCompany(ctx.workspace.id, ctx.params.id, context(ctx)),
    DELETE,
  );

  router.post(
    '/api/v1/companies/:id/score',
    async (ctx) => {
      const body = ctx.body || {};
      const productId = asString(body.productId, { required: true, max: 100, label: '产品' });
      return scoringService.scoreCompany({ workspaceId: ctx.workspace.id, companyId: ctx.params.id, productId, ...context(ctx) });
    },
    WRITE,
  );

  router.post(
    '/api/v1/companies/:id/score-feedback',
    async (ctx) => {
      const body = ctx.body || {};
      return scoringService.recordScoreFeedback(
        ctx.workspace.id,
        ctx.params.id,
        {
          productId: body.productId ? asString(body.productId, { max: 100 }) : null,
          field: asString(body.field, { required: true, max: 60, label: '反馈字段' }),
          aiValue: body.aiValue,
          userValue: body.userValue,
          reason: body.reason ? asString(body.reason, { max: 1000 }) : null,
        },
        context(ctx),
      );
    },
    WRITE,
  );

  router.post(
    '/api/v1/companies/:id/enrich',
    async (ctx) => enrichmentService.enrichCompany({ workspaceId: ctx.workspace.id, companyId: ctx.params.id, ...context(ctx) }),
    DISCOVERY,
  );

  router.post(
    '/api/v1/companies/:id/crawl',
    async (ctx) => {
      const body = ctx.body || {};
      const urls = body.urls ? asArray(body.urls, { max: 5, label: '抓取地址' }).filter((url) => typeof url === 'string') : null;
      return enrichmentService.requestCompanyCrawl({ workspaceId: ctx.workspace.id, companyId: ctx.params.id, ...context(ctx), urls });
    },
    DISCOVERY,
  );

  router.get(
    '/api/v1/companies/:id/timeline',
    async (ctx) => {
      const pagination = parsePagination(ctx.query, { defaultPageSize: 25, maxPageSize: 100 });
      const types = listParam(ctx.query, 'types', { max: 200 });
      return companiesService.getCompanyTimeline(ctx.workspace.id, ctx.params.id, {
        types,
        page: pagination.page,
        pageSize: pagination.pageSize,
      });
    },
    READ,
  );

  router.post(
    '/api/v1/companies/:id/contacts',
    async (ctx) => {
      const body = ctx.body || {};
      const input = {
        companyId: ctx.params.id,
        firstName: asString(body.firstName, { max: 120 }) || null,
        lastName: asString(body.lastName, { max: 120 }) || null,
        fullName: asString(body.fullName, { max: 240 }) || null,
        title: asString(body.title, { max: 200 }) || null,
        roleCategory: body.roleCategory ? asEnum(body.roleCategory, contactsService.ROLE_CATEGORIES, { label: '联系人角色' }) : undefined,
        email: body.email ? asEmail(body.email) : '',
        emailType: body.emailType ? asEnum(body.emailType, contactsService.EMAIL_TYPES, { label: '邮箱类型' }) : undefined,
        emailStatus: body.emailStatus ? asEnum(body.emailStatus, contactsService.EMAIL_STATUSES, { label: '邮箱状态' }) : undefined,
        phone: asString(body.phone, { max: 60 }) || null,
        linkedinUrl: asString(body.linkedinUrl, { max: 2000 }) || null,
        country: body.country ? asCountry(body.country) : null,
        language: asString(body.language, { max: 20 }) || null,
        department: asString(body.department, { max: 120 }) || null,
        isPrimary: asBool(body.isPrimary),
        confidence: body.confidence ? asString(body.confidence, { max: 20 }) : undefined,
        inferred: asBool(body.inferred),
        source: body.source && typeof body.source === 'object' ? body.source : null,
      };
      return contactsService.createContact(ctx.workspace.id, input, context(ctx));
    },
    WRITE,
  );

  router.get(
    '/api/v1/companies/:id/sources',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      return companiesService.getCompanySources(ctx.workspace.id, ctx.params.id, pagination);
    },
    READ,
  );

  router.get(
    '/api/v1/companies/:id/verifications',
    async (ctx) => companiesService.getCompanyVerifications(ctx.workspace.id, ctx.params.id),
    READ,
  );
}
