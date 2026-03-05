const express = require('express');
const { execFileSync, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// 自动检测 claude 路径
let claudePath;
try {
  claudePath = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
} catch {
  claudePath = '/opt/homebrew/bin/claude';
}

// 使用统计文件
const statsPath = path.join(__dirname, 'projects.json');

function loadStats() {
  try {
    if (fs.existsSync(statsPath)) {
      return JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    }
  } catch {}
  return {};
}

function saveStats(stats) {
  try {
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
  } catch {}
}

// 扫描 ~/projects/ 下的首层目录
const projectsDir = path.join(os.homedir(), 'projects');

function scanProjects() {
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const stats = loadStats();

    const projects = entries
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => ({
        id: d.name,
        name: d.name,
        path: path.join(projectsDir, d.name),
        use_count: (stats[d.name] && stats[d.name].use_count) || 0,
        last_used_at: (stats[d.name] && stats[d.name].last_used_at) || 0
      }));

    projects.sort((a, b) => {
      if (b.use_count !== a.use_count) return b.use_count - a.use_count;
      return a.name.localeCompare(b.name);
    });

    return projects;
  } catch {
    return [];
  }
}

function updateProjectUsage(projectId) {
  const stats = loadStats();
  if (!stats[projectId]) stats[projectId] = {};
  stats[projectId].use_count = (stats[projectId].use_count || 0) + 1;
  stats[projectId].last_used_at = Math.floor(Date.now() / 1000);
  saveStats(stats);
}

// 获取项目列表
app.get('/api/projects', (req, res) => {
  res.json(scanProjects());
});

// Clone 项目
const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/).+\.git\/?$/;

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

const sessions = new Map(); // sessionId -> { pty, buffer, projectId, createdAt, lastActivity, attachedWs }
const BUFFER_MAX = 200000; // 输出缓冲区最大字符数（约 200KB）
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟空闲清理

function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function killPty(p) {
  if (!p) return;
  try { p.kill(); } catch {}
}

function createSession(projectId, cols, rows, resume) {
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
    createdAt: Date.now(),
    lastActivity: Date.now(),
    attachedWs: null
  };

  ptyProcess.onData((data) => {
    session.lastActivity = Date.now();
    // 写入缓冲区
    session.buffer += data;
    if (session.buffer.length > BUFFER_MAX) {
      session.buffer = session.buffer.slice(-BUFFER_MAX);
    }
    // 转发给已连接的 WebSocket
    if (session.attachedWs && session.attachedWs.readyState === WebSocket.OPEN) {
      session.attachedWs.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ptyProcess.onExit(() => {
    if (session.attachedWs && session.attachedWs.readyState === WebSocket.OPEN) {
      session.attachedWs.send(JSON.stringify({ type: 'exit', sessionId }));
    }
    updateProjectUsage(projectId);
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, session);
  return sessionId;
}

function attachSession(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // 解除旧连接
  if (session.attachedWs && session.attachedWs !== ws) {
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

// 空闲清理定时器
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session.attachedWs && now - session.lastActivity > IDLE_TIMEOUT) {
      console.log(`清理空闲会话: ${id} (项目: ${session.projectId})`);
      killPty(session.pty);
      sessions.delete(id);
    }
  }
}, 60000);

// 会话列表 API
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id,
      projectId: session.projectId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      attached: !!session.attachedWs
    });
  }
  res.json(list);
});

// 创建 HTTP 服务器并绑定 WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let currentSessionId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'start') {
      // 新建会话（支持 resume）
      const sessionId = createSession(msg.projectId, msg.cols, msg.rows, msg.resume);
      if (!sessionId) {
        ws.send(JSON.stringify({ type: 'error', data: '项目不存在' }));
        return;
      }
      // 解除之前的会话
      if (currentSessionId) detachSession(currentSessionId);
      currentSessionId = sessionId;
      attachSession(sessionId, ws);
      ws.send(JSON.stringify({ type: 'started', sessionId }));

    } else if (msg.type === 'attach') {
      // 重连已有会话
      const session = sessions.get(msg.sessionId);
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', data: '会话不存在或已过期' }));
        return;
      }
      if (currentSessionId) detachSession(currentSessionId);
      currentSessionId = msg.sessionId;
      attachSession(msg.sessionId, ws);
      // 回放缓冲区
      if (session.buffer) {
        ws.send(JSON.stringify({ type: 'replay', data: session.buffer }));
      }
      ws.send(JSON.stringify({ type: 'attached', sessionId: msg.sessionId }));

    } else if (msg.type === 'input') {
      const session = currentSessionId && sessions.get(currentSessionId);
      if (session) session.pty.write(msg.data);

    } else if (msg.type === 'resize') {
      const session = currentSessionId && sessions.get(currentSessionId);
      if (session) session.pty.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    // 只解除绑定，不杀进程
    if (currentSessionId) {
      detachSession(currentSessionId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  console.log(`Claude path: ${claudePath}`);
});
