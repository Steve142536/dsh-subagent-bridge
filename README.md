# @local/dsh-subagent-bridge

让外部 Codex CLI 通过 MCP 协议把任务委托给 DSH（DeepSeek Harness）当子代理执行；DSH Web UI 面板实时显示运行中的子代理。

## 功能

- 在宿主 Web 服务的 `<origin>/mcp/dsh-subagent` 暴露 MCP streamable-http 端点（JSON-RPC 2.0，无鉴权，仅宿主 loopback 服务可达）。
- 五个 MCP 工具：
  - `start_task`：启动一个全新 headless DSH 子代理执行任务，立即返回 `taskId`（`cwd` 必须是已存在的绝对路径目录，否则明确报错）；
  - `wait_task`：阻塞等待任务完成并返回最终答案（超时未完则返回当前状态，可继续轮询）；
  - `cancel_task`：取消排队或运行中的任务，任务进入 `cancelled` 状态，`wait_task` 等待方即时获知；
  - `continue_task`：向已完成任务的同一个 DSH 会话发送后续指令，返回新的任务 ID；当前无法向正在运行的任务插话；
  - `list_tasks`：列出近期任务（id、状态、摘要）。
- 每个任务 spawn 一个 headless DSH 进程（`--profile headless --patch <overlay> --json`），任务全文经 stdin 传入，逐行解析 JSON 事件（`session`/`final`/`error`）收集会话与答案。终态判定在 stdio 全部收尾（`close` 事件）后进行：退出码 0 且收到过有效 `final` 且无 `error` 事件才算 `completed`，否则一律 `failed`。
- 任务状态：`queued` → `running` → `completed` / `failed` / `cancelled`。
- 超出 `maxConcurrent` 的任务排队执行；单任务超时 `maxTaskSeconds` 判为失败；终态任务仅保留 `historyLimit` 条。
- 只读端点 `GET /tasks`、`GET /tasks/<id>`、`GET /info` 供 Web 面板轮询（`/info` 返回 `mcpUrl`、`tools`、`activeCount`、`dshReady`）。

## 从 Git 仓库安装

官方仓库：<https://github.com/Steve142536/dsh-subagent-bridge>

方式 A（最稳）：克隆到本地，再按目录安装——

```bash
git clone https://github.com/Steve142536/dsh-subagent-bridge.git
cd dsh-subagent-bridge
```

然后在 DSH 会话里让助手安装本地目录 `<克隆路径>`（见下一节第 3 步）。

方式 B（一步到位）：直接用 Git 地址安装——在 DSH 会话里让助手用 plugin_manager 安装 `git+https://github.com/Steve142536/dsh-subagent-bridge.git#v1.1.0`（tag 固定版本）。若当前版本的插件管理不接受 git 地址，退回方式 A。

## 插件市场索引（原生更新提示）

DSH 的更新提示来自**插件市场索引**：一个放在 https 上的 JSON 清单，DSH 拉取后用语义化版本对比已安装版本，索引里版本更新时插件页显示"更新可用"，可一键安装（自动生成 `git+https://...#<commit>` 安装命令）。

**使用者**（一次性配置）：在 DSH 的插件市场里添加索引 URL：

```
https://raw.githubusercontent.com/Steve142536/dsh-subagent-bridge/main/market-index.json
```

之后"DSH 子代理桥接"会出现在插件页；本仓库每次发新版，已配置索引的用户会看到更新提示。

**维护者**（发版流程）：提交代码 → 打 tag → 在 `market-index.json` 的 `versions` 数组追加新条目（`version` + `publishTimestamp`（Unix 秒）+ `source.commit`（该版本的完整 40 位 commit SHA））→ 提交推送。

## 安装到其他机器

前提：目标机器装有**桌面版 DeepSeek Harness**（子代理启动器依赖桌面版的 Electron 运行时路径，CLI 版 `dsh` 不可用）。

1. 把整个 `dsh-subagent-bridge` 目录拷贝（或解压）到目标机器任意位置，例如 `C:\Users\<你>\dsh-subagent-bridge`。
2. **先改模型配置**：编辑 `headless-credentials.patch.yml`，把其中的提供商（`llm-pi-ai` 的 GLM/Qwen 示例）、`apiKeyEnv` 与 `agent-default-model` 换成你自己的模型配置——该文件决定子代理用哪个模型、从哪个环境变量读 API key。
3. 在 DSH 的任意会话里让助手安装本地插件目录（例："用 plugin_manager 把 `C:\Users\<你>\dsh-subagent-bridge` 安装为 bundle"），按结果提示刷新或重启。
4. 验证：打开 DSH 面板确认左侧栏出现"DSH 子代理"入口，且 `GET /info` 返回 `dshReady: true`。
5. 按下一节把该机器的 MCP 地址填进 Codex。

