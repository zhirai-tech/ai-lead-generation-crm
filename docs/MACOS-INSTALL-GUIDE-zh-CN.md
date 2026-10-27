# macOS 安装与使用说明（白话版）

**产品：** ZHIRAI AI 智能获客与销售外联系统  
**版本：** 1.1.0-1025  
**安装包：** `ZHIRAI-1.1.0-1025-macOS-arm64.tar.gz`

## 先说清楚：它不是 DMG，也不是 ISO 镜像

macOS 包是一个 **`.tar.gz` 压缩包**，不是磁盘镜像，也不是安装程序。  
不需要打开终端，不需要“挂载”，也不需要安装向导。  
在 Finder 里双击它，macOS 会自动解压出一个文件夹。

## 电脑要求

- Apple Silicon 芯片：M1 / M2 / M3 / M4
- macOS 13 或更高版本
- Intel 芯片的 Mac **不支持**
- 不需要安装 Node.js

## 最简单操作步骤

1. 下载 `ZHIRAI-1.1.0-1025-macOS-arm64.tar.gz`。
2. 在 Finder 里双击这个文件，系统会解压出文件夹 `ZHIRAI-1.1.0-1025-macOS-arm64`。
3. 打开解压后的文件夹。
4. 双击里面的 `ZHIRAI-Base.app`。Finder 里可能显示为 **ZHIRAI AI Lead Generation CRM**。
5. 如果 macOS 提示“无法打开，因为无法验证开发者”：
   - 右键点击 `ZHIRAI-Base.app`，选择“打开”；
   - 弹窗里再点一次“打开”；
   - 如果还是不行：苹果菜单 → 系统设置 → 隐私与安全性 → 点击“仍要打开”。
6. 等几秒，程序会启动本地服务并自动打开浏览器。
7. 如果没有自动打开浏览器，手动打开 Safari 或 Chrome，访问：

   `http://127.0.0.1:4173`

8. 第一次打开会进入“初始化工作台”，按页面创建管理员账号。

可以选做：把 `ZHIRAI-Base.app` 拖进“应用程序”文件夹。  
不拖也能用，不要只单独拖 Helper 文件。

## 数据保存在哪里

```text
~/Library/Application Support/ai-lead-generation-crm/data
```

打开方法：

1. 打开 Finder；
2. 按 `Command + Shift + G`；
3. 把上面的路径粘贴进去；
4. 按回车。

这个文件夹里有数据库、上传文件和本机密钥。换电脑或重装前，先备份整个文件夹。

## 怎么退出、怎么备份

- 退出：点屏幕左上角菜单 **ZHIRAI AI Lead Generation CRM → 退出**，或按 `Command + Q`。
- 程序运行时不要复制或覆盖数据库。
- 备份：先退出程序，再复制整个 `data` 文件夹。
- 卸载：退出程序，把 `ZHIRAI-Base.app` 移到废纸篓；数据文件夹不会自动删除。

## 常见问题

**为什么提示“无法验证开发者”？**  
因为这个版本没有做苹果签名和公证，提示是正常的。右键 → 打开即可。只从官方发布页下载。

**需要安装 Node.js 吗？**  
不需要。macOS 打包版自带运行环境。

**双击没反应怎么办？**  
先确认是 Apple Silicon Mac、macOS 13 或以上；关闭占用 4173 端口的程序后重开；也可以手动访问 `http://127.0.0.1:4173`。

**Intel Mac 能用吗？**  
不能。这个包只支持 Apple Silicon（arm64）。

**可以放到“应用程序”里吗？**  
可以，但不是必须。拖整个 `ZHIRAI-Base.app`，不要只拖里面的 Helper。

## 第一次使用的安全说明

默认发送是暂停的（`GLOBAL_SEND_PAUSED=1`）。  
在你配置好邮箱、合规信息并手动解除暂停之前，不会真实群发邮件。

## 如果提示 “is damaged and can't be opened”

这不是病毒，也不一定是下载损坏。  
常见原因是：应用没有苹果签名，或者打包后文件被修改，macOS 认为签名无效。  
“允许任意来源”这个设置不能解决这种签名错误。

先点击 **Cancel**，不要点 Move to Trash。

打开“终端”，执行：

```bash
cd ~/Downloads/ZHIRAI-1.1.0-1025-macOS-arm64
xattr -cr ZHIRAI-Base.app
codesign --force --deep --sign - ZHIRAI-Base.app
open ZHIRAI-Base.app
```

如果应用已经拖到“应用程序”：

```bash
cd /Applications
xattr -cr ZHIRAI-Base.app
codesign --force --deep --sign - ZHIRAI-Base.app
open ZHIRAI-Base.app
```

如果仍然提示无法验证开发者，再右键应用 →“打开”。  
如果终端出现其他错误，把终端最后几行发回来。
