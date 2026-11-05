# @local/dsh-subagent-bridge

让外部 Codex CLI 通过 MCP 协议把任务委托给 DSH（DeepSeek Harness）当子代理执行；DSH Web UI 面板实时显示运行中的子代理。

当前仓库源码版本为 1.5.0（见 `package.json`）。注意：远程插件市场索引里的已发布版本可能落后于本地源码，本 README 只描述仓库内源码，不代表远程已发布该版本。

## 功能

### MCP 端点与接入

- 在宿主 Web 服务的 `<origin>/mcp/dsh-subagent` 暴露 MCP streamable-http 端点（JSON-RPC 2.0，仅 POST；GET 不提供）。
- **MCP 接入只需 URL，不需要任何令牌或请求头**：桥接鉴权已取消，服务端不再校验 Bearer 令牌。历史版本引入的 `Authorization` 授权头（`http_headers = { "Authorization" = "Bearer <令牌>" }`）若仍留在 Codex 配置里会被原样保留，服务端直接忽略——留着或删掉都不影响接入。
- 桥接面板与只读端点恢复 DSH 原生路由行为，**无插件级鉴权**：不再要求以 DSH owner 身份登录，也不再做额外的浏览器准入判定。
- 旧令牌文件 `~/.dsh/subagent-bridge.token` 不会删除，但服务端已不再读取或校验它；留作历史遗留即可，无需任何处理。
- 任务与配置数据不再有额外的插件级访问门槛：运行期产生的文件（任务历史、插件设置与上述旧令牌文件）都在用户目录 `~/.dsh/` 下，注意不要把任务历史内容粘贴到公开场合。

### 七个 MCP 工具

- `start_task`：启动一个全新 headless DSH 子代理执行任务，立即返回 `taskId`（`cwd` 必须是已存在的绝对路径目录，否则明确报错）。可选参数：
  - `model`：任务级模型覆盖（`provider/model` 格式）；
  - `permissionMode`：任务级权限模式（见下文"权限模型"）；
  - `reasoningEffort`：可选推理力度提示（如 `low`/`medium`/`high`，具体取值取决于提供商；≤64 字符，仅字母/数字/点/下划线/连字符）。指定了它但没有任何可用模型来源时 `start_task` 明确报错，绝不静默丢弃该参数。
- `wait_task`：阻塞等待任务完成并返回最终答案（阻塞时长 10–600 秒，默认 120；超时未完则返回当前状态，运行中附带轮次/步骤进度，可继续轮询）。
- `send_message`：向**运行中**的任务插话，等子代理回执确认后才返回 accepted；失败（发送失败/等待超时/子进程退出/子代理拒绝）如实报错，绝不虚报已送达。`mode` 两种：
  - `steer`（默认）：消息注入当前回合，在代理的**下一步骤**生效；
  - `followup`：消息排队为**下一轮**用户消息，当前回合结束后执行。
  排队中（还没有可寻址会话）与已结束的任务不能插话，会明确报错。
- `interrupt_task`：温和中断**运行中**的任务——子代理取消当前回合（收件箱里尚未消费的消息保留），桥接等到回执确认后才收尾，任务按 `cancelled` 结束（注明温和中断原因）。子进程退出后可用 `continue_task` 续跑同一会话。排队中的任务不支持温和中断（用 `cancel_task`）。
- `cancel_task`：取消排队或运行中的任务，任务立即进入 `cancelled`，`wait_task` 等待方即时获知；运行中的任务整棵进程树被强制终止。**取消后可恢复**：无论是强制取消还是温和中断，只要任务拿到过 sessionId 且子进程已退出，就能用 `continue_task` 续跑同一会话。
- `continue_task`：向**已结束**（completed/failed/cancelled）且有 sessionId 的任务对应的同一 DSH 会话发送后续指令，返回新的 `taskId`。新任务继承前任务的模型与推理力度（任务级超时已移除：即使旧任务记录里固化过 `timeoutSeconds`，续跑的运行期限也一律由全局 `maxTaskSeconds` 决定）；权限模式默认沿用前任务入队时快照的权限，也可传 `permissionMode` 进一步降权，但不得高于原任务的权限快照或当前 DSH 全局权限（绝不提权）；旧版本持久化、缺少权限快照的历史任务，续跑时以 `workspace-write` 为权限上限并有相应提示。原任务的 DSH 进程尚未退出时会拒绝（例如刚 `cancel_task` 完的短暂窗口），稍后重试。
- `list_tasks`：列出近期任务（id、状态、摘要、耗时）。

