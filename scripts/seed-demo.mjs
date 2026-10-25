#!/usr/bin/env node
/**
 * Seed a self-contained demo workspace with realistic (fictional, .example)
 * European automotive aftermarket data. Safe to re-run: the demo workspace and
 * its demo user are removed and re-created; other workspaces are untouched.
 *
 * Usage: node scripts/seed-demo.mjs
 * Login: demo@zhirai.test / Zhirai2026demo
 */
import '../server/core/silence-sqlite-warning.mjs';
import path from 'node:path';
import { config, ensureRuntimeDirs } from '../server/config.mjs';
import { assertOpenedDatabasePath, assertSchemaReady, closeDatabase, get, migrate, openDatabase, run, tx, validateMigrationPolicy } from '../server/core/db.mjs';
import { hashPassword } from '../server/core/crypto.mjs';
import { ensureWorkspaceDefaults } from '../server/services/settings.mjs';

const DEMO_USER = 'usr_demo_owner';
const DEMO_WORKSPACE = 'wsp_demo';
const DEMO_EMAIL = 'demo@zhirai.test';
const DEMO_PASSWORD = 'Zhirai2026demo';

const now = Date.now();
const iso = (daysAgo = 0, hoursAgo = 0, minutesAgo = 0) =>
  new Date(now - daysAgo * 86_400_000 - hoursAgo * 3_600_000 - minutesAgo * 60_000).toISOString();
const future = (days = 0, hours = 0) => new Date(now + days * 86_400_000 + hours * 3_600_000).toISOString();

const WORKSPACE_TABLES = new Set([
  'products', 'icps', 'companies', 'company_sources', 'contacts', 'contact_sources', 'data_verifications',
  'lead_scores', 'company_product_matches', 'email_accounts', 'email_threads', 'email_messages',
  'conversation_classifications', 'message_drafts', 'deals', 'sales_activities', 'follow_up_tasks',
  'automation_states', 'suppression_records', 'notifications', 'usage_records', 'background_jobs',
  'audit_events', 'discovery_runs', 'import_runs', 'campaigns', 'campaign_steps', 'campaign_targets', 'agent_executions',
]);

function insert(table, row) {
  const enriched = WORKSPACE_TABLES.has(table) && row.workspace_id === undefined ? { ...row, workspace_id: DEMO_WORKSPACE } : row;
  const keys = Object.keys(enriched);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  run(sql, keys.map((key) => enriched[key]));
}

