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
let tasksCache = [];
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

// ---- 多标签 & Agent ----
const openTabs = new Map();
let activeTabId = null;
const MAX_TABS = 8;
let availableAgents = ['claude'];
let selectedAgent = 'claude';

// ---- 设置 & Worktree ----
let settingsRoots = [];
const worktreeCache = {}; // projectId → { data: [...], expanded: false }

// ---- Yolo 模式 (--dangerously-skip-permissions) ----
let yoloMode = localStorage.getItem('yoloMode') === 'true';

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
    // Close all tabs and their WebSocket connections
    for (const [id, tab] of openTabs) {
        if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
        if (tab.ws) {
            tab.ws.onclose = null;
            tab.ws.close();
        }
        tab.term.dispose();
        tab.container.remove();
    }
    openTabs.clear();
    activeTabId = null;
    ws = null;
    term = null;
    currentSessionId = null;
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
    const el = document.getElementById('sessionActions');
    if (el) el.style.display = 'flex';
}

function hideSessionActions() {
    const el = document.getElementById('sessionActions');
    if (el) el.style.display = 'none';
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
    termFontSize = Math.max(8, Math.min(24, termFontSize + delta));
    for (const tab of openTabs.values()) {
        tab.term.options.fontSize = termFontSize;
        tab.fitAddon.fit();
    }
    localStorage.setItem('termFontSize', termFontSize);
    const label = document.getElementById('fontSizeLabel');
    if (label) label.textContent = termFontSize + 'px';
    doFit();
}

function toggleYoloMode() {
    yoloMode = !yoloMode;
    localStorage.setItem('yoloMode', yoloMode);
    const toggle = document.getElementById('yoloToggle');
    if (toggle) toggle.checked = yoloMode;
    showToast(yoloMode ? '已开启无确认模式' : '已关闭无确认模式');
}

function initTerminal() {
    window.addEventListener('resize', doFit);
}

function createTabTerminal(container) {
    const t = new Terminal({
        cursorBlink: true,
        fontSize: termFontSize,
        fontFamily: 'Monaco, Menlo, "Courier New", monospace',
        theme: { background: '#1a1a1a', foreground: '#e0e0e0', cursor: '#e0e0e0', selectionBackground: '#3a5a8a' },
        allowProposedApi: true
    });
    const fa = new FitAddon.FitAddon();
    t.loadAddon(fa);
    t.open(container);

    let inputBuffer = '';
    let inputTimer = null;
    const INPUT_FLUSH_DELAY = 40;
    function flushInput() {
        if (inputBuffer) {
            const tab = openTabs.get(activeTabId);
            if (tab && tab.term === t && tab.ws && tab.ws.readyState === WebSocket.OPEN) {
                tab.ws.send(JSON.stringify({ type: 'input', data: inputBuffer }));
            }
            inputBuffer = '';
        }
        if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    }
    t.onData((data) => {
        resetIdleWarning();
        inputBuffer += data;
        if (data.length > 1 || data.charCodeAt(0) < 32 || data.charCodeAt(0) === 127) {
            flushInput();
        } else {
            if (inputTimer) clearTimeout(inputTimer);
            inputTimer = setTimeout(flushInput, INPUT_FLUSH_DELAY);
        }
    });
    return { term: t, fitAddon: fa };
}

