# @local/dsh-subagent-bridge

让外部 Codex CLI 通过 MCP 协议把任务委托给 DSH（DeepSeek Harness）当子代理执行；DSH Web UI 面板实时显示运行中的子代理。

## 功能

- 在宿主 Web 服务的 `<origin>/mcp/dsh-subagent` 暴露 MCP streamable-http 端点（JSON-RPC 2.0，无鉴权，仅宿主 loopback 服务可达）。
- 三个 MCP 工具：
  - `start_task`：启动一个全新 headless DSH 子代理执行任务，立即返回 `taskId`；
  - `wait_task`：阻塞等待任务完成并返回最终答案（超时未完则返回当前状态，可继续轮询）；
  - `list_tasks`：列出近期任务（id、状态、摘要）。
- 每个任务 spawn 一个 headless DSH 进程（`--profile headless --patch <overlay> --json`），任务全文经 stdin 传入，逐行解析 JSON 事件（`session`/`final`/`error`）收集会话与答案。
- 超出 `maxConcurrent` 的任务排队执行；单任务超时 `maxTaskSeconds` 判为失败；终态任务仅保留 `historyLimit` 条。
- 只读端点 `GET /tasks`、`GET /tasks/<id>`、`GET /info` 供 Web 面板轮询（`/info` 返回 `mcpUrl`、`tools`、`activeCount`、`dshReady`）。

## 从 Git 仓库安装

把本目录推送到 Git 仓库后，其他人可从 Git 安装：

方式 A（最稳）：克隆到本地，再按目录安装——

```bash
git clone <仓库地址>
cd dsh-subagent-bridge
```

然后在 DSH 会话里让助手安装本地目录 `<克隆路径>`（见下一节第 3 步）。

方式 B（一步到位）：直接用 Git 地址安装——在 DSH 会话里让助手用 plugin_manager 安装 `git+https://github.com/<你>/<仓库>.git`（可加 `#v1.0.0` 固定 tag）。若当前版本的插件管理不接受 git 地址，退回方式 A。

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

## 配置字段（cordis.patch.yml 的 config）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `routePath` | `/mcp/dsh-subagent` | HTTP 路由前缀 |
| `maxConcurrent` | `4` | 同时运行的子代理数上限，超出后排队 |
| `maxTaskSeconds` | `1800` | 单个任务最长执行秒数，超时判为失败 |
| `historyLimit` | `50` | 面板与 `list_tasks` 保留的历史任务条数 |

## 文件说明

- `index.js`：Host 侧入口（MCP 端点 + headless 子进程执行器）。
- `client.js`：Client 侧 Web 面板，显示运行中的子代理。
- `cordis.patch.yml`：bundle 补丁，声明 Host 插件行与默认配置（Client 面板由 package.json 的 `dsh.client` 段自动发现，无需单独插件行）。
- `headless-credentials.patch.yml`：headless 桥接 overlay（恢复凭据 + 用户提供商配置 + 默认模型），spawn 时经 launcher 的 `--patch` 传入。
- `locale/*.json`、`icon.svg`：面板文案与图标。
