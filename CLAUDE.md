# Claude Code Dashboard

Claude Code 远程开发平台 — 一次部署，任意设备，随时接入。

## 产品定位

将 Claude Code CLI 封装为 Web 服务，解决：
- **IP 风险收敛**：一台 Mac 固定出口，避免多设备 IP 漂移
- **环境统一**：一台机器配置好环境，所有设备浏览器访问
- **跨平台**：iPad / Windows / Android 通过浏览器使用 Claude Code
- **多人共享**：多用户共用同一台机器的 Claude Code

## 架构概览

```
浏览器 (xterm.js) ←→ WebSocket ←→ Express ←→ node-pty ←→ claude CLI
                                      ↕
                                  SQLite (better-sqlite3)
```

单进程 Node.js 服务，HTTP + WebSocket 共用同一端口（3000）。

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端终端 | xterm.js 5.3 + xterm-addon-fit | 浏览器内完整终端模拟 |
| 前端框架 | 原生 HTML/CSS/JS | 无构建，单文件 `app.js` |
| 后端框架 | Express | REST API + 静态文件 |
| 实时通信 | ws (WebSocket) | 终端 I/O 双向传输 |
| 进程管理 | node-pty | 本地 PTY 进程池 |
| 数据库 | better-sqlite3 (WAL) | 用户、项目统计 |
| 进程托管 | PM2 | watch + 自动重启 + launchd 开机自启 |

## 核心机制

### 进程池 (sessions Map)

```
Map<sessionId, {
  pty,           // node-pty 进程实例
  buffer,        // 输出缓冲区（200KB 上限，用于重连回放）
  projectId,     // 所属项目
  owner,         // 用户名
  createdAt,
  lastActivity,
  attachedWs     // 当前绑定的 WebSocket（可为 null）
}>
```

- **attach/detach 模型**：WebSocket 断开只解绑，不 kill 进程；重连后 attach 回来并回放 buffer
- **空闲清理**：无 WebSocket 绑定且 30 分钟无活动的会话自动 kill
- **`claude --resume`**：支持恢复历史对话上下文

### 认证

- scrypt 密码哈希（兼容旧 SHA256 自动迁移），Bearer token 认证
- Token 存 SQLite（7 天有效期），用户数据存 SQLite
- WebSocket 通过 URL query `?token=xxx` 传递认证
- 首次无用户时显示注册页，之后显示登录页

### 统一搜索/克隆

侧边栏搜索框和顶栏项目下拉搜索框均为双用途输入：
- 输入普通文字 → 搜索过滤项目列表
- 输入 git URL（`https://`、`git@`、`ssh://`）→ 提示克隆，回车执行
- git URL 匹配到已有项目时 → 回车直接切换到该项目
- 正则检测：`/^(https?:\/\/|git@|ssh:\/\/).+/`
- 仓库名提取：`extractRepoName()` 从 URL 末尾提取

### 远程剪贴板同步

解决远程设备截图无法粘贴给 Claude Code 的问题：
- **原因**：Claude Code 读取的是服务器（Mac Mini）的系统剪贴板，远程浏览器的剪贴板内容无法直接到达
- **方案**：前端拦截 paste 事件（捕获阶段），检测到图片后上传到服务器，服务器通过 `osascript` 写入 macOS 系统剪贴板
- **流程**：远程截图 → Cmd/Ctrl+V → 图片上传 → 写入 Mac 剪贴板 → toast 提示"已同步" → 再次 Cmd/Ctrl+V → Claude Code 正常读取
- **API**：`POST /api/clipboard` 接收 base64 PNG，写入 macOS 剪贴板
- **限制**：仅支持图片；body 上限 10MB；需 macOS（依赖 osascript）

### WebSocket 消息协议

**客户端 → 服务端：**
- `{type: 'start', projectId, resume, cols, rows}` — 新建会话
- `{type: 'attach', sessionId}` — 接入已有会话
- `{type: 'input', data}` — 终端输入
- `{type: 'resize', cols, rows}` — 终端尺寸变更

**服务端 → 客户端：**
- `{type: 'started', sessionId}` — 会话已创建
- `{type: 'attached', sessionId}` — 已接入会话
- `{type: 'output', data}` — 终端输出
- `{type: 'replay', data}` — 重连时的缓冲区回放
- `{type: 'exit', sessionId}` — 会话结束
- `{type: 'detached'}` — 被其他连接接管
- `{type: 'notify', message}` — 通知（如后台会话结束）
- `{type: 'error', data}` — 错误信息

## 项目结构

```
server.js          — 后端入口（Express + WebSocket + PTY 进程池）
public/index.html  — 页面（登录页 + 主应用）
public/app.js      — 前端逻辑（认证、终端、会话管理）
dashboard.db       — SQLite 数据库（用户、项目统计）
```

## 数据库表

```sql
-- 用户
CREATE TABLE users (
  username TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 项目使用统计
CREATE TABLE project_stats (
  project_id TEXT PRIMARY KEY,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
```

## REST API

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
| POST | /api/clipboard | 剪贴板同步（base64 PNG → macOS 剪贴板）|

## 关键约束

- 启动 claude 时必须 `delete env.CLAUDECODE`，否则 Claude Code 检测嵌套会话拒绝启动
- 项目目录固定为 `~/projects/`，自动扫描首层子目录
- 所有 innerHTML 拼接必须经过 `escapeHtml()` 防 XSS
- 前端所有 API 请求使用 `authFetch()` 包装，401 自动跳转登录
- 优雅停机时先 kill 所有 PTY 进程，再 close db
- express.json body 上限 10MB（支持剪贴板图片上传）
- 剪贴板同步依赖 macOS `osascript`，仅 macOS 服务器可用

## 开发命令

```bash
npm install          # 安装依赖
npm start            # 启动服务 (localhost:3000)
pm2 restart claude-dashboard  # PM2 重启
```
