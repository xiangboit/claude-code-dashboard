# Claude Code Dashboard

将 Claude Code CLI 封装为 Web 服务 — 一次部署，任意设备，随时接入。

在浏览器中管理和运行 Claude Code。自动扫描项目目录，选择项目即可启动完整的 Claude Code 交互式终端。适用于任何安装了 Node.js 和 Claude Code 的 Mac，通过局域网访问，iPad、手机、Windows 均可使用。

## 解决什么问题

- **IP 风险收敛**：一台 Mac 固定出口，避免多设备 IP 漂移触发风控
- **环境统一**：一台机器配置好开发环境，所有设备浏览器访问
- **跨平台**：iPad / Windows / Android 通过浏览器使用 Claude Code
- **多人共享**：多用户共用同一台机器的 Claude Code 订阅

## 架构

```
浏览器 (xterm.js) ←→ WebSocket ←→ Express ←→ node-pty ←→ claude CLI
                                      ↕
                                  SQLite (better-sqlite3)
```

单进程 Node.js 服务，HTTP + WebSocket 共用端口 3000。

## 功能特性

- **完整终端**：xterm.js 浏览器内终端，支持 256 色、鼠标事件、自适应尺寸
- **会话管理**：多会话并行，断开不丢失，重连自动回放输出缓冲区
- **会话恢复**：支持 `claude --resume` 恢复历史对话上下文；PM2 重启后可恢复
- **项目管理**：自动扫描 `~/projects/` 目录，支持搜索、克隆、使用频率排序
- **统一搜索/克隆**：搜索框输入文字搜索项目，输入 git URL 回车直接克隆
- **远程剪贴板**：远程设备截图 Ctrl+V → 自动同步到服务器 macOS 剪贴板 → 再次粘贴即可
- **多用户认证**：scrypt 密码哈希，Bearer token，7 天有效期
- **快捷键**：Ctrl/Cmd+K 快速切换项目，Ctrl/Cmd+N 新建会话
- **健康监控**：CPU、内存、磁盘用量实时查看
- **移动端适配**：响应式布局，iPad / 手机可用
- **优雅停机**：SIGTERM/SIGINT 信号自动清理所有会话进程

## 快速开始

### 环境要求

- macOS（剪贴板同步依赖 osascript）
- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并登录
- 项目存放在 `~/projects/` 目录下

### 安装

```bash
git clone https://github.com/xiangboit/claude-code-dashboard.git
cd claude-code-dashboard
npm install
```

### 启动

```bash
npm start    # http://localhost:3000
```

首次启动会创建默认管理员账户 `admin / 123456`，请登录后立即修改密码。

### 生产部署（PM2）

```bash
npm install -g pm2
pm2 start server.js --name claude-dashboard --watch
pm2 save
pm2 startup    # 开机自启
```

## 使用说明

1. 浏览器访问 `http://<your-server>:3000`
2. 登录后左侧选择项目，点击"新建会话"启动 Claude Code
3. 像本地终端一样使用 — 支持所有 Claude Code 功能
4. 关闭浏览器标签页不影响后台运行，重新打开自动恢复
5. 远程截图粘贴：第一次 Ctrl+V 同步到服务器剪贴板，第二次 Ctrl+V Claude 读取

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端终端 | xterm.js 5.3 + xterm-addon-fit | 浏览器内完整终端模拟 |
| 前端框架 | 原生 HTML/CSS/JS | 无构建，单文件 app.js |
| 后端框架 | Express | REST API + 静态文件 |
| 实时通信 | ws (WebSocket) | 终端 I/O 双向传输 |
| 进程管理 | node-pty | 本地 PTY 进程池 |
| 数据库 | better-sqlite3 (WAL) | 用户、项目统计 |
| 进程托管 | PM2 | watch + 自动重启 + launchd 开机自启 |

## 项目结构

```
server.js          — 后端（Express + WebSocket + PTY 进程池 + 认证 + 数据库）
public/index.html  — 前端页面（登录 + 主应用 + CSS）
public/app.js      — 前端逻辑（终端管理 + 会话控制 + UI 交互）
dashboard.db       — SQLite 数据库（自动创建，已 gitignore）
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/register | 注册 |
| POST | /api/login | 登录 |
| GET | /api/auth/status | 认证状态 |
| POST | /api/change-password | 修改密码 |
| GET | /api/projects | 项目列表 |
| POST | /api/clone | 克隆 git 仓库 |
| GET | /api/sessions | 会话列表 |
| DELETE | /api/sessions/:id | 关闭会话 |
| GET | /api/health | 健康检查 |
| POST | /api/clipboard | 远程剪贴板同步 |

## 测试

```bash
npm test
```

## 配套项目

- [Claude Code App](https://github.com/xiangboit/claude-code-app) — Android 原生客户端，移动控制台体验

## License

MIT
