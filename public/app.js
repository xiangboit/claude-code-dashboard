let currentProject = null;
let currentSessionId = null;
let ws = null;
let term = null;
let fitAddon = null;
let lastCols = 0;
let lastRows = 0;
let projectsCache = [];
let sessionsCache = [];
let pendingAction = null;
let projectSearchQuery = '';
let termFontSize = parseInt(localStorage.getItem('termFontSize')) || (window.innerWidth <= 768 ? 12 : 14);
let idleWarningTimer = null;
let authToken = localStorage.getItem('authToken') || '';
let currentUser = localStorage.getItem('currentUser') || '';

// ---- 粒子 & 状态栏状态 ----
let particlesEnabled = localStorage.getItem('particlesEnabled') !== 'false';
let sessionCreatedAt = null;
let timerInterval = null;
let particleAnimId = null;
let particles = [];
let activityTimeout = null;
const PARTICLE_COUNT = window.innerWidth <= 768 ? 25 : 50;
const STATUS_BAR_HEIGHT = 24;

// ---- 主题切换 ----

function getThemeColor(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'light' ? null : 'light';
    if (next) {
        html.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
    } else {
        html.removeAttribute('data-theme');
        localStorage.removeItem('theme');
    }
    updateThemeIcon();
}

function updateThemeIcon() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const icon = isLight ? '\u2600\uFE0F' : '\uD83C\uDF19';
    const sidebarBtn = document.getElementById('sidebarThemeToggle');
    const loginBtn = document.getElementById('loginThemeToggle');
    if (sidebarBtn) sidebarBtn.textContent = icon;
    if (loginBtn) loginBtn.textContent = icon;
}

// 初始化图标
updateThemeIcon();

// ---- 认证 ----

function authHeaders() {
    return authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
}

async function authFetch(url, opts = {}) {
    opts.headers = { ...opts.headers, ...authHeaders() };
    const res = await fetch(url, opts);
    if (res.status === 401) {
        authToken = '';
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        showLogin(true); // 能收到 401 说明服务在线且有用户，显示登录页
        throw new Error('未登录');
    }
    return res;
}

let authRetryCount = 0;
const AUTH_MAX_RETRIES = 5;

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/status', { headers: authHeaders() });
        const data = await res.json();
        authRetryCount = 0;
        if (data.loggedIn) {
            currentUser = data.username;
            showApp();
        } else {
            showLogin(data.hasUsers);
        }
    } catch {
        // 服务不可达时：有 token 则重试等待服务恢复，否则直接显示登录
        if (authToken && authRetryCount < AUTH_MAX_RETRIES) {
            authRetryCount++;
            const delay = Math.min(1000 * authRetryCount, 5000);
            showLoginMessage('正在连接服务...');
            setTimeout(checkAuth, delay);
        } else {
            authRetryCount = 0;
            showLogin(true); // 默认显示登录页而非注册页
        }
    }
}

function showLoginMessage(msg) {
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('appMain').style.display = 'none';
    document.getElementById('loginError').textContent = msg;
    document.getElementById('loginError').style.color = 'var(--c-text-muted)';
}

function showLogin(hasUsers) {
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('appMain').style.display = 'none';
    const title = document.getElementById('loginTitle');
    const submitBtn = document.getElementById('loginSubmit');
    if (!hasUsers) {
        title.textContent = '创建账户';
        submitBtn.textContent = '注册';
        submitBtn.onclick = () => doAuth('/api/register');
    } else {
        title.textContent = '登录';
        submitBtn.textContent = '登录';
        submitBtn.onclick = () => doAuth('/api/login');
    }
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    errEl.style.color = 'var(--c-red)';
}

function showApp() {
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('appMain').style.display = 'flex';
    document.getElementById('currentUserLabel').textContent = currentUser;
    // Restore sidebar collapsed state
    if (localStorage.getItem('sidebarCollapsed') === 'true' && window.innerWidth > 768) {
        document.getElementById('sidebar').classList.add('collapsed');
    }
    initApp();
}

async function doAuth(endpoint) {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    if (!username || !password) { errorEl.textContent = '请填写用户名和密码'; return; }
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
            authToken = data.token;
            currentUser = data.username;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', currentUser);
            showApp();
        } else {
            errorEl.textContent = data.error;
        }
    } catch (e) {
        errorEl.textContent = e.message;
    }
}