### 执行模型

- 每个任务 spawn 一个 headless DSH 进程（`--profile headless --patch <overlay> --json`），任务全文经 stdin 传入，逐行解析 JSON 事件（`session`/`status`/`final`/`error`）收集会话、进度与答案。终态判定在 stdio 全部收尾（`close` 事件）后进行：退出码 0 且收到过有效 `final` 且无 `error` 事件才算 `completed`，否则一律 `failed`。
- 任务状态：`queued` → `running` → `completed` / `failed` / `cancelled`。
- 超出 `maxConcurrent` 的任务排队执行（队列上限 200，超出明确报错）；单任务运行期限只由全局 `maxTaskSeconds` 决定（超时判为失败；任务级超时覆盖已移除，`start_task` 显式传入 `timeoutSeconds` 会被明确报错，旧任务记录里固化的值也不影响续跑）；终态任务仅保留 `historyLimit` 条。

### 任务与结果的持久化

- 任务表（含任务全文、状态、最终回答、sessionId 等）原子持久化到 `~/.dsh/subagent-bridge.tasks.json`（同目录临时文件 + rename；新建文件 POSIX 上 0600）。宿主重启后仍可查询旧任务结果，并按旧 `taskId` 用 `continue_task` 续跑会话。
- **崩溃/中断不重跑**：启动时把落盘历史读回内存；宿主中断时还在 `queued`/`running` 的任务恢复后**明确标为 `failed`**（注明"宿主中断，启动时标记失败，未重新执行"），不进队列、不占并发槽、绝不自动重复执行。
- `sessionId` 一上报就立即落盘，续跑凭据不因短暂中断丢失；历史文件损坏、版本不符或条目缺字段时插件加载直接失败（需人工处理），绝不以空历史覆盖原文件。
- 持久化失败绝不静默：写盘失败记入健康状态并打进宿主 stderr，可经 `GET /info` 与 `wait_task` 快照看到。

### 权限模型（权限默认来自 DSH 全局，而非 Codex）

- 子代理权限**从不自动继承调用方**：Codex 的沙箱/权限设置不会带进 DSH 子代理。
- 默认权限来自 **DSH 全局设置**（设置对话框"DSH 子代理"分区）：`工作区沙箱`（对应 DSH `workspace-write`，默认，工作区外的访问如 WSL/Docker 会被拦截）或 `完全权限`（`danger-full-access`，解除全部限制）。切换后对新任务生效，运行中的任务不受影响。
- `start_task` 可传任务级 `permissionMode`（`read-only` / `workspace-write` / `danger-full-access`）：只允许**等于或低于**当前 DSH 全局权限——例如全局是工作区沙箱时请求完全权限会明确报错；不传则跟随全局。任务在入队时快照当时生效的权限；排队等待期间若全局权限被调低，任务会在启动前明确失败，绝不注入高于当前全局的权限。
- Codex 聊天上下文不会自动传给子代理：任务指令必须自包含，所需路径、上下文、验收标准都要显式写进 `task`。

### Web 面板

- 面板（`client.js`，DSH 侧边栏"DSH 子代理"入口）轮询 `GET /tasks`、`GET /tasks/<id>`、`GET /info` 展示任务列表与详情；设置分区读写 `GET/POST /config`。这些端点恢复 DSH 原生路由行为，无插件级鉴权（不再要求 DSH owner 登录）。
- `/info` 返回 `mcpUrl`、`tools`、`activeCount`、`dshReady`，以及 `codexSync`（Codex 配置自动同步状态）和 `persistence`（任务持久化健康状态）。

