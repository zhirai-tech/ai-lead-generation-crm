/**
 * CSV exports. The API returns JSON `{filename, content}` so the frontend can
 * download the file without changing the JSON response envelope.
 */
import { listAllCompaniesForExport } from '../repositories/companies.mjs';
import { toCsv } from './imports.mjs';

export const COMPANY_EXPORT_HEADERS = [
  '企业名称',
  '域名',
  '官网',
  '国家',
  '地区',
  '城市',
  '地址',
  '企业类型',
  '行业',
  '员工规模',
  '营收规模',
  '描述',
  'LinkedIn',
  '电话',
  '状态',
  '标签',
  'ICP',
  '数据质量分',
  '可信度',
  '联系人数量',
  '邮箱数量',
  '创建时间',
  '更新时间',
];

const COMPANY_STATUS_LABELS = {
  new: '新线索',
  qualified: '已验证',
  contacted: '已联系',
  replied: '已回复',
  customer: '客户',
  disqualified: '不合格',
  archived: '已归档',
};

const CONFIDENCE_LABELS = { unverified: '未核实', low: '低', medium: '中', high: '高' };

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Export companies matching the list filters as a UTF-8 BOM CSV. */
export function exportCompaniesCsv(workspaceId, filters = {}) {
  const companies = listAllCompaniesForExport(workspaceId, filters);
  const rows = companies.map((company) => [
    company.name,
    company.domain || '',
    company.website || '',
    company.country || '',
    company.region || '',
    company.city || '',
    company.address || '',
    company.companyType || '',
    company.industry || '',
    company.employeeRange || '',
    company.revenueRange || '',
    company.description || '',
    company.linkedinUrl || '',
    company.phone || '',
    COMPANY_STATUS_LABELS[company.status] || company.status,
    (company.tags || []).join('; '),
    company.icpId || '',
    String(company.dataQualityScore ?? 0),
    CONFIDENCE_LABELS[company.confidence] || company.confidence,
    String(company.contactsCount ?? 0),
    String(company.emailCount ?? 0),
    company.createdAt,
    company.updatedAt,
  ]);
  const content = toCsv(COMPANY_EXPORT_HEADERS, rows, { bom: true });
  return {
    filename: `companies-${stamp()}.csv`,
    content,
    count: companies.length,
    contentType: 'text/csv; charset=utf-8',
  };
}
