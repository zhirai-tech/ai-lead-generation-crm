# 部署指南（Deployment）

> 项目：ZHIRAI Europe B2B AI Outreach Platform v1.1.0
> 作者：ZHIRAI · 智睿科技 · 独立开发者
> 适用：Windows 10/11、Linux（Debian/Ubuntu/CentOS）、macOS 自托管部署。
> 目标：**单机、单进程、零第三方运行时依赖**。默认端口 **4173**。

---

## 目录

- [1. 部署前检查](#1-部署前检查)
- [2. 快速部署（Windows）](#2-快速部署windows)
- [3. 快速部署（Linux）](#3-快速部署linux)
- [4. 进程守护](#4-进程守护)
- [5. 反向代理与 HTTPS（nginx 示例）](#5-反向代理与-httpsnginx-示例)
- [6. 环境变量完整说明](#6-环境变量完整说明)
- [7. 数据目录与文件权限](#7-数据目录与文件权限)
- [8. 备份与恢复](#8-备份与恢复)
- [9. 升级与迁移](#9-升级与迁移)
- [10. 首次使用配置](#10-首次使用配置)
- [11. 故障排查](#11-故障排查)
- [12. 安全清单](#12-安全清单)
- [13. 发行包打包规范（zip 根目录平铺）](#13-发行包打包规范zip-根目录平铺)
- [14. 卸载与数据清理](#14-卸载与数据清理)

---

## 1. 部署前检查

| 检查项 | 要求 | 验证命令 |
| --- | --- | --- |
| Node.js | **≥ 22.5**（内置 `node:sqlite`） | `node -v` |
| 端口 | 4173 未被占用（或改 `PORT`） | Windows：`netstat -ano \| findstr :4173`；Linux：`ss -lntp \| grep 4173` |
| 目录权限 | 运行账号对解压目录可读写（需写 `server/data`） | — |
| 磁盘 | ≥ 2 GB 可用 | — |
| 时间同步 | 服务器时间正确（影响发送窗口与签名过期） | `date` / `w32tm /query /status` |
| 网络出站 | 可选：SMTP（465/587）、IMAP（993）、模型 API（443） | 见 §11 |
| 反向代理 | 生产环境建议 nginx/Caddy 提供 HTTPS | §5 |

> **重要**：`DATA_DIR` 不要放在网络盘/NFS/SMB 上。SQLite WAL 依赖本地文件系统锁，网络盘会导致数据损坏或锁错误。

---

## 2. 快速部署（Windows）

### 2.1 解压与初始化

```powershell
# 1) 解压 zip 到目标目录（解压后根目录应直接是 index.html、server\ 等，不要多套一层）
#    例：C:\zhirai-outreach

cd C:\zhirai-outreach

# 2) 检查 Node 版本（必须 >= 22.5）
node -v

# 3) 初始化数据库（创建 server\data 与表结构，可重复执行）
npm run init-db

# 4) 配置环境变量（可选）
copy .env.example .env
notepad .env

# 5) 前台启动（测试）
npm start
```

浏览器打开 **http://127.0.0.1:4173**，按初始化向导创建管理员。

### 2.2 后台运行（Windows）

**方式 A：任务计划程序**

1. 打开「任务计划程序」→ 创建任务。
2. 触发器：登录时 / 启动时。
3. 操作：程序 `C:\Program Files\nodejs\node.exe`，参数 `server\index.mjs`，起始于 `C:\zhirai-outreach`。
4. 勾选「不管用户是否登录都要运行」（可选，需配置账号密码）。
5. 「设置」中勾选「如果任务失败，按以下频率重新启动」。

**方式 B：NSSM（第三方工具，可选）**

```powershell
nssm install zhirai-outreach "C:\Program Files\nodejs\node.exe" "server\index.mjs"
nssm set zhirai-outreach AppDirectory "C:\zhirai-outreach"
nssm set zhirai-outreach AppStdout "C:\zhirai-outreach\server\data\logs\stdout.log"
nssm set zhirai-outreach AppStderr "C:\zhirai-outreach\server\data\logs\stderr.log"
nssm start zhirai-outreach
```

**方式 C：PM2（第三方工具，可选）**

```powershell
npm i -g pm2
pm2 start server/index.mjs --name zhirai-outreach
pm2 save
pm2 startup
```

> 说明：NSSM/PM2 是**部署工具**，不是本项目的运行时依赖；项目本身仍为零依赖。

### 2.3 Windows 防火墙

如需局域网访问（不推荐直接暴露公网）：

```powershell
New-NetFirewallRule -DisplayName "ZHIRAI Outreach 4173" -Direction Inbound -Protocol TCP -LocalPort 4173 -Action Allow
```

---

## 3. 快速部署（Linux）

```bash
# 1) 安装 Node.js >= 22.5（示例：NodeSource 或 nvm）
#    nvm 方式：
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
node -v

# 2) 解压
sudo mkdir -p /opt/zhirai-outreach
sudo chown "$USER":"$USER" /opt/zhirai-outreach
# 将 zip 解压到 /opt/zhirai-outreach（根目录直接是 index.html、server/ ...）
cd /opt/zhirai-outreach

# 3) 初始化
npm run init-db

# 4) 配置
cp .env.example .env
vim .env

# 5) 前台测试
npm start
```

### 3.1 systemd 服务

创建 `/etc/systemd/system/zhirai-outreach.service`：

```ini
[Unit]
Description=ZHIRAI Europe B2B AI Outreach Platform
After=network.target

[Service]
Type=simple
User=zhirai
Group=zhirai
WorkingDirectory=/opt/zhirai-outreach
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info
# 如使用 .env 文件，程序会自动读取 WorkingDirectory 下的 .env；无需在此重复配置
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zhirai-outreach
sudo systemctl status zhirai-outreach
journalctl -u zhirai-outreach -f
```

> 若 Node 通过 nvm 安装，`ExecStart` 需写绝对路径（如 `/home/zhirai/.nvm/versions/node/v22.x.x/bin/node`）。

---

## 4. 进程守护

| 场景 | 推荐 |
| --- | --- |
| Linux 生产 | systemd（§3.1） |
| Windows 生产 | 任务计划程序 或 NSSM |
| 临时/开发 | `npm start` 前台运行 |
| 容器/平台 | 任意支持 Node 22 的进程托管；**不要多副本共享同一个 SQLite** |

**优雅退出**：进程收到 `SIGINT`/`SIGTERM` 时会停止 Worker、关闭 HTTP、关闭数据库（`server/index.mjs`）。

---

## 5. 反向代理与 HTTPS（nginx 示例）

### 5.1 拓扑

```text
浏览器 ──HTTPS 443──▶ nginx（TLS 终止）──HTTP 127.0.0.1:4173──▶ node server/index.mjs
```

### 5.2 应用 `.env` 关键项

```ini
HOST=127.0.0.1
PORT=4173
TRUST_PROXY=1
PUBLIC_BASE_URL=https://outreach.example.com
NODE_ENV=production
```

> `TRUST_PROXY=1` **只**在 nginx 与 Node 同机且 nginx 可信时启用；否则攻击者可伪造 `X-Forwarded-For` 绕过限流。
> `PUBLIC_BASE_URL` 必须是真实 HTTPS 地址：它决定退订链接、**邮件中产品 PDF 公开链接**与 Cookie 的 `Secure` 属性。

### 5.3 nginx 配置

```nginx
# /etc/nginx/conf.d/zhirai-outreach.conf
upstream zhirai_outreach {
    server 127.0.0.1:4173;
    keepalive 16;
}

server {
    listen 80;
    server_name outreach.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name outreach.example.com;

    # --- TLS（用 certbot 签发后填写实际路径）---
    ssl_certificate     /etc/letsencrypt/live/outreach.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/outreach.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_session_cache shared:SSL:10m;

    # --- 安全头（应用自身也会返回 CSP 等，这里补充 HSTS）---
    add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;

    # --- 请求体上限（应用上限 1.5MB，这里留余量）---
    client_max_body_size 4m;

    # --- 超时（AI/抓取任务可能较慢；任务为异步，HTTP 本身应快）---
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;

    # --- 基础限流（应用内也有内存限流，这里是第一道）---
    limit_req_zone $binary_remote_addr zone=zhirai_login:10m rate=10r/m;

    location = /api/v1/auth/login {
        limit_req zone=zhirai_login burst=5 nodelay;
        proxy_pass http://zhirai_outreach;
        include /etc/nginx/proxy_params_zhirai.conf;
    }

    location / {
        proxy_pass http://zhirai_outreach;
        include /etc/nginx/proxy_params_zhirai.conf;
    }
}
```

`/etc/nginx/proxy_params_zhirai.conf`：

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header Connection "";
proxy_buffering on;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5.4 HTTPS 证书

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d outreach.example.com
sudo systemctl status certbot.timer   # 自动续期
```

> 应用**不**做 TLS 终止；没有反向代理时只能 HTTP（仅本机使用）。生产必须 HTTPS，否则会话 Cookie 无 `Secure`、凭据在传输中可被窃听。

### 5.5 Caddy 替代（更简洁）

```caddyfile
outreach.example.com {
    reverse_proxy 127.0.0.1:4173 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
    request_body {
        max_size 4MB
    }
}
```

---

## 6. 环境变量完整说明

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 表示生产语义 |
| `HOST` | `127.0.0.1` | 监听地址；生产保持 127.0.0.1 |
| `PORT` | `4173` | 监听端口（1–65535） |
| `APP_NAME` | `ZHIRAI Outreach` | 应用显示名 |
| `TRUST_PROXY` | `0` | `1` = 信任 `X-Forwarded-For/X-Real-IP/X-Forwarded-Host` |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:<PORT>` | 对外基址；退订链接、产品 PDF 公开链接、Secure Cookie 依据 |
| `DATA_DIR` | `server/data` | 数据目录（相对根目录或绝对路径） |
| `LOG_LEVEL` | `info` | `debug/info/warn/error/silent` |
| `SESSION_TTL_HOURS` | `168` | 会话有效期（1–8760 小时） |
| `WORKER_ENABLED` | `1` | `0` 关闭后台 Worker（仅调试；关闭后任务不执行） |
| `WORKER_POLL_MS` | `1000` | 轮询间隔（100–60000 ms） |
| `GLOBAL_SEND_PAUSED` | `0` | `1` = 全局暂停发送（紧急刹车，重启生效） |
| `AI_PROVIDER` | 空 | 兜底模型 Provider（一般不用，界面配置优先） |
| `AI_BASE_URL` | 空 | 兜底模型 Base URL |
| `AI_API_KEY` | 空 | 兜底模型密钥（**不建议**；改用界面加密保存） |
| `AI_MODEL` | 空 | 兜底模型名 |

**加载顺序**：`.env`（根目录，不覆盖已有环境变量）→ 进程环境变量 → 默认值。修改后需**重启**。

---

## 7. 数据目录与文件权限

```text
server/data/                     ← DATA_DIR
├─ outreach.sqlite               # 主数据库（WAL）
├─ outreach.sqlite-wal           # WAL 日志（运行中）
├─ outreach.sqlite-shm           # 共享内存（运行中）
├─ secret.key                    # 加密主密钥（0600）
├─ uploads/
│  └─ products/<workspace>/<product>/<fileId>.<ext>   # 产品图片 / PDF 资料（v1.1；邮件附件来源）
├─ logs/app.log                  # 应用日志（JSON 行）
└─ backups/                      # 备份（outreach-<时间戳>.sqlite，仅数据库）
```

| 项 | 要求 |
| --- | --- |
| 权限 | 仅运行账号与管理员可读写；`secret.key` 权限 600 |
| 备份 | `outreach.sqlite` + `secret.key` + **`uploads/`**（产品图片/PDF 不在数据库备份内，必须单独复制） |
| 不入库 | `.gitignore` 已排除 `server/data/` 与 `.env` |
| 迁移 | 迁移 `DATA_DIR` 时**整目录复制**（含 `secret.key`），否则凭据不可解 |

Linux 示例：

```bash
sudo chown -R zhirai:zhirai /opt/zhirai-outreach/server/data
sudo chmod 700 /opt/zhirai-outreach/server/data
sudo chmod 600 /opt/zhirai-outreach/server/data/secret.key
```

Windows 示例（管理员 PowerShell）：

```powershell
icacls "C:\zhirai-outreach\server\data" /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "zhirai:(OI)(CI)F"
```

---

## 8. 备份与恢复

### 8.1 备份方式

**方式 A：维护台（推荐给非技术用户）**

1. 打开 `https://your-domain/admin`
2. 用 owner 账号登录工作台后刷新（维护台复用同一会话）
3. 点击「创建备份」→ 生成 `backups/outreach-<时间戳>.sqlite` → 可下载

**方式 B：API（自动化）**

```bash
# 需要 owner 会话 Cookie + CSRF Token（从浏览器开发者工具复制）
curl -X POST https://your-domain/api/v1/ops/backup \
  -H "Cookie: zr_session=<token>; zr_csrf=<csrf>" \
  -H "X-CSRF-Token: <csrf>"
```

**方式 C：脚本 / 手工**

```bash
# 脚本（已随发行包提供）
npm run backup

# 或直接用 sqlite3（停机或允许短暂锁）
sqlite3 server/data/outreach.sqlite "VACUUM INTO 'server/data/backups/manual-$(date +%F).sqlite'"

# 产品图片/PDF 必须单独备份（数据库备份不含 uploads）
tar -czf "server/data/backups/uploads-$(date +%F).tar.gz" -C server/data uploads
```

> `VACUUM INTO` 会生成一致性快照，**不需要停机**；但建议低峰执行。**`uploads/` 不在数据库备份内**，漏备份会导致恢复后主图/附件文件缺失。

### 8.2 恢复步骤

```bash
# 1) 停服务
sudo systemctl stop zhirai-outreach

# 2) 备份当前库（以防恢复错）
mv server/data/outreach.sqlite server/data/outreach.sqlite.broken

# 3) 删除 WAL/SHM（必须，否则与旧库不一致）
rm -f server/data/outreach.sqlite-wal server/data/outreach.sqlite-shm

# 4) 放入备份
cp server/data/backups/outreach-20261022-120000.sqlite server/data/outreach.sqlite

# 4.1) 恢复产品图片/PDF（若有单独备份；否则附件/主图文件会缺失）
tar -xzf server/data/backups/uploads-20261022.tar.gz -C server/data

# 5) 权限
chown zhirai:zhirai server/data/outreach.sqlite
chown -R zhirai:zhirai server/data/uploads
chmod 600 server/data/outreach.sqlite

# 6) 启动并验证
sudo systemctl start zhirai-outreach
curl -s http://127.0.0.1:4173/api/v1/health
```

**恢复后必须验证**：登录 → 企业数量 → 最近邮件 → 设置是否保留 → 凭据是否可读（若 `secret.key` 未随备份恢复，需重新录入凭据）→ 产品详情能看到主图/PDF 文件（验证 `uploads/` 已恢复）。

### 8.3 备份建议

| 项 | 建议 |
| --- | --- |
| 频率 | 每日至少一次；大量发送前手动备份 |
| 保留 | 本地 7 天 + 异地 30 天 |
| 加密 | 备份文件含业务数据，建议加密后异地保存（`age`/`gpg`/7z 加密） |
| 分离 | `secret.key` 与数据库备份**分开**存放；丢失 `secret.key` 只影响凭据，不丢业务数据 |
| 文件 | **必须同时备份 `server/data/uploads/`**（产品图片/PDF；数据库备份不含文件） |
| 演练 | 每季度至少做一次真实恢复演练（数据库 + `uploads/`） |

---

## 9. 升级与迁移

### 9.1 升级步骤

```bash
cd /opt/zhirai-outreach

# 1) 备份（必须；数据库 + 产品文件）
npm run backup
tar -czf "server/data/backups/uploads-$(date +%F).tar.gz" -C server/data uploads

# 2) 停服务
sudo systemctl stop zhirai-outreach

# 3) 替换代码（保留 server/data、.env）
#    解压新版本到临时目录，然后覆盖代码文件；不要删除 server/data

# 4) 应用迁移（也可在启动时自动执行）
#    v1.0 → v1.1 会应用 002_product_media_attachments.sql（全部 ADD COLUMN）
npm run init-db

# 5) 启动并观察日志
sudo systemctl start zhirai-outreach
journalctl -u zhirai-outreach -n 100 --no-pager
```

**迁移机制**：`server/db/migrations/NNN_*.sql` 按文件名顺序执行，已执行的记录在 `schema_migrations` 表；启动时自动执行未应用的迁移（`server/index.mjs`）。迁移在事务中执行，失败会回滚并阻止启动。
**v1.1 迁移**：`002_product_media_attachments.sql` 只做 `ALTER TABLE ADD COLUMN`（带默认值），升级不需要回填数据；旧数据自动获得 `keywords_json='[]'`、`attachments_json='[]'` 等默认值。

### 9.2 回滚

1. 停服务。
2. 恢复代码到旧版本。
3. 恢复升级前的数据库备份（删除 `-wal`/`-shm`）。
4. 启动。
5. **注意**：SQLite 迁移通常不可逆；若新版本迁移改了表结构，必须用备份回滚，不能只回滚代码。

### 9.3 迁移到新服务器

1. 新机安装 Node ≥22.5。
2. 复制整个项目目录（**含** `server/data/`，或至少 `outreach.sqlite` + `secret.key` + `uploads/`）。
3. 修改 `.env` 的 `PUBLIC_BASE_URL`（域名/端口变化时）。
4. `npm run init-db` → 启动 → 验证。
5. 反向代理与 DNS 切换。

---

## 10. 首次使用配置

1. 初始化管理员（首次打开自动向导）。
2. **设置 → 合规**：发件公司名、地址、隐私政策 URL（影响邮件合规）。
3. **设置 → 工作空间**：邀请成员（owner 可加 admin；admin 可加 member/viewer）。
4. **设置 → AI**：选择 Provider（默认 `simulation` 离线可用；生产建议配置 OpenAI 兼容端点或本地模型）。
5. **邮箱账户**：添加 SMTP/IMAP 账号（或先用 `simulation` 协议体验流程）。
6. **设置 → 限额/发送窗口**：按目标市场设置（默认 Europe/Berlin 9–17 工作日）。
7. 录入产品 → 定义 ICP → 运行发现 → 评分 → 生成草稿 → 审批 → 发送。
8. 打开发送前先做一次**测试发送给自己的邮箱**；若产品带 PDF，确认附件与公开链接可打开。

---

## 11. 故障排查

| 现象 | 可能原因 | 排查/解决 |
| --- | --- | --- |
| `npm start` 报 `Cannot find module 'node:sqlite'` | Node < 22.5 | `node -v`；升级 Node |
| `启动失败：EADDRINUSE` | 4173 被占用 | 改 `PORT`，或找出占用进程 |
| 浏览器打不开 | 服务未启动 / HOST 不对 | 看控制台输出；`curl http://127.0.0.1:4173/api/v1/health` |
| 页面能开但 API 全 401 | 未登录 / 会话过期 / 代理未传 Cookie | 重新登录；检查 nginx 是否透传 `Cookie`（默认会） |
| 写操作 403 `CSRF_FAILED` | 前端未带 `X-CSRF-Token` / Origin 不匹配 | 检查 `PUBLIC_BASE_URL` 与访问域名一致；清 Cookie 重登 |
| 429 `RATE_LIMITED` | 触发限流 | 等待 `Retry-After`；检查是否被暴力尝试 |
| 登录后马上掉线（HTTPS） | `PUBLIC_BASE_URL` 是 http，Secure Cookie 未生效/不一致 | 设为 `https://...`，重启 |
| 创建备份失败 | `backups` 目录无写权限 / 磁盘满 | 查 `server/data/backups` 权限与 `df -h` |
| 任务一直 queued | `WORKER_ENABLED=0` / Worker 崩溃 | 看日志 `worker crashed`；设 `WORKER_ENABLED=1` 重启 |
| 发送被拒 | 未审批 / 抑制名单 / 接管状态 / 窗口外 / 限额 / 全局暂停 | 查看任务 `last_error` 与审计；核对设置 |
| 发送窗口外一直不发 | 时区/窗口配置 | 检查 `settings.outreach.sendWindow`（默认 Europe/Berlin） |
| 凭据显示"不可用/需重新录入" | `secret.key` 丢失或被替换 | 从备份恢复 `secret.key`，或重新录入凭据 |
| `SQLITE_BUSY` | 高并发写 | 减少并发；确认 `DATA_DIR` 不在网络盘；重启释放锁 |
| 日志中文乱码（Windows） | 控制台编码 | `chcp 65001`；或用 `logs/app.log` 查看 |
| 备份下载 404 | 文件名不合法/不存在 | 只允许 `backups/` 下 `*.sqlite`；确认文件名 |
| 邮件进入垃圾箱 | SPF/DKIM/DMARC 未配置、发信量突增 | 配置域名认证；降低发送量；检查内容与退订链接 |
| 邮件里的产品 PDF 链接 404 | 文件已删除 / token 过期 / `PUBLIC_BASE_URL` 不对 / 反向代理未转发 `/api/v1/public/*` | 检查产品文件是否仍存在；重发草稿获取新链接；确认公网可访问 `PUBLIC_BASE_URL` |
| 邮件发出但没有附件 | 附件文件缺失 / 单 >5 MB / 总 >8 MB / 类型不允许 | 发送任务结果含 `attachmentWarnings`；重新上传 PDF（≤5 MB）并重新生成草稿 |
| 上传 PDF 报 422 | MIME 非 `application/pdf` 或 base64 非法/超 8 MB | 确认文件类型与大小；用浏览器重新上传 |
| `uploads/` 占用过大 | 产品图片/PDF 累积 | 删除归档产品的文件；监控磁盘；备份时注意文件体积 |

**查看日志**：

```bash
tail -n 200 server/data/logs/app.log
# 或维护台 → 运行日志（需 audit.read 权限）
curl "http://127.0.0.1:4173/api/v1/ops/logs?lines=200" -H "Cookie: ..."
```

**健康检查**：

```bash
curl -s http://127.0.0.1:4173/api/v1/health
# {"ok":true,"data":{"status":"ok","version":"<package.json 版本>","initialized":true,...}}
```

---

## 12. 安全清单

部署完成后逐项确认：

- [ ] `NODE_ENV=production`
- [ ] `HOST=127.0.0.1`，Node 端口不直接暴露公网
- [ ] `PUBLIC_BASE_URL` 为 https
- [ ] `TRUST_PROXY=1` 仅在可信反代后启用
- [ ] 反向代理启用 HTTPS + HSTS
- [ ] nginx 配置 `client_max_body_size` 与登录限流
- [ ] `server/data` 权限仅服务账号可读写，`secret.key` 600
- [ ] 首次登录后立即修改初始化密码
- [ ] 每位成员独立账号；离职移除成员并吊销会话
- [ ] 凭据通过界面录入（加密），不写 `.env`
- [ ] 每日备份 + 异地保存 + 恢复演练
- [ ] 监控 `logs/app.log`（error）与审计异常
- [ ] 定期升级 Node 与产品版本（升级前备份）
- [ ] `DATA_DIR` 不在网络盘
- [ ] 了解 `GLOBAL_SEND_PAUSED=1` 紧急刹车
- [ ] 阅读并落实 [docs/SECURITY.md](docs/SECURITY.md) §13

### 12.1 部署后验收（可选，建议在演示实例执行）

```bash
# 1) 演示数据（会创建 demo@zhirai.test 演示工作空间；不要在生产库执行）
npm run seed

# 2) 启动服务（另一终端）
npm start

# 3) 端到端安全验收：审批→Worker 发送、接管拦截、抑制拦截、公开退订（15 项检查）
node scripts/verify-safety.mjs http://127.0.0.1:4173
# 期望输出：Result: 16/16 passed
```

> `verify-safety.mjs` 会临时放宽发送窗口、审批并发送演示草稿、接管演示客户、添加/删除抑制记录、调用公开退订，并在结束时恢复发送窗口。**只应在演示/测试实例运行**，不要对客户生产数据执行。

---

## 13. 发行包打包规范（zip 根目录平铺）

**必须**：解压后直接得到 `index.html`、`server/`、`src/` 等，**不能多套一层文件夹**。

### 13.1 应包含

```text
index.html
manifest.webmanifest
package.json
.env.example
LICENSE
README.md
DEPLOY.md
CHANGELOG.md
admin/
assets/
docs/            （不含 CONTRACTS.md 可选；建议含 ARCHITECTURE/RESEARCH/LICENSE-REGISTER/DATA-MODEL/API/SECURITY/COMPLIANCE/DECISIONS/USER-GUIDE/ROADMAP/openapi.yaml）
scripts/
server/          （不含 server/data/）
src/
tests/           （可选；客户不需要可剔除）
```

### 13.2 必须排除

```text
server/data/**          # 数据库、上传、日志、备份、secret.key
.env / .env.local
node_modules/
.verify/  coverage/  *.log
.git/  .idea/  .vscode/  .DS_Store  Thumbs.db
```

### 13.3 打包命令

**Windows PowerShell**

```powershell
$src = "C:\zhirai-stage\platform"
$dist = "C:\zhirai-stage\dist"
$out = Join-Path $dist "zhirai-europe-b2b-outreach-v1.1.0.zip"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $out) { Remove-Item $out }

# 复制到临时目录并排除运行时数据
$tmp = Join-Path $env:TEMP "zhirai-pack"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
robocopy $src $tmp /E /XD data node_modules .git .verify coverage /XF .env *.key *.log | Out-Null

# 打包时进入临时目录内部，保证根目录平铺
Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $out -Force
Remove-Item $tmp -Recurse -Force
"OK -> $out"
```

**Linux**

```bash
cd /opt/zhirai-outreach
zip -r /tmp/zhirai-europe-b2b-outreach-v1.1.0.zip . \
  -x 'server/data/*' '.env' '*.key' '*.log' '.git/*' 'node_modules/*' '.verify/*'
```

### 13.4 打包后自检

- [ ] `unzip -l` / 打开 zip 看到 `index.html` 在根（不是 `platform/index.html`）
- [ ] 不含 `server/data/`、`.env`、`secret.key`
- [ ] 含 `LICENSE`、`docs/LICENSE-REGISTER.md`
- [ ] 在新目录解压 → `npm run init-db` → `npm start` → 能打开初始化页
- [ ] 版本号与 `package.json`、`CHANGELOG.md` 一致

---

## 14. 卸载与数据清理

```bash
# 1) 停服务
sudo systemctl disable --now zhirai-outreach

# 2) 导出/备份需要保留的数据
#    （数据库 + secret.key + uploads）

# 3) 删除代码
sudo rm -rf /opt/zhirai-outreach

# 4) 删除 systemd 单元
sudo rm /etc/systemd/system/zhirai-outreach.service
sudo systemctl daemon-reload
```

> 注意：删除 `server/data` 等于删除全部业务数据，不可恢复；删除前务必确认备份已异地保存。
> 若需按 GDPR 删除特定联系人/邮件，请参考 [docs/COMPLIANCE.md](docs/COMPLIANCE.md) §7/§8。

---
<div align="center">

**ZHIRAI · 智睿科技 · 独立开发者**
把想法变成现实 ｜ https://zhirai.cloud
© 2026 智睿科技 保留所有权利。

</div>