function createTabWebSocket(tabId, tabInfo) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tabWs = new WebSocket(`${protocol}//${location.host}?token=${encodeURIComponent(authToken)}`);

    tabWs.onopen = () => {
        if (tabInfo.pendingAttach) {
            tabWs.send(JSON.stringify({ type: 'attach', sessionId: tabInfo.pendingAttach, cols: tabInfo.term.cols, rows: tabInfo.term.rows }));
        } else if (tabInfo.pendingStart) {
            const s = tabInfo.pendingStart;
            const startMsg = { type: 'start', projectId: s.projectId, resume: s.resume, agent: s.agent || tabInfo.agent, cols: tabInfo.term.cols, rows: tabInfo.term.rows, yolo: !!s.yolo };
            if (s.cwd) startMsg.cwd = s.cwd;
            tabWs.send(JSON.stringify(startMsg));
        }
    };

    tabWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
            tabInfo.term.write(msg.data);
            tabInfo.term.scrollToBottom();
            if (tabInfo.sessionId === activeTabId) {
                setActivityIdle(false);
                if (activityTimeout) clearTimeout(activityTimeout);
                activityTimeout = setTimeout(() => setActivityIdle(true), 5000);
            }
        } else if (msg.type === 'replay') {
            tabInfo.term.write(msg.data);
            tabInfo.term.scrollToBottom();
        } else if (msg.type === 'started') {
            const oldId = tabInfo.sessionId;
            tabInfo.sessionId = msg.sessionId;
            if (msg.agent) tabInfo.agent = msg.agent;
            if (oldId !== msg.sessionId) {
                openTabs.delete(oldId);
                openTabs.set(msg.sessionId, tabInfo);
                if (activeTabId === oldId) activeTabId = msg.sessionId;
            }
            tabInfo.createdAt = msg.createdAt;
            currentSessionId = activeTabId;
            syncActiveTab();
            hideSessionActions();
            const killBtn = document.getElementById('killBtn'); if (killBtn) killBtn.style.display = '';
            const fcEl = document.getElementById('fontSizeControls'); if (fcEl) fcEl.style.display = '';
            document.getElementById('newSessionBtn').style.display = '';
            resetIdleWarning();
            loadSessions();
            renderTabBar();
            if (tabInfo.sessionId === activeTabId) {
                showTerminalStatusBar(tabInfo.projectName, msg.createdAt);
            }
        } else if (msg.type === 'attached') {
            tabInfo.sessionId = msg.sessionId;
            if (msg.agent) tabInfo.agent = msg.agent;
            tabInfo.createdAt = msg.createdAt;
            currentSessionId = activeTabId;
            syncActiveTab();
            hideSessionActions();
            const killBtn = document.getElementById('killBtn'); if (killBtn) killBtn.style.display = '';
            const fcEl = document.getElementById('fontSizeControls'); if (fcEl) fcEl.style.display = '';
            document.getElementById('newSessionBtn').style.display = '';
            resetIdleWarning();
            loadSessions();
            renderTabBar();
            if (tabInfo.sessionId === activeTabId) {
                showTerminalStatusBar(tabInfo.projectName, msg.createdAt);
            }
        } else if (msg.type === 'exit') {
            loadSessions();
            closeTab(tabInfo.sessionId);
        } else if (msg.type === 'notify') {
            showToast(msg.message);
            loadSessions();
        } else if (msg.type === 'error') {
            tabInfo.term.writeln('\r\n\x1b[31m' + msg.data + '\x1b[0m');
        } else if (msg.type === 'detached') {
            tabInfo.term.writeln('\r\n\x1b[33m--- 会话已被其他连接接管 ---\x1b[0m');
        }
    };

    tabWs.onclose = () => {
        if (openTabs.has(tabInfo.sessionId)) {
            const banner = document.getElementById('reconnectBanner');
            if (tabInfo.sessionId === activeTabId && banner) banner.classList.add('active');
            tabInfo.reconnectTimer = setTimeout(() => {
                if (openTabs.has(tabInfo.sessionId)) {
                    tabInfo.pendingAttach = tabInfo.sessionId;
                    tabInfo.pendingStart = null;
                    tabInfo.ws = createTabWebSocket(tabInfo.sessionId, tabInfo);
                }
            }, 3000);
        }
    };

    return tabWs;
}

function doFit() {
    const tab = openTabs.get(activeTabId);
    const activeFitAddon = tab ? tab.fitAddon : fitAddon;
    const activeTerm = tab ? tab.term : term;
    if (!activeFitAddon || !activeTerm) return;

    // Adjust terminal container height for status bar
    const wrapper = document.getElementById('terminalWrapper');
    if (wrapper && tab && tab.container) {
        const statusBar = document.getElementById('terminalStatusBar');
        const barHeight = statusBar && statusBar.classList.contains('visible') ? STATUS_BAR_HEIGHT : 0;
        const tabBar = document.getElementById('tabBar');
        const tabBarHeight = tabBar && tabBar.classList.contains('visible') ? tabBar.offsetHeight : 0;
        const rect = wrapper.getBoundingClientRect();
        tab.container.style.height = (rect.height - barHeight - tabBarHeight) + 'px';
    }

    try {
        activeFitAddon.fit();
        // send resize to active tab's ws
        const activeWs = tab ? tab.ws : ws;
        if (activeTerm.cols && activeTerm.rows && activeWs && activeWs.readyState === WebSocket.OPEN) {
            activeWs.send(JSON.stringify({ type: 'resize', cols: activeTerm.cols, rows: activeTerm.rows }));
        }
    } catch {}
}

// ---- WebSocket ----

let reconnectTimer = null;
let reconnectDelay = 3000;
const RECONNECT_MAX_DELAY = 30000;

function connectWebSocket() {
    // Tab system manages per-tab WebSocket connections via createTabWebSocket()
}

function wsSend(msg) {
    const tab = openTabs.get(activeTabId);
    const activeWs = tab ? tab.ws : ws;
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify(msg));
    }
}

// ---- Tab Management ----

function openTab(projectId, sessionId, resume, agent, cwd) {
    if (sessionId && openTabs.has(sessionId)) {
        switchTab(sessionId);
        return;
    }
    if (openTabs.size >= MAX_TABS) {
        showToast('标签页已达上限 (' + MAX_TABS + ')，请关闭一些标签');
        return;
    }

    const tabAgent = agent || selectedAgent || 'claude';
    const project = projectsCache.find(p => p.id === projectId);
    // worktree 场景：显示 worktree 目录名
    const projectName = cwd ? cwd.split('/').pop() : (project ? project.name : projectId);
    const tabId = sessionId || ('new-' + Date.now());

    const container = document.createElement('div');
    container.className = 'tab-terminal';
    container.dataset.session = tabId;
    document.getElementById('terminalContainer').appendChild(container);

    const { term: t, fitAddon: fa } = createTabTerminal(container);

    const tabInfo = {
        sessionId: tabId,
        projectId,
        projectName,
        agent: tabAgent,
        term: t,
        fitAddon: fa,
        container,
        ws: null,
        createdAt: Date.now(),
        reconnectTimer: null,
        pendingAttach: sessionId || null,
        pendingStart: sessionId ? null : { projectId, resume: !!resume, agent: tabAgent, cwd, yolo: yoloMode },
    };

    openTabs.set(tabId, tabInfo);
    tabInfo.ws = createTabWebSocket(tabId, tabInfo);

    hideDashboardPanel();
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');

    switchTab(tabId);
}

