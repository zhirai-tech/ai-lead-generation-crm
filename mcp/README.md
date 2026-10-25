# ZHIRAI MCP Server

这是一个真正的 MCP stdio server（JSON-RPC 2.0），不是浏览器里的工具注册表。

## 启动

```bash
node mcp/server.mjs
```

由桌面壳或 MCP 客户端启动，工作空间可用：

```bash
ZHIRAI_WORKSPACE_ID=wsp_xxx node mcp/server.mjs
```

不设置时使用本地数据库的第一个 workspace。

## 已实现工具

| 工具 | 作用 |
| --- | --- |
| `company.list` | 列出本地客户、联系方式完整度、客户阶段 |
| `company.get` | 企业完整资料 |
| `company.evidence` | 来源 URL、抓取页面、联系人、验证记录 |
| `company.enrich` | 打开官网/Kontakt/Impressum，抓取邮箱/电话/地址 |
| `discovery.start` | 用本地数据源执行发现 |

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "zhirai-outreach": {
      "command": "node",
      "args": ["E:/欧洲 B2B AI 外贸获客平台/mcp/server.mjs"],
      "env": {
        "ZHIRAI_WORKSPACE_ID": "wsp_01M5KN932914C4509ZQV3FW1MQ"
      }
    }
  }
}
```

## 安全边界

- 只在本地启动
- 不把 HTTP 会话/API Key 暴露给模型
- 工具直接读取本地 SQLite
- 高风险写操作（发送、删除）暂未暴露给 MCP
- 模型不能通过 MCP 绕过审批发送邮件

## 当前限制

- `company.enrich` 是 HTTP 抓取，JS/图标隐藏的联系方式可能漏
- 自动发现后的批量 enrich 仍有失败/未写入问题，需要重试队列
- 还没有 Playwright 浏览器工具
