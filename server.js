const express = require('express');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ---- 数据库 ----

// 数据库默认存放在 ~/.claude-dashboard/，避免被 Claude 会话读取
const defaultDbDir = path.join(os.homedir(), '.claude-dashboard');
if (!fs.existsSync(defaultDbDir)) fs.mkdirSync(defaultDbDir, { recursive: true });
const dbPath = process.env.DASHBOARD_DB || path.join(defaultDbDir, 'dashboard.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// ---- 用户认证 ----

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

// 启动时清理过期 token
db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(Date.now());

// 默认管理员账户（首次启动自动创建）
const DEFAULT_ADMIN = { username: 'admin', password: '123456' };

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt] = stored.split(':');
  return hashPassword(password, salt) === stored;
}

// 迁移旧 SHA256 哈希到 scrypt（兼容已有用户）
function migrateOldHash(username, password) {
  const newHash = hashPassword(password);
  db.prepare('UPDATE users SET hash = ? WHERE username = ?').run(newHash, username);
  return newHash;
}

// 启动时：无用户则创建默认管理员
{
  const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  if (userCount === 0) {
    db.prepare('INSERT INTO users (username, hash, created_at) VALUES (?, ?, ?)')
      .run(DEFAULT_ADMIN.username, hashPassword(DEFAULT_ADMIN.password), Date.now());
    console.log(`已创建默认管理员: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
  }
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length > 32 || password.length < 4) return res.status(400).json({ error: '用户名最长32位，密码最少4位' });
  const existing = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: '用户已存在' });
  db.prepare('INSERT INTO users (username, hash, created_at) VALUES (?, ?, ?)').run(username, hashPassword(password), Date.now());
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO tokens (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, username, Date.now(), Date.now() + TOKEN_TTL);
  res.json({ token, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const user = db.prepare('SELECT hash FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  // 兼容旧 SHA256 哈希（不含 ':'）
  if (!user.hash.includes(':')) {
    const oldHash = crypto.createHash('sha256').update(password).digest('hex');
    if (user.hash !== oldHash) return res.status(401).json({ error: '用户名或密码错误' });
    migrateOldHash(username, password);
  } else {
    if (!verifyPassword(password, user.hash)) return res.status(401).json({ error: '用户名或密码错误' });
  }
  db.prepare('DELETE FROM tokens WHERE username = ? AND expires_at < ?').run(username, Date.now());
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO tokens (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, username, Date.now(), Date.now() + TOKEN_TTL);
  res.json({ token, username });
});

function getUserByToken(token) {
  const row = db.prepare('SELECT username FROM tokens WHERE token = ? AND expires_at > ?').get(token, Date.now());
  return row ? row.username : null;
}

function getUser(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return getUserByToken(auth.slice(7));
  }
  return null;
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  req.username = user;
  next();
}

app.post('/api/change-password', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写旧密码和新密码' });
  if (newPassword.length < 4) return res.status(400).json({ error: '新密码最少4位' });
  const row = db.prepare('SELECT hash FROM users WHERE username = ?').get(user);
  if (!row) return res.status(404).json({ error: '用户不存在' });
  // 兼容旧 SHA256 哈希
  if (!row.hash.includes(':')) {
    const oldHash = crypto.createHash('sha256').update(oldPassword).digest('hex');
    if (row.hash !== oldHash) return res.status(401).json({ error: '旧密码错误' });
  } else {
    if (!verifyPassword(oldPassword, row.hash)) return res.status(401).json({ error: '旧密码错误' });
  }
  db.prepare('UPDATE users SET hash = ? WHERE username = ?').run(hashPassword(newPassword), user);
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  const user = getUser(req);
  res.json({ hasUsers: userCount > 0, loggedIn: !!user, username: user || null });
});

// 静态文件（登录页面不需要认证）
app.use(express.static('public'));

// 以下 API 需要认证
app.use('/api/projects', requireAuth);
app.use('/api/clone', requireAuth);
app.use('/api/sessions', requireAuth);
app.use('/api/health', requireAuth);
app.use('/api/clipboard', requireAuth);

// 剪贴板同步：接收远程浏览器的图片，写入 macOS 系统剪贴板
app.post('/api/clipboard', (req, res) => {
  const { image } = req.body; // base64 encoded PNG
  if (!image) return res.status(400).json({ error: '缺少图片数据' });
  const buf = Buffer.from(image, 'base64');
  const tmpFile = path.join(os.tmpdir(), `clipboard-${Date.now()}.png`);
  try {
    fs.writeFileSync(tmpFile, buf);
    execFileSync('osascript', ['-e',
      `set the clipboard to (read (POSIX file "${tmpFile}") as «class PNGf»)`
    ], { timeout: 5000 });
    fs.unlinkSync(tmpFile);
    res.json({ success: true });
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// 自动检测 claude 路径
let claudePath;
try {
  claudePath = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
} catch {
  claudePath = '/opt/homebrew/bin/claude';
}

// ---- 会话记录 ----

db.exec(`
  CREATE TABLE IF NOT EXISTS session_records (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  )
`);

// 启动时：上次残留的 active 会话标记为 stale（进程已丢失，可 resume）
db.prepare("UPDATE session_records SET status = 'stale' WHERE status = 'active'").run();

function recordSessionStart(sessionId, projectId, owner) {
  db.prepare('INSERT INTO session_records (session_id, project_id, owner, created_at, status) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, projectId, owner, Date.now(), 'active');
}

function recordSessionEnd(sessionId) {
  db.prepare('DELETE FROM session_records WHERE session_id = ?').run(sessionId);
}

function getStaleSessionsForUser(username) {
  return db.prepare("SELECT session_id, project_id, created_at FROM session_records WHERE owner = ? AND status = 'stale' ORDER BY created_at DESC").all(username);
}

// ---- 项目统计 ----

db.exec(`
  CREATE TABLE IF NOT EXISTS project_stats (
    project_id TEXT PRIMARY KEY,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL DEFAULT 0
  )
`);

const projectsDir = path.join(os.homedir(), 'projects');

let projectsCache = null;
let projectsCacheTime = 0;
const CACHE_TTL = 5000;

function invalidateProjectsCache() {
  projectsCache = null;
  projectsCacheTime = 0;
}

// 监听项目目录变更
try {
  fs.watch(projectsDir, { persistent: false }, invalidateProjectsCache);
} catch {}

function scanProjects() {
  const now = Date.now();
  if (projectsCache && now - projectsCacheTime < CACHE_TTL) return projectsCache;

  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const statsRows = db.prepare('SELECT project_id, use_count, last_used_at FROM project_stats').all();
    const statsMap = {};
    for (const row of statsRows) statsMap[row.project_id] = row;

    const projects = entries
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => ({
        id: d.name,
        name: d.name,
        path: path.join(projectsDir, d.name),
        use_count: (statsMap[d.name] && statsMap[d.name].use_count) || 0,
        last_used_at: (statsMap[d.name] && statsMap[d.name].last_used_at) || 0
      }));

    projects.sort((a, b) => {
      if (b.use_count !== a.use_count) return b.use_count - a.use_count;
      return a.name.localeCompare(b.name);
    });

    projectsCache = projects;
    projectsCacheTime = now;
    return projects;
  } catch {
    return [];
  }
}

function updateProjectUsage(projectId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO project_stats (project_id, use_count, last_used_at) VALUES (?, 1, ?)
    ON CONFLICT(project_id) DO UPDATE SET use_count = use_count + 1, last_used_at = ?
  `).run(projectId, now, now);
}

// 获取项目列表
app.get('/api/projects', (req, res) => {
  res.json(scanProjects());
});

// Clone 项目
const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/).+/;