function switchTab(sessionId) {
    if (!openTabs.has(sessionId)) return;

    if (activeTabId && openTabs.has(activeTabId)) {
        openTabs.get(activeTabId).container.classList.remove('active');
    }

    activeTabId = sessionId;
    const tab = openTabs.get(sessionId);
    tab.container.classList.add('active');

    syncActiveTab();

    const project = projectsCache.find(p => p.id === tab.projectId);
    if (project) {
        currentProject = project;
        document.getElementById('projectTitle').textContent = project.name;
        document.getElementById('headerProjectPath').textContent = project.path;
        document.getElementById('projectSwitchLabel').textContent = project.name;
    }
    renderProjects();
    renderTabBar();

    setTimeout(() => {
        tab.fitAddon.fit();
        tab.term.focus();
    }, 50);

    if (tab.createdAt) {
        showTerminalStatusBar(tab.projectName, tab.createdAt);
    }
}

function closeTab(sessionId) {
    const tab = openTabs.get(sessionId);
    if (!tab) return;

    if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
    if (tab.ws && tab.ws.readyState === WebSocket.OPEN) tab.ws.close();
    tab.term.dispose();
    tab.container.remove();
    openTabs.delete(sessionId);

    if (activeTabId === sessionId) {
        const remaining = [...openTabs.keys()];
        if (remaining.length > 0) {
            switchTab(remaining[remaining.length - 1]);
        } else {
            activeTabId = null;
            term = null;
            ws = null;
            currentSessionId = null;
            const kbEl = document.getElementById('killBtn'); if (kbEl) kbEl.style.display = 'none';
            const fc2 = document.getElementById('fontSizeControls'); if (fc2) fc2.style.display = 'none';
            hideTerminalStatusBar();
            clearIdleWarning();
            renderTabBar();
            if (currentProject) {
                loadSessions().then(() => showDashboardPanel());
            } else {
                document.getElementById('terminalWrapper').classList.remove('active');
                document.getElementById('emptyState').classList.remove('hidden');
            }
        }
    } else {
        renderTabBar();
    }
}

function renderTabBar() {
    const tabBar = document.getElementById('tabBar');
    if (!tabBar) return;
    if (openTabs.size === 0) {
        tabBar.classList.remove('visible');
        tabBar.innerHTML = '';
        return;
    }
    tabBar.classList.add('visible');
    const multiAgent = availableAgents.length > 1;
    tabBar.innerHTML = [...openTabs.values()].map(t => {
        const isActive = t.sessionId === activeTabId;
        const agentLabel = multiAgent && t.agent ? '<span style="font-size:9px;opacity:0.6;margin-right:2px">' + escapeHtml(t.agent) + '</span>' : '';
        return '<div class="tab-item' + (isActive ? ' active' : '') + '" onclick="switchTab(\'' + escapeHtml(t.sessionId) + '\')" title="' + escapeHtml(t.projectName) + ' (' + escapeHtml(t.agent || 'claude') + ')">' +
            agentLabel +
            '<span class="tab-name">' + escapeHtml(t.projectName) + '</span>' +
            '<span class="tab-close" onclick="event.stopPropagation();closeTab(\'' + escapeHtml(t.sessionId) + '\')">&times;</span>' +
            '</div>';
    }).join('');
}

