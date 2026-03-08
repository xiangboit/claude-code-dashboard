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
const cron = require('node-cron');

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

const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY || null;

function getUser(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (DASHBOARD_API_KEY && token === DASHBOARD_API_KEY) {
      const firstUser = db.prepare('SELECT username FROM users ORDER BY created_at ASC LIMIT 1').get();
      return firstUser ? firstUser.username : null;
    }
    return getUserByToken(token);
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
app.use('/api/settings', requireAuth);

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

// 自动检测 CLI 路径
const agentPaths = {};
for (const cmd of ['claude', 'codex']) {
  try {
    agentPaths[cmd] = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
  } catch {
    agentPaths[cmd] = null;
  }
}
if (!agentPaths.claude) agentPaths.claude = '/opt/homebrew/bin/claude';
const claudePath = agentPaths.claude;

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

// 置顶字段迁移
try { db.exec('ALTER TABLE project_stats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE project_stats ADD COLUMN pin_order INTEGER NOT NULL DEFAULT 0'); } catch {}

// ---- 项目根目录 ----

db.exec(`
  CREATE TABLE IF NOT EXISTS project_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dir_path TEXT NOT NULL UNIQUE,
    label TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`);

// 启动时 seed 默认目录
{
  const rootCount = db.prepare('SELECT COUNT(*) AS cnt FROM project_roots').get().cnt;
  if (rootCount === 0) {
    const defaultDir = path.join(os.homedir(), 'projects');
    db.prepare('INSERT INTO project_roots (dir_path, label, sort_order, created_at) VALUES (?, ?, 0, ?)')
      .run(defaultDir, null, Date.now());
  }
}

function getProjectRoots() {
  return db.prepare('SELECT * FROM project_roots ORDER BY sort_order ASC').all();
}

// ---- 定时任务表 ----

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cron_expr TEXT,
    execution_mode TEXT NOT NULL DEFAULT 'new',
    resume_session_id TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    max_concurrency INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at INTEGER,
    finished_at INTEGER,
    exit_code INTEGER,
    log_path TEXT,
    error TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id, started_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_finished ON task_runs(finished_at)');

// 启动时清理孤儿运行记录
db.prepare("UPDATE task_runs SET status='failed', finished_at=?, error='Server restarted' WHERE status='running'").run(Date.now());

const cronJobs = new Map();          // taskId → cron.ScheduledTask
const runningTaskCounts = new Map(); // taskId → number
const logsBaseDir = path.join(os.homedir(), '.claude-dashboard', 'logs');
if (!fs.existsSync(logsBaseDir)) fs.mkdirSync(logsBaseDir, { recursive: true });

let projectsCache = null;
let projectsCacheTime = 0;
const CACHE_TTL = 5000;

function invalidateProjectsCache() {
  projectsCache = null;
  projectsCacheTime = 0;
}

// 监听多个项目根目录变更
let fsWatchers = [];
function setupFsWatchers() {
  fsWatchers.forEach(w => { try { w.close(); } catch {} });
  fsWatchers = [];
  for (const root of getProjectRoots()) {
    try { fsWatchers.push(fs.watch(root.dir_path, { persistent: false }, invalidateProjectsCache)); } catch {}
  }
}
setupFsWatchers();

function scanProjects() {
  const now = Date.now();
  if (projectsCache && now - projectsCacheTime < CACHE_TTL) return projectsCache;

  const roots = getProjectRoots();
  const statsRows = db.prepare('SELECT project_id, use_count, last_used_at, pinned, pin_order FROM project_stats').all();
  const statsMap = {};
  for (const row of statsRows) statsMap[row.project_id] = row;

  const projects = [];
  const hasMultiRoot = roots.length > 1;

  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root.dir_path, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const stats = statsMap[d.name] || {};
        projects.push({
          id: d.name,
          name: d.name,
          path: path.join(root.dir_path, d.name),
          root: root.dir_path,
          rootLabel: root.label || path.basename(root.dir_path),
          use_count: stats.use_count || 0,
          last_used_at: stats.last_used_at || 0,
          pinned: stats.pinned || 0,
          pin_order: stats.pin_order || 0,
        });
      }
    } catch {}
  }

  projects.sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned;
    if (a.pinned && b.pinned) return a.pin_order - b.pin_order;
    if (b.use_count !== a.use_count) return b.use_count - a.use_count;
    return a.name.localeCompare(b.name);
  });

  projectsCache = projects;
  projectsCacheTime = now;
  return projects;
}

