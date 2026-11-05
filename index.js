// ============================================================================
// @local/dsh-subagent-bridge — Host 侧入口
//
// 职责：
// 1. 在宿主 webServer 上注册 HTTP 前缀路由，对外暴露 MCP streamable-http 端点
//    （JSON-RPC 2.0，无鉴权，绑定在宿主 loopback 服务上），供 Codex 委托任务；
// 2. 把每个任务 spawn 成一个 headless DSH 子进程执行，限制并发、超时与历史条数；
// 3. 提供 /tasks、/tasks/<id>、/info 三个只读 JSON 端点，供 Web 面板轮询展示。
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
import { fileURLToPath } from 'node:url';

// ---------- 常量 ----------
const PROTOCOL_VERSION_DEFAULT = '2025-06-18';
const SERVER_INFO = { name: 'dsh-subagent-bridge', version: '1.0.0' };
const MCP_INSTRUCTIONS =
  'Delegate tasks to DSH subagents. Start tasks and wait for results; use cancel_task to cancel, or continue_task for a completed session. Running tasks cannot receive messages.';
const BODY_LIMIT = 1024 * 1024;   // MCP 请求体上限 1MB，超限回 413
const STDERR_TAIL_LIMIT = 4000;   // stderr 只保留尾部 4000 字符做失败诊断
const ERROR_TEXT_LIMIT = 2000;    // 对外错误文本截断长度
const SUMMARY_LIMIT = 120;        // list_tasks 任务文本摘要长度
const WAIT_MIN_SECONDS = 10;      // wait_task 阻塞时长下限
const WAIT_MAX_SECONDS = 600;     // wait_task 阻塞时长上限
const WAIT_DEFAULT_SECONDS = 120; // wait_task 默认阻塞时长
const KILL_GRACE_MS = 5000;       // cancel_task 后 SIGTERM→SIGKILL 的宽限期；
                                  // 宽限到点仍不退出就强杀，保证 close 事件一定到来，
                                  // 并发槽才不会永久挂起

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
  fs.writeFileSync(configFilePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

// "provider/model" → { provider, model }；空串/非法格式返回 null（跟随宿主默认）
function parseAgentModel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
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
// + 可选的 agent-default-model 覆盖（同 id 后写覆盖先写）。
function buildOverlayText() {
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
  const override = parseAgentModel(readUserConfig().agentModel);
  if (override) {
    lines.push(
      "- id: agent-default-model",
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      `    provider: ${override.provider}`,
      `    model: ${override.model}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// 把 overlay 写进临时文件，返回路径；调用方在子进程退出后删除
function writeTempOverlay() {
  const tmp = path.join(os.tmpdir(), `dsh-subagent-bridge-${process.pid}-${randomBytes(4).toString('hex')}.yml`);
  fs.writeFileSync(tmp, buildOverlayText(), 'utf8');
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

// ---------------------------------------------------------------------------
// MCP 工具定义（description 面向模型、英文、简洁准确；JSON Schema draft 风格）
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'start_task',
    description:
      'Start a task in a fresh DSH subagent (a headless DeepSeek Harness run with full file and shell tools). Returns a taskId immediately; poll with wait_task for the result.',
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
    name: 'continue_task',
    description: 'Continue a completed DSH task in the same session. Returns a new taskId; wait for that task. Running tasks cannot be steered.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Completed task id whose session should be continued.' },
        message: { type: 'string', description: 'Follow-up instructions for that session.' },
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
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*', // 同源即可用；带上便于面板调试工具跨域访问
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

// 空响应：OPTIONS 预检 204 / MCP 通知 202
function sendNoContent(res, status) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
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
  const maxConcurrent = clampInt(config?.maxConcurrent, 4, 1, 64);
  const maxTaskSeconds = clampInt(config?.maxTaskSeconds, 1800, 1, 7 * 24 * 3600);
  const historyLimit = clampInt(config?.historyLimit, 50, 1, 1000);

  const webServer = ctx.webServer; // 由 patch 行的 inject: [webServer] 注入
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-subagent-bridge requires the webServer service (inject: [webServer])');
  }

  // ---------- Codex 端点自动同步 ----------
  // DSH webserver 端口每次启动都会变，Codex 里注册的 MCP URL 会随之失效。
  // webServer 就绪后自动把 ~/.codex/config.toml 的 [mcp_servers.dsh-subagent]
  // 段刷新为当前端点；段不存在时自动追加（等效替用户执行 codex mcp add）。
  // 只改动这一段的 url 行，文件其余内容不碰；本机没有 Codex 配置则静默跳过。
  const codexSync = { status: 'pending', configPath: codexConfigPath, lastError: null };

  function syncCodexConfig(origin) {
    try {
      const url = origin + routePath;
      const urlLine = `url = "${url}"`;
      let text;
      try {
        text = fs.readFileSync(codexConfigPath, 'utf8');
      } catch {
        codexSync.status = 'skipped'; // 没有 ~/.codex/config.toml：本机未装 Codex
        return;
      }
      const lines = text.split(/\r?\n/);
      const sectionRe = /^\s*\[mcp_servers\.dsh-subagent\]\s*$/;
      let sectionIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (sectionRe.test(lines[i])) {
          sectionIndex = i;
          break;
        }
      }
      if (sectionIndex === -1) {
        // 段不存在：文件尾追加（先去掉结尾多余空行，再保证一个空行分隔）
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
        lines.push('', '[mcp_servers.dsh-subagent]', urlLine, '');
        fs.writeFileSync(codexConfigPath, lines.join('\n'), 'utf8');
        codexSync.status = 'created';
        return;
      }
      // 段内找 url 行（扫到下一个段头或 EOF 为止）
      let urlIndex = -1;
      for (let i = sectionIndex + 1; i < lines.length; i++) {
        if (/^\s*\[/.test(lines[i])) break; // 进入下一段
        if (/^\s*url\s*=/.test(lines[i])) {
          urlIndex = i;
          break;
        }
      }
      if (urlIndex === -1) {
        lines.splice(sectionIndex + 1, 0, urlLine); // 段内没有 url：插到段头后
        fs.writeFileSync(codexConfigPath, lines.join('\n'), 'utf8');
        codexSync.status = 'updated';
        return;
      }
      if (lines[urlIndex].trim() === urlLine) {
        codexSync.status = 'unchanged'; // 已指向当前端点
        return;
      }
      lines[urlIndex] = urlLine;
      fs.writeFileSync(codexConfigPath, lines.join('\n'), 'utf8');
      codexSync.status = 'updated';
    } catch (err) {
      codexSync.status = 'failed';
      codexSync.lastError = String(err?.message ?? err);
    }
  }

  // webServer 监听是异步的：就绪前 getOrigin 拿不到端口。就绪轮询（每秒一次、
  // 最多 60 秒），拿到端口立即同步一次 Codex 配置；失败不影响其他功能。
  ctx.effect(() => {
    let tries = 0;
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
        clearInterval(timer);
        codexSync.status = 'failed';
        codexSync.lastError = 'webServer origin not ready within 60s';
      }
    }, 1000);
    return () => clearInterval(timer);
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
      stderrTail: '',   // 子进程 stderr 尾部（仅诊断用；其中的 import 警告无害）
      error: null,      // failed/cancelled 时对外诊断（cancelled 存取消原因）
      timedOut: false,  // 是否因 maxTaskSeconds 超时被杀
      cancelRequested: false, // 是否被 cancel_task 请求取消
      occupiesSlot: false,    // 是否正占用并发槽（释放以它为准，防漏防重）
      killTimer: null,  // 取消后的强杀兜底定时器（SIGTERM 宽限到点转 SIGKILL）
      pid: null,
      child: null,
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
      pid: t.pid,
      elapsedMs: elapsedMs(t),
    };
  }

  // wait_task 已结束时的返回快照
  function taskSnapshot(t) {
    const payload = {
      taskId: t.id,
      status: t.status,
      sessionId: t.sessionId,
      elapsedMs: elapsedMs(t),
    };
    if (t.status === 'completed') payload.answer = t.answer;
    if (t.status === 'failed' || t.status === 'cancelled') payload.error = t.error;
    return payload;
  }

  // 历史裁剪：终态任务超过 historyLimit 时按创建时间删最旧（不动 queued/running）
  function trimHistory() {
    const finished = [...tasks.values()]
      .filter(
        (t) =>
          t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    let excess = finished.length - historyLimit;
    for (const t of finished) {
      if (excess-- <= 0) break;
      tasks.delete(t.id);
    }
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

    const launcher = resolveLauncher();
    if (!launcher) {
      finishRunning(t, 'failed', { error: 'dsh launcher not found; is DeepSeek Harness installed?' });
      return;
    }

    // 直接 spawn Electron exe + ELECTRON_RUN_AS_NODE，等价官方 dsh.cmd 但绕开 cmd.exe 转义；
    // 中文目录等路径原样作为参数传入即可。终态判定统一放在 close 事件
    // （见下），exit 只负责资源清理。
    // overlay 每次任务动态生成（读宿主 desktop 用户 patch + 可选模型覆盖），
    // 写临时文件、子进程退出后删除。
    const overlayFile = writeTempOverlay();
    let child;
    try {
      const spawnOptions = {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
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

    // 任务全文经 stdin 传入；子进程提前退出会触发 EPIPE，监听 error 吞掉即可
    child.stdin.on('error', () => {});
    child.stdin.end(t.task);

    // 任务级超时：到点杀进程；终态判定统一在 close 回调里做
    t.timer = setTimeout(() => {
      t.timedOut = true;
      try {
        child.kill();
      } catch {
        // 进程可能已退出
      }
    }, maxTaskSeconds * 1000);

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
        // session 事件带 sessionId
        t.sessionId =
          typeof event.sessionId === 'string'
            ? event.sessionId
            : typeof event.id === 'string'
              ? event.id
              : t.sessionId;
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

    // spawn 失败（如 ENOENT）：只有 error 事件，通常没有 exit
    child.on('error', (err) => {
      finishRunning(t, 'failed', { error: `failed to run dsh: ${err?.message ?? err}` });
    });

    // 进程退出：只做资源清理。终态判定放在 close 事件——exit 触发时 stdout
    // 的缓冲可能还没读尽，最后的 'final' 事件行会因此丢失；close 保证 stdio
    // 流全部结束（stdout 数据已读完）后才触发。
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
    });

    // stdio 流全部结束、stdout 完整收尾后的终态判定：
    // - 超时被杀 → failed（标注超时原因）；
    // - 已被取消 → 保持 cancelled（finalize 幂等拒绝，这里只释放并发槽）；
    // - 退出码 0 且收到过有效 final 且无 error 事件 → completed；
    // - 其余（非 0 退出、退出 0 但没有有效 final、收到过 error 事件）→ failed，
    //   绝不因退出码好看而误报成功。
    child.on('close', (code) => {
      if (t.killTimer) {
        clearTimeout(t.killTimer);
        t.killTimer = null;
      }
      if (t.timedOut) {
        finishRunning(t, 'failed', {
          error:
            `task exceeded maxTaskSeconds (${maxTaskSeconds}s)` +
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
      while (!disposed && running < maxConcurrent && queue.length > 0) {
        const id = queue.shift();
        const t = tasks.get(id);
        if (!t || t.status !== 'queued') continue; // 已被清理的残留引用，跳过
        startTask(t);
      }
    } finally {
      launching = false;
    }
  }

  // ---------- MCP 工具实现 ----------
  // start_task：入队，立即返回 taskId
  function toolStartTask(args) {
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
    const t = createTask(task, cwd);
    queue.push(t.id);
    tryLaunch();
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
        resolve({
          taskId: t.id,
          status: t.status, // queued | running
          elapsedMs: elapsedMs(t),
          note: 'still running; call wait_task again',
        });
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
  //   启动、瞬时超出 maxConcurrent。
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
    // 运行中：杀子进程；Windows 上 kill() 即强终止，POSIX 上先发 SIGTERM，
    // 若宽限期内仍未退出再补 SIGKILL，保证 close 事件最终一定到来
    try {
      t.child?.kill();
    } catch {
      // 进程可能已自行退出
    }
    if (t.killTimer) clearTimeout(t.killTimer);
    t.killTimer = setTimeout(() => {
      t.killTimer = null;
      try {
        t.child?.kill('SIGKILL');
      } catch {
        // 进程可能已退出
      }
    }, KILL_GRACE_MS);
    finalize(t, 'cancelled', { error: 'cancelled by request' });
    return {
      payload: { taskId: t.id, status: t.status, note: 'running task cancelled' },
    };
  }

  // 复用已完成任务的持久化会话，另起任务执行追问。
  function toolContinueTask(args) {
    const previous = tasks.get(args?.taskId);
    if (!previous) return { isError: true, payload: { error: 'unknown taskId' } };
    if (previous.status !== 'completed' || !previous.sessionId) {
      return { isError: true, payload: { error: 'task must be completed with a sessionId before continuation' } };
    }
    const message = typeof args?.message === 'string' ? args.message : '';
    if (!message.trim()) return { isError: true, payload: { error: 'arguments.message must be a non-empty string' } };
    const active = [...tasks.values()].find((task) =>
      task.resumeSessionId === previous.sessionId && (task.status === 'queued' || task.status === 'running'));
    if (active) return { isError: true, payload: { error: `session already has an active continuation: ${active.id}` } };
    const next = createTask(message, previous.cwd, previous.sessionId);
    queue.push(next.id);
    tryLaunch();
    return { payload: { taskId: next.id, sessionId: previous.sessionId, status: next.status } };
  }

  // list_tasks：近期任务摘要，按创建时间倒序、最多 historyLimit 条
  function toolListTasks() {
    const list = [...tasks.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, historyLimit)
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

  // MCP 端点：POST <routePath>，streamable-http，无鉴权（绑定在宿主 loopback 服务上）
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
      // 批处理：逐个处理、逐个给响应（通知不产生响应），数组形式返回
      if (parsed.length === 0) {
        sendJson(res, 400, jsonRpcError(null, -32600, 'Invalid Request: empty batch'));
        return;
      }
      const responses = [];
      for (const message of parsed) {
        try {
          const response = await processMessage(message);
          if (response) responses.push(response);
        } catch (err) {
          const id =
            message && typeof message === 'object' && !Array.isArray(message)
              ? message.id ?? null
              : null;
          responses.push(jsonRpcError(id, -32603, 'Internal error'));
        }
      }
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

      // 预检请求：CORS 无害放行，便于面板/调试工具访问
      if (method === 'OPTIONS') {
        sendNoContent(res, 204);
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
            .slice(0, historyLimit)
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
            tools: ['start_task', 'wait_task', 'cancel_task', 'continue_task', 'list_tasks'],
            activeCount: [...tasks.values()].filter(
              (t) => t.status === 'queued' || t.status === 'running',
            ).length,
            dshReady: Boolean(resolveLauncher()),
            codexSync,
          });
          return;
        }
        // 设置页读取：子代理模型配置 + 可用模型列表（从宿主用户 patch 解析）
        if (rest === '/config') {
          sendJson(res, 200, {
            agentModel: typeof readUserConfig().agentModel === 'string' ? readUserConfig().agentModel : '',
            providers: availableModels(),
            agentModelConfigPath: configFilePath,
          });
          return;
        }
      }

      // 设置页保存：子代理模型覆盖（空串 = 跟随宿主默认模型）
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
        const agentModel = typeof body?.agentModel === 'string' ? body.agentModel.trim() : '';
        if (agentModel && !parseAgentModel(agentModel)) {
          sendJson(res, 400, { error: 'agentModel must be "provider/model" or empty' });
          return;
        }
        const saved = writeUserConfig({ agentModel });
        sendJson(res, 200, { ok: true, agentModel: saved.agentModel ?? '' });
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
        try {
          t.child?.kill(); // Windows 上 child.kill() 即可，不做更复杂的进程树处理
        } catch {
          // 进程可能已退出
        }
        finalize(t, 'failed', { error: 'host shutting down' });
        releaseSlot(t); // disposed 已置 true，tryLaunch 不会启动新任务
      }
      // 3. 定时器已全部随 finalize 清空；waiter 自身的超时定时器由其唤醒回调清理
    };
  });
}
