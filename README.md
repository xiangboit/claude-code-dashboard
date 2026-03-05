# Claude Code Remote Dashboard

远程管理 Mac Mini 上的 Claude Code 项目，支持动态项目管理和使用统计。

## 功能特性

- 📁 **动态项目管理** - 添加/删除项目，自动记录使用频率
- 🔥 **智能排序** - 按使用次数和最近使用时间排序
- 🔗 **Gitee 集成** - 直接跳转到 Gitee 仓库
- 📊 **Git 状态监控** - 实时查看工作区状态
- ⬇️⬆️ **Git 操作** - Pull/Push 一键操作
- 🤖 **Claude Code 执行** - 远程执行 AI 编程任务
- 💾 **JSON 文件存储** - 持久化存储项目信息和统计数据

## 安装部署

### 1. 本地开发
```bash
cd /tmp/claude-code-dashboard
npm install
npm start
```

访问: http://localhost:3000

### 2. 部署到 Mac Mini
```bash
# 打包项目
cd /tmp/claude-code-dashboard
tar czf dashboard.tar.gz --exclude=node_modules --exclude=.git --exclude=projects.db *

# 复制到 Mac Mini
scp dashboard.tar.gz mac:~/projects/

# SSH 到 Mac Mini 安装
ssh mac
cd ~/projects
mkdir -p claude-code-dashboard
cd claude-code-dashboard
tar xzf ../dashboard.tar.gz
npm install
npm start
```

### 3. 配置 systemd 服务（可选）
```bash
# 在 Mac Mini 上创建服务文件
sudo tee /Library/LaunchDaemons/com.claude.dashboard.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/xiangbo/projects/claude-code-dashboard/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/dashboard.error.log</string>
</dict>
</plist>
EOF

sudo launchctl load /Library/LaunchDaemons/com.claude.dashboard.plist
```

## 配置说明

### SSH 配置
编辑 `server.js` 中的 SSH 配置：
```javascript
const sshConfig = {
  host: '100.116.75.114',  // Mac Mini IP
  username: 'xiangbo',
  privateKeyPath: '/root/.ssh/id_rsa'
};
```

### 数据存储
- 位置: `./projects.json`
- 格式: JSON
- 自动创建
- 首次启动会初始化默认项目

## 使用方法

### 添加项目
1. 点击左上角 **+ 添加** 按钮
2. 填写项目信息：
   - **项目 ID**: 唯一标识（如 `my-project`）
   - **项目名称**: 显示名称
   - **项目路径**: Mac Mini 上的路径（如 `~/projects/my-project`）
   - **Gitee 地址**: 可选
   - **项目描述**: 可选

### 使用项目
1. **选择项目** - 点击左侧项目卡片
2. **查看统计** - 显示使用次数和最后使用时间
3. **Git 操作** - Pull/Push 代码
4. **执行任务** - 输入任务描述，让 Claude Code 执行

### 删除项目
- 鼠标悬停在项目卡片上，点击右上角 **删除** 按钮

## 数据结构

```json
[
  {
    "id": "project-id",
    "name": "Project Name",
    "path": "~/projects/project-path",
    "gitee": "https://gitee.com/username/repo",
    "description": "Project description",
    "use_count": 0,
    "last_used_at": 0,
    "created_at": 1234567890
  }
]
```

## 技术栈

- **后端**: Node.js + Express + node-ssh
- **前端**: 原生 HTML/CSS/JavaScript
- **数据存储**: JSON 文件
- **远程执行**: SSH + Claude Code CLI

## 注意事项

- 确保 Mac Mini 上已安装 Claude Code
- 确保 SSH 密钥已配置（免密登录）
- 项目路径使用 `~` 开头会自动展开为用户目录
- 数据文件 `projects.json` 会自动创建在项目根目录

## 更新日志

### v2.0.0 (2026-03-05)
- ✅ 动态项目管理（添加/删除）
- ✅ JSON 文件持久化存储
- ✅ 使用频率统计
- ✅ 智能排序（按使用次数和时间）
- ✅ 最后使用时间显示

### v1.0.0 (2026-03-05)
- ✅ 项目快速启动
- ✅ Gitee 集成
- ✅ Git 状态监控
- ✅ Git Pull/Push 操作
- ✅ Claude Code 远程执行
