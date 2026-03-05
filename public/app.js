let currentProject = null;
let ws = null;
let term = null;
let fitAddon = null;

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
    wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
}

// ---- WebSocket ----

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
        document.getElementById('reconnectBtn').style.display = 'none';
        if (currentProject) {
            startSession(currentProject.id);
        }
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
            term.write(msg.data);
        } else if (msg.type === 'exit') {
            term.writeln('\r\n\x1b[90m--- 会话已结束 ---\x1b[0m');
            document.getElementById('reconnectBtn').style.display = '';
        } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31m${msg.data}\x1b[0m`);
        }
    };

    ws.onclose = () => {
        document.getElementById('reconnectBtn').style.display = currentProject ? '' : 'none';
    };
}

function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function startSession(projectId) {
    term.clear();
    // 等布局完成后再计算终端尺寸
    setTimeout(() => {
        doFit();
        wsSend({ type: 'start', projectId, cols: term.cols, rows: term.rows });
    }, 50);
}

function reconnect() {
    if (!currentProject) return;
    document.getElementById('reconnectBtn').style.display = 'none';
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
    } else {
        startSession(currentProject.id);
    }
}

// ---- 项目列表 ----

async function loadProjects() {
    const response = await fetch('/api/projects');
    const projects = await response.json();

    const list = document.getElementById('projectList');

    if (projects.length === 0) {
        list.innerHTML = '<div style="color:#666;text-align:center;padding:20px;font-size:12px;">~/projects/ 下无项目目录</div>';
        return;
    }

    list.innerHTML = projects.map(p => `
        <div class="project-item ${currentProject && currentProject.id === p.id ? 'active' : ''}"
             onclick="selectProject('${p.id}')">
            <div class="project-name">${p.name}</div>
            <div class="project-desc">${p.path}</div>
        </div>
    `).join('');
}

// ---- 项目选择 ----

async function selectProject(projectId) {
    const response = await fetch('/api/projects');
    const projects = await response.json();
    currentProject = projects.find(p => p.id === projectId);
    if (!currentProject) return;

    document.getElementById('projectTitle').textContent = currentProject.name;
    document.getElementById('headerProjectPath').textContent = currentProject.path;

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    document.getElementById('reconnectBtn').style.display = 'none';

    loadProjects();

    if (ws && ws.readyState === WebSocket.OPEN) {
        startSession(projectId);
    } else {
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