app.post('/api/clone', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '缺少 git 地址' });
  if (!gitUrlPattern.test(url)) {
    return res.status(400).json({ error: '无效的 git 地址' });
  }

  execFile('git', ['clone', url], { cwd: projectsDir, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: stderr || err.message });
    }
    res.json({ success: true, output: stderr || stdout });
  });
});

// ---- 进程池 ----

const sessions = new Map(); // sessionId -> { pty, buffer, projectId, owner, createdAt, lastActivity, attachedWs }
const BUFFER_MAX = 200000;
const IDLE_TIMEOUT = 30 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 5;
const MAX_SESSIONS_GLOBAL = 10;

function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function killPty(p) {
  if (!p) return;
  try { p.kill(); } catch {}
}

function createSession(projectId, cols, rows, resume, owner) {
  if (sessions.size >= MAX_SESSIONS_GLOBAL) return { error: '全局会话数已达上限' };
  let userCount = 0;
  for (const s of sessions.values()) { if (s.owner === owner) userCount++; }
  if (userCount >= MAX_SESSIONS_PER_USER) return { error: '个人会话数已达上限' };

  const project = scanProjects().find(p => p.id === projectId);
  if (!project) return null;

  const sessionId = generateSessionId();
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const args = resume ? ['--resume'] : [];

  const ptyProcess = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: project.path,
    env
  });

  const session = {
    pty: ptyProcess,
    buffer: '',
    projectId,
    owner: owner || '',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    attachedWs: null
  };

  ptyProcess.onData((data) => {
    session.lastActivity = Date.now();
    session.buffer += data;
    if (session.buffer.length > BUFFER_MAX) {
      session.buffer = session.buffer.slice(-BUFFER_MAX);
    }
    if (session.attachedWs && session.attachedWs.readyState === WebSocket.OPEN) {
      session.attachedWs.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ptyProcess.onExit(() => {
    if (session.attachedWs && session.attachedWs.readyState === WebSocket.OPEN) {
      session.attachedWs.send(JSON.stringify({ type: 'exit', sessionId }));
    } else {
      // 后台会话结束，通知同用户的所有连接
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client._user === session.owner) {
          client.send(JSON.stringify({
            type: 'notify',
            projectId,
            message: `${projectId} 的 Claude 会话已结束`
          }));
        }
      });
    }
    updateProjectUsage(projectId);
    recordSessionEnd(sessionId);
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, session);
  recordSessionStart(sessionId, projectId, owner);
  return sessionId;
}