## 从 Git 仓库安装

官方仓库：<https://github.com/Steve142536/dsh-subagent-bridge>

方式 A（最稳）：克隆到本地，再按目录安装——

```bash
git clone https://github.com/Steve142536/dsh-subagent-bridge.git
cd dsh-subagent-bridge
```

然后在 DSH 会话里让助手安装本地目录 `<克隆路径>`（见下一节第 3 步）。注意：1.5.0 是本仓库**本地源码**的当前版本（见 `package.json`）；远程仓库默认分支与标签上的版本未逐一核实，克隆得到的内容以克隆时仓库实际状态为准，不保证就是 1.5.0。

方式 B（远程 Git 地址安装）：在 DSH 会话里让助手用 plugin_manager 安装 `git+https://github.com/Steve142536/dsh-subagent-bridge.git#<tag>`（tag 固定版本）。注意远程仓库与市场索引中的已发布版本可能落后于本地最新源码，本 README 描述的 1.5.0 不一定已有对应的远程 tag；想要最新行为请用方式 A。

## 插件市场索引（原生更新提示）

DSH 的更新提示来自**插件市场索引**：一个放在 https 上的 JSON 清单，DSH 拉取后用语义化版本对比已安装版本，索引里版本更新时插件页显示"更新可用"，可一键安装（自动生成 `git+https://...#<commit>` 安装命令）。

**使用者**（一次性配置）：在 DSH 的插件市场里添加索引 URL：

```
https://raw.githubusercontent.com/Steve142536/dsh-subagent-bridge/main/market-index.json
```

之后"DSH 子代理桥接"会出现在插件页；本仓库每次发新版并把条目追加进索引，已配置索引的用户会看到更新提示。

**维护者**（发版流程）：提交代码 → 打 tag → 在 `market-index.json` 的 `versions` 数组追加新条目（`version` + `publishTimestamp`（Unix 秒）+ `source.commit`（该版本的完整 40 位 commit SHA））→ 提交推送。在索引条目追加之前，新版本不会推送给任何使用者。

## 安装到其他机器

前提：目标机器装有**桌面版 DeepSeek Harness**（子代理启动器依赖桌面版的 Electron 运行时路径，CLI 版 `dsh` 不可用）。

1. 把整个 `dsh-subagent-bridge` 目录拷贝（或解压）到目标机器任意位置，例如 `C:\Users\<你>\dsh-subagent-bridge`。
2. **模型配置**：无需修改插件包内的任何文件——headless 子代理的提供商/模型配置在 spawn 时动态读取 `~/.dsh/profiles/desktop/cordis.patch.yml`（宿主 desktop profile 的用户层 patch，原文拼进 overlay），因此子代理默认沿用桌面端 DSH 同一套提供商与模型；凭据不经由该 patch 文件提供，而由 DSH 现有凭据机制在 headless 子进程内恢复（overlay 显式启用 credentials/authorization 等内置凭据插件）；子代理用哪个模型可在 DSH 设置对话框的"DSH 子代理"分区选择（默认跟随 DSH 默认模型）。
3. 在 DSH 的任意会话里让助手安装本地插件目录（例："用 plugin_manager 把 `C:\Users\<你>\dsh-subagent-bridge` 安装为 bundle"），按结果提示刷新或重启。
4. 验证：打开 DSH 面板确认左侧栏出现"DSH 子代理"入口，且 `GET /info` 返回 `dshReady: true`。
5. 按下一节把该机器的 MCP 地址接入 Codex。

