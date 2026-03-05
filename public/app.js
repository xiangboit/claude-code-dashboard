let currentProject = null;
let currentSessionId = null;
let sessionEnded = false; // 标记会话已结束，阻止自动重启
let ws = null;
let term = null;
let fitAddon = null;
let lastCols = 0;
let lastRows = 0;
let projectsCache = [];
let sessionsCache = [];

// ---- UI 辅助 ----

function showSessionActions() {
    document.getElementById('sessionActions').style.display = 'flex';
}

function hideSessionActions() {
    document.getElementById('sessionActions').style.display = 'none';
}

// ---- 终端 ----

function initTerminal() {
    term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Monaco, Menlo, "Courier New", monospace',
        theme: {
            background: '#1a1a1a',
            foreground: '#e0e0e0',
            cursor: '#e0e0e0',
            selectionBackground: '#3a5a8a'
        },
        allowProposedApi: true
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    term.open(document.getElementById('terminal'));

    term.onData((data) => {
        wsSend({ type: 'input', data });
    });

    window.addEventListener('resize', doFit);
}

function doFit() {
    const wrapper = document.getElementById('terminalWrapper');
    if (!wrapper.classList.contains('active')) return;

    const rect = wrapper.getBoundingClientRect();
    const termEl = document.getElementById('terminal');
    termEl.style.width = rect.width + 'px';
    termEl.style.height = rect.height + 'px';

    fitAddon.fit();

    if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
    }
}

// ---- WebSocket ----

let reconnectTimer = null;

function connectWebSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
        // WebSocket 重连后：恢复活跃会话，但不自动新建
        if (currentSessionId) {
            attachSession(currentSessionId);
        }
        // sessionEnded=true 或无 currentProject 时不做任何事，等用户点按钮
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
            term.write(msg.data);
        } else if (msg.type === 'replay') {
            term.write(msg.data);
        } else if (msg.type === 'started') {
            currentSessionId = msg.sessionId;
            sessionEnded = false;
            hideSessionActions();
            loadSessions();
        } else if (msg.type === 'attached') {
            currentSessionId = msg.sessionId;
            sessionEnded = false;
            hideSessionActions();
        } else if (msg.type === 'detached') {
            term.writeln('\r\n\x1b[33m--- 会话已被其他连接接管 ---\x1b[0m');
        } else if (msg.type === 'exit') {
            term.writeln('\r\n\x1b[90m--- 会话已结束 ---\x1b[0m');
            currentSessionId = null;
            sessionEnded = true;
            showSessionActions();
            loadSessions();
        } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31m${msg.data}\x1b[0m`);
        }
    };

    ws.onclose = () => {
        reconnectTimer = setTimeout(connectWebSocket, 3000);
    };
}

function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function startNewSession(projectId, resume) {
    term.clear();
    currentSessionId = null;
    sessionEnded = false;
    hideSessionActions();
    setTimeout(() => {
        doFit();
        wsSend({ type: 'start', projectId, resume: !!resume, cols: term.cols, rows: term.rows });
    }, 50);
}

function attachSession(sessionId) {
    term.clear();
    setTimeout(() => {
        doFit();
        wsSend({ type: 'attach', sessionId });
    }, 50);
}

function reconnect(resume) {
    if (!currentProject) return;
    hideSessionActions();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        // 先标记意图，等 ws.onopen 后执行
        sessionEnded = false;
        connectWebSocket();
        // onopen 里没有自动逻辑了，需要手动触发
        const origOnOpen = ws.onopen;
        ws.onopen = () => {
            origOnOpen();
            startNewSession(currentProject.id, resume);
        };
    } else {
        startNewSession(currentProject.id, resume);
    }
}

// ---- 会话列表 ----

async function loadSessions() {
    try {
        const res = await fetch('/api/sessions');
        sessionsCache = await res.json();
    } catch {
        sessionsCache = [];
    }
    renderProjects();
}

function getProjectSession(projectId) {
    return sessionsCache.find(s => s.projectId === projectId);
}

// ---- 项目列表 ----

async function loadProjects() {
    const response = await fetch('/api/projects');
    projectsCache = await response.json();
    await loadSessions();
}

function renderProjects() {
    const list = document.getElementById('projectList');

    if (projectsCache.length === 0) {
        list.innerHTML = '<div style="color:#666;text-align:center;padding:20px;font-size:12px;">~/projects/ 下无项目目录</div>';
        return;
    }

    list.innerHTML = projectsCache.map(p => {
        const session = getProjectSession(p.id);
        const isActive = currentProject && currentProject.id === p.id;
        const hasSession = !!session;
        return `
        <div class="project-item ${isActive ? 'active' : ''}"
             onclick="selectProject('${p.id}')">
            <div class="project-name">
                ${hasSession ? '<span class="session-dot"></span>' : ''}${p.name}
            </div>
            <div class="project-desc">${p.path}</div>
        </div>`;
    }).join('');
}

// ---- 项目选择 ----

async function selectProject(projectId) {
    if (projectsCache.length === 0) await loadProjects();
    currentProject = projectsCache.find(p => p.id === projectId);
    if (!currentProject) return;

    document.getElementById('projectTitle').textContent = currentProject.name;
    document.getElementById('headerProjectPath').textContent = currentProject.path;

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    hideSessionActions();
    sessionEnded = false;

    renderProjects();

    // 查找该项目的已有会话
    const existingSession = getProjectSession(projectId);

    if (ws && ws.readyState === WebSocket.OPEN) {
        if (existingSession) {
            attachSession(existingSession.id);
        } else {
            startNewSession(projectId);
        }
    } else {
        currentSessionId = existingSession ? existingSession.id : null;
        connectWebSocket();
    }

    term.focus();
}

// ---- Clone ----

async function cloneRepo() {
    const input = document.getElementById('cloneInput');
    const status = document.getElementById('cloneStatus');
    const url = input.value.trim();
    if (!url) return;

    status.style.color = '#4a90e2';
    status.textContent = 'Cloning...';
    input.disabled = true;

    try {
        const res = await fetch('/api/clone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.success) {
            status.style.color = '#4caf50';
            status.textContent = 'Done';
            input.value = '';
            loadProjects();
        } else {
            status.style.color = '#ff6b6b';
            status.textContent = data.error;
        }
    } catch (e) {
        status.style.color = '#ff6b6b';
        status.textContent = e.message;
    }
    input.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 5000);
}

// ---- 初始化 ----

initTerminal();
loadProjects();
connectWebSocket();