function seed() {
  // Remove previous demo workspace/user (cascades to demo data only)
  run('DELETE FROM workspaces WHERE id = ?', [DEMO_WORKSPACE]);
  run('DELETE FROM users WHERE id = ?', [DEMO_USER]);

  insert('users', {
    id: DEMO_USER,
    email: DEMO_EMAIL,
    password_hash: hashPassword(DEMO_PASSWORD),
    name: '演示管理员',
    locale: 'zh-CN',
    is_active: 1,
    must_change_password: 0,
    created_at: iso(40),
    updated_at: iso(40),
  });
  insert('workspaces', {
    id: DEMO_WORKSPACE,
    name: '智睿欧洲汽配事业部',
    slug: 'zhirai-europe-parts',
    status: 'active',
    settings_json: '{}',
    created_at: iso(40),
    updated_at: iso(1),
  });
  insert('memberships', {
    id: 'mem_demo_owner',
    workspace_id: DEMO_WORKSPACE,
    user_id: DEMO_USER,
    role: 'owner',
    status: 'active',
    created_at: iso(40),
    updated_at: iso(40),
  });
  ensureWorkspaceDefaults(DEMO_WORKSPACE);

  // ---------------------------------------------------------------- products
  const products = [
    {
      id: 'demo_prod_bracket',
      name: 'EV 电池包支架（铝合金）',
      category: '新能源汽车零部件',
      sku: 'ZR-EV-BRK-01',
      description: '面向欧洲新能源汽车售后与改装市场的电池包固定支架，铝合金 6061-T6，支持多车型适配。',
      specs_json: JSON.stringify({
        材质: '铝合金 6061-T6',
        工艺: 'CNC 精密加工 + 阳极氧化',
        重量: '3.8 kg',
        适配: '400V / 800V 电池包',
        工作温度: '-40℃ ~ 120℃',
        表面处理: '黑色阳极氧化',
      }),
      applications_json: JSON.stringify(['纯电动车电池包固定', '电池包维修替换', '售后改装']),
      materials: '铝合金 6061-T6',
      certifications_json: JSON.stringify(['IATF 16949（工厂体系）', 'RoHS', 'REACH']),
      capacity: '月产能 8,000 件',
      moq: '200 件',
      pricing_terms: 'FOB Shanghai，30% 定金 + 70% 见提单副本',
      samples: '可提供 2 件付费样品，7 个工作日',
      lead_time: '25-35 天',
      status: 'active',
      created_by: DEMO_USER,
      created_at: iso(35),
      updated_at: iso(5),
    },
    {
      id: 'demo_prod_housing',
      name: '电池包铝合金下壳体',
      category: '新能源汽车零部件',
      sku: 'ZR-EV-HSG-02',
      description: '一体压铸电池包下壳体，适用于 C 级纯电轿车平台，支持定制水道与安装点。',
      specs_json: JSON.stringify({ 材质: 'AlSi10MnMg', 工艺: '高压压铸 + 热处理', 重量: '12.5 kg', 密封等级: 'IP67' }),
      applications_json: JSON.stringify(['电池包下壳体', '整车厂配套', '售后总成替换']),
      materials: 'AlSi10MnMg',
      certifications_json: JSON.stringify(['IATF 16949', 'ISO 9001']),
      capacity: '月产能 2,500 件',
      moq: '100 件',
      pricing_terms: 'FOB Ningbo',
      samples: '需按图纸评估',
      lead_time: '40-50 天',
      status: 'active',
      created_by: DEMO_USER,
      created_at: iso(30),
      updated_at: iso(9),
    },
    {
      id: 'demo_prod_stamp',
      name: '高强度钢冲压支架',
      category: '汽车冲压件',
      sku: 'ZR-STL-BRK-03',
      description: '热成型高强钢支架，用于电池模组固定与底盘连接。',
      specs_json: JSON.stringify({ 材质: '22MnB5', 工艺: '热成型 + 激光切割', 厚度: '2.0 mm' }),
      applications_json: JSON.stringify(['电池模组固定', '底盘连接件']),
      materials: '22MnB5',
      certifications_json: JSON.stringify(['IATF 16949']),
      capacity: '月产能 15,000 件',
      moq: '500 件',
      pricing_terms: 'FOB Shanghai',
      samples: '可提供 5 件样品',
      lead_time: '20-30 天',
      status: 'active',
      created_by: DEMO_USER,
      created_at: iso(28),
      updated_at: iso(4),
    },
  ];
  for (const product of products) insert('products', product);

  // --------------------------------------------------------------------- ICPs
  insert('icps', {
    id: 'demo_icp_importer',
    workspace_id: DEMO_WORKSPACE,
    product_id: 'demo_prod_bracket',
    name: '欧洲汽配进口商 / 经销商',
    description: '德国、法国、荷兰、波兰等国的汽车零部件进口商与区域经销商，采购新能源汽车售后件。',
    target_countries_json: JSON.stringify(['DE', 'FR', 'NL', 'BE', 'PL', 'CZ', 'IT', 'ES']),
    target_regions_json: JSON.stringify(['西欧', '中欧', '南欧']),
    target_company_types_json: JSON.stringify(['importer', 'distributor', 'aftermarket']),
    target_sizes_json: JSON.stringify(['20-100', '100-500', '500+']),
    target_roles_json: JSON.stringify(['采购经理', '品类经理', '技术总监']),
    include_keywords_json: JSON.stringify(['EV battery bracket', 'NEV parts', 'battery housing', 'aftermarket']),
    exclude_keywords_json: JSON.stringify(['passenger car only', 'ICE only']),
    min_score: 65,
    is_active: 1,
    created_by: DEMO_USER,
    created_at: iso(25),
    updated_at: iso(3),
  });
  insert('icps', {
    id: 'demo_icp_aftermarket',
    workspace_id: DEMO_WORKSPACE,
    product_id: 'demo_prod_stamp',
    name: '售后市场连锁与改装商',
    description: '欧洲汽车售后连锁、性能改装商，关注高强钢支架与快速交付。',
    target_countries_json: JSON.stringify(['DE', 'NL', 'BE', 'SE', 'AT']),
    target_regions_json: JSON.stringify(['西欧', '北欧']),
    target_company_types_json: JSON.stringify(['aftermarket', 'distributor']),
    target_sizes_json: JSON.stringify(['10-50', '50-200']),
    target_roles_json: JSON.stringify(['采购负责人', '产品经理']),
    include_keywords_json: JSON.stringify(['performance parts', 'aftermarket bracket', 'EV conversion']),
    exclude_keywords_json: JSON.stringify([]),
    min_score: 60,
    is_active: 1,
    created_by: DEMO_USER,
    created_at: iso(20),
    updated_at: iso(6),
  });

  // ---------------------------------------------------------------- companies
  const companies = [
    ['demo_cmp_nordvolt', 'Nordvolt Automotive GmbH', 'nordvolt-automotive.example', 'DE', 'Bavaria', 'Munich', 'importer', '汽车零部件进口', '100-500', 'qualified', 86, 'high', 0],
    ['demo_cmp_rheintal', 'Rheintal Mobility Parts GmbH', 'rheintal-mobility.example', 'DE', 'NRW', 'Düsseldorf', 'distributor', '汽车售后市场', '20-100', 'contacted', 78, 'high', 1],
    ['demo_cmp_atlas', 'Atlas Auto Components B.V.', 'atlas-auto-components.example', 'NL', 'North Holland', 'Amsterdam', 'importer', '汽车零部件贸易', '20-100', 'replied', 91, 'high', 2],
    ['demo_cmp_lyon', 'Lyon Électro Parts SAS', 'lyon-electro-parts.example', 'FR', 'Auvergne-Rhône-Alpes', 'Lyon', 'distributor', '新能源汽车售后', '50-200', 'replied', 84, 'high', 3],
    ['demo_cmp_vistula', 'Vistula Automotive Sp. z o.o.', 'vistula-automotive.example', 'PL', 'Masovia', 'Warsaw', 'importer', '汽车零部件进口', '20-100', 'contacted', 72, 'medium', 4],
    ['demo_cmp_iberia', 'Iberia Movilidad S.L.', 'iberia-movilidad.example', 'ES', 'Madrid', 'Madrid', 'distributor', '汽车售后市场', '10-50', 'qualified', 69, 'medium', 5],
    ['demo_cmp_bavaria', 'Bavaria Drive Systems AG', 'bavaria-drive-systems.example', 'DE', 'Bavaria', 'Ingolstadt', 'manufacturer', '动力总成制造', '500+', 'new', 64, 'medium', 7],
    ['demo_cmp_milano', 'Milano Ricambi S.r.l.', 'milano-ricambi.example', 'IT', 'Lombardy', 'Milan', 'aftermarket', '汽车售后配件', '10-50', 'new', 61, 'low', 8],
    ['demo_cmp_brno', 'Brno Auto Supply s.r.o.', 'brno-auto-supply.example', 'CZ', 'South Moravia', 'Brno', 'distributor', '汽车零部件分销', '20-100', 'contacted', 75, 'medium', 6],
    ['demo_cmp_flanders', 'Flanders EV Solutions NV', 'flanders-ev-solutions.example', 'BE', 'Flanders', 'Ghent', 'aftermarket', '新能源车改装与售后', '10-50', 'qualified', 82, 'high', 9],
    ['demo_cmp_scandi', 'Scandinavian E-Mobility AB', 'scandinavian-emobility.example', 'SE', 'Stockholm', 'Stockholm', 'importer', '电动车零部件进口', '20-100', 'new', 68, 'medium', 10],
    ['demo_cmp_danube', 'Danube Parts Kft.', 'danube-parts.example', 'HU', 'Central Hungary', 'Budapest', 'distributor', '汽车零部件贸易', '10-50', 'new', 55, 'low', 11],
  ];
  for (const [id, name, domain, country, region, city, type, industry, size, status, quality, confidence, activityDays] of companies) {
    insert('companies', {
      id,
      workspace_id: DEMO_WORKSPACE,
      name,
      normalized_name: name.toLowerCase(),
      domain,
      website: `https://${domain}`,
      country,
      region,
      city,
      company_type: type,
      industry,
      employee_range: size,
      description: `${name} 是一家位于${country}的${industry}企业，关注新能源汽车零部件采购与售后供应。`,
      status,
      tags_json: JSON.stringify(['新能源汽车', '欧洲']),
      icp_id: 'demo_icp_importer',
      owner_user_id: DEMO_USER,
      data_quality_score: quality,
      confidence,
      last_verified_at: iso(activityDays),
      created_by: DEMO_USER,
      created_at: iso(30, 0, 0),
      updated_at: iso(activityDays),
    });
    insert('company_sources', {
      id: `demo_src_${id.slice(-8)}`,
      workspace_id: DEMO_WORKSPACE,
      company_id: id,
      source_type: 'demo_seed',
      source_name: '演示数据',
      source_url: `https://${domain}`,
      retrieved_at: iso(activityDays),
      payload_json: JSON.stringify({ note: '虚构演示企业，域名使用 .example 保留域' }),
      confidence: 80,
      created_at: iso(activityDays),
    });
  }

  // -------------------------------------------------------------- contacts
  const contacts = [
    ['demo_ct_nord_1', 'demo_cmp_nordvolt', 'Lukas', 'Weber', '采购经理', 'decision_maker', 'lukas.weber@nordvolt-automotive.example', 'business', 'valid', 'de', 1, 'high'],
    ['demo_ct_nord_2', 'demo_cmp_nordvolt', 'Anna', 'Schmidt', '品类经理', 'influencer', 'anna.schmidt@nordvolt-automotive.example', 'business', 'valid', 'de', 0, 'medium'],
    ['demo_ct_rhein_1', 'demo_cmp_rheintal', 'Markus', 'Becker', '采购负责人', 'decision_maker', 'm.becker@rheintal-mobility.example', 'business', 'unverified', 'de', 1, 'medium'],
    ['demo_ct_atlas_1', 'demo_cmp_atlas', 'Daan', 'de Vries', 'Purchasing Manager', 'decision_maker', 'daan.devries@atlas-auto-components.example', 'business', 'valid', 'nl', 1, 'high'],
    ['demo_ct_atlas_2', 'demo_cmp_atlas', 'Sanne', 'Bakker', 'Technical Buyer', 'technical', 'inferred.sanne@atlas-auto-components.example', 'inferred', 'inferred', 'nl', 0, 'low'],
    ['demo_ct_lyon_1', 'demo_cmp_lyon', 'Camille', 'Moreau', 'Responsable Achats', 'decision_maker', 'camille.moreau@lyon-electro-parts.example', 'business', 'valid', 'fr', 1, 'high'],
    ['demo_ct_lyon_2', 'demo_cmp_lyon', 'Julien', 'Bernard', 'Directeur Technique', 'technical', 'j.bernard@lyon-electro-parts.example', 'business', 'unverified', 'fr', 0, 'medium'],
    ['demo_ct_vist_1', 'demo_cmp_vistula', 'Piotr', 'Nowak', 'Kierownik Zakupów', 'decision_maker', 'piotr.nowak@vistula-automotive.example', 'business', 'valid', 'pl', 1, 'high'],
    ['demo_ct_iberia_1', 'demo_cmp_iberia', 'Carlos', 'Ruiz', 'Jefe de Compras', 'decision_maker', 'carlos.ruiz@iberia-movilidad.example', 'business', 'unverified', 'es', 1, 'medium'],
    ['demo_ct_bavaria_1', 'demo_cmp_bavaria', 'Stefan', 'Huber', 'Einkauf', 'influencer', 'stefan.huber@bavaria-drive-systems.example', 'business', 'unverified', 'de', 1, 'medium'],
    ['demo_ct_milano_1', 'demo_cmp_milano', 'Giulia', 'Rossi', 'Acquisti', 'decision_maker', 'giulia.rossi@milano-ricambi.example', 'business', 'risky', 'it', 1, 'low'],
    ['demo_ct_brno_1', 'demo_cmp_brno', 'Jan', 'Novak', 'Nákupčí', 'decision_maker', 'jan.novak@brno-auto-supply.example', 'business', 'valid', 'cs', 1, 'high'],
    ['demo_ct_flanders_1', 'demo_cmp_flanders', 'Els', 'Janssens', 'Purchasing Lead', 'decision_maker', 'els.janssens@flanders-ev-solutions.example', 'business', 'valid', 'nl', 1, 'high'],
    ['demo_ct_scandi_1', 'demo_cmp_scandi', 'Erik', 'Lindqvist', 'Inköpschef', 'decision_maker', 'erik.lindqvist@scandinavian-emobility.example', 'business', 'unverified', 'sv', 1, 'medium'],
    ['demo_ct_danube_1', 'demo_cmp_danube', 'Márta', 'Kovács', 'Beszerzési Vezető', 'decision_maker', 'marta.kovacs@danube-parts.example', 'role', 'risky', 'hu', 1, 'low'],
  ];
  for (const [id, companyId, firstName, lastName, title, roleCategory, email, emailType, emailStatus, language, isPrimary, confidence] of contacts) {
    insert('contacts', {
      id,
      workspace_id: DEMO_WORKSPACE,
      company_id: companyId,
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`,
      title,
      role_category: roleCategory,
      email,
      email_normalized: email.toLowerCase(),
      email_type: emailType,
      email_status: emailStatus,
      country: null,
      language,
      is_primary: isPrimary,
      confidence,
      last_verified_at: emailStatus === 'valid' ? iso(3) : null,
      created_by: DEMO_USER,
      created_at: iso(24),
      updated_at: iso(3),
    });
    insert('contact_sources', {
      id: `demo_cs_${id.slice(-8)}`,
      workspace_id: DEMO_WORKSPACE,
      contact_id: id,
      source_type: 'demo_seed',
      source_url: `https://${companies.find((c) => c[0] === companyId)?.[2]}`,
      method: emailType === 'inferred' ? 'inference' : 'manual',
      retrieved_at: iso(20),
      confidence: emailType === 'inferred' ? 45 : 85,
      payload_json: '{"note":"演示联系人（虚构）"}',
      created_at: iso(20),
    });
    if (emailStatus === 'valid') {
      insert('data_verifications', {
        id: `demo_ver_${id.slice(-8)}`,
        workspace_id: DEMO_WORKSPACE,
        entity_type: 'contact',
        entity_id: id,
        check_type: 'domain_mx',
        result: 'passed',
        confidence: 80,
        details_json: JSON.stringify({ mx: true, note: '演示记录：域名存在 MX 记录' }),
        verified_at: iso(3),
        created_at: iso(3),
      });
    }
  }

  // ---------------------------------------------------------- scores/matches
  const factors = [
    ['product_match', '产品与业务匹配', 30, 26, '企业进口新能源汽车售后零部件，产品类目匹配'],
    ['company_type', '企业类型匹配', 20, 17, '进口商 / 区域经销商符合 ICP'],
    ['region', '地区匹配', 15, 15, '位于目标市场德国'],
    ['purchase_scenario', '采购场景匹配', 15, 11, '官网提到 2026 年 EV 售后件采购计划'],
    ['data_confidence', '信息可信度', 10, 8, '官网、行业目录与公开联系人信息交叉确认'],
    ['contact_confidence', '联系方式可信度', 10, 7, '企业邮箱域名 MX 校验通过'],
  ];
  const scoreByCompany = {
    demo_cmp_nordvolt: 84,
    demo_cmp_atlas: 90,
    demo_cmp_lyon: 82,
    demo_cmp_flanders: 80,
    demo_cmp_rheintal: 74,
    demo_cmp_vistula: 68,
    demo_cmp_iberia: 66,
    demo_cmp_brno: 71,
    demo_cmp_bavaria: 59,
    demo_cmp_milano: 54,
    demo_cmp_scandi: 63,
    demo_cmp_danube: 48,
  };
  for (const [companyId, score] of Object.entries(scoreByCompany)) {
    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';
    insert('lead_scores', {
      id: `demo_score_${companyId.slice(-8)}`,
      workspace_id: DEMO_WORKSPACE,
      company_id: companyId,
      product_id: 'demo_prod_bracket',
      score,
      grade,
      factors_json: JSON.stringify(
        factors.map(([key, label, weight, baseScore, reason]) => ({
          key,
          label,
          weight,
          score: Math.round((baseScore / weight) * 100),
          reason,
        })),
      ),
      exclusions_json: '[]',
      explanation: `规则评分 ${score} 分（${grade} 级）。主要依据：目标市场、企业类型与公开采购信号；未命中排除条件。`,
      model_version: 'rules-v1',
      scored_at: iso(2),
      created_at: iso(2),
    });
    insert('company_product_matches', {
      id: `demo_match_${companyId.slice(-8)}`,
      workspace_id: DEMO_WORKSPACE,
      company_id: companyId,
      product_id: score >= 60 ? 'demo_prod_bracket' : 'demo_prod_stamp',
      match_score: Math.min(100, score),
      reasons_json: JSON.stringify(['产品类目匹配', '目标市场匹配', '采购角色可触达']),
      evidence_json: JSON.stringify([{ source: 'website', note: '官网产品页提到 EV 零部件' }]),
      status: score >= 60 ? 'confirmed' : 'suggested',
      matched_by: 'rule',
      reviewed_by: score >= 60 ? DEMO_USER : null,
      created_at: iso(7),
      updated_at: iso(7),
    });
  }

  // -------------------------------------------------------------- email box
  insert('email_accounts', {
    id: 'demo_mailbox',
    workspace_id: DEMO_WORKSPACE,
    name: '演示邮箱（模拟）',
    address: 'sales@zhirai-demo.example',
    display_name: 'ZHIRAI Europe Sales',
    protocol: 'simulation',
    smtp_host: null,
    smtp_port: null,
    smtp_secure: 0,
    imap_host: null,
    imap_port: null,
    imap_secure: 0,
    username: null,
    credential_enc: null,
    signature: 'ZHIRAI · 智睿科技\nhttps://zhirai.cloud',
    daily_limit: 30,
    status: 'active',
    created_by: DEMO_USER,
    created_at: iso(20),
    updated_at: iso(2),
  });

  // ------------------------------------------------------------ agent runs
  const agentRoles = [
    ['outreach_writer', 'outreach-writer.v1', '为 Atlas Auto Components 生成首封开发信'],
    ['reply_classification', 'reply-classifier.v1', '识别 Atlas 回复中的报价请求'],
    ['company_qualification', 'company-qualifier.v1', '按 ICP 评估 Nordvolt Automotive'],
    ['quality_review', 'quality-reviewer.v1', '检查开发信事实依据与语言质量'],
  ];
  agentRoles.forEach(([role, promptVersion, summary], index) => {
    insert('agent_executions', {
      id: `demo_exec_${index + 1}`,
      workspace_id: DEMO_WORKSPACE,
      agent_role: role,
      status: 'succeeded',
      input_json: JSON.stringify({ summary }),
      output_json: JSON.stringify({ summary, provider: 'simulation' }),
      prompt_version: promptVersion,
      provider: 'simulation',
      model: 'zhirai-sim-1',
      tokens_in: 1200 + index * 220,
      tokens_out: 420 + index * 80,
      cost_estimate: 0,
      latency_ms: 900 + index * 260,
      created_by: DEMO_USER,
      started_at: iso(2, 3),
      finished_at: iso(2, 2),
      created_at: iso(2, 3),
    });
  });

  // ------------------------------------------------------------- campaigns
  insert('campaigns', {
    id: 'demo_camp_de_q4',
    workspace_id: DEMO_WORKSPACE,
    name: '德国 EV 汽配进口商 · Q4 开发',
    product_id: 'demo_prod_bracket',
    icp_id: 'demo_icp_importer',
    goal: '获取德国进口商报价请求',
    status: 'active',
    daily_limit: 20,
    send_window_json: JSON.stringify({ start: 9, end: 17, weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' }),
    require_approval: 1,
    created_by: DEMO_USER,
    created_at: iso(12),
    updated_at: iso(2),
  });
  const steps = [
    [1, '首封开发信', 'EV battery brackets — 适配欧洲售后市场的稳定供应', 'Hello {{contactFirstName}},\n\nI noticed {{companyName}} supplies EV aftermarket parts in {{country}}. We manufacture aluminum EV battery pack brackets (IATF 16949, RoHS, REACH) with MOQ 200 pcs and 25-35 day lead time.\n\nWould it make sense to send you our specification sheet and a quotation for your 2026 sourcing plan?\n\nBest regards,\nZHIRAI Europe Sales', 0],
    [2, '3 天后跟进', 'Re: EV battery brackets — specification sheet', 'Hello {{contactFirstName}},\n\nFollowing up on my previous note. We can provide a paid sample (2 pcs) within 7 working days so your team can validate fitment before ordering.\n\nWould a short technical call next week be useful?\n\nBest regards,\nZHIRAI Europe Sales', 3],
    [3, '7 天后收尾', 'Re: EV battery brackets — closing the loop', 'Hello {{contactFirstName}},\n\nI will close the loop here. If EV battery brackets are not part of your current sourcing plan, just let me know and I will not follow up again.\n\nIf timing changes, our specification sheet is ready whenever you need it.\n\nBest regards,\nZHIRAI Europe Sales', 7],
  ];
  for (const [stepNo, name, subject, body, delayDays] of steps) {
    insert('campaign_steps', {
      id: `demo_step_${stepNo}`,
      workspace_id: DEMO_WORKSPACE,
      campaign_id: 'demo_camp_de_q4',
      step_no: stepNo,
      name,
      channel: 'email',
      subject_template: subject,
      body_template: body,
      language: 'en',
      delay_days: delayDays,
      conditions_json: '{}',
      is_active: 1,
      created_at: iso(12),
      updated_at: iso(12),
    });
  }
  const targets = [
    ['demo_cmp_nordvolt', 'demo_ct_nord_1', 'active', 1],
    ['demo_cmp_rheintal', 'demo_ct_rhein_1', 'active', 1],
    ['demo_cmp_atlas', 'demo_ct_atlas_1', 'replied', 2],
    ['demo_cmp_lyon', 'demo_ct_lyon_1', 'replied', 2],
    ['demo_cmp_vistula', 'demo_ct_vist_1', 'active', 1],
    ['demo_cmp_brno', 'demo_ct_brno_1', 'active', 1],
  ];
  for (const [companyId, contactId, status, step] of targets) {
    insert('campaign_targets', {
      id: `demo_target_${companyId.slice(-8)}`,
      workspace_id: DEMO_WORKSPACE,
      campaign_id: 'demo_camp_de_q4',
      company_id: companyId,
      contact_id: contactId,
      status,
      current_step: step,
      enrolled_at: iso(10),
      next_run_at: status === 'active' ? future(1) : null,
      last_contacted_at: iso(5),
      created_at: iso(10),
      updated_at: iso(2),
    });
  }

  // -------------------------------------------------------- threads/messages
  const threads = [
    ['demo_thr_atlas', 'demo_cmp_atlas', 'demo_ct_atlas_1', 'Re: EV battery brackets — request for quotation', 'price_inquiry', 1],
    ['demo_thr_lyon', 'demo_cmp_lyon', 'demo_ct_lyon_1', 'Re: EV battery brackets — sample request', 'sample_request', 1],
    ['demo_thr_nord', 'demo_cmp_nordvolt', 'demo_ct_nord_1', 'Re: EV battery brackets — evaluation', 'positive_interest', 1],
  ];
  for (const [id, companyId, contactId, subject, classification, messageCount] of threads) {
    insert('email_threads', {
      id,
      workspace_id: DEMO_WORKSPACE,
      account_id: 'demo_mailbox',
      company_id: companyId,
      contact_id: contactId,
      subject,
      last_message_at: iso(2, 4),
      message_count: messageCount,
      status: 'replied',
      classification,
      created_at: iso(8),
      updated_at: iso(2, 4),
    });
  }

  const messages = [
    ['demo_msg_atlas_out', 'demo_thr_atlas', 'demo_cmp_atlas', 'demo_ct_atlas_1', 'outbound', 'sales@zhirai-demo.example', 'Atlas Auto Components B.V.', 'daan.devries@atlas-auto-components.example', 'EV battery brackets — 适配欧洲售后市场的稳定供应', 'Hello Daan,\n\nI noticed Atlas Auto Components supplies EV aftermarket parts in the Netherlands...', 8],
    ['demo_msg_atlas_in', 'demo_thr_atlas', 'demo_cmp_atlas', 'demo_ct_atlas_1', 'inbound', 'daan.devries@atlas-auto-components.example', 'Daan de Vries', 'sales@zhirai-demo.example', 'Re: EV battery brackets — request for quotation', 'Hello,\n\nThank you for your email. Please send your quotation for 500 pcs of the aluminum EV battery bracket, FOB Shanghai. We would also like to know the lead time and whether you can provide a sample.\n\nBest regards,\nDaan de Vries\nAtlas Auto Components', 2, 4],
    ['demo_msg_lyon_out', 'demo_thr_lyon', 'demo_cmp_lyon', 'demo_ct_lyon_1', 'outbound', 'sales@zhirai-demo.example', 'Lyon Électro Parts SAS', 'camille.moreau@lyon-electro-parts.example', 'EV battery brackets — 适配欧洲售后市场的稳定供应', 'Hello Camille,\n\nWe manufacture EV battery pack brackets for European aftermarket distributors...', 7],
    ['demo_msg_lyon_in', 'demo_thr_lyon', 'demo_cmp_lyon', 'demo_ct_lyon_1', 'inbound', 'camille.moreau@lyon-electro-parts.example', 'Camille Moreau', 'sales@zhirai-demo.example', 'Re: EV battery brackets — sample request', 'Bonjour,\n\nNous sommes intéressés par un échantillon de votre support de batterie. Merci de nous indiquer le prix et le délai de livraison.\n\nCordialement,\nCamille Moreau', 2, 2],
    ['demo_msg_nord_out', 'demo_thr_nord', 'demo_cmp_nordvolt', 'demo_ct_nord_1', 'outbound', 'sales@zhirai-demo.example', 'Nordvolt Automotive GmbH', 'lukas.weber@nordvolt-automotive.example', 'EV battery brackets — 适配欧洲售后市场的稳定供应', 'Hello Lukas,\n\nWe manufacture aluminum EV battery pack brackets...', 5],
    ['demo_msg_nord_in', 'demo_thr_nord', 'demo_cmp_nordvolt', 'demo_ct_nord_1', 'inbound', 'lukas.weber@nordvolt-automotive.example', 'Lukas Weber', 'sales@zhirai-demo.example', 'Re: EV battery brackets — evaluation', 'Hello,\n\nWe are evaluating suppliers for our 2026 EV aftermarket line. Your product looks relevant. Could you share certifications and capacity?\n\nKind regards,\nLukas Weber', 2, 6],
  ];
  for (const [id, threadId, companyId, contactId, direction, from, fromName, to, subject, body, daysAgo, hoursAgo = 0] of messages) {
    insert('email_messages', {
      id,
      workspace_id: DEMO_WORKSPACE,
      account_id: 'demo_mailbox',
      thread_id: threadId,
      company_id: companyId,
      contact_id: contactId,
      direction,
      from_address: from,
      from_name: fromName,
      to_addresses_json: JSON.stringify([direction === 'inbound' ? to : 'daan.devries@atlas-auto-components.example']),
      cc_json: '[]',
      bcc_json: '[]',
      subject,
      body_text: body,
      body_html: null,
      message_id_header: `<${id}@zhirai-demo.example>`,
      in_reply_to: direction === 'inbound' ? `<demo_msg_${id.includes('atlas') ? 'atlas_out' : id.includes('lyon') ? 'lyon_out' : 'nord_out'}@zhirai-demo.example>` : null,
      references_json: '[]',
      sent_at: direction === 'outbound' ? iso(daysAgo, hoursAgo) : null,
      received_at: direction === 'inbound' ? iso(daysAgo, hoursAgo) : null,
      status: direction === 'outbound' ? 'sent' : 'received',
      is_read: direction === 'inbound' ? 0 : 1,
      raw_headers_json: '{}',
      created_at: iso(daysAgo, hoursAgo),
    });
  }

  const classifications = [
    ['demo_cls_atlas', 'demo_thr_atlas', 'demo_msg_atlas_in', 'demo_cmp_atlas', 'demo_ct_atlas_1', 'price_inquiry', 0.91, 88, '客户明确要求 500 pcs 报价、FOB 条件、交期与样品', 'Please send your quotation for 500 pcs ... FOB Shanghai ... lead time ... sample.'],
    ['demo_cls_lyon', 'demo_thr_lyon', 'demo_msg_lyon_in', 'demo_cmp_lyon', 'demo_ct_lyon_1', 'sample_request', 0.86, 74, '法文回复中明确询问样品价格与交期', 'Nous sommes intéressés par un échantillon ... prix et délai.'],
    ['demo_cls_nord', 'demo_thr_nord', 'demo_msg_nord_in', 'demo_cmp_nordvolt', 'demo_ct_nord_1', 'positive_interest', 0.83, 70, '客户表示正在评估 2026 供应商，要求认证与产能资料', 'We are evaluating suppliers for our 2026 EV aftermarket line ...'],
  ];
  for (const [id, threadId, messageId, companyId, contactId, label, confidence, intentScore, rationale, evidence] of classifications) {
    insert('conversation_classifications', {
      id,
      workspace_id: DEMO_WORKSPACE,
      thread_id: threadId,
      message_id: messageId,
      company_id: companyId,
      contact_id: contactId,
      label,
      confidence,
      intent_score: intentScore,
      evidence_json: JSON.stringify([evidence]),
      rationale,
      suggested_reply: '感谢您的回复，我们会在 1 个工作日内发送报价与规格书，并确认样品安排。',
      status: 'ai_suggested',
      agent_execution_id: 'demo_exec_2',
      created_at: iso(2, 3),
      updated_at: iso(2, 3),
    });
  }

  // -------------------------------------------------------------- drafts
  insert('message_drafts', {
    id: 'demo_draft_atlas',
    workspace_id: DEMO_WORKSPACE,
    company_id: 'demo_cmp_atlas',
    contact_id: 'demo_ct_atlas_1',
    campaign_id: 'demo_camp_de_q4',
    campaign_step_id: 'demo_step_2',
    account_id: 'demo_mailbox',
    subject: 'Re: EV battery brackets — quotation for 500 pcs',
    body_text: 'Hello Daan,\n\nThank you for your detailed request. For 500 pcs of the aluminum EV battery bracket (ZR-EV-BRK-01), our FOB Shanghai quotation is attached to this thread. Lead time is 25-35 days after deposit, and we can provide 2 paid samples within 7 working days.\n\nKey confirmed facts:\n- Material: aluminum 6061-T6, CNC + anodized\n- Certifications: IATF 16949, RoHS, REACH\n- MOQ: 200 pcs\n\nI will also include the specification sheet. Please let me know if you need a technical call.\n\nBest regards,\nZHIRAI Europe Sales',
    language: 'en',
    status: 'pending_approval',
    generated_by: 'demo_exec_1',
    quality_json: JSON.stringify({ score: 88, issues: [], checks: ['事实匹配产品库', '无夸大承诺', '包含退订与签名'] }),
    guard_json: JSON.stringify({ allowed: true, blockers: [], warnings: [] }),
    created_at: iso(1, 6),
    updated_at: iso(1, 2),
  });
  insert('message_drafts', {
    id: 'demo_draft_nord',
    workspace_id: DEMO_WORKSPACE,
    company_id: 'demo_cmp_nordvolt',
    contact_id: 'demo_ct_nord_1',
    campaign_id: 'demo_camp_de_q4',
    campaign_step_id: 'demo_step_2',
    account_id: 'demo_mailbox',
    subject: 'Re: EV battery brackets — certifications and capacity',
    body_text: 'Hello Lukas,\n\nThank you for evaluating us for your 2026 EV aftermarket line.\n\nOur confirmed documents: IATF 16949 (factory system), RoHS and REACH certificates. Current capacity is 8,000 pcs per month for the aluminum EV battery bracket; MOQ is 200 pcs with 25-35 day lead time.\n\nI can send the certificate package and a specification sheet today. Would next Tuesday 10:00 CET work for a short technical call?\n\nBest regards,\nZHIRAI Europe Sales',
    language: 'en',
    status: 'pending_approval',
    generated_by: 'demo_exec_1',
    quality_json: JSON.stringify({ score: 84, issues: [], checks: ['认证来自产品资料库', '未承诺未确认事项'] }),
    guard_json: JSON.stringify({ allowed: true, blockers: [], warnings: [] }),
    created_at: iso(1, 4),
    updated_at: iso(1, 1),
  });
  insert('message_drafts', {
    id: 'demo_draft_rhein',
    workspace_id: DEMO_WORKSPACE,
    company_id: 'demo_cmp_rheintal',
    contact_id: 'demo_ct_rhein_1',
    campaign_id: 'demo_camp_de_q4',
    campaign_step_id: 'demo_step_1',
    account_id: 'demo_mailbox',
    subject: 'EV battery brackets — specification sheet for Rheintal Mobility Parts',
    body_text: 'Hello Markus,\n\nI am reaching out because Rheintal Mobility Parts supplies automotive aftermarket components in Germany. We manufacture aluminum EV battery pack brackets with IATF 16949, RoHS and REACH documentation.\n\nCould I send you the specification sheet and MOQ/lead-time details for your 2026 sourcing review?\n\nBest regards,\nZHIRAI Europe Sales',
    language: 'en',
    status: 'approved',
    generated_by: 'demo_exec_1',
    quality_json: JSON.stringify({ score: 86, issues: [], checks: ['事实匹配', '无夸大承诺'] }),
    guard_json: JSON.stringify({ allowed: true, blockers: [], warnings: [] }),
    approved_by: DEMO_USER,
    approved_at: iso(1, 5),
    created_at: iso(3),
    updated_at: iso(1, 5),
  });
  insert('message_drafts', {
    id: 'demo_draft_sent_lyon',
    workspace_id: DEMO_WORKSPACE,
    company_id: 'demo_cmp_lyon',
    contact_id: 'demo_ct_lyon_1',
    campaign_id: 'demo_camp_de_q4',
    campaign_step_id: 'demo_step_1',
    account_id: 'demo_mailbox',
    subject: 'EV battery brackets — 适配欧洲售后市场的稳定供应',
    body_text: 'Hello Camille,\n\nWe manufacture aluminum EV battery pack brackets for European aftermarket distributors...',
    language: 'en',
    status: 'sent',
    generated_by: 'demo_exec_1',
    quality_json: '{}',
    guard_json: '{"allowed":true}',
    approved_by: DEMO_USER,
    approved_at: iso(7),
    sent_message_id: 'demo_msg_lyon_out',
    created_at: iso(8),
    updated_at: iso(7),
  });

  // ---------------------------------------------------------------- deals
  const deals = [
    ['demo_deal_atlas', 'demo_cmp_atlas', 'demo_ct_atlas_1', 'Atlas · 500 pcs EV 支架询价', 'proposal', 18500, 60, 'demo_ct_atlas_1'],
    ['demo_deal_nord', 'demo_cmp_nordvolt', 'demo_ct_nord_1', 'Nordvolt · 2026 年度框架', 'negotiation', 72000, 45, 'demo_ct_nord_1'],
    ['demo_deal_lyon', 'demo_cmp_lyon', 'demo_ct_lyon_1', 'Lyon · 样品转订单', 'qualified', 6400, 35, 'demo_ct_lyon_1'],
    ['demo_deal_flanders', 'demo_cmp_flanders', 'demo_ct_flanders_1', 'Flanders EV · 改装件试单', 'lead', 4200, 20, 'demo_ct_flanders_1'],
  ];
  for (const [id, companyId, contactId, title, stage, amount, probability, ownerId] of deals) {
    insert('deals', {
      id,
      workspace_id: DEMO_WORKSPACE,
      company_id: companyId,
      contact_id: contactId,
      product_id: 'demo_prod_bracket',
      title,
      stage,
      value_amount: amount,
      currency: 'EUR',
      probability,
      expected_close_date: new Date(now + 30 * 86_400_000).toISOString().slice(0, 10),
      status: 'open',
      owner_user_id: DEMO_USER,
      created_at: iso(6),
      updated_at: iso(1),
    });
  }

  const activities = [
    ['demo_cmp_atlas', 'email', '收到询价回复', '客户要求 500 pcs 报价、FOB 条件与样品', 2],
    ['demo_cmp_nordvolt', 'email', '收到认证与产能询问', '客户正在评估 2026 供应商', 2],
    ['demo_cmp_lyon', 'email', '收到样品需求', '法语回复询问样品价格与交期', 2],
    ['demo_cmp_rheintal', 'note', '已批准首封开发信', '等待人工发送窗口', 1],
  ];
  for (const [companyId, type, subject, body, daysAgo] of activities) {
    insert('sales_activities', {
      id: `demo_act_${Math.random().toString(36).slice(2, 10)}`,
      workspace_id: DEMO_WORKSPACE,
      company_id: companyId,
      contact_id: null,
      deal_id: null,
      type,
      subject,
      body,
      occurred_at: iso(daysAgo, 3),
      user_id: DEMO_USER,
      created_at: iso(daysAgo, 3),
    });
  }

  const followUps = [
    ['demo_cmp_nordvolt', '回复认证资料与规格书', 1],
    ['demo_cmp_atlas', '发送 500 pcs 报价单', 0],
    ['demo_cmp_lyon', '确认样品价格与运费', 2],
  ];
  for (const [companyId, title, dueDays] of followUps) {
    insert('follow_up_tasks', {
      id: `demo_task_${companyId.slice(-8)}`,
      workspace_id: DEMO_WORKSPACE,
      company_id: companyId,
      contact_id: null,
      campaign_id: 'demo_camp_de_q4',
      deal_id: null,
      due_at: future(dueDays),
      type: 'follow_up',
      title,
      notes: '演示任务：请根据客户回复人工确认后再发送。',
      status: 'pending',
      assigned_to: DEMO_USER,
      created_at: iso(2),
      updated_at: iso(2),
    });
  }

  // ---------------------------------------------------- automation/suppression
  const automation = [
    ['demo_cmp_atlas', 'NEEDS_HUMAN_REVIEW', '客户回复询价，需要人工确认报价'],
    ['demo_cmp_nordvolt', 'HUMAN_TAKEOVER', '销售已人工接管，AI 停止自动跟进'],
    ['demo_cmp_lyon', 'HUMAN_TAKEOVER', '法语客户，人工跟进'],
    ['demo_cmp_milano', 'DO_NOT_CONTACT', '客户明确拒绝联系'],
  ];
  for (const [companyId, state, reason] of automation) {
    insert('automation_states', {
      id: `demo_aut_${companyId.slice(-8)}`,
      workspace_id: DEMO_WORKSPACE,
      company_id: companyId,
      state,
      reason,
      changed_by: DEMO_USER,
      changed_at: iso(2),
      created_at: iso(2),
      updated_at: iso(2),
    });
  }
  insert('suppression_records', {
    id: 'demo_sup_milano',
    workspace_id: DEMO_WORKSPACE,
    scope: 'email',
    value_normalized: 'giulia.rossi@milano-ricambi.example',
    reason: 'unsubscribe',
    source: 'reply',
    note: '客户回复要求停止联系（演示数据）',
    created_by: DEMO_USER,
    created_at: iso(3),
  });

  // ---------------------------------------------------------- notifications
  insert('notifications', {
    id: 'demo_ntf_atlas',
    workspace_id: DEMO_WORKSPACE,
    user_id: null,
    type: 'high_intent',
    title: 'Atlas Auto Components 请求报价',
    body: '客户要求 500 pcs FOB 报价与样品，置信度 91%。建议 1 个工作日内回复。',
    entity_type: 'company',
    entity_id: 'demo_cmp_atlas',
    severity: 'critical',
    created_at: iso(2, 3),
  });
  insert('notifications', {
    id: 'demo_ntf_approval',
    workspace_id: DEMO_WORKSPACE,
    user_id: null,
    type: 'approval',
    title: '2 封开发信待审批',
    body: 'Atlas 与 Nordvolt 的回复草稿已生成，等待人工审批后发送。',
    entity_type: 'draft',
    entity_id: 'demo_draft_atlas',
    severity: 'warning',
    created_at: iso(1, 2),
  });
  insert('notifications', {
    id: 'demo_ntf_sample',
    workspace_id: DEMO_WORKSPACE,
    user_id: null,
    type: 'high_intent',
    title: 'Lyon Électro Parts 需要样品',
    body: '客户询问样品价格与交期，置信度 86%。',
    entity_type: 'company',
    entity_id: 'demo_cmp_lyon',
    severity: 'info',
    created_at: iso(2, 2),
  });

  // --------------------------------------------------------------- usage
  const usageRows = [
    ['ai_tokens', 'agents', 52400, 0, 0],
    ['email_sent', null, 24, 0, 0],
    ['agent_run', null, 18, 0, 0],
    ['data_lookup', null, 46, 0, 0],
    ['crawl', null, 12, 0, 0],
  ];
  for (const [category, agentRole, quantity, cost, unitIndex] of usageRows) {
    insert('usage_records', {
      id: `demo_use_${category}_${Math.random().toString(36).slice(2, 8)}`,
      workspace_id: DEMO_WORKSPACE,
      category,
      agent_role: agentRole,
      provider: 'simulation',
      model: 'zhirai-sim-1',
      quantity,
      unit: category === 'ai_tokens' ? 'tokens' : 'count',
      cost_estimate: cost,
      currency: 'USD',
      job_id: null,
      agent_execution_id: null,
      occurred_at: iso(1 + unitIndex),
      created_at: iso(1 + unitIndex),
    });
  }

  // ---------------------------------------------------------------- jobs
  const jobs = [
    ['demo_job_discovery', 'discovery.search', 'succeeded', 1, iso(4), null],
    ['demo_job_crawl', 'company.crawl', 'succeeded', 1, iso(3), null],
    ['demo_job_score', 'lead.score', 'succeeded', 1, iso(2), null],
    ['demo_job_draft', 'draft.generate', 'failed', 3, iso(1), 'Provider timeout after 60s (demo)'],
    ['demo_job_send', 'email.send', 'queued', 0, future(0, 1), null],
  ];
  for (const [id, type, status, attempts, runAt, error] of jobs) {
    insert('background_jobs', {
      id,
      workspace_id: DEMO_WORKSPACE,
      type,
      payload_json: JSON.stringify({ demo: true }),
      status,
      priority: 100,
      attempts,
      max_attempts: 3,
      run_at: runAt,
      started_at: status === 'succeeded' ? runAt : null,
      finished_at: status === 'succeeded' ? iso(2) : null,
      lease_until: null,
      worker_id: status === 'succeeded' ? 'worker-demo' : null,
      dedupe_key: `demo:${type}:${id}`,
      last_error: error,
      result_json: status === 'succeeded' ? '{"ok":true}' : '{}',
      cost_estimate: 0,
      created_by: DEMO_USER,
      created_at: iso(5),
      updated_at: iso(1),
    });
  }

  // --------------------------------------------------------------- audit
  insert('audit_events', {
    id: 'demo_aud_1',
    workspace_id: DEMO_WORKSPACE,
    actor_type: 'user',
    actor_id: DEMO_USER,
    action: 'automation.takeover',
    entity_type: 'company',
    entity_id: 'demo_cmp_nordvolt',
    before_json: '{"state":"AUTOMATION_ACTIVE"}',
    after_json: '{"state":"HUMAN_TAKEOVER"}',
    ip: '127.0.0.1',
    user_agent: 'demo-seed',
    request_id: null,
    created_at: iso(2),
  });
  insert('audit_events', {
    id: 'demo_aud_2',
    workspace_id: DEMO_WORKSPACE,
    actor_type: 'user',
    actor_id: DEMO_USER,
    action: 'draft.approve',
    entity_type: 'draft',
    entity_id: 'demo_draft_rhein',
    before_json: '{"status":"pending_approval"}',
    after_json: '{"status":"approved"}',
    ip: '127.0.0.1',
    user_agent: 'demo-seed',
    request_id: null,
    created_at: iso(1, 5),
  });

  // ---------------------------------------------------------- discovery runs
  insert('discovery_runs', {
    id: 'demo_run_1',
    workspace_id: DEMO_WORKSPACE,
    query_json: JSON.stringify({ productId: 'demo_prod_bracket', countries: ['DE', 'NL', 'FR'], keywords: ['EV battery bracket', 'aftermarket'], provider: 'simulation' }),
    provider: 'simulation',
    status: 'completed',
    result_count: 12,
    companies_created: 12,
    created_by: DEMO_USER,
    started_at: iso(4),
    finished_at: iso(4),
    created_at: iso(4),
  });

  // -------------------------------------------------------------- import run
  insert('import_runs', {
    id: 'demo_import_1',
    workspace_id: DEMO_WORKSPACE,
    kind: 'companies',
    filename: 'demo-companies.csv',
    total_rows: 12,
    created_count: 12,
    updated_count: 0,
    skipped_count: 0,
    error_count: 0,
    errors_json: '[]',
    status: 'completed',
    created_by: DEMO_USER,
    created_at: iso(9),
    finished_at: iso(9),
  });
}

ensureRuntimeDirs();
validateMigrationPolicy({ allowlist: config.migrations.allowlist, expectedDbPath: config.migrations.expectedDbPath, actualDbPath: config.dbFile, dataDir: config.dataDir, expectedDataDir: process.env.DATA_DIR || config.dataDir });
const db = openDatabase(config.dbFile);
try {
  assertOpenedDatabasePath(db, config.migrations.expectedDbPath);
  migrate(db, path.join(config.rootDir, 'server', 'db', 'migrations'), { allowlist: config.migrations.allowlist, expectedDbPath: config.migrations.expectedDbPath, actualDbPath: config.dbFile });
  assertSchemaReady(db);
  tx(() => seed());
  const user = get('SELECT email FROM users WHERE id = ?', [DEMO_USER]);
  console.log('');
  console.log('  ZHIRAI 演示数据已写入');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  工作空间：智睿欧洲汽配事业部`);
  console.log(`  演示账号：${user?.email || DEMO_EMAIL}`);
  console.log(`  演示密码：${DEMO_PASSWORD}`);
  console.log(`  访问地址：http://127.0.0.1:${config.port}`);
  console.log('  数据均为虚构演示企业，域名使用 .example 保留域。');
  console.log('');
} finally {
  closeDatabase();
}