// ---- 用户菜单 & 修改密码 ----

function toggleUserMenu() {
    const menu = document.getElementById('userMenu');
    menu.classList.toggle('open');
}

// 点击其他区域关闭弹出层
document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-info')) {
        const menu = document.getElementById('userMenu');
        if (menu) menu.classList.remove('open');
    }
    if (!e.target.closest('.header-project-selector')) {
        const pd = document.getElementById('projectDropdown');
        if (pd) pd.classList.remove('open');
    }
});

function showChangePassword() {
    document.getElementById('userMenu').classList.remove('open');
    document.getElementById('changePwdModal').classList.add('open');
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('changePwdError').textContent = '';
    document.getElementById('oldPassword').focus();
}

function closeChangePassword() {
    document.getElementById('changePwdModal').classList.remove('open');
}

async function doChangePassword() {
    const oldPwd = document.getElementById('oldPassword').value;
    const newPwd = document.getElementById('newPassword').value;
    const confirmPwd = document.getElementById('confirmPassword').value;
    const errorEl = document.getElementById('changePwdError');

    if (!oldPwd || !newPwd) { errorEl.textContent = '请填写所有字段'; return; }
    if (newPwd.length < 4) { errorEl.textContent = '新密码至少4位'; return; }
    if (newPwd !== confirmPwd) { errorEl.textContent = '两次密码不一致'; return; }

    try {
        const res = await authFetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd })
        });
        const data = await res.json();
        if (res.ok) {
            closeChangePassword();
            showToast('密码修改成功');
        } else {
            errorEl.textContent = data.error;
        }
    } catch (e) {
        errorEl.textContent = e.message;
    }
}

function logout() {
    if (!confirm('确定退出登录？')) return;
    authToken = '';
    currentUser = '';
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
        ws.onclose = null; // 阻止触发自动重连
        ws.close();
        ws = null;
    }
    appInitialized = false;
    showLogin(true);
}

// ---- UI 辅助 ----

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showSessionActions() {
    document.getElementById('sessionActions').style.display = 'flex';
}

function hideSessionActions() {
    document.getElementById('sessionActions').style.display = 'none';
}

