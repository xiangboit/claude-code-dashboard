# Claude Code Dashboard

在浏览器中管理和运行 Claude Code 的本地化 Web 方案。自动扫描项目目录，选择项目即可在浏览器内启动完整的 Claude Code 交互式终端。

适用于任何安装了 Node.js 和 Claude Code 的 Mac。通过局域网访问，可在手机、平板或其他电脑上远程操作本机的 Claude Code。

## 功能

- **自动项目发现** — 扫描 `~/projects/` 目录，无需手动配置
- **原生终端体验** — 基于 xterm.js，完整支持 Claude Code 的交互式界面（颜色、光标、快捷键）
- **Git Clone** — 侧边栏粘贴 git 地址即可 clone 新项目
- **使用统计** — 记录每个项目的使用次数
- **PM2 托管** — 崩溃自动重启，开机自启动

## 快速开始

```bash
git clone https://gitee.com/xiangboit/claude-code-remote.git
cd claude-code-remote
npm install
npm start
```

访问 http://localhost:3000

### PM2 持久化运行（推荐）

```bash
npm install -g pm2
pm2 start server.js --name claude-dashboard --watch
pm2 startup  # 按提示执行 sudo 命令
pm2 save
```

## 前提条件

- macOS
- Node.js
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已安装（`brew install claude-code`）
- 项目存放在 `~/projects/` 目录下

## 技术栈

- **后端**: Node.js + Express + node-pty + WebSocket
- **前端**: xterm.js + 原生 HTML/CSS/JS
- **进程管理**: PM2