function updateProjectUsage(projectId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO project_stats (project_id, use_count, last_used_at) VALUES (?, 1, ?)
    ON CONFLICT(project_id) DO UPDATE SET use_count = use_count + 1, last_used_at = ?
  `).run(projectId, now, now);
}

// ---- 定时任务调度器 ----

function executeTask(task) {
  const count = runningTaskCounts.get(task.id) || 0;
  if (task.max_concurrency > 0 && count >= task.max_concurrency) {
    console.log(`任务 ${task.name} 跳过：已达并发上限 (${count}/${task.max_concurrency})`);
    return { error: '已达并发上限' };
  }

  const runId = crypto.randomBytes(8).toString('hex');
  const logDir = path.join(logsBaseDir, task.id);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${runId}.log`);

  db.prepare('INSERT INTO task_runs (id, task_id, status, started_at, log_path) VALUES (?, ?, ?, ?, ?)')
    .run(runId, task.id, 'running', Date.now(), logPath);

  runningTaskCounts.set(task.id, count + 1);

  const resume = task.execution_mode === 'resume';
  // --print: non-interactive plain text output (no TUI, clean logs)
  // --dangerously-skip-permissions: unattended execution, no confirmation prompts
  const extraArgs = ['--print', '--dangerously-skip-permissions'];
  if (task.prompt) extraArgs.push(task.prompt);

  const result = createSession(task.project_id, 80, 24, resume, task.owner, extraArgs);
  if (!result || (typeof result === 'object' && result.error)) {
    const errMsg = (typeof result === 'object' && result.error) || '项目不存在';
    db.prepare("UPDATE task_runs SET status='failed', finished_at=?, error=? WHERE id=?")
      .run(Date.now(), errMsg, runId);
    runningTaskCounts.set(task.id, Math.max(0, count));
    return { error: errMsg };
  }

  const sessionId = result;
  const session = sessions.get(sessionId);

  db.prepare('UPDATE task_runs SET session_id=? WHERE id=?').run(sessionId, runId);

  // Attach log stream and task metadata to session
  session._logStream = fs.createWriteStream(logPath, { flags: 'a' });
  session._logStream.on('error', (err) => {
    console.error(`Log write error for task ${task.id}: ${err.message}`);
  });
  session._runId = runId;
  session._taskId = task.id;

  console.log(`任务 ${task.name} 执行中: run=${runId}, session=${sessionId}`);
  return { runId, sessionId };
}

function registerCronJobs() {
  // Stop all existing cron jobs
  for (const [, job] of cronJobs) job.stop();
  cronJobs.clear();

  const tasks = db.prepare("SELECT * FROM scheduled_tasks WHERE enabled=1 AND cron_expr IS NOT NULL").all();
  for (const task of tasks) {
    if (!cron.validate(task.cron_expr)) {
      console.log(`任务 ${task.name} cron 表达式无效: ${task.cron_expr}`);
      continue;
    }
    const job = cron.schedule(task.cron_expr, () => {
      console.log(`Cron 触发任务: ${task.name}`);
      // Re-read from DB to get latest state
      const latest = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND enabled=1').get(task.id);
      if (latest) executeTask(latest);
    });
    cronJobs.set(task.id, job);
  }
  console.log(`已注册 ${cronJobs.size} 个 cron 任务`);
}

// 日志清理：每 6 小时清理 7 天前的记录和文件
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const logCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const oldRuns = db.prepare('SELECT id, task_id, log_path FROM task_runs WHERE finished_at < ? AND finished_at IS NOT NULL').all(cutoff);
  for (const run of oldRuns) {
    if (run.log_path) try { fs.unlinkSync(run.log_path); } catch {}
  }
  db.prepare('DELETE FROM task_runs WHERE finished_at < ? AND finished_at IS NOT NULL').run(cutoff);
  if (oldRuns.length > 0) console.log(`清理了 ${oldRuns.length} 条过期任务运行记录`);
}, 6 * 60 * 60 * 1000);

// 获取项目列表
app.get('/api/projects', (req, res) => {
  res.json(scanProjects());
});

// Clone 项目
const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/).+/;