安全说明：插件包内不含任何 API 密钥（`apiKeyEnv` 只是环境变量名，密钥保存在各机器自己的 `~/.dsh/.credentials.yaml`），可以放心分发。

## Codex 接入方法

1. 获取桥接地址：查看 DSH Web 面板的连接提示，或访问 `GET /info` 读取 `mcpUrl`（形如 `http://127.0.0.1:61139/mcp/dsh-subagent`；端口随宿主启动变化，以 `/info` 为准）。
2. 在 Codex 配置文件（`~/.codex/config.toml`）中把 DSH 添加为 MCP 服务器（以 Codex 当前版本的 streamable HTTP 配置格式为准）：

   ```toml
   [mcp_servers.dsh-subagent]
   url = "http://127.0.0.1:61139/mcp/dsh-subagent"
   ```

3. 在 Codex 会话里说"把这个任务委托给 DSH 子代理"，模型会调用 `start_task`，再用 `wait_task` 轮询直到拿到结果。任务指令必须自包含（子代理看不到 Codex 侧对话，所需路径和上下文都要写进 `task`）。

### 端口变化与自动同步

DSH 的 web 端口每次启动都会变化，会让 Codex 里注册的 MCP 地址失效。桥接插件内置**端点自动同步**：插件激活、web 端口就绪后，自动把 `~/.codex/config.toml` 中 `[mcp_servers.dsh-subagent]` 段的 `url` 刷新为当前端点（该段不存在时自动追加，等效完成首次注册；本机没有 Codex 配置则跳过）。因此**重启 DSH 后无需手动重新注册**，新开一个 Codex 会话即可使用。设置对话框的"DSH 子代理"分区会显示每次同步的状态（`已写入当前端点` / `端点已是最新` 等）。

## 配置

### 设置对话框配置（推荐）

DSH 设置对话框 →"DSH 子代理"分区，保存到 `~/.dsh/subagent-bridge.config.json`，**保存后立即生效**（无需重启 DSH）：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| 子代理模型 | 跟随 DSH 默认模型 | 自定义 `provider/model` 时，启动 headless 子代理时覆盖默认模型 |
| 同时运行子代理上限 | `8`（1–64） | 超出后排队 |
| 单任务超时（秒） | `3600`（60–604800） | 超时判为失败 |
| 历史任务保留条数 | `200`（10–1000） | 面板与 `list_tasks` 保留的历史任务条数 |
| 子代理权限 | 工作区沙箱 | `工作区沙箱`：子代理只能写工作区内文件，访问 WSL/Docker 等会被拦截；`完全权限`：解除全部限制（通过 `DSH_PERMISSION_MODE=danger-full-access` 注入 headless 子进程），子代理可访问本机任意资源。切换后对新任务生效 |

### cordis.patch.yml 的 config（仅 routePath）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `routePath` | `/mcp/dsh-subagent` | HTTP 路由前缀 |

（`maxConcurrent` / `maxTaskSeconds` / `historyLimit` 曾在 patch config 里配置，现已迁到设置对话框，patch 里的残留值会被忽略。）

## 文件说明

- `index.js`：Host 侧入口（MCP 端点 + headless 子进程执行器）。
- `client.js`：Client 侧 Web 面板，显示运行中的子代理。
- `cordis.patch.yml`：bundle 补丁，声明 Host 插件行与默认配置（Client 面板由 package.json 的 `dsh.client` 段自动发现，无需单独插件行）。
- `headless-credentials.patch.yml`：headless 桥接 overlay（恢复凭据 + 用户提供商配置 + 默认模型），spawn 时经 launcher 的 `--patch` 传入。
- `locale/*.json`：`meta` 节供插件管理页展示标题与描述；`panel` 节是 `client.js` 内嵌词典的参考副本（**实际生效的文案在 `client.js` 的 DICTS**，改文案请改 DICTS 并同步副本）。`icon.svg` 为插件图标。
