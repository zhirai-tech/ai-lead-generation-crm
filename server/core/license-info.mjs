/** Static licence and dependency metadata rendered by the admin console. */
export const LICENSE_INFO = {
  product: {
    name: 'ZHIRAI Europe B2B AI Outreach Platform',
    nameZh: '智睿欧洲 B2B AI 外贸获客平台',
    version: '1.1.0',
    author: 'ZHIRAI · 智睿科技 · 独立开发者',
    copyright: '© 2026 ZHIRAI（智睿科技）',
    license: 'MIT License（保留版权与许可声明）',
    website: 'https://zhirai.cloud',
    support: 'xtang3125@gmail.com',
  },
  runtimeDependencies: [{ name: 'playwright', license: 'Apache-2.0', usage: '可选浏览器自动化/数据发现' }],
  devDependencies: [{ name: 'electron', license: 'MIT', usage: '桌面版运行时' }],
  runtime: {
    node: '>=22.5.0（使用内置 node:sqlite、node:crypto、node:http）',
    database: 'SQLite（WAL 模式，无外部数据库服务）',
    externalServices: '无强制外部服务；可选接入用户自行配置的模型与数据 API',
  },
  thirdPartyComponents: [{ name: 'Playwright', license: 'Apache-2.0' }, { name: 'Electron', license: 'MIT' }],
  researchReferences: [
    { name: 'AgentSDR', license: 'MIT（待核实固定版本）', usage: '仅研究功能与架构，不复制代码' },
    { name: 'OpenOutreach', license: 'GPL-3.0', usage: '仅研究功能与架构，不复制代码' },
    { name: 'Quick-Enrich-Tools', license: 'MIT（待核实固定版本）', usage: '仅研究流程设计' },
    { name: 'OpenEnrich', license: 'AGPL-3.0', usage: '仅研究功能思路' },
    { name: 'NakatomiCRM', license: 'MIT（待核实）', usage: '仅研究 Agent 友好 CRM 设计' },
    { name: 'Twenty CRM', license: 'AGPL-3.0（部分组件独立授权）', usage: '仅研究数据模型' },
    { name: 'Mautic', license: 'GPL-3.0', usage: '仅研究营销自动化流程' },
    { name: 'n8n', license: 'Sustainable Use License', usage: '仅研究工作流编排思路' },
  ],
  notes: [
    '本项目所有业务代码、数据模型、提示词模板与界面均为独立实现。',
    '未复制任何参考项目的源码、素材或品牌内容。',
    '若未来引入第三方组件，必须在本清单登记版本、许可证与分发影响。',
  ],
};