function attachSession(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.attachedWs && session.attachedWs !== ws && session.attachedWs.readyState === WebSocket.OPEN) {
    session.attachedWs.send(JSON.stringify({ type: 'detached' }));
  }

  session.attachedWs = ws;
  session.lastActivity = Date.now();
  return true;
}

function detachSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.attachedWs = null;
  }
}

// 空闲清理
const idleCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session.attachedWs && now - session.lastActivity > IDLE_TIMEOUT) {
      console.log(`清理空闲会话: ${id} (项目: ${session.projectId})`);
      killPty(session.pty);
      recordSessionEnd(id);
      sessions.delete(id);
    }
  }
}, 60000);

// 会话列表 API（按用户过滤，包含 stale 会话）
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.owner !== req.username) continue;
    list.push({
      id,
      projectId: session.projectId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      attached: !!session.attachedWs,
      stale: false
    });
  }
  const stales = getStaleSessionsForUser(req.username);
  for (const s of stales) {
    list.push({
      id: s.session_id,
      projectId: s.project_id,
      createdAt: s.created_at,
      lastActivity: s.created_at,
      attached: false,
      stale: true
    });
  }
  res.json(list);
});

// 关闭会话 API（支持 live 和 stale）
app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) {
    if (session.owner !== req.username) {
      return res.status(403).json({ error: '无权操作此会话' });
    }
    if (session.attachedWs && session.attachedWs.readyState === WebSocket.OPEN) {
      session.attachedWs.send(JSON.stringify({ type: 'exit', sessionId: req.params.id }));
    }
    killPty(session.pty);
    recordSessionEnd(req.params.id);
    sessions.delete(req.params.id);
    return res.json({ success: true });
  }
  // stale session
  recordSessionEnd(req.params.id);
  res.json({ success: true });
});

// 健康检查 API
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  // 磁盘用量（项目目录所在分区）
  let disk = null;
  try {
    const df = execFileSync('df', ['-k', projectsDir], { encoding: 'utf8' });
    const lines = df.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const total = Math.round(parseInt(parts[1]) / 1024 / 1024);
      const used = Math.round(parseInt(parts[2]) / 1024 / 1024);
      disk = { total, used, percent: parts[4] };
    }
  } catch {}

  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: sessions.size,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heap: Math.round(mem.heapUsed / 1024 / 1024)
    },
    cpu: {
      cores: cpus.length,
      load1m: loadAvg[0].toFixed(2)
    },
    disk
  });
});

// 创建 HTTP 服务器并绑定 WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  // 从 URL 参数获取 token 认证
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const username = token && getUserByToken(token);

  if (!username) {
    ws.send(JSON.stringify({ type: 'error', data: '未登录' }));
    ws.close();
    return;
  }

  ws._user = username;
  let currentSessionId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'start') {
      const result = createSession(msg.projectId, msg.cols, msg.rows, msg.resume, username);
      if (!result) {
        ws.send(JSON.stringify({ type: 'error', data: '项目不存在' }));
        return;
      }
      if (typeof result === 'object' && result.error) {
        ws.send(JSON.stringify({ type: 'error', data: result.error }));
        return;
      }
      const sessionId = result;
      if (currentSessionId) detachSession(currentSessionId);
      currentSessionId = sessionId;
      attachSession(sessionId, ws);
      ws.send(JSON.stringify({ type: 'started', sessionId, createdAt: sessions.get(sessionId).createdAt, projectId: msg.projectId }));

    } else if (msg.type === 'attach') {
      const session = sessions.get(msg.sessionId);
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', data: '会话不存在或已过期' }));
        return;
      }
      if (session.owner !== username) {
        ws.send(JSON.stringify({ type: 'error', data: '无权访问此会话' }));
        return;
      }
      if (currentSessionId) detachSession(currentSessionId);
      currentSessionId = msg.sessionId;
      attachSession(msg.sessionId, ws);
      if (msg.cols && msg.rows) {
        session.pty.resize(msg.cols, msg.rows);
      }
      if (session.buffer) {
        ws.send(JSON.stringify({ type: 'replay', data: session.buffer }));
      }
      ws.send(JSON.stringify({ type: 'attached', sessionId: msg.sessionId, createdAt: session.createdAt, projectId: session.projectId }));

    } else if (msg.type === 'input') {
      const session = currentSessionId && sessions.get(currentSessionId);
      if (session) session.pty.write(msg.data);

    } else if (msg.type === 'resize') {
      const session = currentSessionId && sessions.get(currentSessionId);
      if (session) session.pty.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    if (currentSessionId) {
      detachSession(currentSessionId);
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
    console.log(`Claude path: ${claudePath}`);
  });
}

// 优雅停机
// 注意：此处有意不调 recordSessionEnd，让 active 记录保留。
// 下次启动时 session_records 中残留的 active 会被标记为 stale，用户可通过 resume 恢复。
function shutdown() {
  console.log('收到停机信号，清理会话...');
  for (const [id, session] of sessions) {
    killPty(session.pty);
    sessions.delete(id);
  }
  if (idleCleanupTimer) clearInterval(idleCleanupTimer);
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server, db, sessions, idleCleanupTimer, hashPassword };