安全说明：插件包内不含任何 API 密钥或真实端点。提供商/模型配置来自各机器自己的 `~/.dsh/profiles/desktop/cordis.patch.yml`（spawn 时才拼进 overlay）；凭据不在该 patch 文件中，由 DSH 现有凭据机制在运行时恢复。可以放心分发。运行期产生的文件（任务历史、插件设置与旧版令牌文件）都在用户目录 `~/.dsh/` 下，不随插件包分发。

## Codex 接入方法

**推荐：全自动接入，不手动注册。** 桥接插件激活、DSH Web 端口就绪后，若 `~/.codex/config.toml` 已存在，会自动把其中 `[mcp_servers.dsh-subagent]` 段的 `url` 刷新为当前端点；该段不存在时自动追加，等效完成首次注册。**同步只更新 `url` 行**，段内已有配置——包括旧版本写入的 `http_headers`（Authorization）授权头——一律原样保留、不覆盖不删除；桥接鉴权已取消，服务端直接忽略该授权头，接入只需要 URL。若该文件不存在（本机未安装或未运行过 Codex），同步会跳过、不写入任何注册——请先安装并运行一次 Codex 生成配置文件，再重启 DSH 重试。自动同步是否成功以 DSH 设置对话框中显示的同步状态为准，确认同步成功后重载 MCP 配置或重新打开会话后验证。

> **MCP 接入只需 URL，不需要任何令牌或请求头。** 历史版本的 Bearer 鉴权已取消：旧配置里保留的 `Authorization` 授权头会被服务端忽略，无需读取、填写或清理它，也不要把令牌内容粘贴到对话、截图等场合。不建议手工执行 `codex mcp add` 或手动编辑 config.toml 去管理这一段——交给桥接自动同步；若接入不通，到 DSH 设置的"DSH 子代理"分区查看同步状态，处理后重启 DSH 重试。

确实必须手动处理时的最小配置形态（`~/.codex/config.toml`，仅供参考）：

```toml
[mcp_servers.dsh-subagent]
url = "http://127.0.0.1:61139/mcp/dsh-subagent"
```

旧版本留下的 `http_headers = { "Authorization" = "Bearer <令牌>" }` 行可以保留（服务端忽略它），也可以删除，都不影响接入。端口随 DSH 启动变化，手动填的地址很快失效——配置能跑通后建议恢复让桥接自动同步接管；端口变化后重载 Codex 会话即可按新地址连接。

### 端口变化与自动同步

- DSH 的 web 端口每次启动都会变化。桥接在端口就绪后自动同步（就绪前每秒探测最多 60 秒，之后每 30 秒重试直到就绪）；**只改动 `[mcp_servers.dsh-subagent]` 段里的 `url` 行**，段内其余配置（包括旧版本生成的 `http_headers` inline 表）原样保留、不覆盖不删除；本机没有 `~/.codex/config.toml` 则跳过同步、不写入任何注册（面板与设置分区会显示 skipped 状态，视为未安装 Codex）。
- **端口变化后需要重载 Codex**：自动同步只负责把新地址写进 config.toml，已经运行的 Codex 会话不会自动感知 URL 变化；重启 DSH 后请重载 Codex（新开会话或重载 MCP 配置）再继续委托任务。
- 设置对话框的"DSH 子代理"分区显示每次同步的状态（`已写入当前端点 URL` / `配置已是最新` / `已自动写入 Codex 配置` / `未找到 ~/.codex/config.toml` / `同步失败` 等）；接入前请先核对该状态，不要默认同步一定成功。

## 配置

### 设置对话框配置（推荐）

DSH 设置对话框 →"DSH 子代理"分区，保存到 `~/.dsh/subagent-bridge.config.json`，**保存后立即生效**（无需重启 DSH）：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| 子代理模型 | 跟随 DSH 默认模型 | 自定义 `provider/model` 时，启动 headless 子代理时覆盖默认模型 |
| 同时运行子代理上限 | `20`（1–64） | 超出后排队 |
| 单任务超时（秒） | `600000`（60–604800，约 6.9 天） | 超时判为失败 |
| 历史任务保留条数 | `200`（10–1000） | 面板与 `list_tasks` 保留的历史任务条数 |
| 子代理权限 | 工作区沙箱 | `工作区沙箱`：子代理只能写工作区内文件，访问 WSL/Docker 等会被拦截（对应 DSH `workspace-write`）；`完全权限`：解除全部限制（`danger-full-access`），子代理可访问本机任意资源。这是子代理权限的**默认来源（DSH 全局）**，与 Codex 自身的权限设置无关；切换后对新任务生效 |

