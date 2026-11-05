// ============================================================================
// @local/dsh-subagent-bridge — Host 侧入口
//
// 职责：
// 1. 在宿主 webServer 上注册 HTTP 前缀路由，对外暴露 MCP streamable-http 端点
//    （JSON-RPC 2.0，端点不做鉴权，凭 URL 即可调用），供 Codex 委托任务；
// 2. 把每个任务 spawn 成一个 headless DSH 子进程执行，限制并发、超时与历史条数；
// 3. 提供 /tasks、/tasks/<id>、/info 三个只读 JSON 端点，供 Web 面板轮询展示；
// 4. 把任务状态历史原子持久化到 USERPROFILE/.dsh/subagent-bridge.tasks.json，
//    宿主重启后仍可查询旧任务结果、按旧 taskId 续跑会话；中断时还在
//    queued/running 的任务恢复后明确标为 failed，绝不自动重复执行。
//
// 仅用 Node 内置模块；config 由 cordis.patch.yml 原样传入 apply 第二参数，
// 因此不导出 Config（省略 schemastery schema，apply 内做防御性默认值）。
// ============================================================================

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 子代理 IPC 控制通道（bridge-ipc.js）：父进程侧封装。经 spawn stdio 的第 4 项
// 'ipc' 通道，向 overlay 注入的 headless-control.js 插件发送 steer/followup/
// interrupt 控制指令并等待同一 id 的 ok/error 回执。
import { createControlChannel } from './bridge-ipc.js';

// Codex 配置同步（codex-sync.js）：把 ~/.codex/config.toml 的
// [mcp_servers.dsh-subagent] 段刷新为当前 MCP 端点（只同步 url，不带鉴权头）。
// 成功返回 { status: 'skipped' | 'created' | 'updated' | 'unchanged' }，
// 失败抛错。
import { syncCodexConfigFile } from './codex-sync.js';

// ---------- 常量 ----------
const PROTOCOL_VERSION_DEFAULT = '2025-06-18';
// 版本与 package.json 保持一致（package.json 由仓库统一维护）
const SERVER_INFO = { name: 'dsh-subagent-bridge', version: '1.5.0' };
const MCP_INSTRUCTIONS =
  'Delegate tasks to DSH subagents. Start tasks and wait for results. Running tasks can receive messages over the control channel: send_message with mode "steer" (default) guides the agent at its next step of the current turn, while mode "followup" queues the message for the next turn after the current one; interrupt_task gracefully cancels the current round, the task then finishes as cancelled and its session can be continued with continue_task once the subprocess has exited. Use cancel_task for an immediate forced cancel, and continue_task for a finished session. Subagent permissions never inherit from the calling agent automatically: pass the restrictions a task needs via start_task permissionMode (Codex sandbox settings do not carry over), and optionally reasoningEffort to steer reasoning depth.';
const BODY_LIMIT = 1024 * 1024;   // MCP 请求体上限 1MB，超限回 413
const STDERR_TAIL_LIMIT = 4000;   // stderr 只保留尾部 4000 字符做失败诊断
const ERROR_TEXT_LIMIT = 2000;    // 对外错误文本截断长度
const SUMMARY_LIMIT = 120;        // list_tasks 任务文本摘要长度
const WAIT_MIN_SECONDS = 10;      // wait_task 阻塞时长下限
const WAIT_MAX_SECONDS = 600;     // wait_task 阻塞时长上限
const WAIT_DEFAULT_SECONDS = 120; // wait_task 默认阻塞时长
const QUEUE_MAX = 200;            // 排队任务上限：防止失控调用方无限入队爆内存
const KILL_GRACE_MS = 5000;       // cancel_task 后 SIGTERM→SIGKILL 的宽限期；
                                  // 宽限到点仍不退出就强杀，保证 close 事件一定到来，
                                  // 并发槽才不会永久挂起
// 控制通道请求等待回执的上限：steer/followup 的 ack（子代理接受消息）与
// interrupt 的 ack（agent.cancel 执行完成）通常毫秒级；给足余量覆盖子代理
// 繁忙时的处理延迟。到点未收到回执即按失败返回（isError），绝不虚报已送达。
const CONTROL_ACK_TIMEOUT_MS = 15000;
// 温和中断 ack 后等待子进程自行退出的宽限：agent.cancel 打断回合后的收尾
// 通常几秒内完成；到点仍不退出才强杀整棵树，保证并发槽最终释放（与
// cancel_task 的 KILL_GRACE_MS 兜底同型，但给优雅收尾留更长时间）。
const INTERRUPT_GRACE_MS = 30000;
// 任务级权限模式（start_task 的 permissionMode）：与 headless 模板 sandbox-policy
// /permission-presets 的三个 mode 值一一对应。RANK 数值越小权限越低，用于
// "任务级只允许等于或降低当前 DSH 全局权限"的单调比较（绝不允许任务提权）。
const PERMISSION_MODE_RANK = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};
// 任务级推理力度（start_task 的 reasoningEffort）：值会被原样拼进 overlay 的
// YAML（agent-default-model 段的 reasoningEffort 行），换行/冒号/#/引号等字符
// 可能破坏 YAML 结构甚至注入 patch 条目，必须挡在入口——非空、1-64 字符、
// 字母或数字开头，只允许字母/数字/点/下划线/连字符。
const REASONING_EFFORT_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// 插件自身目录：用 import.meta.url 定位，不依赖 process.cwd()；路径含中文目录名
// 也可以直接作为 spawn 参数传给子进程（不经 cmd.exe，无转义问题）。
const pluginDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 模型配置与动态 headless overlay：
// - 子代理的提供商/模型配置继承宿主 desktop profile 的用户层 patch
//   （~/.dsh/profiles/desktop/cordis.patch.yml，spawn 时把它的原文拼进 overlay），
//   因此本仓库不含任何真实端点或密钥；
// - 插件自己的可选覆盖（agentModel，形如 "provider/model"）保存在
//   ~/.dsh/subagent-bridge.config.json（用户级文件，不进仓库），由设置页读写。
// ---------------------------------------------------------------------------
const userPatchPath = path.join(
  process.env.DSH_PROFILE_DIR ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop'),
  'cordis.patch.yml',
);
const configFilePath = path.join(process.env.USERPROFILE ?? '', '.dsh', 'subagent-bridge.config.json');
// Codex CLI 的全局配置；不存在视为本机未安装 Codex，端点同步自动跳过
const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');

function readUserConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {}; // 文件不存在/损坏：视为空配置
  }
}