app.post('/api/clone', (req, res) => {
  const { url, rootId } = req.body;
  if (!url) return res.status(400).json({ error: '缺少 git 地址' });
  if (!gitUrlPattern.test(url)) {
    return res.status(400).json({ error: '无效的 git 地址' });
  }

  const roots = getProjectRoots();
  let targetDir;
  if (rootId) {
    const root = roots.find(r => r.id === rootId);
    if (!root) return res.status(400).json({ error: '项目目录不存在' });
    targetDir = root.dir_path;
  } else {
    targetDir = roots[0]?.dir_path;
    if (!targetDir) return res.status(400).json({ error: '未配置项目目录' });
  }

  execFile('git', ['clone', url], { cwd: targetDir, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: stderr || err.message });
    }
    invalidateProjectsCache();
    res.json({ success: true, output: stderr || stdout });
  });
});

// ---- 项目根目录管理 API ----

app.get('/api/settings/roots', (req, res) => {
  res.json(getProjectRoots());
});

app.post('/api/settings/roots', (req, res) => {
  let { dir_path, label } = req.body;
  if (!dir_path) return res.status(400).json({ error: '缺少路径' });
  // 展开 ~ 为 home 目录
  if (dir_path.startsWith('~')) dir_path = path.join(os.homedir(), dir_path.slice(1));
  dir_path = path.resolve(dir_path).replace(/\/+$/, '');
  try {
    if (!fs.existsSync(dir_path) || !fs.statSync(dir_path).isDirectory()) {
      return res.status(400).json({ error: '路径不存在或不是目录' });
    }
  } catch { return res.status(400).json({ error: '路径无法访问' }); }
  // 检查重复
  const existing = getProjectRoots();
  if (existing.some(r => r.dir_path === dir_path)) {
    return res.status(400).json({ error: '该目录已添加' });
  }
  const maxOrder = existing.reduce((m, r) => Math.max(m, r.sort_order), -1);
  db.prepare('INSERT INTO project_roots (dir_path, label, sort_order, created_at) VALUES (?, ?, ?, ?)')
    .run(dir_path, label || null, maxOrder + 1, Date.now());
  invalidateProjectsCache();
  setupFsWatchers();
  const row = db.prepare('SELECT * FROM project_roots WHERE dir_path = ?').get(dir_path);
  res.json(row);
});

app.delete('/api/settings/roots/:id', (req, res) => {
  const roots = getProjectRoots();
  if (roots.length <= 1) return res.status(400).json({ error: '至少保留一个项目目录' });
  db.prepare('DELETE FROM project_roots WHERE id = ?').run(req.params.id);
  invalidateProjectsCache();
  setupFsWatchers();
  res.json({ success: true });
});

// ---- 项目置顶 API ----

app.post('/api/projects/:id/pin', (req, res) => {
  const projectId = req.params.id;
  const { pinned } = req.body;
  const now = Date.now();
  if (pinned) {
    const maxPin = db.prepare('SELECT MAX(pin_order) AS m FROM project_stats WHERE pinned = 1').get().m || 0;
    db.prepare(`
      INSERT INTO project_stats (project_id, use_count, last_used_at, pinned, pin_order)
      VALUES (?, 0, 0, 1, ?)
      ON CONFLICT(project_id) DO UPDATE SET pinned = 1, pin_order = ?
    `).run(projectId, maxPin + 1, maxPin + 1);
  } else {
    db.prepare(`
      INSERT INTO project_stats (project_id, use_count, last_used_at, pinned, pin_order)
      VALUES (?, 0, 0, 0, 0)
      ON CONFLICT(project_id) DO UPDATE SET pinned = 0, pin_order = 0
    `).run(projectId);
  }
  invalidateProjectsCache();
  res.json({ success: true, pinned: !!pinned });
});

// ---- Worktree 检测 API ----

app.get('/api/projects/:id/worktrees', (req, res) => {
  const project = scanProjects().find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'],
      { cwd: project.path, encoding: 'utf8', timeout: 5000 });
    const worktrees = [];
    let current = {};
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5, 12);
      }
    }
    if (current.path) worktrees.push(current);
    // 主 worktree 标记为 main，其余为 extra
    const extras = worktrees
      .filter(w => w.path !== project.path)
      .map(w => ({ path: w.path, branch: w.branch, head: w.head, name: path.basename(w.path) }));
    res.json(extras);
  } catch {
    res.json([]);
  }
});

// ---- 进程池 ----

const sessions = new Map(); // sessionId -> { pty, buffer, projectId, owner, createdAt, lastActivity, attachedWs }
let shuttingDown = false;
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