任务级可选参数（`start_task` 的 `permissionMode` 与 `reasoningEffort`，以及任务级 `model` 覆盖）不在此配置，见"功能"一节。任务级 `timeoutSeconds` 已移除：任务运行期限一律由全局 `maxTaskSeconds` 决定。

### cordis.patch.yml 的 config（仅 routePath）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `routePath` | `/mcp/dsh-subagent` | HTTP 路由前缀 |

（`maxConcurrent` / `maxTaskSeconds` / `historyLimit` 曾在 patch config 里配置，现已迁到设置对话框，patch 里的残留值会被忽略。）

## 数据文件（都在用户目录）

- `~/.dsh/subagent-bridge.token`：历史版本的 MCP Bearer 令牌文件（首次启动自动生成）。当前版本已取消桥接鉴权，服务端不再读取或校验它；文件不会自动删除，留着不影响任何功能，也可以自行删除。
- `~/.dsh/subagent-bridge.tasks.json`：任务与结果历史（含任务全文与最终回答原文）。
- `~/.dsh/subagent-bridge.config.json`：插件设置（模型/权限/限额）。
- 任务历史包含任务全文与最终回答原文：不要把其中的内容粘贴到公开的对话、issue 或截图里。

## 文件说明

随插件分发（`package.json` 的 `files`）：

- `index.js`：Host 侧入口——MCP 端点与请求调度（桥接鉴权已取消，接入只需 URL）、七个工具实现、headless 子进程执行器、任务持久化、Codex 配置自动同步（仅同步端点 URL，不覆盖段内已有配置）、设置读写端点。
- `headless-control.js`：经 overlay 注入 headless 子进程的控制插件，在子进程内监听 IPC 控制指令（`steer`/`followup`/`interrupt`）并路由到会话代理。
- `bridge-ipc.js`：Host 侧 IPC 控制通道封装（`send_message`/`interrupt_task` 的父进程侧，按 id 匹配回执）。
- `client.js`：Client 侧 Web 面板——任务列表/详情、Codex 同步状态、设置分区（文案词典 DICTS 在此文件内）。
- `cordis.patch.yml`：bundle 补丁，声明 Host 插件行与 `routePath` 默认配置（Client 面板由 package.json 的 `dsh.client` 段自动发现，无需单独插件行）。
- `locale/*.json`：`meta` 节供插件管理页展示标题与描述；`panel` 节是 `client.js` 内嵌词典的参考副本（**实际生效的文案在 `client.js` 的 DICTS**，改文案请改 DICTS 并同步副本）。
- `icon.svg`：插件图标。

仓库内、不随插件分发：

- `tests/`：Node 内置 test runner 的测试（security / bridge-ipc / persistence 等）。
- `market-index.json`：插件市场索引（远程 https 清单的仓库源文件，维护者发版时更新）。
- `.tmp-inspect/`：开发期留存的宿主源码临时检查副本，仅参考用，不属于插件。

headless 桥接 overlay：不在仓库内，spawn 时动态生成并经 launcher 的 `--patch` 传入——其中显式启用 credentials/authorization/deepseek-account 等内置凭据插件（凭据由 DSH 现有凭据机制恢复，overlay 文件本身不含凭据内容），并拼接 `~/.dsh/profiles/desktop/cordis.patch.yml`（desktop profile 用户层 patch）原文以提供提供商/模型配置，任务级模型与 `reasoningEffort` 写入 `agent-default-model` 段，并注入 `headless-control.js` 控制插件。
