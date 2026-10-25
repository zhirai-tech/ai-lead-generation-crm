# ZHIRAI Desktop

第一版桌面壳，目标是先跑通：

- Electron 窗口
- 本地 Node 服务
- 本地 SQLite
- 本地模型配置
- 后续再接 Playwright / 安装器 / 自动更新

## 开发运行

```bash
npm install
npm run desktop
```

`npm install` 会安装 Electron（仅开发依赖），不会把 Electron 打进 Web 包。

## 打包（下一阶段）

建议使用 `electron-builder`：

- Windows: NSIS / portable
- macOS: dmg
- 模型不进安装包，由模型配置向导下载

## 安全边界

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- 预加载只暴露版本信息
- 不把 API Key 写进前端
- 模型 Key 仍走服务端加密凭据

## 当前未完成

- 首次启动强制模型配置页面
- Ollama 自动安装器
- 默认模型下载进度页面
- 安装包签名
- 自动更新