// Strip ANSI/terminal escape sequences + control chars for clean log files
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')      // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[()][AB012]/g, '')               // charset switches
    .replace(/\x1b[>=<PNO]/g, '')                  // mode switches
    .replace(/\x1b\[[\?]?[0-9;]*[hlmsu]/g, '')    // private modes
    .replace(/\r(?!\n)/g, '')                       // bare CR (screen rewrite)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // control chars (keep \t \n \r)
    .replace(/\n{3,}/g, '\n\n');                    // collapse excessive blank lines
}

function createSession(projectId, cols, rows, resume, owner, extraArgs, agent) {
  agent = agent || 'claude';
  if (sessions.size >= MAX_SESSIONS_GLOBAL) return { error: '全局会话数已达上限' };
  let userCount = 0;
  for (const s of sessions.values()) { if (s.owner === owner) userCount++; }
  if (userCount >= MAX_SESSIONS_PER_USER) return { error: '个人会话数已达上限' };

  // 支持绝对路径（worktree 场景）
  let cwd;
  if (path.isAbsolute(projectId) && fs.existsSync(projectId)) {
    cwd = projectId;
  } else {
    const project = scanProjects().find(p => p.id === projectId);
    if (!project) return null;
    cwd = project.path;
  }

  const binPath = agentPaths[agent];
  if (!binPath) return { error: `${agent} 未安装或未找到` };

  const sessionId = generateSessionId();
  const env = { ...process.env };
  let args = [];

  if (agent === 'claude') {
    delete env.CLAUDECODE;
    if (resume) args.push('--resume');
  } else if (agent === 'codex') {
    args.push('--no-alt-screen');
    if (resume) args = ['resume', '--last', '--no-alt-screen'];
  }
  if (extraArgs) args.push(...extraArgs);

  const ptyProcess = pty.spawn(binPath, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env
  });

  const session = {
    pty: ptyProcess,
    buffer: '',
    projectId,
    agent,
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
    if (session._logStream) session._logStream.write(stripAnsi(data));
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (shuttingDown) return;
    // 完成任务运行记录
    if (session._runId) {
      if (session._logStream && !session._logStreamEnded) {
        session._logStreamEnded = true;
        try { session._logStream.end(); } catch {}
      }
      const finalStatus = (exitCode ?? 0) === 0 ? 'completed' : 'failed';
      db.prepare(`UPDATE task_runs SET status=?, finished_at=?, exit_code=? WHERE id=? AND status='running'`)
        .run(finalStatus, Date.now(), exitCode ?? 0, session._runId);
      const newCount = Math.max(0, (runningTaskCounts.get(session._taskId) || 1) - 1);
      if (newCount === 0) runningTaskCounts.delete(session._taskId);
      else runningTaskCounts.set(session._taskId, newCount);
    }
    if (session.attachedWs && session.attachedWs.readyState === WebSocket.OPEN) {
      session.attachedWs.send(JSON.stringify({ type: 'exit', sessionId }));
    } else {
      // 后台会话结束，通知同用户的所有连接
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client._user === session.owner) {
          client.send(JSON.stringify({
            type: 'notify',
            projectId,
            message: `${projectId} 的 ${agent} 会话已结束`
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
      if (session._logStream && !session._logStreamEnded) {
        session._logStreamEnded = true;
        try { session._logStream.end(); } catch {}
      }
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
      agent: session.agent || 'claude',
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
  // stale session — verify ownership before deleting
  const stale = db.prepare('SELECT owner FROM session_records WHERE session_id = ?').get(req.params.id);
  if (stale && stale.owner !== req.username) return res.status(403).json({ error: '无权操作此会话' });
  recordSessionEnd(req.params.id);
  res.json({ success: true });
});

// 可用 Agent 列表
app.get('/api/agents', (req, res) => {
  const agents = Object.entries(agentPaths)
    .filter(([, p]) => p)
    .map(([name, p]) => ({ name, path: p }));
  res.json(agents);
});

// 健康检查 API
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  // 磁盘用量（项目目录所在分区）
  let disk = null;
  try {
    const primaryDir = getProjectRoots()[0]?.dir_path || path.join(os.homedir(), 'projects');
    const df = execFileSync('df', ['-k', primaryDir], { encoding: 'utf8' });
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

// ---- 定时任务 API ----

app.use('/api/tasks', requireAuth);

// 任务列表
app.get('/api/tasks', (req, res) => {
  const tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE owner=? ORDER BY created_at DESC').all(req.username);
  // Batch fetch latest runs for all task IDs
  const taskIds = tasks.map(t => t.id);
  const latestRuns = new Map();
  if (taskIds.length > 0) {
    // SQLite doesn't have great batch support, but we can use a single query with GROUP BY
    const runs = db.prepare(`SELECT * FROM task_runs WHERE task_id IN (${taskIds.map(() => '?').join(',')}) AND started_at = (SELECT MAX(started_at) FROM task_runs tr2 WHERE tr2.task_id = task_runs.task_id)`).all(...taskIds);
    for (const r of runs) latestRuns.set(r.task_id, r);
  }
  const result = tasks.map(t => ({
    ...t,
    latestRun: latestRuns.get(t.id) || null,
    runningCount: runningTaskCounts.get(t.id) || 0
  }));
  res.json(result);
});

// 创建任务
const MAX_TOTAL_TASKS = parseInt(process.env.MAX_TOTAL_TASKS) || 50;
app.post('/api/tasks', (req, res) => {
  const taskCount = db.prepare('SELECT COUNT(*) AS cnt FROM scheduled_tasks').get().cnt;
  if (taskCount >= MAX_TOTAL_TASKS) return res.status(400).json({ error: `任务数已达上限 (${MAX_TOTAL_TASKS})` });
  const { name, project_id, prompt, cron_expr, execution_mode, max_concurrency } = req.body;
  if (!name || !project_id || !prompt) return res.status(400).json({ error: '名称、项目和 Prompt 不能为空' });
  if (cron_expr && !cron.validate(cron_expr)) return res.status(400).json({ error: 'Cron 表达式无效' });
  const project = scanProjects().find(p => p.id === project_id);
  if (!project) return res.status(400).json({ error: '项目不存在' });

  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  db.prepare(`INSERT INTO scheduled_tasks (id, name, project_id, owner, prompt, cron_expr, execution_mode, max_concurrency, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, project_id, req.username, prompt, cron_expr || null, execution_mode || 'new', max_concurrency ?? 1, now, now);
  registerCronJobs();
  res.json({ id });
});

// 编辑任务
app.put('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND owner=?').get(req.params.id, req.username);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const { name, project_id, prompt, cron_expr, execution_mode, max_concurrency, enabled } = req.body;
  if (cron_expr && !cron.validate(cron_expr)) return res.status(400).json({ error: 'Cron 表达式无效' });

  db.prepare(`UPDATE scheduled_tasks SET name=?, project_id=?, prompt=?, cron_expr=?, execution_mode=?, max_concurrency=?, enabled=?, updated_at=? WHERE id=?`)
    .run(
      name ?? task.name, project_id ?? task.project_id, prompt ?? task.prompt,
      cron_expr !== undefined ? (cron_expr || null) : task.cron_expr,
      execution_mode ?? task.execution_mode, max_concurrency ?? task.max_concurrency,
      enabled !== undefined ? (enabled ? 1 : 0) : task.enabled, Date.now(), req.params.id
    );
  registerCronJobs();
  res.json({ success: true });
});

// 删除任务
app.delete('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND owner=?').get(req.params.id, req.username);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  // Stop cron job
  const job = cronJobs.get(req.params.id);
  if (job) { job.stop(); cronJobs.delete(req.params.id); }

  // Kill running sessions for this task
  const runningRuns = db.prepare("SELECT session_id FROM task_runs WHERE task_id=? AND status='running'").all(req.params.id);
  for (const run of runningRuns) {
    if (run.session_id) {
      const s = sessions.get(run.session_id);
      if (s) {
        s._runId = null; // prevent onExit from writing to deleted records
        if (s._logStream && !s._logStreamEnded) {
          s._logStreamEnded = true;
          try { s._logStream.end(); } catch {}
        }
        killPty(s.pty);
      }
    }
  }

  // Clean up logs
  const logDir = path.join(logsBaseDir, req.params.id);
  if (!logDir.startsWith(logsBaseDir)) return res.status(400).json({ error: '非法日志路径' });
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch {}

  db.prepare('DELETE FROM task_runs WHERE task_id=?').run(req.params.id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(req.params.id);
  runningTaskCounts.delete(req.params.id);
  res.json({ success: true });
});

// 手动触发任务
const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS) || 3;
app.post('/api/tasks/:id/trigger', (req, res) => {
  let totalRunning = 0;
  for (const c of runningTaskCounts.values()) totalRunning += c;
  if (totalRunning >= MAX_CONCURRENT_RUNS) return res.status(400).json({ error: `并发运行数已达上限 (${MAX_CONCURRENT_RUNS})` });
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND owner=?').get(req.params.id, req.username);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const result = executeTask(task);
  if (!result || result.error) {
    return res.status(400).json({ error: result ? result.error : '执行失败' });
  }
  res.json({ runId: result.runId, sessionId: result.sessionId });
});

// 取消任务运行（kill PTY）
app.post('/api/tasks/:id/cancel', (req, res) => {
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND owner=?').get(req.params.id, req.username);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const runningRuns = db.prepare("SELECT * FROM task_runs WHERE task_id=? AND status='running'").all(req.params.id);
  for (const run of runningRuns) {
    if (run.session_id) {
      const session = sessions.get(run.session_id);
      if (session) {
        session._runId = null; // prevent onExit from interfering
        if (session._logStream && !session._logStreamEnded) {
          session._logStreamEnded = true;
          try { session._logStream.end(); } catch {}
        }
        killPty(session.pty);
      }
    }
    db.prepare("UPDATE task_runs SET status='cancelled', finished_at=? WHERE id=?").run(Date.now(), run.id);
  }
  runningTaskCounts.set(req.params.id, 0);
  res.json({ success: true });
});

// 运行历史
app.get('/api/tasks/:id/runs', (req, res) => {
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND owner=?').get(req.params.id, req.username);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const runs = db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT ? OFFSET ?').all(req.params.id, limit, offset);
  res.json(runs);
});

// 删除运行记录和日志
app.delete('/api/tasks/runs/:runId', (req, res) => {
  const run = db.prepare('SELECT tr.*, st.owner FROM task_runs tr JOIN scheduled_tasks st ON tr.task_id=st.id WHERE tr.id=?').get(req.params.runId);
  if (!run || run.owner !== req.username) return res.status(404).json({ error: '记录不存在' });
  if (run.status === 'running') return res.status(400).json({ error: '无法删除运行中的记录' });
  if (run.log_path && !run.log_path.startsWith(logsBaseDir)) return res.status(400).json({ error: '非法日志路径' });
  if (run.log_path) { try { fs.unlinkSync(run.log_path); } catch {} }
  db.prepare('DELETE FROM task_runs WHERE id=?').run(req.params.runId);
  res.json({ success: true });
});

// 读取运行日志（tail 100KB）
app.get('/api/tasks/runs/:runId/log', (req, res) => {
  const run = db.prepare('SELECT tr.*, st.owner FROM task_runs tr JOIN scheduled_tasks st ON tr.task_id=st.id WHERE tr.id=?').get(req.params.runId);
  if (!run || run.owner !== req.username) return res.status(404).json({ error: '记录不存在' });
  if (run.log_path && !run.log_path.startsWith(logsBaseDir)) return res.status(400).json({ error: '非法日志路径' });
  if (!run.log_path || !fs.existsSync(run.log_path)) return res.json({ log: '' });

  const stat = fs.statSync(run.log_path);
  const maxBytes = 100 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const stream = fs.createReadStream(run.log_path, { start, encoding: 'utf8' });
  let content = '';
  stream.on('data', chunk => { content += chunk; });
  stream.on('end', () => res.json({ log: content, truncated: start > 0, totalSize: stat.size }));
  stream.on('error', () => res.json({ log: '' }));
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
      const result = createSession(msg.cwd || msg.projectId, msg.cols, msg.rows, msg.resume, username, null, msg.agent);
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
      const startedSession = sessions.get(sessionId);
      ws.send(JSON.stringify({ type: 'started', sessionId, createdAt: startedSession.createdAt, projectId: msg.projectId, agent: startedSession ? startedSession.agent : 'claude' }));

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
      ws.send(JSON.stringify({ type: 'attached', sessionId: msg.sessionId, createdAt: session.createdAt, projectId: session.projectId, agent: session.agent || 'claude' }));

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

// 启动时注册 cron 任务
registerCronJobs();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
    for (const [cmd, p] of Object.entries(agentPaths)) {
      console.log(`${cmd}: ${p || '(not found)'}`);
    }
  });
}

// 优雅停机
// 注意：此处有意不调 recordSessionEnd，让 active 记录保留。
// 下次启动时 session_records 中残留的 active 会被标记为 stale，用户可通过 resume 恢复。
function shutdown() {
  shuttingDown = true;
  console.log('收到停机信号，清理会话...');
  // 停止所有 cron jobs
  for (const [, job] of cronJobs) job.stop();
  cronJobs.clear();
  if (logCleanupTimer) clearInterval(logCleanupTimer);
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

module.exports = { app, server, db, sessions, idleCleanupTimer, hashPassword, cronJobs, runningTaskCounts };