function syncActiveTab() {
    const tab = openTabs.get(activeTabId);
    if (tab) {
        term = tab.term;
        ws = tab.ws;
        fitAddon = tab.fitAddon;
        currentSessionId = tab.sessionId;
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
        wsSend({ type: 'start', projectId, resume: !!resume, cols: term.cols, rows: term.rows, yolo: yoloMode });
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
    const targetId = sessionId || activeTabId;
    if (!targetId) return;
    try { await authFetch('/api/sessions/' + targetId, { method: 'DELETE' }); } catch {}
    closeTab(targetId);
    loadSessions();
}

function reconnect(resume) {
    if (!currentProject) return;
    openTab(currentProject.id, null, resume);
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
                ${availableAgents.length > 1 && s.agent ? '<span style="font-size:9px;color:var(--c-text-dim);margin-left:2px">' + escapeHtml(s.agent) + '</span>' : ''}
                <span class="session-time">${formatTime(s.createdAt)}</span>
            </div>
            <button class="session-close" onclick="event.stopPropagation();killSession('${escapeHtml(s.id)}')" title="关闭">&times;</button>
        </div>`;
    }).join('');
}

async function resumeStaleSession(staleId, projectId) {
    // 清除 stale 记录，然后对该项目发起 claude --resume
    try { await authFetch('/api/sessions/' + staleId, { method: 'DELETE' }); } catch {}
    const project = projectsCache.find(p => p.id === projectId);
    if (project) {
        currentProject = project;
        document.getElementById('projectTitle').textContent = project.name;
        document.getElementById('headerProjectPath').textContent = project.path;
        document.getElementById('projectSwitchLabel').textContent = project.name;
    }
    closeSidebar();
    openTab(projectId, null, true);
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

    if (openTabs.has(sessionId)) {
        switchTab(sessionId);
    } else {
        openTab(projectId, sessionId);
    }
}

// ---- 项目列表 ----

async function loadProjects() {
    const response = await authFetch('/api/projects');
    projectsCache = await response.json();
    await loadSessions();
}

async function loadAgents() {
    try {
        const res = await authFetch('/api/agents');
        if (res.ok) {
            const agents = await res.json();
            availableAgents = agents.map(a => a.name);
            renderAgentSelector();
        }
    } catch {}
}

function renderAgentSelector() {
    const el = document.getElementById('agentSelector');
    if (!el) return;
    if (availableAgents.length <= 1) {
        el.style.display = 'none';
        return;
    }
    el.style.display = '';
    el.innerHTML = availableAgents.map(a =>
        `<button class="btn agent-btn${a === selectedAgent ? ' active' : ''}" onclick="selectAgent('${escapeHtml(a)}')">${escapeHtml(a)}</button>`
    ).join('');
}

function selectAgent(agent) {
    selectedAgent = agent;
    renderAgentSelector();
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
        list.innerHTML = '<div style="color:var(--c-text-dim);text-align:center;padding:20px;font-size:12px;line-height:1.6;">将项目放在配置的目录下<br>即可自动发现<br><span style="color:var(--c-text-faint);font-size:11px;">或粘贴 git 地址回车 clone</span></div>';
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

    const hasMultiRoot = new Set(projectsCache.map(p => p.root)).size > 1;
    const pinned = filtered.filter(p => p.pinned);
    const unpinned = filtered.filter(p => !p.pinned);

    function renderProjectItem(p) {
        const sessions = getProjectSessions(p.id);
        const liveSessions = sessions.filter(s => !s.stale);
        const isActive = currentProject && currentProject.id === p.id;
        const liveCount = liveSessions.length;
        const name = escapeHtml(p.name);
        const pid = escapeHtml(p.id);
        const pinClass = p.pinned ? 'pinned' : '';
        const pinIcon = p.pinned ? '&#9733;' : '&#9734;';
        const rootTag = hasMultiRoot && p.rootLabel ? `<span class="root-tag">${escapeHtml(p.rootLabel)}</span>` : '';
        const wt = worktreeCache[p.id];
        const hasWorktrees = wt?.data?.length > 0;
        const wtExpanded = wt?.expanded;
        const wtToggle = hasWorktrees
            ? `<span class="worktree-toggle ${wtExpanded ? 'expanded' : ''}" onclick="toggleWorktreeList('${pid}', event)">&#9654;</span>`
            : '';

        let wtList = '';
        if (hasWorktrees && wtExpanded) {
            wtList = '<div class="worktree-list open">' + wt.data.map(w =>
                `<div class="worktree-item" onclick="openWorktree('${pid}', '${escapeHtml(w.path)}', '${escapeHtml(w.branch || '')}', event)" title="${escapeHtml(w.path)}">${escapeHtml(w.branch || w.name)}</div>`
            ).join('') + '</div>';
        }

        return `
        <div class="project-item ${isActive ? 'active' : ''}"
             onclick="selectProject('${pid}')">
            <div class="project-name">
                ${wtToggle}
                ${liveCount > 0 ? '<span class="session-dot"></span>' : ''}${name}
                ${liveCount > 1 ? `<span class="session-count">${liveCount}</span>` : ''}
                ${rootTag}
                <button class="project-pin ${pinClass}" onclick="togglePin('${pid}', event)" title="${p.pinned ? '取消置顶' : '置顶'}">${pinIcon}</button>
            </div>
        </div>${wtList}`;
    }

    html += pinned.map(renderProjectItem).join('');
    if (pinned.length > 0 && unpinned.length > 0) {
        html += '<div class="pin-separator"></div>';
    }

    // 多根目录时按 root 分组
    if (hasMultiRoot && unpinned.length > 0) {
        const groups = {};
        for (const p of unpinned) {
            const key = p.root || 'unknown';
            if (!groups[key]) groups[key] = { label: p.rootLabel || key, items: [] };
            groups[key].items.push(p);
        }
        for (const [, g] of Object.entries(groups)) {
            html += `<div class="root-group-header">${escapeHtml(g.label)}</div>`;
            html += g.items.map(renderProjectItem).join('');
        }
    } else {
        html += unpinned.map(renderProjectItem).join('');
    }
    list.innerHTML = html;

    // 异步加载 worktree 信息（首次渲染后静默检测）
    filtered.forEach(p => {
        if (!worktreeCache[p.id]) {
            worktreeCache[p.id] = { data: null, expanded: false };
            loadWorktrees(p.id).then(data => {
                if (data && data.length > 0) renderProjects(overrideList, hintText);
            });
        }
    });
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

    // Check if any tab already has this project's session open
    if (latest) {
        const existingTab = openTabs.get(latest.id);
        if (existingTab) {
            switchTab(latest.id);
            return;
        }
    }
    // Check if any tab is open for this project at all
    for (const [id, tab] of openTabs) {
        if (tab.projectId === projectId) {
            switchTab(id);
            return;
        }
    }

    if (latest) {
        openTab(projectId, latest.id);
    } else {
        openTab(projectId, null, false);
    }
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
    const ad = document.getElementById('agentDropdown');
    if (pd) pd.classList.remove('open');
    if (um) um.classList.remove('open');
    if (ad) ad.classList.remove('open');
    closeSettings();
}

// ---- 仪表板面板 ----

