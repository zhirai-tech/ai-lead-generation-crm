/** OWNER: t-data. Contact routes: CRUD, verification, inference, sources. */
import { asBool, asCountry, asEmail, asEnum, asString, parsePagination, parseSort } from '../core/validate.mjs';
import * as contactsService from '../services/contacts.mjs';
import * as verificationService from '../services/verification.mjs';

const READ = { auth: 'required', capability: 'data.read' };
const WRITE = { auth: 'required', capability: 'data.write' };
const DELETE = { auth: 'required', capability: 'data.delete' };
const DISCOVERY = { auth: 'required', capability: 'discovery.run' };

function context(ctx) {
  return { actorId: ctx.user?.id || null, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
}

function listParam(query, name, { max = 120 } = {}) {
  const value = asString(query.get(name), { max, label: name });
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

export function mount(router) {
  router.get(
    '/api/v1/contacts',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      const sort = parseSort(
        ctx.query,
        { fullName: 'fullName', firstName: 'firstName', createdAt: 'createdAt', updatedAt: 'updatedAt', lastVerifiedAt: 'lastVerifiedAt', emailStatus: 'emailStatus' },
        { key: 'createdAt', direction: 'DESC' },
      );
      const emailStatus = listParam(ctx.query, 'emailStatus', { max: 200 }).filter((status) => contactsService.EMAIL_STATUSES.includes(status));
      const hasEmailRaw = ctx.query.get('hasEmail');
      const filters = {
        q: asString(ctx.query.get('q'), { max: 120 }),
        companyId: asString(ctx.query.get('companyId'), { max: 100 }) || null,
        emailStatus: emailStatus.length ? emailStatus : null,
        roleCategory: ctx.query.get('roleCategory')
          ? asEnum(ctx.query.get('roleCategory'), contactsService.ROLE_CATEGORIES, { label: '联系人角色' })
          : null,
        country: ctx.query.get('country') ? asCountry(ctx.query.get('country')) : null,
        emailType: ctx.query.get('emailType')
          ? asEnum(ctx.query.get('emailType'), contactsService.EMAIL_TYPES, { label: '邮箱类型' })
          : null,
        hasEmail: hasEmailRaw === null || hasEmailRaw === '' ? null : asBool(hasEmailRaw),
        ...pagination,
      };
      return contactsService.listContacts(ctx.workspace.id, filters, sort);
    },
    READ,
  );

  router.post(
    '/api/v1/contacts',
    async (ctx) => {
      const body = ctx.body || {};
      const input = {
        companyId: asString(body.companyId, { required: true, max: 100, label: '所属企业' }),
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

  router.post(
    '/api/v1/contacts/infer-email',
    async (ctx) => {
      const body = ctx.body || {};
      const companyId = asString(body.companyId, { required: true, max: 100, label: '企业' });
      const firstName = asString(body.firstName, { max: 80 });
      const lastName = asString(body.lastName, { max: 80 });
      const candidates = await verificationService.inferEmails(ctx.workspace.id, companyId, firstName, lastName);
      return { candidates, items: candidates };
    },
    DISCOVERY,
  );

  router.get('/api/v1/contacts/:id', async (ctx) => contactsService.getContactDetail(ctx.workspace.id, ctx.params.id), READ);

  router.patch(
    '/api/v1/contacts/:id',
    async (ctx) => {
      const body = ctx.body || {};
      const patch = {};
      const stringFields = ['firstName', 'lastName', 'fullName', 'title', 'phone', 'linkedinUrl', 'language', 'department'];
      for (const field of stringFields) {
        if (body[field] !== undefined) patch[field] = body[field] === null ? null : asString(body[field], { max: field === 'fullName' ? 240 : 2000 });
      }
      if (body.country !== undefined) patch.country = body.country ? asCountry(body.country) : null;
      if (body.email !== undefined) patch.email = body.email ? asEmail(body.email) : '';
      if (body.emailType !== undefined) patch.emailType = asEnum(body.emailType, contactsService.EMAIL_TYPES, { label: '邮箱类型' });
      if (body.emailStatus !== undefined) patch.emailStatus = asEnum(body.emailStatus, contactsService.EMAIL_STATUSES, { label: '邮箱状态' });
      if (body.roleCategory !== undefined) patch.roleCategory = asEnum(body.roleCategory, contactsService.ROLE_CATEGORIES, { label: '联系人角色' });
      if (body.confidence !== undefined) patch.confidence = asEnum(body.confidence, contactsService.CONFIDENCE_LEVELS, { label: '可信度' });
      if (body.isPrimary !== undefined) patch.isPrimary = asBool(body.isPrimary);
      if (body.inferred !== undefined) patch.inferred = asBool(body.inferred);
      return contactsService.updateContact(ctx.workspace.id, ctx.params.id, patch, context(ctx));
    },
    WRITE,
  );

  router.delete(
    '/api/v1/contacts/:id',
    async (ctx) => contactsService.deleteContact(ctx.workspace.id, ctx.params.id, context(ctx)),
    DELETE,
  );

  router.post(
    '/api/v1/contacts/:id/verify',
    async (ctx) =>
      verificationService.verifyContactEmail({
        workspaceId: ctx.workspace.id,
        contactId: ctx.params.id,
        ...context(ctx),
      }),
    WRITE,
  );

  router.get(
    '/api/v1/contacts/:id/sources',
    async (ctx) => {
      const pagination = parsePagination(ctx.query);
      return contactsService.getContactSources(ctx.workspace.id, ctx.params.id, pagination);
    },
    READ,
  );
}
