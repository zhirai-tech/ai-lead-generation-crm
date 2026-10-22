/**
 * Ideal customer profile service. ICPs describe the buyer profile used by
 * discovery and rule-based scoring; they never invent certifications or facts.
 */
import { notFound, validationError } from '../core/errors.mjs';
import { nowIso } from '../core/time.mjs';
import { recordAudit } from '../core/audit.mjs';
import { asCountry } from '../core/validate.mjs';
import { id } from '../core/ids.mjs';
import * as icpsRepo from '../repositories/icps.mjs';
import * as productsRepo from '../repositories/products.mjs';

const LIST_FIELDS = [
  ['targetCountries', 'target_countries_json', '目标国家', 50],
  ['targetRegions', 'target_regions_json', '目标区域', 30],
  ['targetCompanyTypes', 'target_company_types_json', '目标企业类型', 30],
  ['targetSizes', 'target_sizes_json', '目标规模', 30],
  ['targetRoles', 'target_roles_json', '目标角色', 30],
  ['includeKeywords', 'include_keywords_json', '包含关键词', 100],
  ['excludeKeywords', 'exclude_keywords_json', '排除关键词', 100],
];

function normalizeList(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${label}必须是数组`);
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 120))
    .slice(0, max);
}

function validateProduct(workspaceId, productId) {
  if (!productId) return null;
  const product = productsRepo.findProduct(workspaceId, productId);
  if (!product) throw validationError('关联产品不存在');
  return product.id;
}

export function listIcps(workspaceId, filters, sort) {
  return icpsRepo.listIcps(workspaceId, { ...filters, sortKey: sort?.key, sortDirection: sort?.direction });
}

export function getIcpOrThrow(workspaceId, icpId) {
  const icp = icpsRepo.findIcp(workspaceId, icpId);
  if (!icp) throw notFound('ICP 不存在');
  return icp;
}

export function createIcp(workspaceId, input, context = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw validationError('ICP 名称不能为空');
  const now = nowIso();
  const data = {
    id: id('icp'),
    workspace_id: workspaceId,
    product_id: validateProduct(workspaceId, input.productId || null),
    name: name.slice(0, 200),
    description: input.description ? String(input.description).slice(0, 4000) : null,
    min_score: Number.isInteger(input.minScore) ? Math.max(0, Math.min(100, input.minScore)) : 60,
    is_active: input.isActive === false ? 0 : 1,
    created_by: context.actorId || null,
    created_at: now,
    updated_at: now,
  };
  for (const [apiField, column, label, max] of LIST_FIELDS) {
    let values = normalizeList(input[apiField], label, max);
    if (apiField === 'targetCountries') {
      values = values.map((value) => asCountry(value, { label }));
    }
    data[column] = JSON.stringify(values);
  }
  const icp = icpsRepo.insertIcp(data);
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'icp.create',
    entityType: 'icp',
    entityId: icp.id,
    after: icp,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return icp;
}

export function updateIcp(workspaceId, icpId, patch, context = {}) {
  const before = getIcpOrThrow(workspaceId, icpId);
  const changes = {};
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw validationError('ICP 名称不能为空');
    changes.name = name.slice(0, 200);
  }
  if (patch.description !== undefined) changes.description = patch.description ? String(patch.description).slice(0, 4000) : null;
  if (patch.productId !== undefined) changes.product_id = validateProduct(workspaceId, patch.productId || null);
  if (patch.minScore !== undefined) {
    if (!Number.isInteger(patch.minScore) || patch.minScore < 0 || patch.minScore > 100) {
      throw validationError('最低评分必须是 0-100 的整数');
    }
    changes.min_score = patch.minScore;
  }
  if (patch.isActive !== undefined) changes.is_active = patch.isActive ? 1 : 0;
  for (const [apiField, column, label, max] of LIST_FIELDS) {
    if (patch[apiField] === undefined) continue;
    let values = normalizeList(patch[apiField], label, max);
    if (apiField === 'targetCountries') values = values.map((value) => asCountry(value, { label }));
    changes[column] = JSON.stringify(values);
  }
  changes.updated_at = nowIso();
  const icp = icpsRepo.updateIcp(workspaceId, icpId, changes);
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'icp.update',
    entityType: 'icp',
    entityId: icpId,
    before,
    after: icp,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return icp;
}

export function deleteIcp(workspaceId, icpId, context = {}) {
  const before = getIcpOrThrow(workspaceId, icpId);
  if (!icpsRepo.deleteIcp(workspaceId, icpId)) throw notFound('ICP 不存在');
  recordAudit({
    workspaceId,
    actorType: context.actorId ? 'user' : 'system',
    actorId: context.actorId || null,
    action: 'icp.delete',
    entityType: 'icp',
    entityId: icpId,
    before,
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
  return { deleted: true, id: icpId, affectedCompanies: icpsRepo.countCompaniesUsingIcp(workspaceId, icpId) };
}

export function listActiveIcps(workspaceId) {
  return icpsRepo.listActiveIcps(workspaceId);
}