function showDashboardPanel() {
    if (!currentProject) return;
    document.getElementById('dashboardProjectName').textContent = currentProject.name;
    document.getElementById('dashboardProjectPath').textContent = currentProject.path;

    loadTasks();

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

function toggleDashboardPanel() {
    const panel = document.getElementById('dashboardPanel');
    if (panel.classList.contains('active')) {
        hideDashboardPanel();
        if (openTabs.size > 0) {
            document.getElementById('terminalWrapper').classList.add('active');
            if (activeTabId) {
                const tab = openTabs.get(activeTabId);
                if (tab) { tab.fitAddon.fit(); tab.term.focus(); }
            }
        } else {
            document.getElementById('emptyState').classList.remove('hidden');
        }
    } else {
        if (currentProject) {
            showDashboardPanel();
        } else {
            showToast('请先选择一个项目');
        }
    }
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
    // 健康面板已移到设置 tab
    switchSidebarTab('settings');
}

async function refreshHealth() {
    try {
        const res = await authFetch('/api/health');
        const data = await res.json();
        updateHealthUI(data);
    } catch {}
}

// ---- 设置弹窗 ----

function showSettings() {
    switchSidebarTab('settings');
}

function closeSettings() {
    const m = document.getElementById('settingsModal');
    if (m) m.classList.remove('open');
}

// ---- 侧边栏 Tab 切换 ----

function switchSidebarTab(tabName) {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    document.querySelectorAll('.sidebar-tab-content').forEach(c => c.classList.remove('active'));
    const panel = document.getElementById('sidebarTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (panel) panel.classList.add('active');
    if (tabName === 'tasks') renderSidebarTasks();
    if (tabName === 'settings') loadSettingsRoots();
}

// ---- 新建对话（含 Agent 选择） ----

function handleNewSession(event) {
    if (!currentProject) { showToast('请先选择一个项目'); return; }
    if (availableAgents.length > 1) {
        // 多 agent：显示下拉选择
        if (event) event.stopPropagation();
        const dropdown = document.getElementById('agentDropdown');
        if (dropdown.classList.contains('open')) {
            dropdown.classList.remove('open');
            return;
        }
        const list = document.getElementById('agentDropdownList');
        list.innerHTML = availableAgents.map(a =>
            `<div class="agent-dropdown-item" onclick="selectAgentAndStart('${escapeHtml(a)}')">
                <span class="agent-icon"></span>${escapeHtml(a)}
            </div>`
        ).join('');
        dropdown.classList.add('open');
        return;
    }
    reconnect(false);
}

function selectAgentAndStart(agent) {
    selectedAgent = agent;
    document.getElementById('agentDropdown').classList.remove('open');
    reconnect(false);
}

// ---- 侧边栏任务列表 ----

function renderSidebarTasks() {
    const el = document.getElementById('sidebarTaskList');
    if (!el) return;
    if (tasksCache.length === 0) {
        el.innerHTML = '<div style="color:var(--c-text-dim);padding:8px 0;">无定时任务</div>';
        return;
    }
    el.innerHTML = tasksCache.map(t => {
        const run = t.latestRun;
        const statusColor = run ? (run.status === 'success' ? 'var(--c-green)' : run.status === 'running' ? 'var(--c-accent)' : 'var(--c-red)') : 'var(--c-text-dim)';
        const statusText = run ? run.status : 'idle';
        return `<div style="padding:6px 0;border-bottom:1px solid var(--c-border);cursor:pointer;" onclick="showTaskDetail('${escapeHtml(t.id)}')">
            <div style="display:flex;align-items:center;gap:6px;">
                <span style="width:6px;height:6px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
                <span style="color:var(--c-text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.name)}</span>
            </div>
            <div style="color:var(--c-text-dim);font-size:10px;margin-top:2px;">${escapeHtml(t.project_id)} · ${statusText} · ${t.cron_expr || 'manual'}</div>
        </div>`;
    }).join('');
}

// ---- 设置：项目根目录 ----

async function loadSettingsRoots() {
    try {
        const res = await authFetch('/api/settings/roots');
        settingsRoots = await res.json();
        renderSettingsRoots();
    } catch {}
}

function renderSettingsRoots() {
    // 渲染到侧边栏设置 tab
    const targets = [document.getElementById('sidebarSettingsRootList'), document.getElementById('settingsRootList')];
    const isLast = settingsRoots.length === 1;
    const html = settingsRoots.length === 0
        ? '<div style="color:var(--c-text-dim);font-size:12px;padding:4px 0;">未配置项目目录</div>'
        : settingsRoots.map(r => `
            <div class="settings-root-item">
                <div class="root-path">${escapeHtml(r.dir_path)}</div>
                ${isLast ? '' : `<button class="settings-root-delete" onclick="removeProjectRoot(${r.id})" title="移除">&times;</button>`}
            </div>
        `).join('');
    targets.forEach(el => { if (el) el.innerHTML = html; });
}

async function addProjectRoot(source) {
    const inputId = source === 'sidebar' ? 'sidebarSettingsNewRoot' : 'settingsNewRoot';
    const errorId = source === 'sidebar' ? 'sidebarSettingsRootError' : 'settingsRootError';
    const input = document.getElementById(inputId);
    const errorEl = document.getElementById(errorId);
    const dirPath = input.value.trim();
    if (!dirPath) return;
    if (errorEl) errorEl.textContent = '';
    try {
        const res = await authFetch('/api/settings/roots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir_path: dirPath })
        });
        const data = await res.json();
        if (!res.ok) { if (errorEl) errorEl.textContent = data.error; return; }
        input.value = '';
        await loadSettingsRoots();
        loadProjects();
    } catch (e) { if (errorEl) errorEl.textContent = e.message; }
}

async function removeProjectRoot(id) {
    if (!confirm('确定移除此项目目录？（不会删除文件）')) return;
    try {
        const res = await authFetch('/api/settings/roots/' + id, { method: 'DELETE' });
        if (res.ok) { await loadSettingsRoots(); loadProjects(); }
    } catch {}
}

// ---- 项目置顶 ----

async function togglePin(projectId, event) {
    event.stopPropagation();
    const p = projectsCache.find(p => p.id === projectId);
    if (!p) return;
    try {
        await authFetch('/api/projects/' + encodeURIComponent(projectId) + '/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: !p.pinned })
        });
        await loadProjects();
    } catch {}
}

