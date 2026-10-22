/**
 * Deterministic offline simulation outputs, one builder per role.
 *
 * The simulation provider is the default when no model credential is
 * configured. Its purpose is to keep every flow (drafting, qualification,
 * classification, tests, demos) working without network access. It must NEVER
 * be presented as a real model result: executions record provider
 * `simulation`, cost 0 and the outputs only reference facts present in the
 * caller-supplied input. Nothing is fetched from the internet.
 *
 * The builders are pure: same input -> same output (stable for tests and UI).
 */

const s = (value, fallback = '') => (typeof value === 'string' ? value.trim() || fallback : fallback);
const n = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const a = (value) => (Array.isArray(value) ? value : []);
const o = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const cut = (text, maximum) => (text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text);
const strings = (list, maximum = 20) =>
  a(list)
    .map((item) => s(item))
    .filter(Boolean)
    .slice(0, maximum);

// ---------------------------------------------------------------- outreach
const OUTREACH_TEMPLATES = {
  en: {
    fallbacks: { company: 'your company', industry: 'your industry', product: 'our product' },
    subject: (product, company) => `${product} for ${company}`,
    greeting: 'Hello,',
    intro: (company, industry, product) =>
      `I am reaching out because ${company} operates in ${industry}, and ${product} may be relevant to your procurement needs.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Certifications from our product data: ${certifications.join(', ')}.` : '',
        moq ? `MOQ: ${moq}.` : '',
        leadTime ? `Lead time: ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: 'Would you be open to a short online call to see whether this fits your roadmap?',
    unsubscribe: 'If you prefer not to receive further emails, just reply "unsubscribe" and we will remove your address.',
    close: 'Best regards,',
  },
  de: {
    fallbacks: { company: 'Ihr Unternehmen', industry: 'Ihrer Branche', product: 'unser Produkt' },
    subject: (product, company) => `Kurze Frage zu ${product} für ${company}`,
    greeting: 'Guten Tag,',
    intro: (company, industry, product) =>
      `Ich melde mich, weil ${company} im Bereich ${industry} tätig ist und ${product} zu Ihrem Beschaffungsbedarf passen könnte.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Zertifizierungen laut Produktdaten: ${certifications.join(', ')}.` : '',
        moq ? `Mindestbestellmenge: ${moq}.` : '',
        leadTime ? `Lieferzeit: ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: 'Wären Sie für ein kurzes Online-Gespräch offen, um zu prüfen, ob das für Sie relevant ist?',
    unsubscribe: 'Wenn Sie keine weiteren E-Mails wünschen, antworten Sie bitte mit „Abmelden" und wir entfernen Ihre Adresse.',
    close: 'Mit freundlichen Grüßen,',
  },
  fr: {
    fallbacks: { company: 'votre société', industry: 'votre secteur', product: 'notre produit' },
    subject: (product, company) => `Question rapide sur ${product} pour ${company}`,
    greeting: 'Bonjour,',
    intro: (company, industry, product) =>
      `Je vous contacte car ${company} évolue dans le secteur ${industry} et ${product} pourrait correspondre à vos besoins d'achat.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Certifications disponibles : ${certifications.join(', ')}.` : '',
        moq ? `Quantité minimale de commande : ${moq}.` : '',
        leadTime ? `Délai de livraison : ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: 'Seriez-vous disponible pour un court échange en ligne afin de vérifier si cela vous concerne ?',
    unsubscribe: "Si vous ne souhaitez plus recevoir d'e-mails, répondez « désabonnement » et nous supprimerons votre adresse.",
    close: 'Cordialement,',
  },
  es: {
    fallbacks: { company: 'su empresa', industry: 'su sector', product: 'nuestro producto' },
    subject: (product, company) => `Consulta rápida sobre ${product} para ${company}`,
    greeting: 'Hola,',
    intro: (company, industry, product) =>
      `Me pongo en contacto porque ${company} opera en el sector ${industry} y ${product} podría encajar en sus necesidades de compra.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Certificaciones disponibles: ${certifications.join(', ')}.` : '',
        moq ? `Cantidad mínima de pedido: ${moq}.` : '',
        leadTime ? `Plazo de entrega: ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: '¿Estaría disponible para una breve llamada online y comprobar si le resulta relevante?',
    unsubscribe: 'Si prefiere no recibir más correos, responda « baja » y eliminaremos su dirección.',
    close: 'Saludos cordiales,',
  },
  nl: {
    fallbacks: { company: 'uw bedrijf', industry: 'uw branche', product: 'ons product' },
    subject: (product, company) => `Korte vraag over ${product} voor ${company}`,
    greeting: 'Hallo,',
    intro: (company, industry, product) =>
      `Ik neem contact op omdat ${company} actief is in ${industry} en ${product} mogelijk aansluit bij uw inkoopbehoeften.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Certificeringen beschikbaar: ${certifications.join(', ')}.` : '',
        moq ? `Minimale bestelhoeveelheid: ${moq}.` : '',
        leadTime ? `Levertijd: ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: 'Zou u openstaan voor een kort online gesprek om te kijken of dit relevant is?',
    unsubscribe: 'Wilt u geen e-mails meer ontvangen, antwoord dan met "uitschrijven" en wij verwijderen uw adres.',
    close: 'Met vriendelijke groet,',
  },
  it: {
    fallbacks: { company: 'la vostra azienda', industry: 'il vostro settore', product: 'il nostro prodotto' },
    subject: (product, company) => `Breve domanda su ${product} per ${company}`,
    greeting: 'Buongiorno,',
    intro: (company, industry, product) =>
      `La contatto perché ${company} opera nel settore ${industry} e ${product} potrebbe essere rilevante per le vostre esigenze di acquisto.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Certificazioni disponibili: ${certifications.join(', ')}.` : '',
        moq ? `Quantità minima d'ordine: ${moq}.` : '',
        leadTime ? `Tempi di consegna: ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: 'Sarebbe disponibile per una breve call online per verificare se è pertinente?',
    unsubscribe: 'Se non desidera ricevere altre e-mail, risponda "annulla iscrizione" e rimuoveremo il suo indirizzo.',
    close: 'Cordiali saluti,',
  },
  pl: {
    fallbacks: { company: 'Państwa firma', industry: 'Państwa branża', product: 'nasz produkt' },
    subject: (product, company) => `Krótkie pytanie o ${product} dla ${company}`,
    greeting: 'Dzień dobry,',
    intro: (company, industry, product) =>
      `Piszę, ponieważ ${company} działa w branży ${industry}, a ${product} może odpowiadać Państwa potrzebom zakupowym.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Dostępne certyfikaty: ${certifications.join(', ')}.` : '',
        moq ? `Minimalna ilość zamówienia: ${moq}.` : '',
        leadTime ? `Czas dostawy: ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: 'Czy byliby Państwo otwarci na krótką rozmowę online, aby sprawdzić, czy to istotne?',
    unsubscribe: 'Jeśli nie chcą Państwo otrzymywać kolejnych e-maili, proszę odpowiedzieć „wypisz", a usuniemy adres.',
    close: 'Z poważaniem,',
  },
  pt: {
    fallbacks: { company: 'a vossa empresa', industry: 'o vosso setor', product: 'o nosso produto' },
    subject: (product, company) => `Questão rápida sobre ${product} para ${company}`,
    greeting: 'Olá,',
    intro: (company, industry, product) =>
      `Contacto porque ${company} atua no setor ${industry} e ${product} pode ser relevante para as vossas necessidades de compra.`,
    factLine: ({ certifications, moq, leadTime }) =>
      [
        certifications.length ? `Certificações disponíveis: ${certifications.join(', ')}.` : '',
        moq ? `Quantidade mínima de encomenda: ${moq}.` : '',
        leadTime ? `Prazo de entrega: ${leadTime}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ask: 'Estaria disponível para uma breve chamada online para verificar se isto é relevante?',
    unsubscribe: 'Se preferir não receber mais e-mails, responda "cancelar subscrição" e removeremos o seu endereço.',
    close: 'Com os melhores cumprimentos,',
  },
};

const PRODUCT_NOUNS = Object.freeze({
  en: 'product',
  de: 'Produkt',
  fr: 'produit',
  es: 'producto',
  nl: 'product',
  it: 'prodotto',
  pl: 'produkt',
  pt: 'produto',
});

const REPLY_TEMPLATES = {
  positive_interest: 'Thank you for your reply. I would be happy to arrange a short call at a time that suits you — would next week work?',
  price_inquiry: 'Thank you for your interest. To give you accurate pricing, could you share the required specifications and volume? We will confirm the details internally.',
  quote_request: 'Thank you for the request. We will prepare a quotation based on the specifications you shared and come back to you shortly.',
  sample_request: 'Thank you for your interest in a sample. Could you confirm the required specification and delivery address so we can arrange it?',
  technical_question: 'Thank you for the technical question. I will confirm the details with our technical team and get back to you with a precise answer.',
  follow_up_needed: 'Thank you for the update. I will follow up at the time you mentioned — please let me know if anything changes.',
  no_need_now: 'Thank you for letting me know. I will not follow up for now; feel free to reach out if your requirements change.',
  rejection: 'Thank you for your reply. I understand and will respect your decision. All the best with your projects.',
  unsubscribe: '',
  auto_reply: '',
  unknown: 'Thank you for your message. Could you share a little more detail so we can respond accurately?',
};

const INTENT_SCORES = {
  positive_interest: 80,
  price_inquiry: 60,
  quote_request: 75,
  sample_request: 70,
  technical_question: 55,
  follow_up_needed: 35,
  no_need_now: 10,
  rejection: 5,
  unsubscribe: 0,
  auto_reply: 2,
  unknown: 20,
};

const BLOCKED_AUTOMATION_STATES = new Set(['HUMAN_TAKEOVER', 'DO_NOT_CONTACT', 'PAUSED', 'CLOSED']);

function detectReplyLabel(text) {
  const lower = text.toLowerCase();
  if (/(unsubscribe|opt[ -]?out|abmelden|désabonn|darse de baja|baja|uitschrij|annulla|wypis|descadastr|cancelar subscri)/.test(lower)) return 'unsubscribe';
  if (/(out of office|automatic reply|auto[ -]?reply|abwesenheit|absence|fuera de la oficina|automatisch antwoord|assenza|nieobecno|ausência)/.test(lower)) return 'auto_reply';
  if (/(quotation|quote|angebot|devis|presupuesto|offert|preventivo|wycena|orçamento)/.test(lower)) return 'quote_request';
  if (/(price|pricing|preis|prix|precio|prijs|prezzo|cena|preço|cost|kosten)/.test(lower)) return 'price_inquiry';
  if (/(sample|muster|échantillon|muestra|monster|campione|próbk|amostra)/.test(lower)) return 'sample_request';
  if (/(technical|specification|spezifikation|technique|técnic|technisch|tecnico|technicz)/.test(lower)) return 'technical_question';
  if (/(not interested|no need|kein interesse|pas intéressé|no nos interesa|geen interesse|non interessato|nie zainteresow|não temos interesse)/.test(lower)) return 'no_need_now';
  if (/(reject|decline|ablehnen|refus|rechaz|afwijz|rifiut|odrzuc|recus)/.test(lower)) return 'rejection';
  if (/(later|next quarter|nächste|suivi|más adelante|volgende|più avanti|później|mais tarde)/.test(lower)) return 'follow_up_needed';
  if (/(interested|interessiert|intéressé|interesado|geïnteresseerd|interessato|zainteresowan|interessad)/.test(lower)) return 'positive_interest';
  return 'unknown';
}

function languageOf(input, source = {}) {
  const raw = s(source.language || input.language || input.locale, 'en').toLowerCase().slice(0, 2);
  return OUTREACH_TEMPLATES[raw] ? raw : 'en';
}

// ------------------------------------------------------------- role builders
function buildOrchestrator(input) {
  const goal = s(input.goal, '未提供明确目标');
  return {
    objective: cut(`理解目标并拆解任务：${goal}`, 2000),
    steps: [
      { order: 1, role: 'market_research', title: '明确 ICP 与可验证的企业发现策略', rationale: '先确认目标市场与公开数据来源，避免凭空生成企业。', dependsOn: [] },
      { order: 2, role: 'company_qualification', title: '按 ICP 评估候选企业', rationale: '使用可追溯证据评分，并标记排除项。', dependsOn: [1] },
      { order: 3, role: 'contact_research', title: '确定目标角色与联系人检索方式', rationale: '锁定决策链角色，但不编造姓名或邮箱。', dependsOn: [2] },
      { order: 4, role: 'product_matching', title: '匹配产品与采购场景', rationale: '基于产品资料解释匹配理由。', dependsOn: [2] },
      { order: 5, role: 'outreach_writer', title: '生成个性化开发信', rationale: '仅引用已提供的事实。', dependsOn: [3, 4] },
      { order: 6, role: 'compliance_guard', title: '发送前合规检查', rationale: '检查退订、拒绝联系与不当承诺。', dependsOn: [5] },
      { order: 7, role: 'quality_review', title: '质量复核', rationale: '检查事实依据与语言质量，再进入人工审批。', dependsOn: [5] },
    ],
    assumptions: ['当前为内置离线模拟 Provider，未调用任何外部模型。'],
    risks: ['若输入缺少国家、行业或产品资料，后续步骤只能给出策略性建议。'],
  };
}

function buildMarketResearch(input) {
  const icp = o(input.icp);
  const countries = strings(icp.targetCountries || input.countries, 10);
  const keywords = strings(icp.includeKeywords || input.keywords, 10);
  const country = countries[0] || 'Europe';
  const keyword = keywords[0] || 'B2B supplier';
  const segment = s(icp.name || input.objective, '目标细分市场');
  return {
    searchStrategies: [
      {
        name: '公开企业名录检索',
        query: `${keyword} ${country} (site:.com OR site:.eu OR site:.de)`,
        sources: ['公开企业官网', '行业协会会员名录'],
        signals: ['产品类别与 ICP 匹配', '公开采购或供应商页面'],
      },
      {
        name: '展会与采购平台',
        query: `${keyword} "${country}" exhibitor list trade fair`,
        sources: ['展会参展商名单', '公开采购平台'],
        signals: ['近期参展或公开招标'],
      },
    ],
    targetSegments: [
      {
        segment: cut(segment, 200),
        rationale: '与输入 ICP 描述一致的细分市场，需人工复核企业真实性。',
        keywords: keywords.slice(0, 10),
      },
    ],
    exclusions: strings(icp.excludeKeywords, 20),
    unknowns: ['输入未提供目标企业数量与搜索预算', '未提供可用于验证企业规模的公开数据源'],
    notes: '仅输出搜索策略，不生成任何未经验证的企业名称或联系方式。',
  };
}

function buildQualification(input) {
  const company = o(input.company);
  const icp = o(input.icp);
  const factors = [];
  const evidence = [];
  let score = 50;

  const country = s(company.country);
  if (country) {
    const targets = strings(icp.targetCountries, 20).map((item) => item.toUpperCase());
    const matched = !targets.length || targets.includes(country.toUpperCase());
    const impact = matched ? 15 : -20;
    score += impact;
    factors.push({ name: '地区匹配', impact, kind: 'fact', evidence: `输入企业国家为 ${country}。` });
    evidence.push({ field: 'company.country', value: country, source: 'input.company.country', kind: 'fact' });
  } else {
    factors.push({ name: '地区匹配', impact: 0, kind: 'unknown', evidence: '输入未提供企业国家。' });
  }

  const industry = s(company.industry);
  if (industry) {
    score += 10;
    factors.push({ name: '行业匹配', impact: 10, kind: 'inference', evidence: `输入行业为 ${industry}，需与 ICP 行业描述人工核对。` });
    evidence.push({ field: 'company.industry', value: industry, source: 'input.company.industry', kind: 'fact' });
  } else {
    factors.push({ name: '行业匹配', impact: 0, kind: 'unknown', evidence: '输入未提供企业行业。' });
  }

  const companyType = s(company.companyType);
  if (companyType) {
    score += 5;
    factors.push({ name: '企业类型匹配', impact: 5, kind: 'fact', evidence: `输入企业类型为 ${companyType}。` });
  }

  const domain = s(company.domain);
  if (domain) {
    score += 5;
    factors.push({ name: '企业信息可信度', impact: 5, kind: 'fact', evidence: `输入包含企业域名 ${domain}，可用于后续人工核验。` });
    evidence.push({ field: 'company.domain', value: domain, source: 'input.company.domain', kind: 'fact' });
  }

  const description = s(company.description);
  const excludeKeywords = strings(icp.excludeKeywords, 20);
  const exclusions = [];
  for (const keyword of excludeKeywords) {
    if (description && description.toLowerCase().includes(keyword.toLowerCase())) {
      exclusions.push({ reason: `企业描述命中排除关键词：${keyword}`, severity: 'blocker' });
    }
  }

  score = clamp(Math.round(score), 0, 100);
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 45 ? 'C' : 'D';
  const known = factors.filter((factor) => factor.kind !== 'unknown').length;
  return {
    score,
    grade,
    factors,
    exclusions,
    evidence,
    summary: cut(
      `基于输入信息评分 ${score}（${grade} 级）。已知事实：${known} 项；缺失信息：${factors.length - known} 项。该结果仅来自输入数据，未做外部验证。`,
      2000,
    ),
    confidence: Math.round((known / Math.max(1, factors.length)) * 0.8 * 100) / 100,
  };
}

function departmentForRole(role) {
  const lower = role.toLowerCase();
  if (/(procure|purchase|einkauf|achat|compras|inkoop|acquist|zakup|sourcing|supply)/.test(lower)) return '采购/供应链';
  if (/(tech|engineer|quality|technisch|technique|técnic|tecnico|technicz|r&d)/.test(lower)) return '技术/质量';
  if (/(market|sales|vertrieb|commercial|vente|ventas|verkoop|vendite|sprzeda)/.test(lower)) return '市场/销售';
  if (/(manage|director|head|ceo|cto|geschäftsführ|directeur|gerente|direttore|kierown)/.test(lower)) return '管理层';
  return '未知';
}

function buildContactResearch(input) {
  const icp = o(input.icp);
  const company = o(input.company);
  const roles = strings(icp.targetRoles, 10);
  const selected = roles.length ? roles : ['采购经理', '技术负责人', '运营负责人'];
  const targetRoles = selected.slice(0, 8).map((role, index) => ({
    role: cut(role, 120),
    department: cut(departmentForRole(role), 120),
    priority: clamp(index + 1, 1, 5),
    reason: '来自输入 ICP 的目标角色，需人工核实该企业是否存在对应岗位。',
  }));
  const departments = [...new Set(targetRoles.map((item) => item.department))];
  return {
    targetRoles,
    departments,
    prioritizedTitles: targetRoles.slice(0, 5).map((item) => cut(item.role, 200)),
    searchApproaches: [
      '企业官网的团队/联系方式公开页面',
      '公开的展会参展商与行业协会名录',
      '职业社交平台上企业公开的岗位信息',
    ],
    unknowns: [
      company.name ? `尚未确认 ${s(company.name)} 的具体联系人` : '输入未提供企业名称',
      '未提供任何已验证的姓名、邮箱或电话',
    ],
    notes: '仅给出目标角色与检索方式，不生成姓名、邮箱或电话，避免编造联系人。',
  };
}

function buildProductMatching(input) {
  const product = o(input.product || a(input.products)[0]);
  const company = o(input.company || a(input.companies)[0]);
  const productName = s(product.name || input.productName, '未提供产品');
  const industry = s(company.industry);
  const applications = strings(product.applications, 10);
  const certifications = strings(product.certifications, 10);
  let matchScore = 55;
  const evidence = [];
  if (industry && (applications.join(' ').toLowerCase().includes(industry.toLowerCase()) || s(product.category))) {
    matchScore += 15;
    evidence.push(`输入企业行业：${industry}`);
  }
  if (applications.length) {
    matchScore += 15;
    evidence.push(`产品资料中的应用场景：${applications.slice(0, 3).join('、')}`);
  }
  if (certifications.length) {
    matchScore += 5;
    evidence.push(`产品资料中的认证：${certifications.slice(0, 3).join('、')}`);
  }
  if (s(product.description)) evidence.push('输入包含产品描述，可按需人工核对细节。');
  matchScore = clamp(Math.round(matchScore), 0, 100);
  return {
    matches: [
      {
        productRef: cut(productName, 200),
        matchScore,
        useCase: cut(applications[0] || '通用采购场景', 500),
        rationale: '基于输入的产品资料与企业行业描述判断匹配度；未使用外部数据，具体规格需人工确认。',
        evidence: evidence.slice(0, 10),
      },
    ],
    recommendedRef: cut(productName, 200),
    notes: '若需提高置信度，请补充产品规格、应用案例与企业采购场景。',
    unknowns: ['输入可能缺少采购数量、目标价格与交付要求'],
  };
}

function containsCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

function tidyText(text) {
  return String(text || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Replace `{{variable}}` placeholders; missing values become empty (never invented). */
function applyTemplate(template, values) {
  const used = new Set();
  const missing = new Set();
  const text = String(template ?? '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === null || value === '') {
      missing.add(key);
      return '';
    }
    used.add(key);
    return String(value);
  });
  return { text: tidyText(text), used, missing };
}

// Known Chinese units are localised for Latin-language emails; unknown Chinese
// facts are omitted from the body and surfaced in riskNotes instead.
const CN_UNIT_REPLACEMENTS = Object.freeze([
  [/件\s*\/\s*月/g, 'pcs/month'],
  [/套\s*\/\s*月/g, 'sets/month'],
  [/月产能/g, 'monthly capacity'],
  [/年产能/g, 'annual capacity'],
  [/工作日/g, 'business days'],
  [/小时/g, 'hours'],
  [/厘米/g, 'cm'],
  [/件/g, 'pcs'],
  [/套/g, 'sets'],
  [/台/g, 'units'],
  [/个/g, 'pcs'],
  [/吨/g, 'tons'],
  [/天/g, 'days'],
  [/周/g, 'weeks'],
  [/月/g, 'months'],
  [/年/g, 'years'],
  [/米/g, 'm'],
]);

function localizeRawValue(value) {
  let text = s(value);
  if (!text) return '';
  for (const [pattern, replacement] of CN_UNIT_REPLACEMENTS) text = text.replace(pattern, replacement);
  return text
    .replace(/[ \t]*\/[ \t]*/g, '/')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function localizeFactValue(value, language) {
  const text = localizeRawValue(value);
  if (!text) return '';
  return language === 'zh' || !containsCjk(text) ? text : '';
}

function cleanCertificationText(value, language) {
  const source = s(value);
  if (!source) return '';
  // "ISO 9001（质量体系认证）" -> "ISO 9001"; English certification names are kept.
  const withoutChineseNote = source.replace(/[（(][^）)]*[\u4e00-\u9fff][^）)]*[）)]/g, '').trim() || source;
  const text = localizeRawValue(withoutChineseNote);
  return language === 'zh' || !containsCjk(text) ? text : '';
}

/**
 * Localise known Chinese units inside rendered campaign templates as well, so a
 * template that hardcodes "MOQ 200 件 / 25-35 天" does not leak Chinese units
 * into an English email. Unknown Chinese content is left in place and flagged.
 */
function localizeRenderedText(text, language) {
  const source = String(text || '');
  if (language === 'zh') return tidyText(source);
  const withoutChineseNotes = source.replace(/[（(][^）)]*[\u4e00-\u9fff][^）)]*[）)]/g, '');
  return tidyText(localizeRawValue(withoutChineseNotes));
}

const TEMPLATE_FACT_SOURCES = Object.freeze({
  companyName: 'company.name',
  company_name: 'company.name',
  'company.name': 'company.name',
  company: 'company.name',
  contactName: 'contact.fullName',
  contact_name: 'contact.fullName',
  'contact.fullName': 'contact.fullName',
  fullName: 'contact.fullName',
  full_name: 'contact.fullName',
  contactFirstName: 'contact.firstName',
  contact_first_name: 'contact.firstName',
  'contact.firstName': 'contact.firstName',
  firstName: 'contact.firstName',
  first_name: 'contact.firstName',
  contactLastName: 'contact.lastName',
  contact_last_name: 'contact.lastName',
  'contact.lastName': 'contact.lastName',
  lastName: 'contact.lastName',
  last_name: 'contact.lastName',
  contactTitle: 'contact.title',
  contact_title: 'contact.title',
  productName: 'product.name',
  product_name: 'product.name',
  'product.name': 'product.name',
  product: 'product.name',
  industry: 'company.industry',
  country: 'company.country',
  moq: 'product.moq',
  leadTime: 'product.leadTime',
  lead_time: 'product.leadTime',
  capacity: 'product.capacity',
  materials: 'product.materials',
  certifications: 'product.certifications',
  campaignName: 'campaign.name',
  stepName: 'campaignStep.name',
  senderName: 'sender.name',
  sender_name: 'sender.name',
  'sender.name': 'sender.name',
  senderCompany: 'settings.compliance.senderCompanyName',
  senderAddress: 'settings.compliance.senderAddress',
});

function buildTemplateValues(input, { company, contact, product, campaign, campaignStep, sender, compliance, language }) {
  const fullName =
    s(contact.fullName || contact.full_name || contact.contactName) ||
    [s(contact.firstName || contact.first_name || input.contactFirstName), s(contact.lastName || contact.last_name)].filter(Boolean).join(' ');
  const firstName =
    s(contact.firstName || contact.first_name || input.contactFirstName) || (fullName ? fullName.split(/\s+/)[0] : '');
  const lastName = s(contact.lastName || contact.last_name) || (fullName ? fullName.split(/\s+/).slice(-1)[0] : '');
  const companyName = s(company.name);
  const rawProductName = s(product.name);
  const cjkProductName = Boolean(rawProductName) && language !== 'zh' && containsCjk(rawProductName);
  const productName = cjkProductName ? PRODUCT_NOUNS[language] || PRODUCT_NOUNS.en : rawProductName;
  const senderName =
    s(sender.name || sender.fullName || sender.full_name) || [s(sender.firstName), s(sender.lastName)].filter(Boolean).join(' ');
  const signature =
    s(input.signature) ||
    [senderName, s(sender.title), s(sender.companyName || sender.company_name || compliance.senderCompanyName), s(sender.address || compliance.senderAddress)]
      .filter(Boolean)
      .join('\n');
  const localizedMoq = localizeFactValue(product.moq, language);
  const localizedLeadTime = localizeFactValue(product.leadTime || product.lead_time, language);
  const localizedCertifications = strings(product.certifications, 12)
    .map((item) => cleanCertificationText(item, language))
    .filter(Boolean);
  return {
    companyName,
    company_name: companyName,
    'company.name': companyName,
    company: companyName,
    contactName: fullName,
    contact_name: fullName,
    'contact.fullName': fullName,
    fullName,
    full_name: fullName,
    contactFirstName: firstName,
    contact_first_name: firstName,
    'contact.firstName': firstName,
    firstName,
    first_name: firstName,
    contactLastName: lastName,
    contact_last_name: lastName,
    'contact.lastName': lastName,
    lastName,
    last_name: lastName,
    contactTitle: s(contact.title),
    contact_title: s(contact.title),
    productName,
    product_name: productName,
    'product.name': productName,
    product: productName,
    industry: s(company.industry),
    country: s(company.country),
    moq: localizedMoq,
    leadTime: localizedLeadTime,
    lead_time: localizedLeadTime,
    capacity: localizeFactValue(product.capacity, language),
    materials: localizeFactValue(product.materials, language),
    certifications: localizedCertifications.join(', '),
    campaignName: s(campaign.name),
    campaign_name: s(campaign.name),
    stepName: s(campaignStep.name),
    step_name: s(campaignStep.name),
    senderName,
    sender_name: senderName,
    'sender.name': senderName,
    senderCompany: s(sender.companyName || sender.company_name || compliance.senderCompanyName),
    senderAddress: s(sender.address || compliance.senderAddress),
    privacyUrl: s(compliance.privacyUrl),
    signature,
    language,
  };
}

function hasClosingPhrase(text) {
  return /(best regards|kind regards|sincerely|mit freundlichen|cordialement|saludos cordiales|met vriendelijke|cordiali saluti|z poważaniem|melhores cumprimentos)/i.test(
    String(text || ''),
  );
}

function composeClosing(template, values, existingText = '') {
  if (hasClosingPhrase(existingText)) return values.signature || '';
  return values.signature ? `${template.close}\n${values.signature}` : template.close;
}

function isUnsubscribeText(text) {
  return /(unsubscribe|opt[ -]?out|abmelden|désabonn|darse de baja|uitschrij|annulla|wypis|descadastr)/i.test(String(text || ''));
}

function buildOutreach(input) {
  const company = o(input.company);
  const contact = o(input.contact);
  const product = o(input.product || a(input.products)[0]);
  const campaign = o(input.campaign);
  const campaignStep = o(input.campaignStep || input.step);
  const settings = o(input.settings);
  const preferences = o(input.preferences);
  const compliance = o(settings.compliance || input.compliance || preferences);
  const sender = o(input.sender);

  const declaredLanguage = s(input.language || campaignStep.language || campaign.language || input.locale, 'en').toLowerCase().slice(0, 2);
  const language = OUTREACH_TEMPLATES[declaredLanguage] ? declaredLanguage : 'en';
  const template = OUTREACH_TEMPLATES[language];
  const includeUnsubscribe =
    input.includeUnsubscribe !== false &&
    settings.includeUnsubscribe !== false &&
    o(preferences).includeUnsubscribe !== false;

  const companyName = s(company.name);
  const industry = s(company.industry);
  const productName = s(product.name);
  const contactName =
    s(contact.fullName || contact.full_name || contact.contactName) ||
    [
      s(contact.firstName || contact.first_name || input.contactFirstName),
      s(contact.lastName || contact.last_name),
    ]
      .filter(Boolean)
      .join(' ');
  const rawCertifications = strings(product.certifications, 12);
  const cleanedCertifications = rawCertifications.map((item) => cleanCertificationText(item, language));
  const certifications = cleanedCertifications.filter(Boolean);
  const omittedCertifications = rawCertifications.filter((_item, index) => !cleanedCertifications[index]);
  const rawMoq = s(product.moq);
  const rawLeadTime = s(product.leadTime || product.lead_time);
  const moq = localizeFactValue(rawMoq, language);
  const leadTime = localizeFactValue(rawLeadTime, language);
  const capacity = localizeFactValue(product.capacity, language);
  const omittedFacts = [];
  if (rawMoq && !moq) omittedFacts.push(`MOQ：${rawMoq}`);
  if (rawLeadTime && !leadTime) omittedFacts.push(`交期：${rawLeadTime}`);
  if (omittedCertifications.length) omittedFacts.push(`认证：${omittedCertifications.join('、')}`);

  // A Chinese product name inside an English/German email reads badly; fall
  // back to a neutral product reference and flag it in riskNotes instead.
  const cjkProductNameOmitted = Boolean(productName) && language !== 'zh' && containsCjk(productName);
  const productLabel = cjkProductNameOmitted ? '' : productName;
  const resolved = {
    company: companyName || template.fallbacks.company,
    industry: industry || template.fallbacks.industry,
    product: productLabel || template.fallbacks.product,
  };

  const values = buildTemplateValues(input, { company, contact, product, campaign, campaignStep, sender, compliance, language });
  const subjectTemplate = s(campaignStep.subjectTemplate || campaignStep.subject_template);
  const bodyTemplate = s(campaignStep.bodyTemplate || campaignStep.body_template);
  const usedKeys = new Set();
  const missingKeys = new Set();

  let subject = '';
  if (subjectTemplate) {
    const rendered = applyTemplate(subjectTemplate, values);
    for (const key of rendered.used) usedKeys.add(key);
    for (const key of rendered.missing) missingKeys.add(key);
    subject = localizeRenderedText(rendered.text, language);
  }
  if (!subject) subject = template.subject(resolved.product, resolved.company);

  let body = '';
  let unlocalizableTemplateText = false;
  if (bodyTemplate) {
    const rendered = applyTemplate(bodyTemplate, values);
    for (const key of rendered.used) usedKeys.add(key);
    for (const key of rendered.missing) missingKeys.add(key);
    const renderedText = localizeRenderedText(rendered.text, language);
    if (renderedText) {
      unlocalizableTemplateText = language !== 'zh' && containsCjk(renderedText);
      const startsWithGreeting = /^(hi|hello|dear|guten tag|hallo|bonjour|hola|buongiorno|dzień dobry|olá|geachte|sehr geehrte)/i.test(renderedText);
      const sections = startsWithGreeting ? [renderedText] : [template.greeting, renderedText];
      // Append only documented facts the template body does not already mention, so
      // a template that already covers certifications/MOQ/lead time is not duplicated.
      const lowerRendered = renderedText.toLowerCase();
      const certWording = /(certificat|zertifizier|certifi|accrédit|certificación|certifica|atesty|认证)/i.test(renderedText);
      const moqWording =
        /(moq|minimum order|mindestbestell|quantité minimale|cantidad mínima|minimale bestel|quantità minima|minimalna ilość|quantidade mínima|起订)/i.test(
          renderedText,
        );
      const leadWording =
        /(lead time|delivery time|lieferzeit|délai|plazo|levertijd|tempi di consegna|czas dostawy|prazo|交期)/i.test(renderedText);
      const uncovered = {
        certifications: certWording ? [] : certifications.filter((item) => !lowerRendered.includes(item.toLowerCase())),
        moq: moq && !moqWording && !lowerRendered.includes(moq.toLowerCase()) ? moq : '',
        leadTime: leadTime && !leadWording && !lowerRendered.includes(leadTime.toLowerCase()) ? leadTime : '',
      };
      const factLine = template.factLine(uncovered);
      if (factLine) sections.push(factLine);
      const closingDetected = hasClosingPhrase(renderedText);
      if (!closingDetected && !/[?？]/.test(renderedText)) sections.push(template.ask);
      if (includeUnsubscribe && !isUnsubscribeText(renderedText)) sections.push(template.unsubscribe);
      const closing = composeClosing(template, values, renderedText);
      if (closing) sections.push(closing);
      body = sections.filter(Boolean).join('\n\n');
    }
  }

  if (!body) {
    const factLine = template.factLine({ certifications, moq, leadTime });
    const sections = [template.greeting, template.intro(resolved.company, resolved.industry, resolved.product)];
    if (factLine) sections.push(factLine);
    sections.push(template.ask);
    if (includeUnsubscribe) sections.push(template.unsubscribe);
    sections.push(composeClosing(template, values));
    body = sections.join('\n\n');
  }

  const claims = [];
  const claimKeys = new Set();
  const personalizationPoints = [];
  const haystack = `${subject}\n${body}`.toLowerCase();
  const usedInDraft = (value) => {
    const needle = String(value ?? '').trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  };
  const pushClaim = (text, source) => {
    const key = `${source}|${text}`;
    if (claimKeys.has(key)) return;
    claimKeys.add(key);
    claims.push({ text: cut(text, 300), source: cut(source, 300) });
  };
  const pushPoint = (text) => personalizationPoints.push(cut(text, 300));

  if (subjectTemplate || bodyTemplate) {
    for (const key of usedKeys) {
      const source = TEMPLATE_FACT_SOURCES[key];
      if (!source) continue;
      if (cjkProductNameOmitted && ['productName', 'product_name', 'product.name'].includes(key)) continue;
      const value = String(values[key] ?? '');
      if (!value.trim()) continue;
      pushClaim(`模板变量 ${key} 使用输入事实：${value.slice(0, 180)}`, source);
      pushPoint(`${key}=${value.slice(0, 180)}`);
    }
  }
  if (companyName && usedInDraft(companyName)) {
    pushClaim(`邮件中使用了企业名称：${companyName}`, 'company.name');
    pushPoint(`企业名称：${companyName}`);
  }
  if (industry && usedInDraft(industry)) {
    pushClaim(`邮件中使用了行业信息：${industry}`, 'company.industry');
    pushPoint(`行业：${industry}`);
  }
  if (productLabel && usedInDraft(productLabel)) {
    pushClaim(`邮件中使用了产品名称：${productLabel}`, 'product.name');
    pushPoint(`产品：${productLabel}`);
  }
  if (certifications.length && certifications.some((item) => usedInDraft(item))) {
    pushClaim(`认证信息仅来自产品资料：${certifications.slice(0, 5).join('、')}`, 'product.certifications');
    pushPoint(`认证：${certifications.slice(0, 3).join('、')}`);
  }
  if (moq && usedInDraft(moq)) {
    pushClaim(`MOQ 仅来自产品资料：${moq}`, 'product.moq');
    pushPoint(`MOQ：${moq}`);
  }
  if (leadTime && usedInDraft(leadTime)) {
    pushClaim(`交期仅来自产品资料：${leadTime}`, 'product.leadTime');
    pushPoint(`交期：${leadTime}`);
  }
  if (capacity && usedInDraft(capacity)) {
    pushClaim(`产能仅来自产品资料：${capacity}`, 'product.capacity');
    pushPoint(`产能：${capacity}`);
  }

  const riskNotes = ['当前为内置离线模拟 Provider 生成，未调用外部模型，也未做外部事实核验。'];
  if (missingKeys.size) {
    riskNotes.push(`模板变量缺少对应数据，已省略：${[...missingKeys].slice(0, 10).join('、')}；请补充后重发。`);
  }
  if (!values.signature) {
    riskNotes.push('未提供发件人签名（settings.compliance / sender / signature），发送前请补充姓名与公司信息。');
  }
  if (!contactName) riskNotes.push('输入没有收件人姓名，邮件使用中性问候，请发送前人工确认。');
  if (!productName) riskNotes.push('输入未提供产品名称，邮件内容较通用。');
  if (cjkProductNameOmitted) riskNotes.push('产品名称为中文，已在拉丁语系邮件中用通用产品表述代替，发送前请补充目标语言产品名。');
  if (omittedFacts.length) {
    riskNotes.push(`以下中文事实无法本地化，已从英文正文省略：${omittedFacts.slice(0, 6).join('；')}；请人工翻译后补充。`);
  }
  if (unlocalizableTemplateText) {
    riskNotes.push('活动步骤正文包含无法本地化的中文内容，已保留原文，请人工翻译后再发送。');
  }
  if (!rawCertifications.length && !rawMoq && !rawLeadTime) riskNotes.push('产品资料未包含认证/MOQ/交期，邮件未做相关承诺。');
  riskNotes.push('发送前请人工复核价格、交期、产能等未被输入覆盖的信息。');

  return {
    subject: cut(subject, 300),
    body: cut(body, 6000),
    language,
    claims: claims.slice(0, 20),
    riskNotes: riskNotes.slice(0, 20),
    personalizationPoints: personalizationPoints.slice(0, 20),
  };
}

function buildReplyClassification(input) {
  const message = o(input.message);
  const text = s(message.body || message.bodyText || message.body_text || message.text || input.body || input.text || input.messageText);
  const language = languageOf(input, message).slice(0, 2);
  const label = text ? detectReplyLabel(text) : 'unknown';
  const suggestedReply = language === 'en' ? REPLY_TEMPLATES[label] || '' : '';
  const rationale =
    label === 'unknown'
      ? '回复正文缺失或信号不足，无法可靠判断意图，建议人工查看原文。'
      : `模拟关键词规则匹配到 ${label} 相关表达；置信度仅供演示，需人工确认。`;
  return {
    label,
    confidence: text ? 0.6 : 0.2,
    intentScore: INTENT_SCORES[label] || 0,
    evidence: text ? [{ quote: cut(text, 140), explanation: `关键词规则匹配 ${label}` }] : [],
    rationale,
    suggestedReply,
    nextAction:
      label === 'unsubscribe'
        ? '写入退订抑制名单并停止后续自动外呼'
        : label === 'rejection'
          ? '记录拒绝原因，暂停该联系人外呼'
          : label === 'auto_reply'
            ? '忽略自动回复，等待真实回复'
            : '人工确认分类后安排下一步跟进',
  };
}

function buildFollowUpPlanning(input) {
  const classification = o(input.classification);
  const label = s(classification.label || input.label || o(input.message).label, 'unknown');
  const dueInDaysByLabel = {
    quote_request: 1,
    price_inquiry: 2,
    sample_request: 2,
    positive_interest: 3,
    technical_question: 3,
    follow_up_needed: 7,
    no_need_now: 35,
    rejection: 1,
    unsubscribe: 0,
    auto_reply: 1,
    unknown: 3,
  };
  const priorityByLabel = {
    quote_request: 'high',
    price_inquiry: 'high',
    sample_request: 'high',
    positive_interest: 'high',
    technical_question: 'normal',
    follow_up_needed: 'normal',
    no_need_now: 'low',
    rejection: 'low',
    unsubscribe: 'low',
    auto_reply: 'low',
    unknown: 'normal',
  };
  const map = {
    quote_request: ['准备并发送报价', '整理规格并生成报价草稿，价格需人工确认后发送'],
    price_inquiry: ['回复价格咨询', '先确认规格与数量，再提供价格区间，避免承诺固定价格'],
    sample_request: ['安排样品沟通', '确认样品规格与收货地址后回复'],
    positive_interest: ['安排线上会议', '提供两个可选时间段，确认参会人角色'],
    technical_question: ['技术问题确认', '与技术团队确认后回复，不臆测参数'],
    follow_up_needed: ['按客户约定时间跟进', '按客户提到的时间发送简短跟进'],
    no_need_now: ['设置长期培育提醒', '30 天后发送一次低压力跟进'],
    rejection: ['记录拒绝并停止外呼', '记录拒绝原因，暂停自动外呼'],
    unsubscribe: ['执行退订流程', '写入退订名单并停止联系'],
    auto_reply: ['忽略自动回复', '等待客户真实回复，不发送自动跟进'],
    unknown: ['人工查看回复', '人工确认意图后再决定下一步'],
  };
  const [nextStep, draftHint] = map[label] || map.unknown;
  return {
    nextStep: cut(nextStep, 300),
    dueInDays: clamp(dueInDaysByLabel[label] ?? 3, 0, 60),
    taskTitle: cut(nextStep, 200),
    draftHint: cut(draftHint, 2000),
    priority: priorityByLabel[label] || 'normal',
    rationale: '基于输入的分类结果给出单一跟进动作；模拟模式未读取历史沟通细节。',
  };
}

function draftParts(input) {
  const draft = o(input.draft || input.email || input.message);
  return {
    subject: s(draft.subject || input.subject),
    body: s(draft.body || draft.bodyText || draft.body_text || input.body),
  };
}

function buildCompliance(input) {
  const { subject, body } = draftParts(input);
  const contact = o(input.contact);
  const settings = o(input.settings);
  const suppression = o(input.suppression);
  const blockers = [];
  const warnings = [];
  const checkedItems = ['退订/抑制名单', '自动化接管状态', '联系人邮箱状态', '内容承诺用语', '退订说明', '法律依据'];

  if (!subject && !body) blockers.push({ code: 'MISSING_CONTENT', message: '未提供可检查的邮件内容。' });

  const suppressionHit =
    input.suppressionHit === true || suppression.hit === true || a(input.suppressionMatches).length > 0 || a(input.suppressions).length > 0;
  if (suppressionHit) blockers.push({ code: 'SUPPRESSED_EMAIL', message: '该联系人或域名在抑制名单中，禁止发送。' });

  const automationState = s(input.automationState || o(input.automation).state);
  if (BLOCKED_AUTOMATION_STATES.has(automationState)) {
    blockers.push({ code: 'AUTOMATION_BLOCKED', message: `自动化状态为 ${automationState}，禁止自动发送。` });
  }

  const emailStatus = s(contact.emailStatus || contact.email_status);
  if (emailStatus === 'invalid') blockers.push({ code: 'INVALID_EMAIL', message: '联系人邮箱状态为无效，禁止发送。' });

  const text = `${subject}\n${body}`;
  if (/(100%|guarantee|guaranteed|best price|cheapest|no\.?\s*1|zero risk)/i.test(text)) {
    warnings.push({ code: 'UNSUPPORTED_CLAIM', message: '内容包含绝对化承诺或无依据排名，请删除或改为可验证表述。' });
  }
  const includeUnsubscribe = input.includeUnsubscribe !== false && settings.includeUnsubscribe !== false;
  if (includeUnsubscribe && body && !/(unsubscribe|opt[ -]?out|abmelden|désabonn|darse de baja|uitschrij|annulla|wypis|descadastr)/i.test(body)) {
    warnings.push({ code: 'MISSING_UNSUBSCRIBE', message: '邮件缺少退订说明。' });
  }
  if (input.requireLegalBasis === true && !s(settings.legalBasis || input.legalBasis)) {
    warnings.push({ code: 'MISSING_LEGAL_BASIS', message: '缺少合法权益/同意依据记录。' });
  }
  if (automationState === 'NEEDS_HUMAN_REVIEW') {
    warnings.push({ code: 'HUMAN_REVIEW_REQUIRED', message: '该企业需要人工复核后才能发送。' });
  }

  const requiredActions = [];
  for (const blocker of blockers) {
    if (blocker.code === 'SUPPRESSED_EMAIL') requiredActions.push('确认退订/抑制记录，并停止对该联系人的所有发送。');
    else if (blocker.code === 'AUTOMATION_BLOCKED') requiredActions.push('先由人工恢复自动化状态，再重新执行发送前检查。');
    else if (blocker.code === 'INVALID_EMAIL') requiredActions.push('先验证或更换邮箱地址。');
    else requiredActions.push('补充待发送内容后重新检查。');
  }
  if (warnings.some((item) => item.code === 'MISSING_UNSUBSCRIBE')) requiredActions.push('在邮件正文补充退订说明。');
  if (warnings.some((item) => item.code === 'UNSUPPORTED_CLAIM')) requiredActions.push('删除绝对化承诺并改用可验证事实。');

  return {
    allowed: blockers.length === 0,
    blockers: blockers.slice(0, 10),
    warnings: warnings.slice(0, 10),
    requiredActions: requiredActions.slice(0, 20),
    checkedItems,
  };
}

function buildQualityReview(input) {
  const draft = o(input.draft || input.email || input.message);
  const campaignStep = o(input.campaignStep || input.step);
  const { subject, body } = draftParts(input);
  const claims = a(input.claims);
  const issues = [];
  const strengths = [];
  const text = `${subject}\n${body}`;
  const declaredLanguage = s(input.language || campaignStep.language || o(input.campaign).language).toLowerCase().slice(0, 2);
  const draftLanguage = s(draft.language).toLowerCase().slice(0, 2);
  const effectiveLanguage = draftLanguage || declaredLanguage;

  if (!subject) issues.push({ severity: 'high', category: 'structure', message: '缺少邮件主题。', suggestion: '补充具体、可读的主题行。' });
  if (!body) issues.push({ severity: 'high', category: 'structure', message: '缺少邮件正文。', suggestion: '补充正文后重新复核。' });
  if (body && [...body].length > 1200) {
    issues.push({ severity: 'medium', category: 'language', message: '正文过长。', suggestion: '压缩到 80-180 词，保留一个明确行动号召。' });
  }
  if (/\{\{[^}]+\}\}/.test(text)) {
    const placeholders = [...new Set((text.match(/\{\{[^}]+\}\}/g) || []).slice(0, 8))].join('、');
    issues.push({
      severity: 'high',
      category: 'structure',
      message: `存在未替换的模板变量：${placeholders}`,
      suggestion: '发送前替换所有模板变量，或从模板中删除无数据支持的字段。',
    });
  } else if (/\[company\]|\bxxx\b|<name>|\[name\]/i.test(text)) {
    issues.push({ severity: 'high', category: 'structure', message: '正文包含未替换的占位符。', suggestion: '替换所有占位符为真实或中性表述。' });
  }
  if (declaredLanguage && draftLanguage && declaredLanguage !== draftLanguage) {
    issues.push({
      severity: 'high',
      category: 'language',
      message: `草稿声明语言为 ${draftLanguage}，与目标语言 ${declaredLanguage} 不一致。`,
      suggestion: '按目标语言重新生草稿，或在草稿中更新 language 字段。',
    });
  }
  if (effectiveLanguage && effectiveLanguage !== 'zh' && containsCjk(text)) {
    issues.push({
      severity: 'high',
      category: 'language',
      message: `草稿目标语言为 ${effectiveLanguage}，但正文包含中文字符。`,
      suggestion: '将正文改为目标语言，产品名称等中文事实可保留在内部备注中。',
    });
  }
  if (/(100%|guarantee|guaranteed|best price|cheapest|no\.?\s*1|zero risk)/i.test(text)) {
    issues.push({ severity: 'high', category: 'promises', message: '包含绝对化承诺或无依据排名。', suggestion: '删除绝对化表述，仅保留输入支持的事实。' });
  }
  if (body && claims.length === 0) {
    issues.push({ severity: 'medium', category: 'factual_grounding', message: '正文没有任何事实来源标注。', suggestion: '在 claims 中列出正文使用的事实及其输入来源。' });
  }
  if (/(only today|act now|urgent|最后一次)/i.test(text)) {
    issues.push({ severity: 'low', category: 'compliance', message: '包含人为紧迫感表达。', suggestion: '改用中性、尊重对方时间的表述。' });
  }
  if (subject && [...subject].length > 120) {
    issues.push({ severity: 'low', category: 'language', message: '主题过长。', suggestion: '主题控制在 120 字符以内。' });
  }

  if (body) strengths.push('正文结构完整，具备问候与行动号召。');
  if (claims.length) strengths.push('已标注事实来源（claims）。');
  if (!issues.some((issue) => issue.category === 'personalization')) strengths.push('未发现明显的人称或个性化误用。');

  let score = 100;
  for (const issue of issues) score -= issue.severity === 'high' ? 30 : issue.severity === 'medium' ? 12 : 5;
  score = clamp(score, 0, 100);
  const highCount = issues.filter((issue) => issue.severity === 'high').length;
  const fabricated = issues.some((issue) => issue.category === 'factual_grounding' && issue.severity === 'high');
  const verdict = fabricated || highCount >= 2 || score < 50 ? 'reject' : score >= 80 && highCount === 0 ? 'pass' : 'revise';

  return {
    verdict,
    score,
    issues: issues.slice(0, 20),
    strengths: strengths.slice(0, 20),
    summary: cut(`复核得分 ${score}，结论 ${verdict}。模拟模式仅做结构化规则检查，未做真实语言模型评审。`, 2000),
  };
}

const BUILDERS = {
  orchestrator: buildOrchestrator,
  market_research: buildMarketResearch,
  company_qualification: buildQualification,
  contact_research: buildContactResearch,
  product_matching: buildProductMatching,
  outreach_writer: buildOutreach,
  reply_classification: buildReplyClassification,
  follow_up_planning: buildFollowUpPlanning,
  compliance_guard: buildCompliance,
  quality_review: buildQualityReview,
};

/** Build a structurally valid, deterministic sample output for one role. */
export function simulateRole(role, input = {}) {
  const builder = BUILDERS[role];
  if (!builder) throw new Error(`simulation builder missing for agent role "${role}"`);
  return builder(o(input));
}

export const SIMULATED_ROLES = Object.freeze(Object.keys(BUILDERS));

export default { simulateRole, SIMULATED_ROLES };
