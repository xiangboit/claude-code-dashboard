const express = require('express');
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
app.post('/api/clone', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '缺少 git 地址' });

  const { execFile } = require('child_process');
  execFile('git', ['clone', url], { cwd: projectsDir, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: stderr || err.message });
    }
    res.json({ success: true, output: stderr || stdout });
  });
});

// 创建 HTTP 服务器并绑定 WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let ptyProcess = null;
  let currentProjectId = null;

  function startSession(projectId, cols, rows) {
    // 关闭已有进程
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }

    const project = scanProjects().find(p => p.id === projectId);
    if (!project) {
      ws.send(JSON.stringify({ type: 'error', data: '项目不存在' }));
      return;
    }

    currentProjectId = projectId;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    ptyProcess = pty.spawn('/opt/homebrew/bin/claude', [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: project.path,
      env
    });

    ptyProcess.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    ptyProcess.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit' }));
      }
      if (currentProjectId) {
        updateProjectUsage(currentProjectId);
      }
      ptyProcess = null;
    });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'start') {
      startSession(msg.projectId, msg.cols, msg.rows);
    } else if (msg.type === 'input') {
      if (ptyProcess) ptyProcess.write(msg.data);
    } else if (msg.type === 'resize') {
      if (ptyProcess) ptyProcess.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
});