// ---- Worktree 切换 ----

async function loadWorktrees(projectId) {
    if (worktreeCache[projectId]?.data) return worktreeCache[projectId].data;
    try {
        const res = await authFetch('/api/projects/' + encodeURIComponent(projectId) + '/worktrees');
        const data = await res.json();
        if (!worktreeCache[projectId]) worktreeCache[projectId] = { data: null, expanded: false };
        worktreeCache[projectId].data = data;
        return data;
    } catch { return []; }
}

async function toggleWorktreeList(projectId, event) {
    event.stopPropagation();
    const cache = worktreeCache[projectId] || { data: null, expanded: false };
    worktreeCache[projectId] = cache;
    cache.expanded = !cache.expanded;
    if (cache.expanded && !cache.data) {
        await loadWorktrees(projectId);
    }
    renderProjects();
}

function openWorktree(projectId, worktreePath, branch, event) {
    if (event) event.stopPropagation();
    // 用 worktree 绝对路径作为 cwd 打开新 tab
    openTab(projectId, null, false, selectedAgent, worktreePath);
}

// ---- 初始化 ----

let appInitialized = false;

function initApp() {
    if (appInitialized) return;
    appInitialized = true;
    initTerminal();
    loadProjects();
    loadTasks();
    loadAgents();
    connectWebSocket();
    refreshHealth();
    const fsl = document.getElementById('fontSizeLabel');
    if (fsl) fsl.textContent = termFontSize + 'px';
    const yoloToggle = document.getElementById('yoloToggle');
    if (yoloToggle) yoloToggle.checked = yoloMode;
    setInterval(refreshHealth, 10000);
    setInterval(loadTasks, 15000);
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
        try { await authFetch('/api/sessions/' + id, { method: 'DELETE' }); } catch {}
    }
    for (const id of [...openTabs.keys()]) {
        closeTab(id);
    }
    loadSessions();
}

// ---- Escape 键关闭弹窗 ----

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeAllPopups();
        closeChangePassword();
        closeCreateTaskModal();
        closeTaskDetailModal();
        closeTaskPanel();
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

// ---- 定时任务 ----

async function loadTasks() {
    try {
        const res = await authFetch('/api/tasks');
        if (!res.ok) throw new Error();
        tasksCache = await res.json();
    } catch {
        tasksCache = [];
    }
    renderTasks();
}

function renderTaskItems(tasks, onClickPrefix) {
    if (tasks.length === 0) {
        return '<div style="color:var(--c-text-dim);font-size:12px;padding:8px;">无定时任务</div>';
    }
    return tasks.map(t => {
        const running = t.runningCount > 0;
        const dotClass = running ? 'running' : (t.enabled ? 'enabled' : 'disabled');
        const schedule = t.cron_expr || '仅手动';
        const project = projectsCache.find(p => p.id === t.project_id);
        const projectName = project ? escapeHtml(project.name) : escapeHtml(t.project_id);
        const statusText = running ? '运行中' : (t.enabled ? '就绪' : '已禁用');
        return `<div class="dashboard-session-item" onclick="${onClickPrefix}showTaskDetail('${escapeHtml(t.id)}')">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
                <span class="task-status-dot ${dotClass}"></span>
                <div style="min-width:0;flex:1;">
                    <div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.name)}</div>
                    <div class="task-meta">${projectName} · ${escapeHtml(schedule)} · ${statusText}</div>
                </div>
            </div>
            <div class="task-actions" onclick="event.stopPropagation()">
                ${running
                    ? `<button onclick="event.stopPropagation();attachTaskRun('${escapeHtml(t.id)}')" title="查看终端">attach</button>`
                    : `<button onclick="event.stopPropagation();triggerTask('${escapeHtml(t.id)}')" title="手动触发">触发</button>`}
            </div>
        </div>`;
    }).join('');
}

function renderTasks() {
    const el = document.getElementById('dashboardTasks');
    if (!el) return;
    el.innerHTML = renderTaskItems(tasksCache, '');
}