function writeUserConfig(patchObj) {
  const next = { ...readUserConfig(), ...patchObj };
  fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
  // 原子写：先写同目录临时文件再 rename，进程中途崩溃也不会留下半截 JSON
  const tmpPath = `${configFilePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, configFilePath);
  return next;
}

// "provider/model" → { provider, model }；空串/非法格式返回 null（跟随宿主默认）。
// 两段都做字符白名单：值会被原样拼进 overlay 的 YAML（agent-default-model 行），
// 换行/冒号/# 等字符可能破坏 YAML 结构甚至注入 patch 条目，必须挡在入口。
const AGENT_MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function parseAgentModel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const provider = trimmed.slice(0, slash);
  const model = trimmed.slice(slash + 1);
  if (!AGENT_MODEL_PART.test(provider) || !AGENT_MODEL_PART.test(model)) return null;
  return { provider, model };
}

// 任务级 permissionMode 归一化：只接受 DSH sandbox-policy 的三个 mode 值
// （read-only / workspace-write / danger-full-access），其余一律返回 null，
// 由调用方决定是报错（start_task 显式传了非法值）还是视为未指定（落盘恢复
// 时清洗历史值）。前后空白宽容去除。
function parsePermissionMode(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return Object.hasOwn(PERMISSION_MODE_RANK, trimmed) ? trimmed : null;
}

// 任务级 reasoningEffort 校验：非空安全字符串（白名单见 REASONING_EFFORT_PART）。
// 合法返回 trim 后的值，否则返回 null，由调用方决定报错。
function parseReasoningEffort(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return REASONING_EFFORT_PART.test(trimmed) ? trimmed : null;
}

// 从用户 patch 文本粗解析可用模型（llm-pi-ai providers 段的缩进约定：
// 4 空格 providers: → 6 空格 provider 名 → 10 空格 "- id:" 模型项）。
// 只做文本提取，不执行任何内容；解析不出返回 []，设置 UI 退化为手填。
function parseAvailableModels(text) {
  const providers = [];
  let current = null;
  let inProviders = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!inProviders) {
      if (/^ {4}providers:\s*$/.test(line)) inProviders = true;
      continue;
    }
    if (indent < 4) {
      inProviders = false; // 回到顶层条目，providers 段结束
      current = null;
      continue;
    }
    const providerMatch = line.match(/^ {6}([A-Za-z0-9_-]+):\s*$/);
    if (providerMatch) {
      current = { provider: providerMatch[1], models: [] };
      providers.push(current);
      continue;
    }
    const modelMatch = line.match(/^ {10}- id:\s*(\S+)\s*$/);
    if (modelMatch && current) current.models.push(modelMatch[1]);
  }
  return providers.filter((p) => p.models.length > 0);
}

function availableModels() {
  try {
    return parseAvailableModels(fs.readFileSync(userPatchPath, 'utf8'));
  } catch {
    return [];
  }
}

// 生成 headless overlay 文本：凭据恢复（headless 模板默认禁用，需显式打开）
// + 宿主 desktop 用户层 patch 原文（提供商/模型/子代理配置随宿主走）
// + 可选的 agent-default-model 覆盖（同 id 后写覆盖先写）
// + 控制插件注入（headless-control.js，经 IPC 承载 send_message/interrupt_task）。
// modelOverride 是任务级覆盖（start_task 的 model 参数），优先于全局设置。
// reasoningEffort 是任务级推理力度（start_task 的 reasoningEffort 参数）：只在
// 任务显式指定时随 agent-default-model 段一起写入 overlay；指定了 reasoningEffort
// 却没有任何 provider/model 来源时抛错——toolStartTask 入队时已解析出有效模型
//（存进任务记录），正常不会走到这里，这里是防 reasoningEffort 被静默丢弃的兜底。
function buildOverlayText(modelOverride, reasoningEffort = null) {
  const lines = [
    '# dsh-subagent-bridge generated headless overlay（自动生成，请勿手工编辑）',
    '- id: credentials',
    '  disabled: false',
    '- id: authorization',
    '  disabled: false',
    '- id: deepseek-account',
    '  disabled: false',
  ];
  try {
    const userPatch = fs.readFileSync(userPatchPath, 'utf8');
    if (userPatch.trim()) lines.push(userPatch.replace(/\s+$/, ''));
  } catch {
    // 用户 patch 不可读：仅凭据行，模型走 headless 模板默认
  }
  const override = parseAgentModel(modelOverride) ?? parseAgentModel(readUserConfig().agentModel);
  if (override) {
    lines.push(
      "- id: agent-default-model",
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      `    provider: ${override.provider}`,
      `    model: ${override.model}`,
    );
    // reasoningEffort 行只在任务显式指定时写入；值已过 REASONING_EFFORT_PART
    // 白名单，不会破坏 YAML 结构
    if (reasoningEffort) lines.push(`    reasoningEffort: ${reasoningEffort}`);
  } else if (reasoningEffort) {
    // 兜底：有推理力度但没有模型来源。绝不静默忽略——静默丢参数会让调用方
    // 以为限制生效了，实际子代理用的是完全不同的配置
    throw new Error(
      'reasoningEffort was requested but no provider/model is available for the agent-default-model overlay',
    );
  }
  // 控制插件注入（send_message / interrupt_task 的子代理侧端点）：
  // - name 用 file:// URL：pathToFileURL 会把中文目录名、空格等做 percent
  //   encoding，且 URL 不含双引号，放进 YAML 双引号标量安全；
  // - inject: [agents] 给插件提供 ctx.agents 服务（按 sessionId 查会话代理）；
  // - 与 spawn stdio 的第 4 项 'ipc' 配对：父进程经 bridge-ipc.js 在该通道上
  //   发送 dsh-subagent-control 协议消息，插件在子进程内监听并路由到代理；
  // - insert 条目放在最后追加，不干扰前面的凭据/模型段
  const controlPluginUrl = pathToFileURL(path.join(pluginDir, 'headless-control.js')).href;
  lines.push(
    '- insert:',
    '    - id: dsh-subagent-control',
    `      name: "${controlPluginUrl}"`,
    '      inject: [agents]',
  );
  return `${lines.join('\n')}\n`;
}

// 把 overlay 写进临时文件，返回路径；调用方在子进程退出后删除
function writeTempOverlay(modelOverride = null, reasoningEffort = null) {
  const tmp = path.join(os.tmpdir(), `dsh-subagent-bridge-${process.pid}-${randomBytes(4).toString('hex')}.yml`);
  fs.writeFileSync(tmp, buildOverlayText(modelOverride, reasoningEffort), 'utf8');
  return tmp;
}

// ---------------------------------------------------------------------------
// launcher 解析：等价于官方 dsh.cmd 的直接调用，绕开 cmd.exe 转义。
// process.execPath 是 DeepSeek Harness.exe（Electron），配 ELECTRON_RUN_AS_NODE=1
// 即可把它当纯 Node 运行安装目录里的 cli.js。惰性解析并缓存一次。
// ---------------------------------------------------------------------------
let launcherCache; // undefined=未解析；null=解析失败；{ exe, cliJs }=成功

function resolveLauncher() {
  if (launcherCache !== undefined) return launcherCache;
  launcherCache = null;
  const exe = process.execPath;
  const resourcesDir = path.join(path.dirname(exe), 'resources');
  // 优先 asar 内路径（Host 进程的 fs 能透读 app.asar），失败再试 unpacked 兜底
  const candidates = [
    path.join(resourcesDir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    path.join(resourcesDir, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
  ];
  for (const cliJs of candidates) {
    if (fs.existsSync(cliJs)) {
      launcherCache = { exe, cliJs };
      break;
    }
  }
  return launcherCache;
}

// 终止任务的整棵进程树：Windows 上 child.kill() 只杀 headless 主进程，
// 它派生的工具子进程（shell、构建脚本等）会变孤儿继续占用文件/端口。
// 用 taskkill /T 递归终止整棵树：不带 /F 先温和请求，force 时 /F 强制。
// 非 Windows 平台退回信号量 kill。
function killTaskTree(child, force) {
  if (!child) return;
  const pid = typeof child.pid === 'number' ? child.pid : null;
  if (pid === null || process.platform !== 'win32') {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // 进程可能已退出
    }
    return;
  }
  try {
    spawn('taskkill', force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : undefined);
    } catch {
      // 进程可能已退出
    }
  }
}

// ---------------------------------------------------------------------------
// MCP 工具定义（description 面向模型、英文、简洁准确；JSON Schema draft 风格）
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'start_task',
    description:
      'Start a task in a fresh DSH subagent (a headless DeepSeek Harness run with file and shell tools). Returns a taskId immediately; poll with wait_task for the result. The subagent permission is independent of the caller: Codex sandbox/permission settings do not carry over automatically, so pass the restrictions this task needs via permissionMode.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'Complete, self-contained task instructions for the subagent. It cannot see this conversation; include all paths and context it needs.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for the subagent; defaults to the DSH workspace root.',
        },
        timeoutSeconds: {
          type: 'number',
          description:
            'Optional per-task timeout override in seconds (60-604800). Defaults to the bridge runtime limit configured in DSH settings.',
          minimum: 60,
          maximum: 604800,
        },
        model: {
          type: 'string',
          description:
            'Optional model override for this task, formatted "provider/model" (e.g. "glm/glm-5.3-flash"). Defaults to the model configured in DSH settings.',
        },
        permissionMode: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description:
            'Optional per-task DSH permission mode for the subagent. It never inherits from the calling agent (a Codex sandbox mode does not carry over); when omitted the task snapshots the bridge global DSH subagent permission at enqueue time. Only a mode equal to or lower than the current global permission is accepted: danger-full-access is rejected while the global setting is workspace-write. A queued task keeps its snapshot even if the global permission is raised afterwards; if the global permission is lowered below the snapshot before the task starts, the task fails explicitly instead of silently running with a downgraded mode.',
        },
        reasoningEffort: {
          type: 'string',
          description:
            'Optional reasoning-effort hint for this task (e.g. "low", "medium", "high"; exact values depend on the provider), written into the agent-default-model overlay. Non-empty, at most 64 characters, letters/digits/dot/underscore/dash only. When set without an explicit model, the model resolves to the bridge global agentModel, else to the host default model selection; start_task fails if no default model is available.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_task',
    description:
      'Wait for a DSH subagent task to finish and return its final answer. If it is still running when the timeout elapses, returns the current status; call again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task id returned by start_task.',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Max seconds to block, 10-600; default 120.',
          minimum: 10,
          maximum: 600,
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_task',
    description:
      'Cancel a queued or running DSH subagent task. The task moves to the cancelled state immediately and any wait_task call on it returns right away; its subprocess is killed.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task id returned by start_task.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'interrupt_task',
    description:
      'Gracefully interrupt a running DSH subagent task: the agent cancels its current round (unconsumed inbox messages are kept) and the bridge waits for the acknowledgement before reporting. The task then finishes as cancelled with the interrupt reason, and continue_task can resume the session once the subprocess has fully exited. For an immediate forced kill (or for queued tasks) use cancel_task instead.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task id returned by start_task.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to a running DSH subagent task over its control channel and wait for the subagent acknowledgement. mode "steer" (default) injects the message into the current turn so it takes effect at the agent\'s next step; mode "followup" queues it as a user message for the next turn after the current one finishes. Returns accepted only after the acknowledgement; failures are reported as errors and never claim delivery. Queued tasks have no session yet and cannot receive messages.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task id returned by start_task.',
        },
        message: {
          type: 'string',
          description: 'Message text delivered to the running subagent.',
        },
        mode: {
          type: 'string',
          enum: ['steer', 'followup'],
          description:
            '"steer" (default) steers the current turn at its next step; "followup" runs the message as a new turn after the current one finishes.',
        },
      },
      required: ['taskId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'continue_task',
    description:
      'Continue a finished (completed, failed, or cancelled) DSH task that has a sessionId, in the same session. The new task inherits the previous model, timeout, and reasoningEffort, and runs under the previous task\'s snapshotted permission mode; a legacy task recorded without a snapshot is capped at the safe workspace-write mode. Optionally pass permissionMode equal to or lower than that inherited mode (and never above the current global DSH subagent permission) to run the continuation with tighter restrictions. If the inherited snapshot exceeds the current global permission and no lower permissionMode is passed, the call is rejected instead of silently downgrading. Permissions still do not inherit from the calling agent: pass suitable restrictions on the original start_task. Returns a new taskId; wait for that task. Queued or running tasks cannot be steered, and the call is rejected while the previous task\'s dsh process has not exited yet (e.g. right after cancel_task); retry shortly.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Finished task id whose session should be continued (must have a sessionId).',
        },
        message: { type: 'string', description: 'Follow-up instructions for that session.' },
        permissionMode: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description:
            'Optional permission mode for the continuation task. Must be equal to or lower than the continued task\'s permission mode (workspace-write for legacy tasks without a snapshot) and never above the current global DSH subagent permission; when omitted the inherited mode is used.',
        },
      },
      required: ['taskId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_tasks',
    description: 'List recent DSH subagent tasks with id, status, and a short summary.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ---------------------------------------------------------------------------
// HTTP / JSON-RPC 小工具
// ---------------------------------------------------------------------------
// 所有 JSON 响应都带跨域头：恢复旧版行为，允许任意来源的网页直接访问本端点
//（含携带旧 Authorization 头的浏览器请求，端点不校验也不拒绝该头）
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

// 写 JSON 响应；客户端已断连则静默放弃
function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(payload));
  } catch {
    // 写入失败（对端断开等），忽略
  }
}

// 空响应：OPTIONS 204、MCP 通知 202、405 等。与 JSON 响应一样带跨域头；
// extraHeaders 供 OPTIONS 预检追加允许的方法与请求头
function sendNoContent(res, status, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    });
    res.end();
  } catch {
    // 忽略写入失败
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// 截取文本尾部（stderr 尾部/错误诊断保留最新内容）
function truncateTail(text, limit) {
  const s = String(text ?? '');
  return s.length > limit ? s.slice(-limit) : s;
}

// 读取请求体，超限 reject { statusCode: 413 }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const err = new Error('payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy(); // 停止接收剩余数据
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// apply：插件激活入口
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  // ---------- 配置默认值（patch 的 config 原样传入，做防御性兜底） ----------
  const routePath =
    typeof config?.routePath === 'string' && config.routePath.startsWith('/')
      ? config.routePath
      : '/mcp/dsh-subagent';
  const clampInt = (value, fallback, min, max) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };
  // ---------- 运行限额（设置页可改、保存后热生效） ----------
  // 优先级：~/.dsh/subagent-bridge.config.json 的用户设置 > 内置默认。
  // 不再读取 patch config 里的 maxConcurrent/maxTaskSeconds/historyLimit
  // （那三个字段已废弃，残留值无害）。默认值：并发 20、单任务约 6.9 天、历史 200 条。
  const clampLimits = (raw) => ({
    maxConcurrent: clampInt(raw?.maxConcurrent, 20, 1, 64),
    maxTaskSeconds: clampInt(raw?.maxTaskSeconds, 600000, 60, 7 * 24 * 3600),
    historyLimit: clampInt(raw?.historyLimit, 200, 10, 1000),
  });
  let limits = clampLimits(readUserConfig());
  // 子代理沙箱权限：'workspace'（工作区沙箱，默认）| 'full'（完全权限）。
  // 完全权限通过 DSH_PERMISSION_MODE=danger-full-access 注入 headless 子进程。
  const POLICIES = new Set(['workspace', 'full']);
  const readPolicy = (value) => (POLICIES.has(value) ? value : 'workspace');
  let agentPolicy = readPolicy(readUserConfig().agentPolicy);

  // 全局 agentPolicy → 注入子进程的 DSH_PERMISSION_MODE 具体值：
  // 'workspace' → 'workspace-write'（默认工作区沙箱），'full' → 'danger-full-access'。
  const globalPermissionMode = () => (agentPolicy === 'full' ? 'danger-full-access' : 'workspace-write');
  // 任务级 permissionMode 是否被当前全局上限允许：只允许等于或低于当前全局
  // 权限等级（"降低当前 DSH 全局权限"语义；调用方保证传入值已通过
  // parsePermissionMode 归一化为三值之一或为 null）。用于三处：
  // - start_task 入队校验：显式传值不得高于当时全局，否则报错；
  // - continue_task：显式传值不得高于当前全局，继承快照同理（否则报错）；
  // - startTask 启动复核：入队快照高于已被调低的全局上限时任务明确 failed，
  //   绝不静默降级运行。
  const isPermissionModeAllowed = (requested) =>
    requested != null && PERMISSION_MODE_RANK[requested] <= PERMISSION_MODE_RANK[globalPermissionMode()];

  const webServer = ctx.webServer; // 由 patch 行的 inject: [webServer, agentDefaultModel] 注入
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-subagent-bridge requires the webServer service (inject: [webServer])');
  }

  // ---------- Codex 端点自动同步 ----------
  // DSH webserver 端口每次启动都会变，Codex 里注册的 MCP URL 会随之失效。
  // webServer 就绪后自动把 ~/.codex/config.toml 的 [mcp_servers.dsh-subagent]
  // 段刷新为当前端点；段不存在时自动追加（等效替用户执行 codex mcp add）。
  // 只改动这一段的 url 行，文件其余内容不碰；本机没有 Codex 配置则静默跳过。
  // 具体读写与冲突检测实现在 codex-sync.js 的 syncCodexConfigFile，这里只保留
  // 状态对象和调用包装（就绪轮询的调用时机保持不变）。
  const codexSync = { status: 'pending', configPath: codexConfigPath, lastError: null };

  function syncCodexConfig(origin) {
    try {
      const result = syncCodexConfigFile(codexConfigPath, origin + routePath);
      codexSync.status = result.status;
      codexSync.lastError = null;
    } catch (err) {
      codexSync.status = 'failed';
      codexSync.lastError = String(err?.message ?? err);
    }
  }

  // webServer 监听是异步的：就绪前 getOrigin 拿不到端口。就绪轮询先每秒一次
  // （最多 60 秒），拿到端口立即同步一次 Codex 配置；若 60 秒内始终没就绪，
  // 不再永久放弃，而是降为每 30 秒重试一次（DSH 慢启动/休眠唤醒等场景下
  // 迟早会就绪），成功后停止轮询。
  ctx.effect(() => {
    let tries = 0;
    let slowTimer = null; // 降频重试定时器（卸载时一并清理）
    const timer = setInterval(() => {
      if (disposed) {
        clearInterval(timer);
        return;
      }
      let origin = '';
      try {
        origin = webServer.getOrigin();
      } catch {
        // 尚未就绪，下一轮再试
      }
      if (origin) {
        clearInterval(timer);
        syncCodexConfig(origin);
      } else if (++tries >= 60) {
        // 60 秒仍未就绪：转为每 30 秒重试，直到就绪或插件卸载
        codexSync.status = 'pending';
        codexSync.lastError = 'webServer origin not ready yet; retrying every 30s';
        clearInterval(timer);
        slowTimer = setInterval(() => {
          if (disposed) {
            clearInterval(slowTimer);
            slowTimer = null;
            return;
          }
          let late = '';
          try {
            late = webServer.getOrigin();
          } catch {
            // 仍未就绪，30 秒后再试
          }
          if (late) {
            clearInterval(slowTimer);
            slowTimer = null;
            syncCodexConfig(late);
          }
        }, 30000);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      if (slowTimer) {
        clearInterval(slowTimer);
        slowTimer = null;
      }
    };
  });

  // ---------- 任务存储与调度 ----------
  const tasks = new Map();   // id -> 任务记录（插入序 ≈ 创建序）
  const queue = [];          // 排队中的任务 id（FIFO）
  const waiters = new Map(); // id -> Set<回调>，wait_task 的阻塞等待者
  let running = 0;           // 当前占用并发槽的任务数
  let disposed = false;      // 卸载后不再调度新任务
  let launching = false;     // tryLaunch 防重入

  function newTaskId() {
    let id;
    do {
      id = `dshx-${randomBytes(4).toString('hex')}`; // dshx-<8位随机>
    } while (tasks.has(id));
    return id;
  }

  // 创建待执行任务；续接任务保留原 DSH 会话标识。
  function createTask(task, cwd, resumeSessionId = null) {
    const nowMs = Date.now();
    const t = {
      id: newTaskId(),
      task,
      cwd,
      resumeSessionId,
      status: 'queued',
      createdAtMs: nowMs,
      createdAt: new Date(nowMs).toISOString(),
      startedAtMs: null,
      startedAt: null,
      endedAtMs: null,
      endedAt: null,
      sessionId: null,
      answer: '',       // 'final' 事件给出的最终答案（completed 时对外）
      gotFinal: false,  // 是否收到过有效 final（text 为非空字符串）——
                        // 退出码 0 但从未收到有效 final 时不得判 completed
      eventError: null, // 'error' 事件文本（收到过就不得判 completed，作失败诊断）
      stderrTail: '',   // 子进程 stderr 尾部（仅内存中的失败诊断，不落盘；
                        // 其中的 import 警告无害，绝不作为失败依据）
      error: null,      // failed/cancelled 时对外诊断（cancelled 存取消原因）
      timedOut: false,  // 是否因 maxTaskSeconds 超时被杀
      cancelRequested: false, // 是否被 cancel_task 请求取消
      occupiesSlot: false,    // 是否正占用并发槽（释放以它为准，防漏防重）
      killTimer: null,  // 取消后的强杀兜底定时器（SIGTERM 宽限到点转 SIGKILL）
      closeFallbackTimer: null, // exit 后 close 迟迟不来的兜底强终定时器
      model: null,      // 任务级模型覆盖（"provider/model"；null = 全局配置）。
                        // 指定 reasoningEffort 且未显式给 model 时，这里保存为
                        // 满足 overlay 需要而解析出的有效模型（全局 agentModel
                        // 或宿主默认选择），保证 overlay 一定能生成
      timeoutSeconds: null, // 任务级超时覆盖（秒；null = 全局 limits）
      permissionMode: null, // 任务级权限快照（'read-only'|'workspace-write'|
                            // 'danger-full-access'）。start_task/continue_task
                            // 入队时固化"当时实际允许的权限"（显式传值或当时的
                            // 全局值），启动时按快照注入：排队期间全局调高不提权、
                            // 调低则启动复核明确 failed；仅旧历史恢复的任务可能
                            // 为 null（缺快照，续跑按 workspace-write 上限收敛）
      reasoningEffort: null, // 任务级推理力度（安全字符串；null = 不指定，
                             // overlay 不写 reasoningEffort 行）
      progress: null,   // 最近一次 status 事件（{phase, turn, step, atMs}）
      pid: null,
      child: null,
      control: null,    // 子进程 IPC 控制通道（bridge-ipc.js）：send_message/
                        // interrupt_task 专用；spawn 后建立（建立失败任务直接
                        // failed，绝不降级继续运行）、子进程退出时 dispose；
                        // null = 尚未建立或已随进程终结
      timer: null,      // 任务级超时定时器
    };
    tasks.set(t.id, t);
    return t;
  }

  // 对外耗时：结束取净耗时，运行中取至今耗时，未开始（queued）为 0
  function elapsedMs(t) {
    if (t.startedAtMs == null) return 0;
    return (t.endedAtMs ?? Date.now()) - t.startedAtMs;
  }

  // 面板依赖的 TaskView 形状（务必与 client.js 约定一致）
  function taskView(t) {
    return {
      id: t.id,
      task: t.task,
      cwd: t.cwd,
      status: t.status, // queued | running | completed | failed | cancelled
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      sessionId: t.sessionId,
      answer: t.status === 'completed' ? t.answer : null,
      error: t.status === 'failed' || t.status === 'cancelled' ? t.error : null,
      model: t.model,
      permissionMode: t.permissionMode, // 任务级权限快照（null = 旧历史缺快照）
      reasoningEffort: t.reasoningEffort, // 任务级推理力度（null = 未指定）
      progress: t.status === 'running' ? t.progress : null,
      pid: t.pid,
      elapsedMs: elapsedMs(t),
    };
  }

  // wait_task 返回的任务快照：终态（completed/failed/cancelled）与
  // 等待超时（queued/running）共用；running 时附带 progress 轮次/步骤
  function taskSnapshot(t) {
    const payload = {
      taskId: t.id,
      status: t.status,
      sessionId: t.sessionId,
      elapsedMs: elapsedMs(t),
    };
    if (t.status === 'running') payload.progress = t.progress; // 运行中可看轮次/步骤
    if (t.status === 'completed') payload.answer = t.answer;
    if (t.status === 'failed' || t.status === 'cancelled') payload.error = t.error;
    // 持久化异常必须随快照暴露给调用方：写盘失败若只记在 /info 里，调用方
    // 会误以为结果已安全保存，宿主重启后却查不到、续不了，且无从发现失败
    if (persistence.status === 'error') {
      payload.persistence = {
        status: persistence.status,
        lastError: persistence.lastError,
      };
    }
    return payload;
  }

  // 历史裁剪：终态任务超过 limits.historyLimit 时按创建时间删最旧（不动 queued/running）
  function trimHistory() {
    const finished = [...tasks.values()]
      .filter(
        (t) =>
          t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    let excess = finished.length - limits.historyLimit;
    let removed = false;
    for (const t of finished) {
      if (excess-- <= 0) break;
      tasks.delete(t.id);
      removed = true;
    }
    if (removed) schedulePersistTasks(); // 裁剪结果同步落盘，文件与内存保持一致
  }

  // 任务进入终态后唤醒所有 wait_task 等待者
  function notifyWaiters(t) {
    const set = waiters.get(t.id);
    if (!set) return;
    waiters.delete(t.id);
    for (const fn of set) {
      try {
        fn();
      } catch {
        // 单个 waiter 异常不影响其他等待者
      }
    }
  }

  // 置终态 + 唤醒等待者 + 裁剪历史；返回是否真的发生了终态迁移。
  // cancelled 与 completed/failed 同为终态，一旦进入不可被后续事件覆盖
  // （例如取消后子进程 close 再触发时，状态保持 cancelled）。
  function finalize(t, status, patch = {}) {
    if (
      t.status === 'completed' ||
      t.status === 'failed' ||
      t.status === 'cancelled'
    ) {
      return false;
    }
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    if (t.killTimer && status !== 'cancelled') {
      clearTimeout(t.killTimer);
      t.killTimer = null;
    }
    const nowMs = Date.now();
    t.status = status;
    t.endedAtMs = nowMs;
    t.endedAt = new Date(nowMs).toISOString();
    if (status === 'completed') t.answer = typeof patch.answer === 'string' ? patch.answer : '';
    if (status === 'failed') {
      t.error = truncateTail(patch.error ?? 'unknown failure', ERROR_TEXT_LIMIT);
    }
    if (status === 'cancelled') {
      // 取消原因复用 error 字段承载，面板与 wait_task 都能展示
      t.error = truncateTail(patch.error ?? 'cancelled', ERROR_TEXT_LIMIT);
    }
    if (status !== 'cancelled') t.child = null;
    notifyWaiters(t);
    trimHistory();
    schedulePersistTasks(); // 终态迁移落盘（防抖合并同轮多次变更）
    return true;
  }

  // 释放任务占用的并发槽并调度下一个排队任务。
  // 以 occupiesSlot 为唯一释放依据：不会因 close/error 多次事件重复递减，
  // 也不会因取消路径提前 finalize 而漏释放（漏了会永久占死一个槽）。
  function releaseSlot(t) {
    if (!t.occupiesSlot) return;
    t.child = null;
    t.occupiesSlot = false;
    running--;
    tryLaunch();
  }

  // 子进程事件路径（close / error）的统一收尾：置终态 + 释放槽。
  // finalize 可能因任务已被取消/收尾而不迁移状态，但子进程确实已退出时
  // 槽必须释放，所以 finalize 与 releaseSlot 各自独立幂等。
  function finishRunning(t, status, patch = {}) {
    finalize(t, status, patch);
    releaseSlot(t);
  }

  // 启动 headless 子进程执行任务（调用方保证有空闲槽位）
  function startTask(t) {
    running++;
    t.occupiesSlot = true; // 与 running++ 成对；之后由 releaseSlot 统一释放
    t.status = 'running';
    t.startedAtMs = Date.now();
    t.startedAt = new Date(t.startedAtMs).toISOString();
    schedulePersistTasks(); // 状态迁移落盘（防抖）

    // 启动前权限复核：入队时快照的权限若高于已被调低的全局上限（任务排队
    // 期间设置页把全局权限调低），绝不静默降级运行——调用方以为的权限边界
    // 没有按原样生效，必须明确 failed 并说明两侧权限值；调高全局不影响本
    // 任务（只认快照，防提权）。
    if (t.permissionMode && !isPermissionModeAllowed(t.permissionMode)) {
      finishRunning(t, 'failed', {
        error:
          `task permission snapshot "${t.permissionMode}" exceeds the current global DSH subagent ` +
          `permission ("${globalPermissionMode()}") that was lowered while the task was queued; ` +
          'failing instead of silently running with a downgraded mode',
      });
      return;
    }

    const launcher = resolveLauncher();
    if (!launcher) {
      finishRunning(t, 'failed', { error: 'dsh launcher not found; is DeepSeek Harness installed?' });
      return;
    }

    // 直接 spawn Electron exe + ELECTRON_RUN_AS_NODE，等价官方 dsh.cmd 但绕开 cmd.exe 转义；
    // 中文目录等路径原样作为参数传入即可。终态判定统一放在 close 事件
    // （见下），exit 只负责资源清理。
    // overlay 每次任务动态生成（读宿主 desktop 用户 patch + 任务级/全局模型覆盖），
    // 写临时文件、子进程退出后删除。写失败必须终止任务：running/occupiesSlot
    // 已经置位，不收尾会永久占用并发槽。
    let overlayFile;
    try {
      // overlay 携带任务级模型覆盖与推理力度（reasoningEffort 只在任务显式
      // 指定时写入 agent-default-model 段）
      overlayFile = writeTempOverlay(t.model, t.reasoningEffort);
    } catch (err) {
      finishRunning(t, 'failed', { error: `failed to write headless overlay: ${err?.message ?? err}` });
      return;
    }
    let child;
    try {
      const spawnOptions = {
        // DSH_PERMISSION_MODE 注入说明见下方 env 内注释
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // DSH_PERMISSION_MODE 是 headless 模板 sandbox-policy 的原生出口：
          // mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'。
          // 直接注入入队时固化的任务权限快照（start_task/continue_task 入队时
          // 记录"当时实际允许的权限"：显式传值或当时的全局值）：排队期间全局
          // 权限被调高不会让本任务提权（只认快照）；被调低则已在 startTask
          // 开头的启动复核中明确 failed，绝不会走到这里静默降级。
          // 'workspace-write'（默认）= 工作区沙箱，工作区外的访问（WSL/Docker
          // 等）会被拦截；'danger-full-access' = 完全权限；'read-only' = 只读。
          // 全局档位可在设置页切换，保存后对新入队的任务生效（运行中的任务
          // 不受影响）。
          DSH_PERMISSION_MODE: t.permissionMode ?? globalPermissionMode(),
        },
        // 第 4 项 'ipc'：与 overlay 注入的 headless-control.js 配对的控制
        // 通道（父进程经 bridge-ipc.js 发送 steer/followup/interrupt 并等回执）
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      };
      // cwd 必须是绝对路径才传，否则不传（headless 自己解析工作目录）
      if (t.cwd && path.isAbsolute(t.cwd)) spawnOptions.cwd = t.cwd;
      child = spawn(
        launcher.exe,
        [launcher.cliJs, '--profile', 'headless', '--patch', overlayFile, '--json',
          ...(t.resumeSessionId ? ['--session-id', t.resumeSessionId] : [])],
        spawnOptions,
      );
    } catch (err) {
      try {
        fs.unlinkSync(overlayFile);
      } catch {
        // 临时文件清理失败无妨（系统会回收临时目录）
      }
      finishRunning(t, 'failed', { error: `failed to spawn dsh: ${err?.message ?? err}` });
      return;
    }

    t.child = child;
    t.pid = typeof child.pid === 'number' ? child.pid : null;

    // 任务全文经 stdin 传入；子进程提前退出会触发 EPIPE，监听 error 吞掉即可。
    // 监听先于下方各失败路径挂载，保证任何收尾路径都没有裸露的 error 事件
    child.stdin.on('error', () => {});

    // spawn 失败（如 ENOENT）：只有 error 事件，通常没有 exit。本监听必须
    // 先于控制通道建立挂载：控制通道建立失败会立即终止子进程并收尾任务，
    // 此后子进程仍可能异步触发 error 事件，没有监听器会变成未捕获异常。
    child.on('error', (err) => {
      try {
        fs.unlinkSync(overlayFile); // 异步 spawn 失败时 exit 可能不触发，这里兜底删
      } catch {
        // 无妨
      }
      // 子进程已不可用：控制通道一并终结（在途请求被 reject，此后新请求直接失败）
      if (t.control) {
        t.control.dispose();
        t.control = null;
      }
      finishRunning(t, 'failed', { error: `failed to run dsh: ${err?.message ?? err}` });
    });

    // 建立子代理控制通道（stdio 第 4 项 'ipc'）：overlay 注入的
    // headless-control.js 在子进程内监听 dsh-subagent-control 协议消息。
    // 通道建立失败绝不降级继续运行：没有控制通道的任务既无法接收 send_message
    // 也无法温和 interrupt，带着这种能力缺口跑长任务只会让调用方在任务中途
    // 才发现失控——立即终止刚启动的子进程并明确 failed（并发槽不立即释放：
    // taskkill 异步，等子进程 exit 后由 catch 分支自装的一次性监听释放）。
    try {
      t.control = createControlChannel(child);
    } catch (err) {
      try {
        fs.unlinkSync(overlayFile); // exit 监听尚未挂上（在下方），这里手动清理
      } catch {
        // 临时文件清理失败无妨（系统会回收临时目录）
      }
      killTaskTree(child, true); // 终止刚启动的子进程，不留孤儿占用资源
      // 立即标 failed，但并发槽不能在这里释放：Windows 上 taskkill 是异步的
      // （killTaskTree 只发起终止，本进程此刻可能还活着）。若走 finishRunning
      // 立即释放槽，tryLaunch 会提前启动下一个任务（瞬时超出 maxConcurrent），
      // continue_task 的"原进程尚未退出"保护（previous.occupiesSlot）也同时
      // 失效——同一会话可能被续跑成两个并发进程。因此本分支只 finalize、
      // 不 releaseSlot，等子进程真正退出后再释放。
      finalize(t, 'failed', {
        error: `failed to create the subagent control channel: ${err?.message ?? err}`,
      });
      // 本分支在常规 exit 监听安装之前 return，没有任何既有监听会替它释放
      // 并发槽——必须自装一次性 exit 监听兜住，否则槽永久泄漏（killTaskTree
      // 发起的 taskkill 总会以本进程退出收场，exit 届时触发）。正常路径下
      // t.control 必为 null（createControlChannel 的同步抛错点都在挂监听之前，
      // 不存在部分建立的通道），dispose 仅为防御；releaseSlot 以 occupiesSlot
      // 为准幂等，与既有 error 路径（spawn 失败时 exit 不会触发、由 error
      // 处理器释放槽）竞争也不会重复收尾。
      child.once('exit', () => {
        if (t.control) {
          t.control.dispose();
          t.control = null;
        }
        releaseSlot(t);
      });
      return;
    }

    // 控制通道就绪后才把任务全文交给子进程执行
    child.stdin.end(t.task);

    // 任务级超时（t.timeoutSeconds 优先，否则全局 limits）：到点强杀整棵
    // 进程树（child.kill() 在 Windows 上杀不掉孙进程，孤儿会一直占着 stdio
    // 句柄导致 close 永不触发）；终态判定统一在 close 回调里做
    const effectiveTimeoutSeconds = t.timeoutSeconds ?? limits.maxTaskSeconds;
    t.timer = setTimeout(() => {
      t.timedOut = true;
      killTaskTree(child, true);
    }, effectiveTimeoutSeconds * 1000);

    // stdout：--json 模式逐行输出 JSON 事件，坏行跳过
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return; // 非事件行（日志等）直接跳过
      }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'session') {
        // session 事件带 sessionId（事件字段名两种形态都认）。取到且与当前
        // 不同时更新，并立即同步落盘：sessionId 是 continue_task 续跑的唯一
        // 凭据，若只等下一次防抖写盘，宿主在这段窗口中断后，恢复出的历史就
        // 丢掉 sessionId、旧会话再也无法续跑。
        const reported =
          typeof event.sessionId === 'string'
            ? event.sessionId
            : typeof event.id === 'string'
              ? event.id
              : null;
        if (reported && reported !== t.sessionId) {
          t.sessionId = reported;
          persistTasksNow(); // 立即落盘（内部会清掉尚未触发的防抖定时器）
        }
      } else if (event.type === 'status') {
        // status 事件：agent 的轮次/步骤阶段计数（turn_start/step_start/
        // step_end/turn_end）。透传给面板与 wait_task 快照，让调用方与
        // 面板能区分"在推进"和"卡死"。
        t.progress = {
          phase: typeof event.phase === 'string' ? event.phase : null,
          turn: Number.isFinite(event.turn) ? event.turn : null,
          step: Number.isFinite(event.step) ? event.step : null,
          atMs: Date.now(),
        };
      } else if (event.type === 'final') {
        // final 事件带 text（最终答案，可能是空串）。
        // 只有 text 为非空字符串才算"有效 final"：退出码 0 但从未收到
        // 有效 final 时不能判 completed（防止异常收尾误报成功）。
        if (typeof event.text === 'string') {
          t.answer = event.text;
          if (event.text.trim()) t.gotFinal = true;
        }
      } else if (event.type === 'error') {
        // error 事件带 message：收到过就不能把任务判成 completed，
        // 文本同时作为失败诊断素材
        t.eventError = typeof event.message === 'string' ? event.message : JSON.stringify(event);
      }
    });

    // stderr：累积保留尾部 4000 字符做失败诊断。
    // 注意：其中会出现 computer-use 包 import 失败的无害警告（GUI 才有的包），
    // 绝不作为任务失败依据；失败判定只看退出码和 JSON error/final 事件。
    child.stderr.on('data', (chunk) => {
      t.stderrTail = truncateTail(t.stderrTail + chunk.toString('utf8'), STDERR_TAIL_LIMIT);
    });

    // 进程退出：只做资源清理。终态判定放在 close 事件——exit 触发时 stdout
    // 的缓冲可能还没读尽，最后的 'final' 事件行会因此丢失；close 保证 stdio
    // 流全部结束（stdout 数据已读完）后才触发。
    // 兜底：若孙进程继承了 stdio 句柄且没被杀干净，close 可能迟迟不来——
    // exit 后 15 秒仍无 close 就强制收尾，绝不让并发槽被永久占用：
    // - 任务仍 running：强制进入 failed 终态并释放槽；
    // - 任务已被 cancel_task/interrupt_task 收尾为 cancelled：终态保持不变
    //  （finalize 幂等保护），但只要仍占用并发槽就必须释放并关闭控制通道——
    //   只判断 running 会让已取消任务在 close 永不到来时占死一个槽。
    child.on('exit', () => {
      try {
        fs.unlinkSync(overlayFile); // 临时 overlay 用完即删
      } catch {
        // 已被清理也无妨
      }
      if (t.killTimer) {
        // 进程已退出，强杀兜底定时器不再需要
        clearTimeout(t.killTimer);
        t.killTimer = null;
      }
      if (!t.closeFallbackTimer) {
        t.closeFallbackTimer = setTimeout(() => {
          t.closeFallbackTimer = null;
          if (t.status === 'running') {
            // 强制收尾同样必须终结控制通道：走到这里说明 close 可能永远不来
            // （孤儿进程持有管道），不能指望下方 close 监听来 dispose——不
            // dispose 会把通道的四个监听器永久留在已死的 child 上，在途请求
            // 也只能干等各自超时。dispose 幂等，close 稍后真触发时是无操作。
            if (t.control) {
              t.control.dispose();
              t.control = null;
            }
            finishRunning(t, 'failed', {
              error: 'dsh process exited but its stdio streams never closed (orphaned child processes holding the pipes?); forcing terminal state',
            });
          } else if (t.occupiesSlot) {
            // 已 cancelled 的兜底释放：并发槽以 occupiesSlot 为准幂等释放；
            // close 一直没来，控制通道也必须在这里终结（在途请求被 reject、
            // 监听器摘除），绝不在已终态任务上留下活动通道。不改变任务状态。
            if (t.control) {
              t.control.dispose();
              t.control = null;
            }
            releaseSlot(t);
          }
        }, 15000);
      }
    });

    // stdio 流全部结束、stdout 完整收尾后的终态判定：
    // - 超时被杀 → failed（标注超时原因）；
    // - 已被取消 → 保持 cancelled（finalize 幂等拒绝，这里只释放并发槽）；
    // - 退出码 0 且收到过有效 final 且无 error 事件 → completed；
    // - 其余（非 0 退出、退出 0 但没有有效 final、收到过 error 事件）→ failed，
    //   绝不因退出码好看而误报成功。
    child.on('close', (code) => {
      // 控制通道随进程退出终结：dispose 幂等（reject 残留在途请求、摘除本通道
      // 的全部监听器）；此后 send_message/interrupt_task 一律明确报错
      if (t.control) {
        t.control.dispose();
        t.control = null;
      }
      if (t.killTimer) {
        clearTimeout(t.killTimer);
        t.killTimer = null;
      }
      if (t.closeFallbackTimer) {
        clearTimeout(t.closeFallbackTimer);
        t.closeFallbackTimer = null;
      }
      if (t.timedOut) {
        finishRunning(t, 'failed', {
          error:
            `task exceeded timeout (${t.timeoutSeconds ?? limits.maxTaskSeconds}s)` +
            (t.stderrTail ? `; ${t.stderrTail}` : ''),
        });
      } else if (code === 0 && t.gotFinal && !t.eventError) {
        finishRunning(t, 'completed', { answer: t.answer });
      } else {
        let reason;
        if (code === 0 && !t.gotFinal) {
          reason = 'dsh exited with code 0 but no valid final event was received';
        } else {
          reason = `dsh exited with code ${code ?? 'null'}`;
        }
        if (t.eventError) reason += `; error event: ${t.eventError}`;
        if (t.stderrTail) reason += `; ${t.stderrTail}`;
        finishRunning(t, 'failed', { error: reason });
      }
    });
  }

  // 队列调度：有空闲槽位就按 FIFO 启动排队任务（防重入，允许启动中同步收尾）
  function tryLaunch() {
    if (launching) return;
    launching = true;
    try {
      while (!disposed && running < limits.maxConcurrent && queue.length > 0) {
        const id = queue.shift();
        const t = tasks.get(id);
        if (!t || t.status !== 'queued') continue; // 已被清理的残留引用，跳过
        startTask(t);
      }
    } finally {
      launching = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 任务状态持久化：把任务表的最近有限历史原子写入
  // USERPROFILE/.dsh/subagent-bridge.tasks.json，宿主重启后仍可查询旧任务
  // 结果、按旧 taskId 续跑会话。
  // - 只落盘可序列化字段（child/timer/killTimer/closeFallbackTimer/
  //   occupiesSlot/progress 等运行时状态一律不写；stderrTail 只是运行期
  //   失败诊断素材，恢复后的任务不再关联任何子进程，同样不落盘）；
  // - 文件包含任务文本与最终回答的原文，二者分别来自调用方与子代理的产出，
  //   本插件既不注入凭据、也不审查内容里是否带有凭据——不要把该文件当作
  //   "绝无凭据"的文件对待，按普通任务数据妥善保管；
  // - 写入为"同目录临时文件 + rename"原子替换，进程中途崩溃也不会留下
  //   半截 JSON 或覆盖掉上一份好状态；
  // - 文件按 0o600 新建限权：仅 POSIX 生效（属主可读写）；Windows 忽略该
  //   权限位，不做任何额外 ACL 收敛，可访问性完全取决于所在目录的既有
  //   权限，不能假设只有当前用户读得到；
  // - 运行期的写入失败不抛异常、也不静默：记入 persistence 健康状态并打到
  //   宿主 stderr（经 /info 与任务快照可见），绝不因子进程回调里的写盘失败
  //   让宿主崩溃或无声丢失状态。启动阶段的加载失败则相反——直接抛错终止
  //   插件加载（见 loadPersistedTasks），绝不以空历史继续运行后覆盖原文件。
  // ---------------------------------------------------------------------------
  const tasksFilePath = path.join(process.env.USERPROFILE ?? '', '.dsh', 'subagent-bridge.tasks.json');
  const persistDisabled = !process.env.USERPROFILE; // 无用户目录：持久化整体禁用
  const persistence = {
    status: persistDisabled ? 'disabled' : 'ok', // ok | error | disabled
    lastError: null,
    lastSavedAtMs: null,
    lastSavedAt: null,
    loadedCount: 0,       // 启动时恢复进内存的历史任务条数
    recoveredToFailed: 0, // 其中启动时由 queued/running 标为 failed 的条数
  };
  let persistTimer = null;           // 防抖定时器（dispose 时强刷并清理）
  let lastLoggedPersistError = null; // 相同错误只打一次，避免刷屏

  // 持久化错误统一出口：更新健康状态 + 输出宿主 stderr（失败必须可见）
  function reportPersistError(stage, err) {
    persistence.status = 'error';
    persistence.lastError = `${stage}: ${err?.message ?? err}`;
    if (persistence.lastError !== lastLoggedPersistError) {
      lastLoggedPersistError = persistence.lastError;
      console.error(`[dsh-subagent-bridge] task state persistence ${persistence.lastError}`);
    }
  }

  // 任务记录 → 可序列化落盘对象（白名单式逐字段挑选，运行时对象进不来；
  // stderrTail 仅存活在内存里做失败诊断，不落盘）
  function persistedTaskView(t) {
    return {
      id: t.id,
      task: t.task,
      cwd: t.cwd,
      resumeSessionId: t.resumeSessionId,
      status: t.status,
      createdAtMs: t.createdAtMs,
      createdAt: t.createdAt,
      startedAtMs: t.startedAtMs,
      startedAt: t.startedAt,
      endedAtMs: t.endedAtMs,
      endedAt: t.endedAt,
      sessionId: t.sessionId,
      answer: t.answer,
      gotFinal: t.gotFinal,
      eventError: t.eventError,
      error: t.error,
      timedOut: t.timedOut,
      cancelRequested: t.cancelRequested,
      model: t.model,
      // 任务级权限模式与推理力度一并落盘：continue_task 续跑要恢复它们
      permissionMode: t.permissionMode,
      reasoningEffort: t.reasoningEffort,
      timeoutSeconds: t.timeoutSeconds,
      pid: t.pid,
    };
  }

  // 同步全量写当前任务表（含排队/运行中的条目：宿主中断后才能把它们恢复
  // 为 failed，而不是无声丢失）
  function persistTasksNow() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (persistDisabled) return;
    try {
      fs.mkdirSync(path.dirname(tasksFilePath), { recursive: true });
      const savedAtMs = Date.now();
      const payload = {
        version: 1,
        savedAtMs,
        savedAt: new Date(savedAtMs).toISOString(),
        tasks: [...tasks.values()]
          .sort((a, b) => a.createdAtMs - b.createdAtMs)
          .map(persistedTaskView),
      };
      // 同目录临时文件 + rename：对已存在目标的 rename 是原子替换，读方
      // 要么看到完整旧文件、要么看到完整新文件，不会读到半截 JSON
      const tmpPath = `${tasksFilePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600, // 新建文件权限收敛到属主（POSIX 生效；Windows 忽略该位）
      });
      fs.renameSync(tmpPath, tasksFilePath);
      persistence.status = 'ok';
      persistence.lastError = null;
      persistence.lastSavedAtMs = savedAtMs;
      persistence.lastSavedAt = payload.savedAt;
    } catch (err) {
      reportPersistError('write failed', err);
    }
  }

  // 防抖调度：同一轮事件循环内的连续状态迁移（入队→启动→终态）合并为一次
  // 写盘；最迟 100ms 后必然落盘
  function schedulePersistTasks() {
    if (persistDisabled || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistTasksNow();
    }, 100);
  }

  // 启动时恢复历史：把上次落盘的任务读回内存，供 list/wait/continue 使用。
  // 绝不自动重新执行——中断时还在 queued/running 的任务明确标为 failed
  // （宿主中断），也不进队列、不占并发槽、不关联任何子进程。
  // 加载阶段遇到文件不可读、JSON 损坏、版本不支持、条目非对象、缺 id/task/
  // status、状态非法或 id 重复时，直接抛错终止插件加载（apply 内调用，异常
  // 冒泡给宿主）：若以空历史继续运行，后续落盘会把原历史文件覆盖成空表，
  // 历史与续跑凭据永久丢失；跳过损坏条目则会无声丢掉部分会话。唯一例外是
  // ENOENT——首次启动本来就没有历史文件，正常继续。报错后由人工修复或
  // 确认删除文件再重启，绝不静默覆盖原文件。
  function loadPersistedTasks() {
    if (persistDisabled) {
      console.warn('[dsh-subagent-bridge] USERPROFILE is not set; task state persistence is disabled');
      return;
    }
    let raw;
    try {
      raw = fs.readFileSync(tasksFilePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return; // ENOENT=首次启动，无历史
      // 文件存在但读不了（权限/IO 错误）：终止加载，防止后续落盘覆盖原文件
      throw new Error(
        `dsh-subagent-bridge: cannot read task history file ${tasksFilePath}: ${err?.message ?? err}`,
      );
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // JSON 损坏（进程中断留下半截文件、手工误编辑等）：终止加载，绝不静默
      // 丢弃原历史
      throw new Error(
        `dsh-subagent-bridge: task history file is corrupted (invalid JSON): ${tasksFilePath}: ${err?.message ?? err}`,
      );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.tasks)) {
      throw new Error(
        `dsh-subagent-bridge: task history file has unexpected shape (expected an object with a "tasks" array): ${tasksFilePath}`,
      );
    }
    if (data.version !== 1) {
      // 版本不支持（缺失，或来自更新/更旧的写入格式）：终止加载。格式兼容由
      // 人工处理，本版本绝不猜测兼容、更不覆盖
      throw new Error(
        `dsh-subagent-bridge: task history file version ${JSON.stringify(data.version)} is not supported (expected 1): ${tasksFilePath}`,
      );
    }
    const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
    const asString = (v) => (typeof v === 'string' ? v : null);
    const asNumber = (v) => (Number.isFinite(v) ? v : null);
    const asBool = (v) => (typeof v === 'boolean' ? v : false);
    const nowMs = Date.now();
    data.tasks.forEach((entry, index) => {
      // 条目损坏（非对象）或缺 id/任务文本/status、状态非法、id 重复：一律
      // 抛错终止插件加载，绝不跳过——跳过意味着部分历史或会话凭据无声丢失
      const describe = `task history entry #${index} in ${tasksFilePath}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`dsh-subagent-bridge: ${describe} is not an object`);
      }
      const id = asString(entry.id);
      const task = asString(entry.task);
      if (!id) {
        throw new Error(`dsh-subagent-bridge: ${describe} is missing a string "id"`);
      }
      if (task === null) {
        throw new Error(
          `dsh-subagent-bridge: task history entry ${id} in ${tasksFilePath} is missing a string "task"`,
        );
      }
      if (!STATUSES.has(entry.status)) {
        throw new Error(
          `dsh-subagent-bridge: task history entry ${id} in ${tasksFilePath} has invalid status ${JSON.stringify(entry.status)}`,
        );
      }
      if (tasks.has(id)) {
        throw new Error(`dsh-subagent-bridge: duplicate task id ${id} in ${tasksFilePath}`);
      }
      // 任务级权限/推理参数恢复：非空但非法的值一律抛错终止插件加载，绝不
      // 静默清成 null——permissionMode 变 null 会被 continue_task 当作"缺
      // 快照"处理，与"跟随全局/安全上限"的语义纠缠后可能放大权限；损坏的
      // 落盘数据必须显式暴露、由人工修复。空值（null/undefined/空串）视为
      // 未指定（旧格式缺快照），维持兼容。
      let restoredPermissionMode = null;
      if (entry.permissionMode !== undefined && entry.permissionMode !== null && entry.permissionMode !== '') {
        restoredPermissionMode = parsePermissionMode(entry.permissionMode);
        if (!restoredPermissionMode) {
          throw new Error(
            `dsh-subagent-bridge: task history entry ${id} in ${tasksFilePath} has invalid permissionMode ${JSON.stringify(entry.permissionMode)} (expected one of: read-only, workspace-write, danger-full-access)`,
          );
        }
      }
      let restoredReasoningEffort = null;
      if (entry.reasoningEffort !== undefined && entry.reasoningEffort !== null && entry.reasoningEffort !== '') {
        restoredReasoningEffort = parseReasoningEffort(entry.reasoningEffort);
        if (!restoredReasoningEffort) {
          throw new Error(
            `dsh-subagent-bridge: task history entry ${id} in ${tasksFilePath} has invalid reasoningEffort ${JSON.stringify(entry.reasoningEffort)}`,
          );
        }
      }
      const t = {
        id,
        task,
        cwd: asString(entry.cwd),
        resumeSessionId: asString(entry.resumeSessionId),
        status: entry.status,
        createdAtMs: asNumber(entry.createdAtMs) ?? nowMs,
        createdAt: asString(entry.createdAt) ?? new Date(nowMs).toISOString(),
        startedAtMs: asNumber(entry.startedAtMs),
        startedAt: asString(entry.startedAt),
        endedAtMs: asNumber(entry.endedAtMs),
        endedAt: asString(entry.endedAt),
        sessionId: asString(entry.sessionId),
        answer: asString(entry.answer) ?? '',
        gotFinal: asBool(entry.gotFinal),
        eventError: asString(entry.eventError),
        stderrTail: '', // 运行期诊断不再持久化；恢复出的任务没有子进程 stderr
        error: asString(entry.error),
        timedOut: asBool(entry.timedOut),
        cancelRequested: asBool(entry.cancelRequested),
        model: asString(entry.model),
        // 上面已校验：合法三值之一或 null（未指定/缺快照），非法值已抛错
        permissionMode: restoredPermissionMode,
        reasoningEffort: restoredReasoningEffort,
        timeoutSeconds: asNumber(entry.timeoutSeconds),
        progress: null,
        pid: asNumber(entry.pid),
        // 运行时字段全部复位：恢复出的任务与任何子进程/定时器/并发槽无关
        occupiesSlot: false,
        child: null,
        control: null, // 恢复的任务没有子进程，也就没有控制通道
        timer: null,
        killTimer: null,
        closeFallbackTimer: null,
      };
      if (entry.status === 'queued' || entry.status === 'running') {
        // 宿主中断恢复：没跑完也不再重跑，统一标 failed 并注明原因；
        // endedAt 缺失时用恢复时刻补齐，保证终态字段完整
        t.status = 'failed';
        t.endedAtMs = t.endedAtMs ?? nowMs;
        t.endedAt = t.endedAt ?? new Date(t.endedAtMs).toISOString();
        t.error = truncateTail(
          `host was interrupted while the task was ${entry.status}; marked failed on startup without re-executing`,
          ERROR_TEXT_LIMIT,
        );
        persistence.recoveredToFailed++;
      }
      tasks.set(id, t);
      persistence.loadedCount++;
    });
    trimHistory(); // 恢复的历史同样受 historyLimit 约束，超出按创建时间删最旧
    if (persistence.loadedCount > 0) schedulePersistTasks(); // 把恢复态固化回文件
  }

  loadPersistedTasks();

  // ---------- MCP 工具实现 ----------
  // 读取宿主共享的默认模型选择（agentDefaultModel 服务的 currentSelection）。
  // 只在 start_task 指定了 reasoningEffort、且任务级 model 与插件全局 agentModel
  // 都没有提供 provider/model 时调用：reasoningEffort 必须随 agent-default-model
  // overlay 写入，没有模型来源时不能静默忽略——服务缺失/读取抛错/选择不完整
  // 都在此明确抛错，由 toolStartTask 转为 isError 返回给 MCP 客户端。
  async function resolveDefaultSelectionModel() {
    let service;
    try {
      // ctx.get 是 cordis 标准方法；测试宿主等最小环境可能没有该方法，
      // 同样视为服务不可用，而不是让 TypeError 逃逸
      service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    } catch (err) {
      throw new Error(
        `reasoningEffort needs a default model selection, but reading the agentDefaultModel service failed: ${err?.message ?? err}`,
      );
    }
    if (!service || typeof service.currentSelection !== 'function') {
      throw new Error(
        'reasoningEffort needs a default model selection, but the agentDefaultModel service is not available in this host; pass arguments.model explicitly',
      );
    }
    let selection;
    try {
      // 官方实现是同步返回；await 同时兼容可能的异步实现，同步值 await 无副作用
      selection = await service.currentSelection();
    } catch (err) {
      throw new Error(
        `reasoningEffort needs a default model selection, but agentDefaultModel.currentSelection() failed: ${err?.message ?? err}`,
      );
    }
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : '';
    const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
    if (!parseAgentModel(`${provider}/${model}`)) {
      throw new Error(
        'reasoningEffort needs a default model selection, but agentDefaultModel.currentSelection() returned no usable provider/model; pass arguments.model explicitly',
      );
    }
    return `${provider}/${model}`;
  }

  // start_task：入队，立即返回 taskId
  async function toolStartTask(args) {
    const task = typeof args?.task === 'string' ? args.task : '';
    if (!task.trim()) {
      return { isError: true, payload: { error: 'arguments.task must be a non-empty string' } };
    }
    // cwd 校验：给了 cwd 就必须是已存在的绝对路径目录，否则明确报错（isError），
    // 不再静默交给 headless 自行解析——错误目录会让任务在错误位置执行还难以排查
    let cwd = null;
    const cwdInput = typeof args?.cwd === 'string' ? args.cwd.trim() : '';
    if (cwdInput) {
      if (!path.isAbsolute(cwdInput)) {
        return {
          isError: true,
          payload: { error: `arguments.cwd must be an absolute path, got: ${cwdInput}` },
        };
      }
      try {
        if (!fs.statSync(cwdInput).isDirectory()) {
          return {
            isError: true,
            payload: { error: `arguments.cwd is not a directory: ${cwdInput}` },
          };
        }
      } catch {
        return {
          isError: true,
          payload: { error: `arguments.cwd does not exist or is not accessible: ${cwdInput}` },
        };
      }
      cwd = cwdInput;
    }
    // 任务级超时覆盖（60-604800 秒）：不传或非法时回退全局 limits
    let timeoutSeconds = null;
    if (args?.timeoutSeconds !== undefined) {
      timeoutSeconds = clampInt(args.timeoutSeconds, 0, 60, 604800);
      if (!timeoutSeconds) {
        return {
          isError: true,
          payload: { error: 'arguments.timeoutSeconds must be an integer between 60 and 604800' },
        };
      }
    }
    // 任务级模型覆盖："provider/model"，字符白名单防 YAML 注入
    let model = null;
    const modelInput = typeof args?.model === 'string' ? args.model.trim() : '';
    if (modelInput) {
      if (!parseAgentModel(modelInput)) {
        return {
          isError: true,
          payload: {
            error: `arguments.model must be "provider/model" using letters, digits, dot, underscore and dash only, got: ${modelInput}`,
          },
        };
      }
      model = modelInput;
    }
    // 任务级权限模式：只允许等于或低于当前 DSH 全局子代理权限（"降低"语义）。
    // 不传（undefined/null）= 跟随全局设置；传了非法值明确报错；传了合法值但
    // 高于当前全局权限（如全局 workspace 时要 danger-full-access）也明确报错，
    // 绝不静默降级——调用方必须知道请求的限制没有按原样生效。
    let permissionMode = null;
    if (args?.permissionMode !== undefined && args?.permissionMode !== null) {
      const requested = parsePermissionMode(args.permissionMode);
      if (!requested) {
        return {
          isError: true,
          payload: {
            error: 'arguments.permissionMode must be one of: read-only, workspace-write, danger-full-access',
          },
        };
      }
      if (!isPermissionModeAllowed(requested)) {
        return {
          isError: true,
          payload: {
            error: `arguments.permissionMode "${requested}" exceeds the current global DSH subagent permission ("${globalPermissionMode()}"); only equal or lower modes are accepted`,
          },
        };
      }
      permissionMode = requested;
    }
    // 任务级推理力度：非空安全字符串（白名单见 REASONING_EFFORT_PART，防 YAML
    // 注入）。不传 = 不指定，overlay 不写 reasoningEffort 行，子代理沿用模型默认。
    let reasoningEffort = null;
    if (args?.reasoningEffort !== undefined && args?.reasoningEffort !== null) {
      const effort = parseReasoningEffort(args.reasoningEffort);
      if (!effort) {
        return {
          isError: true,
          payload: {
            error: 'arguments.reasoningEffort must be a non-empty string of at most 64 characters using letters, digits, dot, underscore and dash only',
          },
        };
      }
      reasoningEffort = effort;
    }
    // 指定了 reasoningEffort 时必须为 overlay 提供确定的 provider/model，优先级：
    // 任务级 model（上面已校验）> 插件全局 agentModel > 宿主共享默认选择
    //（agentDefaultModel 服务）。服务不可用/选择不完整时明确报错，绝不静默忽略。
    // 未指定 reasoningEffort 时不查询默认选择，保持原有行为（overlay 由
    // buildOverlayText 按任务级 model / 全局 agentModel 决定，都无则不写段）。
    let effectiveModel = model;
    if (reasoningEffort && !effectiveModel) {
      const globalModel = parseAgentModel(readUserConfig().agentModel);
      if (globalModel) {
        effectiveModel = `${globalModel.provider}/${globalModel.model}`;
      } else {
        try {
          effectiveModel = await resolveDefaultSelectionModel();
        } catch (err) {
          return { isError: true, payload: { error: String(err?.message ?? err) } };
        }
      }
    }
    // 队列上限：失控调用方（或死循环委托）最多排 200 个，超出明确报错，
    // 避免无限入队把内存与调度拖垮
    if (queue.length >= QUEUE_MAX) {
      return {
        isError: true,
        payload: { error: `task queue is full (${QUEUE_MAX} pending tasks); wait for existing tasks to finish` },
      };
    }
    const t = createTask(task, cwd);
    t.timeoutSeconds = timeoutSeconds;
    // effectiveModel：任务级显式覆盖，或为满足 reasoningEffort 解析出的有效模型
    //（null = 未指定推理力度且未指定模型，跟随全局/宿主默认）
    t.model = effectiveModel;
    // 权限快照：入队即固化本任务实际允许的权限——调用方显式传值（上面已校验
    // ≤ 当时全局）时快照该值；未传时快照当时的全局值。此后排队等待期间全局
    // 权限被调高不会让本任务提权（启动只认快照），被调低则由 startTask 的
    // 启动复核明确 failed，绝不静默升降。
    t.permissionMode = permissionMode ?? globalPermissionMode();
    t.reasoningEffort = reasoningEffort;
    queue.push(t.id);
    tryLaunch();
    schedulePersistTasks(); // 新任务入队即持久化（防抖），宿主中断后可恢复为 failed
    return {
      payload: {
        taskId: t.id,
        status: t.status, // 入队后的即时状态（可能已被立即启动为 running）
        note: 'Call wait_task with this taskId to await the result.',
      },
    };
  }

  // wait_task：已结束立即返回；否则阻塞等待，到点返回当前状态（正常 result，非 isError）
  async function toolWaitTask(args) {
    const taskId = typeof args?.taskId === 'string' ? args.taskId : '';
    const t = taskId ? tasks.get(taskId) : null;
    if (!t) {
      return { isError: true, payload: { error: 'unknown taskId' } };
    }

    let seconds = Number(args?.timeoutSeconds ?? WAIT_DEFAULT_SECONDS);
    if (!Number.isFinite(seconds)) seconds = WAIT_DEFAULT_SECONDS;
    seconds = Math.min(Math.max(seconds, WAIT_MIN_SECONDS), WAIT_MAX_SECONDS);

    // 终态（completed/failed/cancelled）立即返回快照；cancelled 由
    // notifyWaiters 唤醒后走到同一出口，等待方第一时间获知取消
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
      return { payload: taskSnapshot(t) };
    }

    // 客户端断连不影响这里：任务照常执行，断连只影响响应能否送达
    const payload = await new Promise((resolve) => {
      let timer = null;
      let waiter = null;
      const detach = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const set = waiters.get(t.id);
        if (set) {
          set.delete(waiter);
          if (set.size === 0) waiters.delete(t.id);
        }
      };
      waiter = () => {
        detach();
        resolve(taskSnapshot(t));
      };
      timer = setTimeout(() => {
        detach();
        // 超时到点：返回完整任务快照（running 时含 progress 轮次/步骤，
        // 调用方可据此区分"在推进"和"卡死"），并附加 note 说明仍在运行
        const snapshot = taskSnapshot(t);
        snapshot.note = 'still running; call wait_task again';
        resolve(snapshot);
      }, seconds * 1000);
      let set = waiters.get(t.id);
      if (!set) {
        set = new Set();
        waiters.set(t.id, set);
      }
      set.add(waiter);
    });
    return { payload };
  }

  // cancel_task：取消排队或运行中的任务，任务立即进入 cancelled 终态，
  // wait_task 等待者经 notifyWaiters 即时唤醒。
  // - queued：未占并发槽，直接置终态即可；queue 里残留的 id 会被 tryLaunch
  //   的"非 queued 跳过"逻辑忽略，无需从数组里摘除；
  // - running：先杀子进程再置终态。并发槽不在这里立即释放，而是等子进程
  //   close 后由 finishRunning 统一释放——避免旧进程还活着时新任务提前
  //   启动、瞬时超出 limits.maxConcurrent。
  function toolCancelTask(args) {
    const taskId = typeof args?.taskId === 'string' ? args.taskId : '';
    const t = taskId ? tasks.get(taskId) : null;
    if (!t) {
      return { isError: true, payload: { error: 'unknown taskId' } };
    }
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
      // 已是终态：幂等返回当前状态，不算错误（调用方与收尾事件可能并发）
      return {
        payload: { taskId: t.id, status: t.status, note: 'task already finished' },
      };
    }
    t.cancelRequested = true;
    if (t.status === 'queued') {
      finalize(t, 'cancelled', { error: 'cancelled before start' });
      return {
        payload: { taskId: t.id, status: t.status, note: 'queued task cancelled' },
      };
    }
    // 运行中：杀整棵进程树（Windows 上 kill() 杀不掉孙进程，孤儿会一直
    // 占着 stdio 句柄导致 close 永不触发）；先温和请求，宽限期内未退出
    // 再强制终止，保证 close 事件最终一定到来
    killTaskTree(t.child, false);
    if (t.killTimer) clearTimeout(t.killTimer);
    t.killTimer = setTimeout(() => {
      t.killTimer = null;
      killTaskTree(t.child, true);
    }, KILL_GRACE_MS);
    finalize(t, 'cancelled', { error: 'cancelled by request' });
    return {
      payload: { taskId: t.id, status: t.status, note: 'running task cancelled' },
    };
  }

  // ---------------------------------------------------------------------------
  // 运行中消息与温和中断（经 bridge-ipc.js 控制通道 + overlay 注入的
  // headless-control.js 插件实现）：
  // - send_message：向运行中子代理插话（steer = 引导当前回合的下一步骤；
  //   followup = 追加到当前回合结束后的下一轮），等子代理回执后才报告 accepted；
  // - interrupt_task：温和打断运行中子代理的当前回合（agent.cancel，保留收件箱
  //   未消费消息），等回执后把任务收尾为 cancelled；进程真正退出（并发槽释放）
  //   后可用 continue_task 续跑同一会话。
  // 两者都只对 running 且已上报 sessionId 的任务生效；任何失败都返回 isError
  // 并说明原因，绝不虚报消息已送达或中断已完成。cancel_task 的强制取消（直接
  // 杀整棵进程树）保持不变，两者语义互补。
  // ---------------------------------------------------------------------------

  // send_message：向运行中任务发送一条消息，等待子代理 ack 后返回 accepted。
  // - mode 'steer'（默认）：子代理侧执行 agent.steer，消息在当前回合的下一步骤
  //   生效（引导正在进行的回合）；
  // - mode 'followup'：子代理侧执行 agent.followup，消息排到当前回合结束后的
  //   下一轮执行；
  // - 仅 running 且子进程已上报 sessionId 时可发（sessionId 是控制协议寻址
  //   会话代理的唯一凭据）；queued（无会话可寻址）与终态（代理已停止，消息
  //   无人消费）一律明确报错，绝不静默丢弃；
  // - 失败（发送失败/等待超时/子进程退出/子代理拒绝）返回 isError 并携带原因，
  //   不声称消息已送达。
  async function toolSendMessage(args) {
    const taskId = typeof args?.taskId === 'string' ? args.taskId : '';
    const t = taskId ? tasks.get(taskId) : null;
    if (!t) {
      return { isError: true, payload: { error: 'unknown taskId' } };
    }
    // mode：'steer'（默认，引导当前回合的下一步骤）| 'followup'（下一轮执行）
    let mode = 'steer';
    if (args?.mode !== undefined && args?.mode !== null) {
      if (args.mode !== 'steer' && args.mode !== 'followup') {
        return {
          isError: true,
          payload: { error: 'arguments.mode must be "steer" or "followup"' },
        };
      }
      mode = args.mode;
    }
    const message = typeof args?.message === 'string' ? args.message : '';
    if (!message.trim()) {
      return { isError: true, payload: { error: 'arguments.message must be a non-empty string' } };
    }
    // 只有运行中且已建立会话的任务可插话
    if (t.status === 'queued') {
      return {
        isError: true,
        payload: { error: 'task is still queued; messages can only be sent to running tasks' },
      };
    }
    if (t.status !== 'running') {
      return {
        isError: true,
        payload: {
          error: `task is ${t.status}; use continue_task to send a follow-up to a finished session`,
        },
      };
    }
    if (!t.sessionId) {
      return {
        isError: true,
        payload: {
          error:
            'task is running but the agent session is not addressable yet (no sessionId reported); retry shortly',
        },
      };
    }
    if (!t.control) {
      return {
        isError: true,
        payload: {
          error: 'control channel is not available for this task; the message cannot be delivered',
        },
      };
    }
    try {
      // 经控制通道发给子进程内的 headless-control.js：action 与 mode 同名
      //（steer → agent.steer，followup → agent.followup）。await 到 ok:true
      // 回执才视为送达（CONTROL_ACK_TIMEOUT_MS 内未回执按失败处理）。
      await t.control.request(
        { sessionId: t.sessionId, action: mode, message },
        CONTROL_ACK_TIMEOUT_MS,
      );
    } catch (err) {
      // 失败必须如实报告：不声称已送达；任务若在此期间转入终态，一并说明
      const suffix = t.status !== 'running' ? `; task is now ${t.status}` : '';
      return {
        isError: true,
        payload: { error: `failed to deliver message: ${err?.message ?? err}${suffix}` },
      };
    }
    return {
      payload: {
        taskId: t.id,
        status: t.status,
        mode,
        accepted: true,
        note:
          mode === 'steer'
            ? 'message accepted; it steers the agent at its next step of the current turn'
            : 'message accepted; it will run as a follow-up turn after the current turn finishes',
      },
    };
  }

  // interrupt_task：温和中断运行中任务——经控制通道请求子进程内的
  // headless-control.js 对目标代理执行 agent.cancel（打断当前回合、保留收件箱
  // 未消费消息），等待 ack 确认后才收尾，绝不虚报中断已完成。
  // 与 cancel_task 的区别：不立即杀进程树，给子代理优雅收尾的机会；ack 成功后
  // 任务按 cancelled 终态收尾（原因注明温和中断），并发槽等子进程 close 后由
  // finishRunning/releaseSlot 释放——期间 continue_task 会被"原进程尚未退出"
  // 保护拒绝，进程真正退出后即可续跑同一会话。
  // 兜底：ack 后若子进程迟迟不退出（INTERRUPT_GRACE_MS），强杀整棵树保证
  // close 事件最终到来、并发槽不泄漏。
  async function toolInterruptTask(args) {
    const taskId = typeof args?.taskId === 'string' ? args.taskId : '';
    const t = taskId ? tasks.get(taskId) : null;
    if (!t) {
      return { isError: true, payload: { error: 'unknown taskId' } };
    }
    // 仅运行中且已建立会话的任务可温和中断；queued 用 cancel_task、终态不可中断
    if (t.status === 'queued') {
      return {
        isError: true,
        payload: {
          error: 'task is still queued; use cancel_task to cancel it before it starts',
        },
      };
    }
    if (t.status !== 'running') {
      return {
        isError: true,
        payload: { error: `task is already ${t.status}; only running tasks can be interrupted` },
      };
    }
    if (!t.sessionId) {
      return {
        isError: true,
        payload: {
          error:
            'task is running but the agent session is not addressable yet (no sessionId reported); retry shortly or use cancel_task',
        },
      };
    }
    if (!t.control) {
      return {
        isError: true,
        payload: {
          error: 'control channel is not available for this task; use cancel_task for a forced cancel',
        },
      };
    }
    try {
      // 温和打断：await ok:true 回执确认 agent.cancel 已执行（CONTROL_ACK_
      // TIMEOUT_MS 内未回执按失败处理，任务保持 running 不受影响）
      await t.control.request(
        { sessionId: t.sessionId, action: 'interrupt' },
        CONTROL_ACK_TIMEOUT_MS,
      );
    } catch (err) {
      // 失败（发送失败/超时/子进程退出/子代理拒绝）：明确 isError，任务保持
      // 原状；若已转入终态，一并说明当前状态
      const suffix = t.status !== 'running' ? `; task is now ${t.status}` : '';
      return {
        isError: true,
        payload: { error: `interrupt request failed: ${err?.message ?? err}${suffix}` },
      };
    }
    // ack 成功但任务已被其他路径（超时/取消）抢先收尾：如实报告，不声称已中断
    if (t.status !== 'running') {
      return {
        isError: true,
        payload: {
          error: `interrupt was acknowledged but the task already finished as ${t.status}`,
        },
      };
    }
    // 兜底强杀定时器与 cancel_task 同款：温和路径若迟迟等不到进程退出，
    // INTERRUPT_GRACE_MS 后强杀整棵树，保证 close 事件最终到来、槽不泄漏
    //（进程正常退出时 exit 回调会清掉该定时器；finalize 对 cancelled 不清
    // killTimer，正是为了让这个兜底继续生效）
    if (t.killTimer) clearTimeout(t.killTimer);
    t.killTimer = setTimeout(() => {
      t.killTimer = null;
      killTaskTree(t.child, true);
    }, INTERRUPT_GRACE_MS);
    finalize(t, 'cancelled', {
      error: 'interrupted by request; the agent round was cancelled gracefully',
    });
    return {
      payload: {
        taskId: t.id,
        status: t.status,
        note:
          'interrupt accepted; the task finishes as cancelled, and the session can be continued with continue_task once the subprocess has exited',
      },
    };
  }

  // 复用已终态任务（completed/failed/cancelled，且子进程上报过 sessionId）的
  // 持久化会话，另起任务执行追问；新任务继承前一任务的 model 与 timeoutSeconds。
  // 同会话并发保护：cancel_task 已返回但原进程尚未退出（仍持有并发槽/会话）时
  // 不允许续跑；所有同 sessionId 的运行/排队任务也都阻止并发续跑。
  function toolContinueTask(args) {
    const previous = tasks.get(args?.taskId);
    if (!previous) return { isError: true, payload: { error: 'unknown taskId' } };
    // 仅已终态（completed/failed/cancelled）且拿到了 sessionId 的任务可续跑；
    // 排队中或运行中的任务一律拒绝
    if (previous.status === 'queued' || previous.status === 'running') {
      return {
        isError: true,
        payload: { error: `task is ${previous.status}; only finished tasks can be continued` },
      };
    }
    if (!previous.sessionId) {
      return {
        isError: true,
        payload: { error: 'task has no sessionId; nothing to continue from' },
      };
    }
    const message = typeof args?.message === 'string' ? args.message : '';
    if (!message.trim()) return { isError: true, payload: { error: 'arguments.message must be a non-empty string' } };
    // 并发续跑保护一：cancel_task 立即返回 cancelled，但被取消任务的子进程
    // 要等 close 事件才释放并发槽——这段窗口期内原进程可能还活着，仍在持有
    // 该 DSH 会话。此时续跑会让同一会话出现两个并发进程（事件流互相污染、
    // 上下文交错），必须拒绝，让调用方等原进程真正退出后重试。
    if (previous.occupiesSlot || previous.child) {
      return {
        isError: true,
        payload: {
          error:
            "previous task's dsh process has not exited yet (concurrency slot still held); wait for it to finish before continuing the session",
        },
      };
    }
    // 并发续跑保护二：同一 sessionId 的任何运行/排队任务都阻止并发续跑。
    // 匹配是双向的——task.sessionId（原本就属于该会话的任务，或续跑后被子
    // 进程上报为该会话的任务）与 task.resumeSessionId（以该会话为目标入队的
    // 续跑任务）都算占用；occupiesSlot/child 兜底覆盖"状态已终态但子进程
    // 还没退出"的收尾窗口。
    const active = [...tasks.values()].find(
      (task) =>
        task.id !== previous.id &&
        (task.sessionId === previous.sessionId || task.resumeSessionId === previous.sessionId) &&
        (task.status === 'queued' || task.status === 'running' || task.occupiesSlot || task.child),
    );
    if (active) return { isError: true, payload: { error: `session already has an active continuation: ${active.id}` } };
    if (queue.length >= QUEUE_MAX) {
      return {
        isError: true,
        payload: { error: `task queue is full (${QUEUE_MAX} pending tasks); wait for existing tasks to finish` },
      };
    }
    // 权限继承与收敛（续跑绝不提权，绝不静默降级）：
    // - 基准权限 = 原任务入队时快照的实际权限（快照机制引入后的任务必有）；
    //   旧历史可能缺快照（null），此时基准只能取安全上限 workspace-write，
    //   并在响应中明确说明，绝不放宽到更高权限。
    // - 调用方显式传 permissionMode（可选）：必须是合法三值之一、不高于基准
    //  （同等或更低），且不高于当前全局；任一不满足都明确报错。
    // - 未显式传：继承基准；基准高于当前全局（原任务入队后全局被调低）时
    //   明确报错，提示显式传更低权限或调高全局后重试——绝不静默降级续跑。
    const baseMode = previous.permissionMode ?? 'workspace-write';
    const snapshotMissing = !previous.permissionMode;
    let effectiveMode = baseMode;
    const notes = [];
    if (snapshotMissing) {
      notes.push(
        `previous task has no recorded permissionMode snapshot; the continuation's permission is capped at the safe mode "${baseMode}"`,
      );
    }
    if (args?.permissionMode !== undefined && args?.permissionMode !== null) {
      const requested = parsePermissionMode(args.permissionMode);
      if (!requested) {
        return {
          isError: true,
          payload: {
            error: 'arguments.permissionMode must be one of: read-only, workspace-write, danger-full-access',
          },
        };
      }
      if (PERMISSION_MODE_RANK[requested] > PERMISSION_MODE_RANK[baseMode]) {
        return {
          isError: true,
          payload: {
            error: `arguments.permissionMode "${requested}" exceeds the continued task's permission ("${baseMode}"); only equal or lower modes are accepted`,
          },
        };
      }
      if (!isPermissionModeAllowed(requested)) {
        return {
          isError: true,
          payload: {
            error: `arguments.permissionMode "${requested}" exceeds the current global DSH subagent permission ("${globalPermissionMode()}"); only equal or lower modes are accepted`,
          },
        };
      }
      if (requested !== baseMode) {
        notes.push(`permissionMode lowered from the continued task's "${baseMode}" to "${requested}"`);
      }
      effectiveMode = requested;
    } else if (!isPermissionModeAllowed(baseMode)) {
      return {
        isError: true,
        payload: {
          error:
            `the continued task's permission "${baseMode}" exceeds the current global DSH subagent permission ` +
            `("${globalPermissionMode()}"); pass an equal or lower permissionMode explicitly (or raise the global permission) and retry`,
        },
      };
    }
    const next = createTask(message, previous.cwd, previous.sessionId);
    // 继承前一任务的任务级覆盖：model、timeoutSeconds 与 reasoningEffort 原样
    // 继承（reasoningEffort 与 model 配套存储，二者始终一致生效）；
    // permissionMode 取上面收敛出的快照（显式降权值 / 继承快照 / 缺快照时的
    // 安全上限 workspace-write），启动时按它注入
    next.model = previous.model;
    next.timeoutSeconds = previous.timeoutSeconds;
    next.permissionMode = effectiveMode;
    next.reasoningEffort = previous.reasoningEffort;
    queue.push(next.id);
    tryLaunch();
    schedulePersistTasks(); // 续跑任务入队即持久化（防抖），宿主中断后可恢复为 failed
    return {
      payload: {
        taskId: next.id,
        sessionId: previous.sessionId,
        status: next.status,
        permissionMode: next.permissionMode, // 本任务实际生效的权限快照
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      },
    };
  }

  // list_tasks：近期任务摘要，按创建时间倒序、最多 limits.historyLimit 条
  function toolListTasks() {
    const list = [...tasks.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limits.historyLimit)
      .map((t) => ({
        id: t.id,
        status: t.status,
        task: t.task.length > SUMMARY_LIMIT ? t.task.slice(0, SUMMARY_LIMIT) + '…' : t.task,
        elapsedMs: elapsedMs(t),
      }));
    return { payload: { tasks: list } };
  }

  async function callTool(name, args) {
    if (name === 'start_task') return toolStartTask(args);
    if (name === 'wait_task') return toolWaitTask(args);
    if (name === 'cancel_task') return toolCancelTask(args);
    if (name === 'interrupt_task') return toolInterruptTask(args);
    if (name === 'send_message') return toolSendMessage(args);
    if (name === 'continue_task') return toolContinueTask(args);
    if (name === 'list_tasks') return toolListTasks();
    return null; // 未知工具
  }

  // ---------- MCP JSON-RPC 处理 ----------
  // 处理单条消息：返回响应对象；通知（无 id 或 notifications/*）返回 null
  async function processMessage(message) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      typeof message.method !== 'string'
    ) {
      const id =
        message && typeof message === 'object' && !Array.isArray(message)
          ? message.id ?? null
          : null;
      return jsonRpcError(id, -32600, 'Invalid Request');
    }

    // 通知：不写响应体
    if (message.id === undefined || message.id === null || message.method.startsWith('notifications/')) {
      return null;
    }

    const { id } = message;
    switch (message.method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion:
            typeof message.params?.protocolVersion === 'string'
              ? message.params.protocolVersion
              : PROTOCOL_VERSION_DEFAULT,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        });
      case 'tools/list':
        return jsonRpcResult(id, { tools: TOOLS });
      case 'ping':
        // MCP 标准探活请求，规范要求回空结果对象（缺失会让严格客户端断连）
        return jsonRpcResult(id, {});
      case 'tools/call': {
        const name = message.params?.name;
        if (typeof name !== 'string') {
          return jsonRpcError(id, -32602, 'tools/call requires params.name');
        }
        let outcome;
        try {
          outcome = await callTool(name, message.params?.arguments ?? {});
        } catch (err) {
          // 工具内部异常按 MCP 惯例转为 isError 结果，而不是协议错误
          outcome = { isError: true, payload: { error: String(err?.message ?? err) } };
        }
        if (!outcome) return jsonRpcError(id, -32602, `unknown tool: ${name}`);
        const result = {
          content: [{ type: 'text', text: JSON.stringify(outcome.payload, null, 2) }],
        };
        if (outcome.isError) result.isError = true; // 业务失败（如 unknown taskId）
        return jsonRpcResult(id, result);
      }
      default:
        return jsonRpcError(id, -32601, 'method not found');
    }
  }

  // MCP 端点：POST <routePath>，streamable-http；端点不做鉴权，凭 URL 即可调用
  async function handleMcp(req, res) {
    let raw;
    try {
      raw = await readBody(req, BODY_LIMIT);
    } catch (err) {
      if (err?.statusCode === 413) {
        sendJson(res, 413, { error: 'payload too large' });
      } else {
        sendJson(res, 400, { error: 'failed to read request body' });
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 解析失败：HTTP 400 + JSON-RPC parse error
      sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    // 客户端已断连就不再写响应；wait_task 的等待在内部继续，任务不受影响
    if (res.destroyed) return;

    if (Array.isArray(parsed)) {
      // 批处理：并发处理、逐条给响应（通知不产生响应），数组形式返回。
      // 并行是刻意的：wait_task 可以阻塞 600 秒，串行会拖住同批的
      // start_task/list_tasks 等瞬时消息。
      if (parsed.length === 0) {
        sendJson(res, 400, jsonRpcError(null, -32600, 'Invalid Request: empty batch'));
        return;
      }
      const results = await Promise.all(
        parsed.map(async (message) => {
          try {
            return await processMessage(message);
          } catch (err) {
            const id =
              message && typeof message === 'object' && !Array.isArray(message)
                ? message.id ?? null
                : null;
            return jsonRpcError(id, -32603, 'Internal error');
          }
        }),
      );
      const responses = results.filter(Boolean);
      if (responses.length === 0) {
        sendNoContent(res, 202); // 全是通知
        return;
      }
      sendJson(res, 200, responses);
      return;
    }

    try {
      const response = await processMessage(parsed);
      if (!response) {
        sendNoContent(res, 202); // 通知：202 空响应
        return;
      }
      sendJson(res, 200, response);
    } catch (err) {
      const id = parsed && typeof parsed === 'object' ? parsed.id ?? null : null;
      sendJson(res, 200, jsonRpcError(id, -32603, 'Internal error'));
    }
  }

  // ---------- 路由分发 ----------
  async function handler(req, res) {
    try {
      const method = req.method ?? 'GET';
      // routePath 是前缀，req.url 是完整路径；用 URL 剥离查询串
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      // 预检请求：恢复旧版行为，所有路径一律 204 空响应并放开跨域——
      // 允许 GET/POST/OPTIONS 方法与 content-type、authorization 请求头
      //（authorization 兼容旧版带授权头的浏览器跨域请求，端点不校验该头）
      if (method === 'OPTIONS') {
        sendNoContent(res, 204, {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
        });
        return;
      }

      if (!pathname.startsWith(routePath)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      // MCP JSON-RPC 入口：精确匹配 POST <routePath>；GET（server-initiated
      // SSE 通道）本实现不提供，按 MCP 惯例回 405 Method Not Allowed
      if (pathname === routePath) {
        if (method === 'POST') {
          await handleMcp(req, res);
          return;
        }
        sendNoContent(res, 405);
        return;
      }

      const rest = pathname.slice(routePath.length); // '/' | '/tasks' | '/tasks/<id>' | '/info' | ...

      if (method === 'GET') {
        // 面板轮询：任务列表，按创建时间倒序、最多 historyLimit 条
        if (rest === '/tasks') {
          const list = [...tasks.values()]
            .sort((a, b) => b.createdAtMs - a.createdAtMs)
            .slice(0, limits.historyLimit)
            .map(taskView);
          sendJson(res, 200, { tasks: list });
          return;
        }
        // 面板轮询：单个任务
        if (rest.startsWith('/tasks/')) {
          const taskId = rest.slice('/tasks/'.length);
          const t = taskId ? tasks.get(taskId) : null;
          if (!t) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          sendJson(res, 200, taskView(t));
          return;
        }
        // 面板/接入方：桥接信息
        if (rest === '/info') {
          let origin = '';
          try {
            origin = webServer.getOrigin(); // 端口一律来自宿主，不硬编码
          } catch {
            // 监听未就绪时无 origin，给空串兜底
          }
          sendJson(res, 200, {
            mcpUrl: origin + routePath,
            tools: [
              'start_task',
              'wait_task',
              'cancel_task',
              'interrupt_task',
              'send_message',
              'continue_task',
              'list_tasks',
            ],
            activeCount: [...tasks.values()].filter(
              (t) => t.status === 'queued' || t.status === 'running',
            ).length,
            dshReady: Boolean(resolveLauncher()),
            codexSync,
            // 持久化健康状态：写盘/加载失败绝不能静默，这里原样可见
            persistence: {
              path: tasksFilePath,
              status: persistence.status,
              lastError: persistence.lastError,
              lastSavedAt: persistence.lastSavedAt,
              loadedCount: persistence.loadedCount,
              recoveredToFailed: persistence.recoveredToFailed,
            },
          });
          return;
        }
        // 设置页读取：子代理模型 + 沙箱权限 + 运行限额 + 可用模型列表（从宿主用户 patch 解析）
        if (rest === '/config') {
          const saved = readUserConfig();
          sendJson(res, 200, {
            agentModel: typeof saved.agentModel === 'string' ? saved.agentModel : '',
            agentPolicy,
            limits,
            providers: availableModels(),
            agentModelConfigPath: configFilePath,
          });
          return;
        }
      }

      // 设置页保存：partial 更新（agentModel 与/或 limits 三项），保存即热生效
      if (method === 'POST' && rest === '/config') {
        let raw;
        try {
          raw = await readBody(req, BODY_LIMIT);
        } catch {
          sendJson(res, 400, { error: 'failed to read request body' });
          return;
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body must be a JSON object' });
          return;
        }
        const patchObj = {};
        if (Object.hasOwn(body, 'agentModel')) {
          const agentModel = typeof body.agentModel === 'string' ? body.agentModel.trim() : '';
          if (agentModel && !parseAgentModel(agentModel)) {
            sendJson(res, 400, { error: 'agentModel must be "provider/model" or empty' });
            return;
          }
          patchObj.agentModel = agentModel;
        }
        if (Object.hasOwn(body, 'agentPolicy')) {
          if (!POLICIES.has(body.agentPolicy)) {
            sendJson(res, 400, { error: "agentPolicy must be 'workspace' or 'full'" });
            return;
          }
          patchObj.agentPolicy = body.agentPolicy;
          agentPolicy = body.agentPolicy; // 热生效：之后启动的任务用新权限
        }
        if (
          Object.hasOwn(body, 'maxConcurrent') ||
          Object.hasOwn(body, 'maxTaskSeconds') ||
          Object.hasOwn(body, 'historyLimit')
        ) {
          // 与现有用户配置合并后统一 clamp，写入的值总是合法区间内的整数
          const previous = limits;
          const merged = clampLimits({ ...readUserConfig(), ...body });
          Object.assign(patchObj, merged);
          limits = merged; // 热生效：调度/超时/历史裁剪立即用新值
          // 调大并发上限：立即调度排队任务（否则要等下一次任务自然结束才启动）
          if (merged.maxConcurrent > previous.maxConcurrent) tryLaunch();
          // 调小历史条数：立即裁剪一次（否则要等下一个任务结束才裁）
          if (merged.historyLimit < previous.historyLimit) trimHistory();
        }
        if (Object.keys(patchObj).length === 0) {
          sendJson(res, 400, { error: 'no recognized fields to save' });
          return;
        }
        const saved = writeUserConfig(patchObj);
        sendJson(res, 200, {
          ok: true,
          agentModel: typeof saved.agentModel === 'string' ? saved.agentModel : '',
          agentPolicy,
          limits,
        });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      // 兜底：不让异常逃逸（webserver 会把异常变 400，这里给更明确的 500）
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: 'internal error', message: String(err?.message ?? err) });
      } else {
        try {
          res.end();
        } catch {
          // 忽略
        }
      }
    }
  }

  // ---------- 资源注册与清理 ----------
  ctx.effect(() => {
    const disposeRoute = webServer.register({ kind: 'prefix', path: routePath, handler });
    return () => {
      disposed = true;
      // 1. 注销路由：卸载后端点消失，属预期
      try {
        disposeRoute();
      } catch {
        // 路由已失效也无妨
      }
      // 2. 收尾所有未终态任务：杀子进程、标记失败、唤醒等待者（finalize 内
      //    清定时器）；槽位经 releaseSlot 统一释放，保持计数一致
      for (const t of tasks.values()) {
        if (
          t.status === 'completed' ||
          t.status === 'failed' ||
          t.status === 'cancelled'
        ) {
          continue;
        }
        // 控制通道随停机终结：reject 在途请求并摘除监听（dispose 幂等），
        // 避免通道事件在停机后仍触发
        if (t.control) {
          try {
            t.control.dispose();
          } catch {
            // 通道已失效也无妨
          }
          t.control = null;
        }
        try {
          killTaskTree(t.child, true); // 停机强杀整棵进程树，不留孤儿
        } catch {
          // 进程可能已退出
        }
        finalize(t, 'failed', { error: 'host shutting down' });
        releaseSlot(t); // disposed 已置 true，tryLaunch 不会启动新任务
      }
      // 3. 定时器已全部随 finalize 清空；waiter 自身的超时定时器由其唤醒回调清理
      // 4. 停机前强刷一次任务状态：把收尾产生的 failed 终态与未落盘的变更
      //    写进 tasks.json，重启后可查可续跑；persistTasksNow 内部会清掉
      //    尚未触发的防抖定时器
      persistTasksNow();
    };
  });
}
