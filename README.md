# SSH MCP 工具

[![ISC License](https://img.shields.io/badge/License-ISC-718096?style=flat-square)](https://opensource.org/licenses/ISC)
[![Node.js](https://img.shields.io/badge/Node.js-18.x-339933?style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![SSH](https://img.shields.io/badge/SSH-MCP-0078d7?style=flat-square)](https://github.com/shuakami/mcp-ssh)

[English Version (README-EN.md)](README-EN.md)

## 这是什么

这是一个基于 MCP (Model Context Protocol) 的 SSH 工具，它能让 AI 模型通过标准化接口访问和管理 SSH 连接。

简单来说，它让 AI 助手能够执行各种 SSH 操作，如连接服务器、执行命令、管理文件等，无需用户手动输入复杂的命令或切换到终端。

<details>
<summary><b>支持的功能</b> (点击展开)</summary>

- **连接管理**：创建、获取、列表、更新、删除 SSH 连接
- **命令执行**：执行单条命令、复合命令、后台任务
- **tmux 会话管理**：创建、获取、列表、发送按键、捕获输出
- **文件操作**：上传、下载、查看文件内容
- **进程管理**：检测阻塞进程、智能等待、超时处理
- **安全控制**：密码/密钥认证、超时控制、错误处理
- **SSH 配置导入**：从 `~/.ssh/config` 一键导入已有服务器连接
- **可配置安全规则**：用户自定义 allowlist/denylist 覆盖默认安全检查策略
- **SSE 访问控制**：通过 Bearer Token 保护 SSE 端点，防止未授权访问
</details>

<details>
<summary><b>功能特点</b> (点击展开)</summary>

以下是 SSH MCP 工具的一些核心特点：

- **智能命令执行**：自动检测并等待阻塞进程，避免会话卡死
- **tmux 集成**：完整支持 tmux 会话管理，实现持久化终端会话
- **复合命令支持**：智能处理包含 `&&` 和 `;` 的复合命令
- **实时反馈**：命令执行状态实时更新，支持长时间运行的任务
- **错误恢复**：自动处理断线重连、超时等异常情况
- **安全可靠**：支持多种认证方式，保护敏感信息

通过简单的自然语言指令，AI 可以帮助你完成上述所有操作，无需手动编写复杂的 SSH 命令或在终端中执行操作。
</details>

## 快速上手

### 0. 环境准备

<details>
<summary>环境要求 (点击展开)</summary>

1. **Python 3.11+（必需）**
   - 访问 [Python 官网](https://www.python.org/downloads/)
   - 下载并安装 Python 3.11 或更高版本
   - **重要**：安装时请勾选"Add Python to PATH"选项
   - **安装完成后请重启电脑**，确保环境变量生效

2. **Node.js 和 npm**
   - 访问 [Node.js 官网](https://nodejs.org/)
   - 下载并安装 LTS（长期支持）版本
   - 安装时选择默认选项即可，安装包会同时安装 Node.js 和 npm

3. **Git**
   - 访问 [Git 官网](https://git-scm.com/)
   - 下载并安装 Git
   - 安装时使用默认选项即可
   
4. **tmux** (远程服务器需要)
   - 在远程服务器上安装 tmux
   - 对于 Ubuntu/Debian: `sudo apt-get install tmux`
   - 对于 CentOS/RHEL: `sudo yum install tmux`
</details>

### 1. 克隆并安装

```bash
git clone https://github.com/ttdxq/mcp-ssh-safeguard.git
cd mcp-ssh-safeguard
npm install
npm run build
```
> ⚠️ **重要提示**：安装后请不要删除克隆或解压的文件，插件需要持续访问这些文件！

### 2. 构建项目

```bash
npm run build
```

### 3. 添加到 Cursor MCP 配置

根据你的操作系统，按照以下步骤配置 MCP：

<details>
<summary><b>Windows 配置</b> (点击展开)</summary>

1. 在 Cursor 中，打开或创建 MCP 配置文件：`C:\\Users\\你的用户名\\.cursor\\mcp.json`
   - 注意：请将 `你的用户名` 替换为你的 Windows 用户名

2. 添加或修改配置如下：

```json
{
  "mcpServers": {
    "ssh-mcp-safeguard": {
      "command": "pythonw",
      "args": [
        "C:/Users/你的用户名/mcp-ssh-safeguard/bridging_ssh_mcp.py"
      ],
      "env": {
        "DATA_PATH": "",
        "SAVE_HISTORY": "true",
        "DEFAULT_SSH_PORT": "22",
        "CONNECTION_TIMEOUT": "10000",
        "RECONNECT_ATTEMPTS": "3",
        "PASSWORD_EXPIRY_DAYS": "30",
        "COMMAND_TIMEOUT": "60000",
        "OPENAI_API_KEY": "your-api-key-here",
        "OPENAI_API_BASE": "https://api.openai.com/v1",
        "OPENAI_MODEL": "gpt-3.5-turbo",
        "OPENAI_TIMEOUT": "30000",
        "OPENAI_THINKING_TYPE": "disabled",
        "SAFETY_CHECK_ENABLED": "true",
        "MAX_OUTPUT_LENGTH": "3000"
      }
    }
  }
}
```

说明：运行时现在优先读取 `DATA_PATH`，旧的 `SSH_DATA_PATH` 仅作为兼容别名。

说明：Docker 模式默认不会持久化保存密码；只有在明确设置 `ALLOW_INSECURE_DOCKER_CREDENTIALS=true` 时，才会恢复旧的明文保存行为。

说明：AI 安全检查支持通过 `OPENAI_TIMEOUT` 调整模型请求超时，并通过 `OPENAI_THINKING_TYPE=disabled|enabled|auto` 控制供应商的思考能力开关。

说明：兼容 OpenAI 风格和方舟风格变量名；例如 `OPENAI_API_KEY`/`ARK_API_KEY`、`OPENAI_API_BASE`/`ARK_API_BASE`、`OPENAI_MODEL`/`ARK_MODEL` 都可用于初始化 AI 安全检查。

**如何配置基于 AI 的安全检查**

AI 安全检查会在 `executeCommand`、`backgroundExecute`、文件传输、隧道创建和 terminal 写入之前执行。要让它真正生效，至少需要满足下面几个条件：

1. `SAFETY_CHECK_ENABLED` 设为 `true`
2. 提供 API Key：`OPENAI_API_KEY` 或 `ARK_API_KEY`
3. 提供兼容 OpenAI Chat Completions 的接口地址：`OPENAI_API_BASE` 或 `ARK_API_BASE`
4. 提供模型名：`OPENAI_MODEL` 或 `ARK_MODEL`

注意：只有 `SAFETY_CHECK_ENABLED=true` 但没有 API Key 时，运行时不会初始化 AI 安全检查服务。

推荐最小配置：

```json
{
  "OPENAI_API_KEY": "your-api-key",
  "OPENAI_API_BASE": "https://api.openai.com/v1",
  "OPENAI_MODEL": "gpt-4.1-mini",
  "OPENAI_TIMEOUT": "30000",
  "OPENAI_THINKING_TYPE": "disabled",
  "SAFETY_CHECK_ENABLED": "true"
}
```

字段说明：

- `OPENAI_API_KEY`: 必填，AI 提供商的 API Key
- `OPENAI_API_BASE`: 必填，兼容 OpenAI 的接口地址
- `OPENAI_MODEL`: 必填，用于安全检查的模型名
- `OPENAI_TIMEOUT`: 可选，单位毫秒；供应商响应较慢时可以调大
- `OPENAI_THINKING_TYPE`: 可选，支持 `disabled`、`enabled`、`auto`
- `SAFETY_CHECK_ENABLED`: 可选，显式控制是否启用 AI 安全检查

如果你使用兼容 OpenAI 协议的其他供应商，也可以直接使用兼容别名：

```json
{
  "ARK_API_KEY": "your-api-key",
  "ARK_API_BASE": "https://your-provider.example.com/v1",
  "ARK_MODEL": "your-model-name",
  "ARK_TIMEOUT": "30000",
  "ARK_THINKING_TYPE": "disabled",
  "SAFETY_CHECK_ENABLED": "true"
}
```

运行时会优先读取 `OPENAI_*`，如果没提供，再兼容读取 `ARK_*`。两套变量最好不要混着写成不同值。

配置完成后，可以用下面两种请求确认它是否已经生效：

- 低风险命令如 `pwd` 应直接通过
- 高风险命令如 `rm -rf /` 应先被拦截并要求确认，而不是直接发送到远端主机

> ⚠️ **请注意**:
> - 将 `你的用户名` 替换为你的 Windows 用户名
> - 确保路径正确指向你克隆或解压的项目目录
> - 路径应该反映你将项目文件放置的实际位置
> - **不要删除克隆或解压的文件夹**，这会导致 MCP 无法正常工作
</details>

<details>
<summary><b>macOS 配置</b> (点击展开)</summary>

1. 在 Cursor 中，打开或创建 MCP 配置文件：`/Users/你的用户名/.cursor/mcp.json`
   - 注意：请将 `你的用户名` 替换为你的 macOS 用户名

2. 添加或修改配置如下：

```json
{
  "mcpServers": {
    "ssh-mcp-safeguard": {
      "command": "python3",
      "args": [
        "/Users/你的用户名/mcp-ssh-safeguard/bridging_ssh_mcp.py"
      ],
      "env": {
        "DATA_PATH": "",
        "SAVE_HISTORY": "true",
        "DEFAULT_SSH_PORT": "22",
        "CONNECTION_TIMEOUT": "10000",
        "RECONNECT_ATTEMPTS": "3",
        "PASSWORD_EXPIRY_DAYS": "30",
        "COMMAND_TIMEOUT": "60000",
        "OPENAI_API_KEY": "your-api-key-here",
        "OPENAI_API_BASE": "https://api.openai.com/v1",
        "OPENAI_MODEL": "gpt-3.5-turbo",
        "OPENAI_TIMEOUT": "30000",
        "OPENAI_THINKING_TYPE": "disabled",
        "SAFETY_CHECK_ENABLED": "true",
        "MAX_OUTPUT_LENGTH": "3000"
      }
    }
  }
}
```

> ⚠️ **请注意**:
> - 将 `你的用户名` 替换为你的 macOS 用户名
> - 确保路径正确指向你克隆或解压的项目目录
> - 路径应该反映你将项目文件放置的实际位置
> - **不要删除克隆或解压的文件夹**，这会导致 MCP 无法正常工作
</details>

<details>
<summary><b>Linux 配置</b> (点击展开)</summary>

1. 在 Cursor 中，打开或创建 MCP 配置文件：`/home/你的用户名/.cursor/mcp.json`
   - 注意：请将 `你的用户名` 替换为你的 Linux 用户名

2. 添加或修改配置如下：

```json
{
  "mcpServers": {
    "ssh-mcp-safeguard": {
      "command": "python3",
      "args": [
        "/home/你的用户名/mcp-ssh-safeguard/bridging_ssh_mcp.py"
      ],
      "env": {
        "DATA_PATH": "",
        "SAVE_HISTORY": "true",
        "DEFAULT_SSH_PORT": "22",
        "CONNECTION_TIMEOUT": "10000",
        "RECONNECT_ATTEMPTS": "3",
        "PASSWORD_EXPIRY_DAYS": "30",
        "COMMAND_TIMEOUT": "60000",
        "OPENAI_API_KEY": "your-api-key-here",
        "OPENAI_API_BASE": "https://api.openai.com/v1",
        "OPENAI_MODEL": "gpt-3.5-turbo",
        "OPENAI_TIMEOUT": "30000",
        "OPENAI_THINKING_TYPE": "disabled",
        "SAFETY_CHECK_ENABLED": "true",
        "MAX_OUTPUT_LENGTH": "3000"
      }
    }
  }
}
```

> ⚠️ **请注意**:
> - 将 `你的用户名` 替换为你的 Linux 用户名
> - 确保路径正确指向你克隆或解压的项目目录
> - 路径应该反映你将项目文件放置的实际位置
> - **不要删除克隆或解压的文件夹**，这会导致 MCP 无法正常工作
</details>

### 4. 启动服务

配置好之后，重启 Cursor 编辑器，它会自动启动 MCP 服务。然后你就可以开始使用了。

### 5. 配置 SSH 连接

<details>
<summary><b>如何配置 SSH 连接</b> (点击展开)</summary>

1. 在 Cursor 编辑器中，使用 AI 助手创建新的 SSH 连接：
   ```
   请帮我创建一个新的 SSH 连接，连接到我的服务器
   ```

2. AI 助手会引导你提供以下信息：
   - 主机地址（IP 或域名）
   - 端口号（默认 22）
   - 用户名
   - 认证方式（密码或密钥）
   - 其他可选配置（超时时间、密钥路径等）

3. 连接创建后，你可以通过以下命令测试连接：
   ```
   请帮我测试刚才创建的 SSH 连接
   ```
</details>

## 多 Agent 同时使用（SSE 模式）

默认的 stdio 模式下，每个 MCP 客户端会启动一个独立的 Node.js 进程，进程管理器会检测到旧进程并将其终止。这导致**同一个配置只能有一个 agent 正常使用**，新 agent 启动后旧 agent 会被断开。

SSE 模式解决了这个问题：一个常驻的 HTTP 服务器进程可以同时服务多个 agent 客户端。

### 启动 SSE 服务器

```bash
# 先构建项目（如果还没构建）
npm run build

# 启动 SSE 服务器
npm run mcp:sse

# 自定义端口和绑定地址（默认 127.0.0.1:3001）
MCP_SSE_PORT=4000 MCP_SSE_HOST=0.0.0.0 npm run mcp:sse

# 自定义心跳与写回超时
MCP_SSE_HEARTBEAT_INTERVAL=15000 MCP_SSE_WRITE_TIMEOUT=5000 npm run mcp:sse

# 强制指定 SSE 日志语言（zh | en | auto）
MCP_SSE_LOG_LANGUAGE=zh npm run mcp:sse
```

启动后会看到：
```
[SSE] SSH MCP SSE 服务器已启动 → http://127.0.0.1:3001
[SSE] SSE 端点: http://127.0.0.1:3001/sse
[SSE] 健康检查: http://127.0.0.1:3001/health
[SSE] 等待客户端连接...
```

### 客户端 MCP 配置

将原来的 `command` + `args` 配置替换为 `url`：

```json
{
  "mcpServers": {
    "ssh-mcp-safeguard": {
      "url": "http://127.0.0.1:3001/sse"
    }
  }
}
```

如果 SSE 服务器启用了认证（设置了 `MCP_SSE_AUTH_TOKEN`），客户端配置需要附带 token：

```json
{
  "mcpServers": {
    "ssh-mcp-safeguard": {
      "url": "http://127.0.0.1:3001/sse?token=your-secret-token"
    }
  }
}
```

如果需要配置环境变量（API Key 等），在启动 SSE 服务器之前设置：

```bash
OPENAI_API_KEY=your-key OPENAI_API_BASE=https://api.openai.com/v1 OPENAI_MODEL=gpt-4.1-mini npm run mcp:sse
```

或者在项目根目录创建 `.env` 文件：

```env
MCP_SSE_PORT=3001
MCP_SSE_HEARTBEAT_INTERVAL=15000
MCP_SSE_WRITE_TIMEOUT=5000
MCP_SSE_LOG_LANGUAGE=auto
MCP_SSE_AUTH_TOKEN=your-secret-token
OPENAI_API_KEY=your-key
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
SAFETY_CHECK_ENABLED=true
```

### SSE 运行时说明

- `MCP_SSE_HEARTBEAT_INTERVAL`：SSE 心跳间隔，单位毫秒，默认 `15000`
- `MCP_SSE_WRITE_TIMEOUT`：SSE 写回等待 `drain` 的超时，单位毫秒，默认 `5000`
- `MCP_SSE_LOG_LANGUAGE`：SSE 日志语言，支持 `zh`、`en`、`auto`，默认 `auto`
- `MCP_SSE_AUTH_TOKEN`：SSE 访问令牌，设置后所有请求需携带 `Authorization: Bearer <token>` 或 URL 参数 `?token=<token>`；不设置则不启用认证
- SSE 服务器会为长时间空闲的连接持续发送心跳，降低长阻塞命令结果回传时因链路静默而断开的概率
- SSE 写回现在会处理 Node.js 的 backpressure；如果客户端过慢或连接异常，会在日志中记录发送失败
- 当 `MCP_SSE_LOG_LANGUAGE=zh` 或 `en` 时，SSE 日志事件名会强制使用对应语言
- 当 `MCP_SSE_LOG_LANGUAGE=auto`（默认）时，SSE 日志事件名会根据客户端 `Accept-Language` 自动切换：中文客户端输出中文事件名，非中文客户端输出英文事件名

示例日志：

```text
[SSE] 会话已建立 sessionId="..." activeConnections=1
[SSE] 心跳已发送 sessionId="..." activeConnections=1
[SSE] 消息已发送 sessionId="..." messageId="12" processingTimeMs=1834 hasError=false
```

### 多 Agent 同时连接

SSE 服务器启动后，多个 agent 可以同时连接：

| Agent | 行为 |
|-------|------|
| Agent A 连入 | 分配 session-1，正常工作 |
| Agent B 连入 | 分配 session-2，正常工作，**不影响 Agent A** |
| Agent C 连入 | 分配 session-3，正常工作，**不影响 A 和 B** |
| Agent A 断开 | session-1 关闭，**B 和 C 继续正常工作** |

访问 `http://127.0.0.1:3001/health` 可以查看当前活跃连接数。

> **注意**：SSE 模式下所有 agent 共享同一个后端进程的 SSH 连接池和缓存。如果需要完全隔离，请使用 stdio 模式。

### 保持向后兼容

原有的 stdio 模式（`command` + `args` 配置）完全不受影响，无需任何修改。只有在需要多 agent 同时使用时才需要切换到 SSE 模式。

## 使用示例

<details>
<summary><b>基本命令执行</b> (点击展开)</summary>

```
请在服务器上执行 ls -la 命令
```

AI 助手会：
1. 检查现有 SSH 连接
2. 执行命令并返回结果
3. 格式化输出以提高可读性
</details>

<details>
<summary><b>tmux 会话管理</b> (点击展开)</summary>

```
请创建一个新的 tmux 会话并运行 top 命令
```

AI 助手会：
1. 创建新的 tmux 会话
2. 在会话中执行 top 命令
3. 返回会话 ID 供后续使用
</details>

<details>
<summary><b>文件操作</b> (点击展开)</summary>

```
请帮我查看 /var/log/syslog 文件的最后 100 行
```

AI 助手会：
1. 检查文件权限
2. 使用适当的命令读取文件
3. 格式化并返回内容
</details>

## 高级功能

### 阻塞检测

SSH MCP 工具内置了智能的阻塞检测机制：

- 自动检测交互式程序（如 vim、nano）
- 识别后台运行的阻塞进程
- 支持设置等待超时时间（最长10分钟）
- 提供强制执行选项（使用 force 参数）

### 复合命令处理

支持执行包含 `&&` 和 `;` 的复合命令：

- 智能拆分和执行多个命令
- 保持命令执行顺序
- 提供详细的执行状态
- 支持错误处理和回滚

### tmux 集成

完整的 tmux 会话管理支持：

- 创建和管理持久化会话
- 支持发送按键序列
- 实时捕获会话输出
- 智能处理会话状态

### SSH 配置导入

支持从本地 `~/.ssh/config` 文件导入已有的 SSH 连接配置：

- 自动检测平台默认配置路径（Windows/macOS/Linux）
- 跳过通配符 Host 模式（`*`、`?`）
- 通过 `importSSHConfig` 工具一键导入
- 通过 `getSSHConfigPaths` 查看当前平台可用的配置文件路径

### 可配置安全规则

在 AI 安全检查和本地规则之外，支持用户自定义安全规则：

- **allowlist**：匹配的命令直接按指定级别处理，覆盖本地规则
- **denylist**：匹配的命令始终拦截或标记，优先级最高
- 每条规则包含 `pattern`（正则表达式）、`level`（safe/moderate/dangerous）、`reason`（说明）
- 规则持久化到 `DATA_PATH/safety-rules.json`，重启后自动加载
- 通过 `listSafetyRules` 查看当前规则，`updateSafetyRules` 全量更新

使用示例：

```
请将 "kubectl rollout restart" 加入安全规则白名单
请将 "docker system prune" 加入安全规则黑名单
```

## 增强提示设置

为了更好地使用 SSH MCP 工具与远程服务器协作，建议在 Cursor 中添加以下 CursorRules 设置：

<details>
<summary><b>推荐的 CursorRules 设置</b> (点击展开)</summary>

```
在**需要、或可能需要用户协助的**ssh任务时，可创建tmux，一个可共享的终端会话，并直接**告诉用户**可以通过什么命令链接到tmux来和你协作（不要在mcp内告诉用户，你应该输出出来）。然后再开始你的任务。

**你必须在tmux内进行任务。可以使用tmux send-keys相关命令，mcp会自动返回当前运行的命令和上一个运行的命令的结果。**

你应该先查看现有的tmux窗口再做决定。

**注意：在命令运行时必须耐心等待（sleep命令）当前命令，不要/同时/后台/继续执行下一个任务/命令。**

在用户没有明确要求时，你不应该创建帮助文件或者指南/报告文件。尤其是用户在找你帮忙的时候，你应该直接说出来。
```

</details>

添加此设置后，AI 助手将能够更智能地处理 SSH 任务，特别是在需要用户协作的场景中，可以创建共享的 tmux 会话，让远程操作更加高效和透明。

## 工作原理

<details>
<summary>技术实现细节 (点击展开)</summary>

本工具基于 **MCP (Model Context Protocol)** 标准实现，作为 AI 模型与 SSH 服务之间的桥梁。它使用 **node-ssh** 作为底层 SSH 客户端，并通过 **Zod** 进行请求验证和类型检查。

主要技术组件包括：
- **SSH 客户端**：负责建立和维护 SSH 连接，支持密码和密钥认证
- **tmux 管理器**：处理 tmux 会话的创建、管理和交互
- **命令执行系统**：支持单命令、复合命令的执行，并提供阻塞检测
- **进程监控**：实时检测进程状态，避免会话卡死
- **文件传输**：支持上传和下载功能，处理各种文件类型

每个 SSH 操作都被封装为标准化的 MCP 工具，接收结构化参数并返回格式化结果。所有远程命令都经过处理，以确保以人类可读的格式呈现，使 AI 模型能够轻松理解命令执行结果。
</details>

## 贡献指南

欢迎提交 Issue 和 Pull Request！在提交之前，请：

1. 查看现有的 Issue 和 PR
2. 遵循项目的代码风格
3. 添加适当的测试用例
4. 更新相关文档

## 许可证

本项目采用 ISC 许可证 - 详见 [LICENSE](LICENSE) 文件

---

If this project helps you, please give it a Star ⭐️ (｡♥‿♥｡)