function showCreateTaskModal() {
    const modal = document.getElementById('createTaskModal');
    modal.classList.add('open');
    document.getElementById('taskName').value = '';
    document.getElementById('taskPrompt').value = '';
    document.getElementById('taskCron').value = '';
    document.getElementById('createTaskError').textContent = '';
    document.querySelector('input[name="taskMode"][value="new"]').checked = true;

    // Populate project select
    const select = document.getElementById('taskProject');
    const hasSelection = currentProject && projectsCache.some(p => p.id === currentProject.id);
    select.innerHTML = (hasSelection ? '' : '<option value="">选择项目...</option>') +
        projectsCache.map(p =>
            `<option value="${escapeHtml(p.id)}" ${currentProject && p.id === currentProject.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
        ).join('');

    document.getElementById('taskName').focus();
}

function closeCreateTaskModal() {
    document.getElementById('createTaskModal').classList.remove('open');
}

async function doCreateTask() {
    const btn = document.querySelector('#createTaskModal .modal-btn-confirm');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
        const name = document.getElementById('taskName').value.trim();
        const project_id = document.getElementById('taskProject').value;
        const prompt = document.getElementById('taskPrompt').value.trim();
        const cron_expr = document.getElementById('taskCron').value.trim();
        const execution_mode = document.querySelector('input[name="taskMode"]:checked').value;
        const dangerously_skip_permissions = document.getElementById('taskYolo').checked;
        const errorEl = document.getElementById('createTaskError');

        if (!name || !project_id || !prompt) { errorEl.textContent = '名称、项目和 Prompt 不能为空'; return; }

        try {
            const res = await authFetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, project_id, prompt, cron_expr: cron_expr || undefined, execution_mode, dangerously_skip_permissions })
            });
            const data = await res.json();
            if (res.ok) {
                closeCreateTaskModal();
                showToast('任务创建成功');
                loadTasks();
            } else {
                errorEl.textContent = data.error;
            }
        } catch (e) {
            errorEl.textContent = e.message;
        }
    } finally {
        btn.disabled = false;
    }
}

let currentTaskDetail = null;

function showTaskDetail(taskId) {
    const task = tasksCache.find(t => t.id === taskId);
    if (!task) return;
    currentTaskDetail = task;

    document.getElementById('taskDetailName').textContent = task.name;
    const project = projectsCache.find(p => p.id === task.project_id);
    document.getElementById('taskDetailProject').textContent = project ? project.name : task.project_id;
    document.getElementById('taskDetailCron').textContent = task.cron_expr || '仅手动';
    document.getElementById('taskDetailMode').textContent =
        (task.execution_mode === 'resume' ? '恢复会话' : '新会话') +
        (task.dangerously_skip_permissions ? ' · 无确认' : '');
    document.getElementById('taskDetailPrompt').textContent = task.prompt;

    // Actions
    const actionsEl = document.getElementById('taskDetailActions');
    const running = task.runningCount > 0;
    actionsEl.innerHTML = `
        <button class="btn btn-new" style="padding:4px 12px;font-size:12px;" onclick="triggerTask('${escapeHtml(task.id)}')">触发</button>
        ${running ? `<button class="btn btn-kill" style="display:inline;padding:4px 12px;font-size:12px;" onclick="cancelTask('${escapeHtml(task.id)}')">取消运行</button>` : ''}
        <button class="btn" style="padding:4px 12px;font-size:12px;color:var(--c-text-muted);border:1px solid var(--c-border);" onclick="toggleTaskEnabled('${escapeHtml(task.id)}', ${task.enabled ? 0 : 1})">${task.enabled ? '禁用' : '启用'}</button>
        <button class="btn btn-kill" style="display:inline;padding:4px 12px;font-size:12px;" onclick="doDeleteTask('${escapeHtml(task.id)}')">删除</button>
    `;

    document.getElementById('taskLogContainer').style.display = 'none';
    document.getElementById('taskLogViewer').textContent = '';
    // Also clean up truncation hints
    document.getElementById('taskLogContainer').querySelectorAll('.truncation-hint').forEach(el => el.remove());
    document.getElementById('taskDetailModal').classList.add('open');
    loadTaskRuns(task.id);
}

function closeTaskDetailModal() {
    document.getElementById('taskDetailModal').classList.remove('open');
    currentTaskDetail = null;
}

async function loadTaskRuns(taskId) {
    const listEl = document.getElementById('taskRunList');
    try {
        const res = await authFetch(`/api/tasks/${taskId}/runs?limit=10`);
        if (!res.ok) throw new Error();
        const runs = await res.json();
        if (runs.length === 0) {
            listEl.innerHTML = '<div style="color:var(--c-text-dim);font-size:12px;padding:6px;">暂无运行记录</div>';
            return;
        }
        listEl.innerHTML = runs.map(r => {
            const time = r.started_at ? formatTime(r.started_at) : '--';
            const hasSession = r.session_id && r.status === 'running';
            return `<div class="run-item">
                <div style="display:flex;align-items:center;gap:6px;">
                    <span class="run-status ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
                    <span style="color:var(--c-text-dim);font-size:11px;">${time}</span>
                </div>
                <div style="display:flex;gap:4px;">
                    ${hasSession ? `<button class="btn" style="padding:2px 6px;font-size:10px;color:var(--c-accent);border:1px solid var(--c-accent);" onclick="attachTaskRun('${escapeHtml(taskId)}')">attach</button>` : ''}
                    <button class="btn" style="padding:2px 6px;font-size:10px;color:var(--c-text-muted);border:1px solid var(--c-border);" onclick="viewRunLog('${escapeHtml(r.id)}')">日志</button>
                    ${r.status !== 'running' ? `<button class="btn" style="padding:2px 6px;font-size:10px;color:var(--c-red,#ef5350);border:1px solid var(--c-red,#ef5350);" onclick="deleteTaskRun('${escapeHtml(taskId)}','${escapeHtml(r.id)}')" title="删除此记录和日志">✕</button>` : ''}
                </div>
            </div>`;
        }).join('');
    } catch {
        listEl.innerHTML = '<div style="color:var(--c-red);font-size:12px;">加载失败</div>';
    }
}

async function viewRunLog(runId) {
    const container = document.getElementById('taskLogContainer');
    const viewer = document.getElementById('taskLogViewer');
    container.style.display = 'block';
    // Clean up previous truncation hints
    container.querySelectorAll('.truncation-hint').forEach(el => el.remove());
    viewer.textContent = '加载中...';
    try {
        const res = await authFetch(`/api/tasks/runs/${runId}/log`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        let log = data.log || '';
        // Clean up any remaining control chars on frontend
        log = log.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
        viewer.textContent = log || '(无日志)';
        if (data.truncated) {
            const hint = document.createElement('div');
            hint.className = 'truncation-hint';
            hint.style.cssText = 'color:var(--c-warn,#ffa726);font-size:10px;margin-bottom:4px;';
            hint.textContent = `⚠ 日志已截断，仅显示最后 ${Math.round(data.totalSize/1024)}KB 中的尾部`;
            viewer.parentNode.insertBefore(hint, viewer);
        }
        // Auto-scroll to bottom
        viewer.scrollTop = viewer.scrollHeight;
    } catch {
        viewer.textContent = '加载失败';
    }
}

async function deleteTaskRun(taskId, runId) {
    try {
        const res = await authFetch(`/api/tasks/runs/${runId}`, { method: 'DELETE' });
        if (!res.ok) { const d = await res.json(); showToast(d.error || '删除失败'); return; }
        showToast('记录已删除');
        document.getElementById('taskLogContainer').style.display = 'none';
        loadTaskRuns(taskId);
    } catch (e) {
        showToast('删除失败: ' + e.message);
    }
}

async function triggerTask(taskId) {
    // Simple debounce via flag
    if (triggerTask._pending) return;
    triggerTask._pending = true;
    try {
        const res = await authFetch(`/api/tasks/${taskId}/trigger`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || '触发失败'); return; }
        showToast('任务已触发');
        setTimeout(loadTasks, 1000);
    } catch (e) {
        showToast('触发失败: ' + e.message);
    } finally {
        triggerTask._pending = false;
    }
}

async function cancelTask(taskId) {
    try {
        const res = await authFetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
        if (!res.ok) { const d = await res.json(); showToast(d.error || '取消失败'); return; }
        showToast('已取消运行');
        await loadTasks();
        if (currentTaskDetail && currentTaskDetail.id === taskId) {
            showTaskDetail(taskId);
        }
    } catch (e) {
        showToast('取消失败: ' + e.message);
    }
}

function attachTaskRun(taskId) {
    const task = tasksCache.find(t => t.id === taskId);
    if (!task || !task.latestRun || !task.latestRun.session_id) {
        showToast('无运行中的会话');
        return;
    }
    closeTaskDetailModal();
    // Set project context
    const project = projectsCache.find(p => p.id === task.project_id);
    if (project) {
        currentProject = project;
        document.getElementById('projectTitle').textContent = project.name;
        document.getElementById('headerProjectPath').textContent = project.path;
        document.getElementById('projectSwitchLabel').textContent = project.name;
    }
    switchSession(task.latestRun.session_id, task.project_id);
}

async function toggleTaskEnabled(taskId, enabled) {
    try {
        const res = await authFetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        if (!res.ok) { const d = await res.json(); showToast(d.error || '操作失败'); return; }
        showToast(enabled ? '任务已启用' : '任务已禁用');
        await loadTasks();
        if (currentTaskDetail && currentTaskDetail.id === taskId) {
            showTaskDetail(taskId);
        }
    } catch (e) {
        showToast('操作失败: ' + e.message);
    }
}

async function doDeleteTask(taskId) {
    if (!confirm('确定删除此任务？运行记录和日志也将一并删除。')) return;
    try {
        const res = await authFetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        if (!res.ok) { const d = await res.json(); showToast(d.error || '删除失败'); return; }
        showToast('任务已删除');
        closeTaskDetailModal();
        loadTasks();
    } catch (e) {
        showToast('删除失败: ' + e.message);
    }
}

// ---- 任务管理面板（独立入口）----

function toggleTaskPanel() {
    const modal = document.getElementById('taskPanelModal');
    if (modal.classList.contains('open')) {
        closeTaskPanel();
    } else {
        openTaskPanel();
    }
}

async function openTaskPanel() {
    await loadTasks();
    renderTaskPanel();
    document.getElementById('taskPanelModal').classList.add('open');
}

function closeTaskPanel() {
    document.getElementById('taskPanelModal').classList.remove('open');
}

function renderTaskPanel() {
    const el = document.getElementById('taskPanelList');
    if (!el) return;
    if (tasksCache.length === 0) {
        el.innerHTML = '<div style="color:var(--c-text-dim);font-size:13px;padding:16px;text-align:center;">暂无定时任务，点击右上角「+ 新建」创建</div>';
        return;
    }
    el.innerHTML = renderTaskItems(tasksCache, "closeTaskPanel();");
}

// 启动时检查认证状态
checkAuth();