function formatTime(ts) {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    const d = new Date(ts);
    if (diff < 172800000) return `昨天 ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// ---- Toast 通知 ----

function showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ---- 终端状态栏 ----

function showTerminalStatusBar(projectName, createdAt) {
    sessionCreatedAt = createdAt;
    document.getElementById('tsbProject').textContent = projectName;
    document.getElementById('tsbActivityDot').classList.remove('idle');
    document.getElementById('terminalStatusBar').classList.add('visible');
    startTimer();
    requestAnimationFrame(() => doFit());
}

function hideTerminalStatusBar() {
    document.getElementById('terminalStatusBar').classList.remove('visible');
    stopTimer();
    sessionCreatedAt = null;
    requestAnimationFrame(() => doFit());
}

function startTimer() {
    stopTimer();
    updateTimerDisplay();
    timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimerDisplay() {
    if (!sessionCreatedAt) return;
    const elapsed = Math.floor((Date.now() - sessionCreatedAt) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const el = document.getElementById('tsbTimer');
    if (el) el.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function setActivityIdle(idle) {
    const dot = document.getElementById('tsbActivityDot');
    if (dot) dot.classList.toggle('idle', idle);
}

// ---- 粒子系统 ----

function createParticle(w, h) {
    return {
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 1.5 + 0.5,
        baseAlpha: Math.random() * 0.3 + 0.1, alphaRange: Math.random() * 0.15 + 0.05,
        phase: Math.random() * Math.PI * 2, phaseSpeed: Math.random() * 0.01 + 0.005
    };
}

function initParticles() {
    if (!particlesEnabled) return;
    const canvas = document.getElementById('particleCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let width, height;
    function resize() {
        const rect = canvas.parentElement.getBoundingClientRect();
        width = canvas.width = rect.width;
        height = canvas.height = rect.height;
    }
    let resizeTimer = null;
    function debouncedResize() { if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 100); }
    resize();
    window.addEventListener('resize', debouncedResize);
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(createParticle(width, height));

    const isLight = () => document.documentElement.getAttribute('data-theme') === 'light';

    function animate() {
        if (!particlesEnabled) { particleAnimId = null; return; }
        if (document.hidden) { particleAnimId = requestAnimationFrame(animate); return; }
        ctx.clearRect(0, 0, width, height);
        const light = isLight();
        const r = light ? 58 : 120, g = light ? 123 : 200, b = light ? 213 : 255;
        for (const p of particles) {
            p.x += p.vx; p.y += p.vy;
            if (p.x < -10) p.x = width + 10; if (p.x > width + 10) p.x = -10;
            if (p.y < -10) p.y = height + 10; if (p.y > height + 10) p.y = -10;
            p.phase += p.phaseSpeed;
            const alpha = p.baseAlpha + Math.sin(p.phase) * p.alphaRange;
            const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 3);
            grad.addColorStop(0, `rgba(${r},${g},${b},${alpha * 0.5})`);
            grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
            ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * 3, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
            ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`; ctx.fill();
        }
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - dist / 120) * 0.08})`; ctx.lineWidth = 0.5; ctx.stroke();
                }
            }
        }
        particleAnimId = requestAnimationFrame(animate);
    }
    particleAnimId = requestAnimationFrame(animate);
}

function toggleParticles() {
    particlesEnabled = !particlesEnabled;
    localStorage.setItem('particlesEnabled', particlesEnabled);
    const canvas = document.getElementById('particleCanvas');
    const btn = document.getElementById('tsbToggleFx');
    if (particlesEnabled) {
        canvas.classList.remove('hidden'); btn.classList.remove('off');
        if (!particleAnimId) initParticles();
    } else {
        canvas.classList.add('hidden'); btn.classList.add('off');
        if (particleAnimId) { cancelAnimationFrame(particleAnimId); particleAnimId = null; }
    }
}

// ---- 终端 ----

function changeFontSize(delta) {
    termFontSize = Math.max(10, Math.min(22, termFontSize + delta));
    localStorage.setItem('termFontSize', termFontSize);
    if (term) {
        term.options.fontSize = termFontSize;
        setTimeout(doFit, 50);
    }
}

function initTerminal() {
    term = new Terminal({
        cursorBlink: true,
        fontSize: termFontSize,
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

    let inputBuffer = '';
    let inputTimer = null;
    const INPUT_FLUSH_DELAY = 40; // ms

    function flushInput() {
        if (inputBuffer) {
            wsSend({ type: 'input', data: inputBuffer });
            inputBuffer = '';
        }
        if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    }

    term.onData((data) => {
        resetIdleWarning();
        inputBuffer += data;
        // 控制字符（回车、Ctrl+C 等）或转义序列（方向键等）立即发送
        if (data.length > 1 || data.charCodeAt(0) < 32 || data.charCodeAt(0) === 127) {
            flushInput();
        } else {
            if (inputTimer) clearTimeout(inputTimer);
            inputTimer = setTimeout(flushInput, INPUT_FLUSH_DELAY);
        }
    });

    window.addEventListener('resize', doFit);
}

function doFit() {
    const wrapper = document.getElementById('terminalWrapper');
    if (!wrapper.classList.contains('active')) return;

    const rect = wrapper.getBoundingClientRect();
    const termEl = document.getElementById('terminal');
    const statusBar = document.getElementById('terminalStatusBar');
    const barHeight = statusBar && statusBar.classList.contains('visible') ? STATUS_BAR_HEIGHT : 0;
    termEl.style.width = rect.width + 'px';
    termEl.style.height = (rect.height - barHeight) + 'px';

    fitAddon.fit();

    if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
    }
}

// ---- WebSocket ----

let reconnectTimer = null;
let reconnectDelay = 3000;
const RECONNECT_MAX_DELAY = 30000;

function connectWebSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}?token=${encodeURIComponent(authToken)}`);

    ws.onopen = () => {
        reconnectDelay = 3000;
        const banner = document.getElementById('reconnectBanner');
        if (banner) banner.classList.remove('active');
        // 执行 pending action（如 reconnect 触发的新建会话）
        if (pendingAction) {
            const action = pendingAction;
            pendingAction = null;
            action();
        } else if (currentSessionId) {
            attachSession(currentSessionId);
        }
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
            term.write(msg.data);
            setActivityIdle(false);
            if (activityTimeout) clearTimeout(activityTimeout);
            activityTimeout = setTimeout(() => setActivityIdle(true), 5000);
        } else if (msg.type === 'replay') {
            term.write(msg.data);
        } else if (msg.type === 'started') {
            currentSessionId = msg.sessionId;
            hideSessionActions();
            document.getElementById('killBtn').style.display = '';
            document.getElementById('fontSizeControls').style.display = '';
            document.getElementById('newSessionBtn').style.display = '';
            resetIdleWarning();
            loadSessions();
            showTerminalStatusBar(currentProject ? currentProject.name : (msg.projectId || ''), msg.createdAt || Date.now());
        } else if (msg.type === 'attached') {
            currentSessionId = msg.sessionId;
            hideSessionActions();
            document.getElementById('killBtn').style.display = '';
            document.getElementById('fontSizeControls').style.display = '';
            document.getElementById('newSessionBtn').style.display = '';
            resetIdleWarning();
            loadSessions();
            showTerminalStatusBar(currentProject ? currentProject.name : (msg.projectId || ''), msg.createdAt || Date.now());
        } else if (msg.type === 'detached') {
            term.writeln('\r\n\x1b[33m--- 会话已被其他连接接管 ---\x1b[0m');
        } else if (msg.type === 'exit') {
            currentSessionId = null;
            document.getElementById('killBtn').style.display = 'none';
            document.getElementById('fontSizeControls').style.display = 'none';
            clearIdleWarning();
            showSessionActions();
            hideTerminalStatusBar();
            loadSessions().then(() => showDashboardPanel());
        } else if (msg.type === 'notify') {
            showToast(msg.message);
            loadSessions();
        } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31m${msg.data}\x1b[0m`);
        }
    };

    ws.onclose = () => {
        const banner = document.getElementById('reconnectBanner');
        if (banner) banner.classList.add('active');
        reconnectTimer = setTimeout(connectWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    };
}

function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function startNewSession(projectId, resume) {
    hideDashboardPanel();
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    term.clear();
    currentSessionId = null;
    hideSessionActions();
    setTimeout(() => {
        doFit();
        wsSend({ type: 'start', projectId, resume: !!resume, cols: term.cols, rows: term.rows });
    }, 50);
}

function attachSession(sessionId) {
    hideDashboardPanel();
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    term.clear();
    setTimeout(() => {
        doFit();
        wsSend({ type: 'attach', sessionId, cols: term.cols, rows: term.rows });
    }, 50);
}

async function killSession(sessionId) {
    const id = sessionId || currentSessionId;
    if (!id) return;
    try {
        await authFetch(`/api/sessions/${id}`, { method: 'DELETE' });
    } catch {}
    // 主动刷新，不依赖 onExit 推送
    loadSessions();
}

function reconnect(resume) {
    if (!currentProject) return;
    hideSessionActions();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingAction = () => startNewSession(currentProject.id, resume);
        connectWebSocket();
    } else {
        startNewSession(currentProject.id, resume);
    }
}

// ---- 会话管理 ----

async function loadSessions() {
    try {
        const res = await authFetch('/api/sessions');
        sessionsCache = await res.json();
    } catch {
        sessionsCache = [];
    }
    renderProjects();
    renderSessions();
}

function getProjectSessions(projectId) {
    return sessionsCache.filter(s => s.projectId === projectId);
}

function getLatestSession(sessions) {
    if (sessions.length === 0) return null;
    return [...sessions].sort((a, b) => b.lastActivity - a.lastActivity)[0];
}

function renderSessions() {
    const list = document.getElementById('sessionList');
    if (!list) return;

    const clearBtn = document.getElementById('clearAllSessions');
    if (clearBtn) clearBtn.style.display = sessionsCache.length > 1 ? '' : 'none';

    if (sessionsCache.length === 0) {
        list.innerHTML = '<div style="color:var(--c-text-faint);text-align:center;padding:10px;font-size:11px;">无活跃会话</div>';
        return;
    }

    list.innerHTML = sessionsCache.map(s => {
        const isCurrent = s.id === currentSessionId;
        const project = projectsCache.find(p => p.id === s.projectId);
        const name = escapeHtml(project ? project.name : s.projectId);
        if (s.stale) {
            return `
            <div class="session-item stale" onclick="resumeStaleSession('${escapeHtml(s.id)}', '${escapeHtml(s.projectId)}')">
                <div class="session-info">
                    <span class="session-dot" style="background:var(--c-warn)"></span>
                    <span class="session-name">${name}</span>
                    <span class="session-time" style="color:var(--c-warn)">重启丢失·点击恢复</span>
                </div>
                <button class="session-close" onclick="event.stopPropagation();killSession('${escapeHtml(s.id)}')" title="清除">&times;</button>
            </div>`;
        }
        return `
        <div class="session-item ${isCurrent ? 'active' : ''}" onclick="switchSession('${escapeHtml(s.id)}', '${escapeHtml(s.projectId)}')">
            <div class="session-info">
                <span class="session-dot"></span>
                <span class="session-name">${name}</span>
                <span class="session-time">${formatTime(s.createdAt)}</span>
            </div>
            <button class="session-close" onclick="event.stopPropagation();killSession('${escapeHtml(s.id)}')" title="关闭">&times;</button>
        </div>`;
    }).join('');
}

async function resumeStaleSession(staleId, projectId) {
    // 清除 stale 记录，然后对该项目发起 claude --resume
    try { await authFetch(`/api/sessions/${staleId}`, { method: 'DELETE' }); } catch {}
    const project = projectsCache.find(p => p.id === projectId);
    if (project) {
        currentProject = project;
        document.getElementById('projectTitle').textContent = project.name;
        document.getElementById('headerProjectPath').textContent = project.path;
        document.getElementById('projectSwitchLabel').textContent = project.name;
    }
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    closeSidebar();
    if (ws && ws.readyState === WebSocket.OPEN) {
        startNewSession(projectId, true);
    } else {
        pendingAction = () => startNewSession(projectId, true);
        connectWebSocket();
    }
    term.focus();
}

function switchSession(sessionId, projectId) {
    const project = projectsCache.find(p => p.id === projectId);
    if (project) {
        currentProject = project;
        document.getElementById('projectTitle').textContent = project.name;
        document.getElementById('headerProjectPath').textContent = project.path;
        document.getElementById('projectSwitchLabel').textContent = project.name;
    }

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    hideSessionActions();

    renderProjects();
    closeSidebar();

    if (ws && ws.readyState === WebSocket.OPEN) {
        attachSession(sessionId);
    } else {
        currentSessionId = sessionId;
        connectWebSocket();
    }

    term.focus();
}

// ---- 项目列表 ----

async function loadProjects() {
    const response = await authFetch('/api/projects');
    projectsCache = await response.json();
    await loadSessions();
}

const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/).+/;

function extractRepoName(url) {
    return url.replace(/\.git$/, '').split('/').pop().split(':').pop();
}

function filterProjects(query) {
    projectSearchQuery = query.trim();
    if (GIT_URL_RE.test(projectSearchQuery)) {
        const repoName = extractRepoName(projectSearchQuery);
        const match = projectsCache.filter(p =>
            p.name.toLowerCase() === repoName.toLowerCase()
        );
        if (match.length > 0) {
            renderProjects(match, '已存在，回车切换');
        } else {
            renderProjects([], '回车开始 clone');
        }
    } else {
        renderProjects();
    }
}

function handleSearchClone(inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;
    if (GIT_URL_RE.test(value)) {
        const repoName = extractRepoName(value);
        const match = projectsCache.find(p =>
            p.name.toLowerCase() === repoName.toLowerCase()
        );
        if (match) {
            selectProject(match.id);
            inputEl.value = '';
            projectSearchQuery = '';
            return;
        }
        performClone(inputEl, document.getElementById('sidebarCloneStatus'), false);
    }
}

function renderProjects(overrideList, hintText) {
    const list = document.getElementById('projectList');

    let filtered;
    if (overrideList !== undefined) {
        filtered = overrideList;
    } else if (projectSearchQuery && !GIT_URL_RE.test(projectSearchQuery)) {
        const q = projectSearchQuery.toLowerCase();
        filtered = projectsCache.filter(p => p.name.toLowerCase().includes(q));
    } else {
        filtered = projectsCache;
    }

    if (filtered.length === 0 && !hintText && projectsCache.length === 0) {
        list.innerHTML = '<div style="color:var(--c-text-dim);text-align:center;padding:20px;font-size:12px;line-height:1.6;">将项目放在 ~/projects/ 下<br>即可自动发现<br><span style="color:var(--c-text-faint);font-size:11px;">或粘贴 git 地址回车 clone</span></div>';
        return;
    }

    if (filtered.length === 0) {
        const msg = hintText || '未找到匹配项目';
        list.innerHTML = '<div style="color:var(--c-text-dim);text-align:center;padding:12px;font-size:12px;">' + escapeHtml(msg) + '</div>';
        return;
    }

    let html = '';
    if (hintText) {
        html += '<div style="color:var(--c-accent);text-align:center;padding:6px;font-size:11px;">' + escapeHtml(hintText) + '</div>';
    }

    html += filtered.map(p => {
        const sessions = getProjectSessions(p.id);
        const liveSessions = sessions.filter(s => !s.stale);
        const isActive = currentProject && currentProject.id === p.id;
        const liveCount = liveSessions.length;
        const name = escapeHtml(p.name);
        const desc = escapeHtml(p.path);
        return `
        <div class="project-item ${isActive ? 'active' : ''}"
             onclick="selectProject('${escapeHtml(p.id)}')">
            <div class="project-name">
                ${liveCount > 0 ? '<span class="session-dot"></span>' : ''}${name}
                ${liveCount > 1 ? `<span class="session-count">${liveCount}</span>` : ''}
            </div>
            <div class="project-desc">${desc}</div>
        </div>`;
    }).join('');
    list.innerHTML = html;
}

// ---- 项目选择 ----

async function selectProject(projectId) {
    if (projectsCache.length === 0) await loadProjects();
    currentProject = projectsCache.find(p => p.id === projectId);
    if (!currentProject) return;

    document.getElementById('projectTitle').textContent = currentProject.name;
    document.getElementById('headerProjectPath').textContent = currentProject.path;
    document.getElementById('projectSwitchLabel').textContent = currentProject.name;

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    document.getElementById('newSessionBtn').style.display = '';
    hideSessionActions();

    renderProjects();
    closeSidebar();

    const liveSessions = getProjectSessions(projectId).filter(s => !s.stale);
    const latest = getLatestSession(liveSessions);

    if (ws && ws.readyState === WebSocket.OPEN) {
        if (latest) {
            attachSession(latest.id);
        } else {
            startNewSession(projectId);
        }
    } else {
        currentSessionId = latest ? latest.id : null;
        connectWebSocket();
    }

    term.focus();
}

// ---- Clone ----

async function performClone(inputEl, statusEl, autoClose) {
    const url = inputEl.value.trim();
    if (!url) return;
    statusEl.style.color = 'var(--c-accent)';
    statusEl.textContent = 'Cloning...';
    inputEl.disabled = true;
    try {
        const res = await authFetch('/api/clone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.success) {
            statusEl.style.color = 'var(--c-green)';
            statusEl.textContent = 'Done';
            inputEl.value = '';
            projectSearchQuery = '';
            loadProjects();
            if (autoClose) setTimeout(() => closeAllPopups(), 1500);
        } else {
            statusEl.style.color = 'var(--c-red)';
            statusEl.textContent = data.error;
        }
    } catch (e) {
        statusEl.style.color = 'var(--c-red)';
        statusEl.textContent = e.message;
    }
    inputEl.disabled = false;
    setTimeout(() => { statusEl.textContent = ''; }, 5000);
}

// ---- 项目快捷切换下拉 ----

function toggleProjectDropdown() {
    const dropdown = document.getElementById('projectDropdown');
    const wasOpen = dropdown.classList.contains('open');
    closeAllPopups();
    if (!wasOpen) {
        dropdown.classList.add('open');
        renderProjectDropdown(projectsCache);
        document.getElementById('projectDropdownSearch').value = '';
        document.getElementById('projectDropdownSearch').focus();
    }
}

function renderProjectDropdown(projects, hintText) {
    const list = document.getElementById('projectDropdownList');
    if (projects.length === 0) {
        const msg = hintText || '无匹配项目';
        list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--c-text-dim);font-size:12px;">' + escapeHtml(msg) + '</div>';
        return;
    }
    let html = '';
    if (hintText) {
        html += '<div style="color:var(--c-accent);text-align:center;padding:6px;font-size:11px;">' + escapeHtml(hintText) + '</div>';
    }
    html += projects.map(p => {
        const isActive = currentProject && currentProject.id === p.id;
        const liveSessions = getProjectSessions(p.id).filter(s => !s.stale);
        const name = escapeHtml(p.name);
        return `<div class="project-dropdown-item ${isActive ? 'active' : ''}"
                     onclick="selectProject('${escapeHtml(p.id)}');closeAllPopups()">
                    ${liveSessions.length > 0 ? '<span class="session-dot"></span>' : ''}
                    ${name}
                    ${liveSessions.length > 1 ? '<span class="session-count">' + liveSessions.length + '</span>' : ''}
                </div>`;
    }).join('');
    list.innerHTML = html;
}

function filterProjectDropdown(query) {
    const q = query.trim();
    if (GIT_URL_RE.test(q)) {
        const repoName = extractRepoName(q);
        const match = projectsCache.filter(p =>
            p.name.toLowerCase() === repoName.toLowerCase()
        );
        if (match.length > 0) {
            renderProjectDropdown(match, '已存在，回车仍可 clone');
        } else {
            renderProjectDropdown([], '回车开始 clone');
        }
    } else {
        const filtered = q ? projectsCache.filter(p =>
            p.name.toLowerCase().includes(q.toLowerCase())
        ) : projectsCache;
        renderProjectDropdown(filtered);
    }
}

function handleDropdownClone(inputEl) {
    const value = inputEl.value.trim();
    if (!value || !GIT_URL_RE.test(value)) return;
    performClone(inputEl, document.getElementById('dropdownCloneStatus'), true);
}

// ---- 弹出层管理 ----

function closeAllPopups() {
    const pd = document.getElementById('projectDropdown');
    const um = document.getElementById('userMenu');
    if (pd) pd.classList.remove('open');
    if (um) um.classList.remove('open');
}

// ---- 仪表板面板 ----

function showDashboardPanel() {
    if (!currentProject) return;
    document.getElementById('dashboardProjectName').textContent = currentProject.name;
    document.getElementById('dashboardProjectPath').textContent = currentProject.path;

    // Active sessions for this project
    const projectSessions = getProjectSessions(currentProject.id);
    const sessionsEl = document.getElementById('dashboardSessions');
    if (projectSessions.length === 0) {
        sessionsEl.innerHTML = '<div style="color:var(--c-text-dim);font-size:12px;padding:8px;">无活跃会话</div>';
    } else {
        sessionsEl.innerHTML = projectSessions.map(s => {
            const name = escapeHtml(currentProject.name);
            return `<div class="dashboard-session-item" onclick="switchSession('${escapeHtml(s.id)}', '${escapeHtml(s.projectId)}')">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span class="session-dot" ${s.stale ? 'style="background:var(--c-warn)"' : ''}></span>
                            <span>${name}</span>
                            <span style="color:var(--c-text-dim);font-size:10px;">${formatTime(s.createdAt)}</span>
                        </div>
                        <button class="session-close" onclick="event.stopPropagation();killSession('${escapeHtml(s.id)}')">&times;</button>
                    </div>`;
        }).join('');
    }

    refreshHealth();

    document.getElementById('terminalWrapper').classList.remove('active');
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('dashboardPanel').classList.add('active');
}

function hideDashboardPanel() {
    document.getElementById('dashboardPanel').classList.remove('active');
}

function updateHealthUI(data) {
    // Status bar
    const el1 = document.getElementById('statusSessions');
    const el2 = document.getElementById('statusMemory');
    if (el1) el1.textContent = `${data.sessions} sessions`;
    if (el2) el2.textContent = `${data.memory.rss}MB`;
    // Health panel
    const u = document.getElementById('healthUptime');
    const s = document.getElementById('healthSessions');
    const c = document.getElementById('healthCpu');
    const r = document.getElementById('healthRss');
    const hp = document.getElementById('healthHeap');
    const dk = document.getElementById('healthDisk');
    if (u) u.textContent = formatUptime(data.uptime);
    if (s) s.textContent = data.sessions;
    if (c && data.cpu) c.textContent = `${data.cpu.load1m} (${data.cpu.cores} cores)`;
    if (r) r.textContent = `${data.memory.rss} MB`;
    if (hp) hp.textContent = `${data.memory.heap} MB`;
    if (dk && data.disk) dk.textContent = `${data.disk.used}/${data.disk.total} GB (${data.disk.percent})`;
    // Dashboard panel
    const du = document.getElementById('dashUptime');
    const ds = document.getElementById('dashSessions');
    const dm = document.getElementById('dashMemory');
    const dd = document.getElementById('dashDisk');
    if (du) du.textContent = formatUptime(data.uptime);
    if (ds) ds.textContent = data.sessions;
    if (dm) dm.textContent = data.memory.rss + ' MB';
    if (dd && data.disk) dd.textContent = data.disk.used + '/' + data.disk.total + ' GB';
}

// ---- 侧边栏 ----

function toggleSidebar() {
    const isMobile = window.innerWidth <= 768;
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (isMobile) {
        const isOpen = sidebar.classList.toggle('open');
        overlay.classList.toggle('active', isOpen);
    } else {
        sidebar.classList.toggle('collapsed');
        localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
    }
    setTimeout(doFit, 300);
}

function closeSidebar() {
    const isMobile = window.innerWidth <= 768;
    const sidebar = document.getElementById('sidebar');
    if (isMobile) {
        sidebar.classList.remove('open');
        document.getElementById('sidebarOverlay').classList.remove('active');
    }
    // Desktop: don't auto-close sidebar on project select
    setTimeout(doFit, 300);
}

// ---- 状态监控 ----

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function toggleHealthPanel(e) {
    if (e) e.stopPropagation();
    document.getElementById('healthPanel').classList.toggle('open');
}

document.addEventListener('click', (e) => {
    const panel = document.getElementById('healthPanel');
    const bar = document.getElementById('statusBar');
    if (panel && !panel.contains(e.target) && !bar.contains(e.target)) {
        panel.classList.remove('open');
    }
});

async function refreshHealth() {
    try {
        const res = await authFetch('/api/health');
        const data = await res.json();
        updateHealthUI(data);
    } catch {}
}

// ---- 初始化 ----

let appInitialized = false;

function initApp() {
    if (appInitialized) return;
    appInitialized = true;
    initTerminal();
    loadProjects();
    connectWebSocket();
    refreshHealth();
    setInterval(refreshHealth, 10000);
    // 粒子系统
    initParticles();
    const fxBtn = document.getElementById('tsbToggleFx');
    if (fxBtn) fxBtn.addEventListener('click', toggleParticles);
    if (!particlesEnabled) {
        const canvas = document.getElementById('particleCanvas');
        if (canvas) canvas.classList.add('hidden');
        if (fxBtn) fxBtn.classList.add('off');
    }
}

// ---- 批量关闭会话 ----

async function killAllSessions() {
    if (!confirm('确定关闭所有会话？')) return;
    const ids = sessionsCache.map(s => s.id);
    for (const id of ids) {
        try { await authFetch(`/api/sessions/${id}`, { method: 'DELETE' }); } catch {}
    }
    loadSessions();
}

// ---- Escape 键关闭弹窗 ----

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeAllPopups();
        closeChangePassword();
        document.getElementById('healthPanel').classList.remove('open');
    }
});

// ---- 键盘快捷键 ----

document.addEventListener('keydown', (e) => {
    // 如果焦点在输入框内，不拦截
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // 终端获焦时只拦截 Ctrl/Cmd 组合键
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        toggleProjectDropdown();
    } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (currentProject) reconnect(false);
    }
});

// ---- 空闲警告 ----

const IDLE_WARN_MS = 25 * 60 * 1000; // 25 分钟

function resetIdleWarning() {
    clearIdleWarning();
    if (!currentSessionId) return;
    idleWarningTimer = setTimeout(() => {
        showToast('当前会话即将因空闲被自动清理（30分钟限制）');
    }, IDLE_WARN_MS);
}

function clearIdleWarning() {
    if (idleWarningTimer) { clearTimeout(idleWarningTimer); idleWarningTimer = null; }
}

// ---- 剪贴板同步（远程图片 → Mac 系统剪贴板）----

// 剪贴板图片同步：捕获阶段拦截 paste 事件
document.addEventListener('paste', (e) => {
    if (!currentSessionId) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            syncClipboardImage(item.getAsFile());
            return;
        }
    }
}, true);

let clipboardSyncing = false;
async function syncClipboardImage(blob) {
    if (clipboardSyncing) return;
    clipboardSyncing = true;
    const reader = new FileReader();
    reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        showToast('正在同步剪贴板...');
        try {
            const res = await authFetch('/api/clipboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64 })
            });
            const data = await res.json();
            if (data.success) {
                showToast('剪贴板已同步，请再次粘贴');
            } else {
                showToast('同步失败: ' + data.error);
            }
        } catch (err) {
            showToast('同步失败: ' + err.message);
        }
        clipboardSyncing = false;
    };
    reader.readAsDataURL(blob);
}

// 启动时检查认证状态
checkAuth();
