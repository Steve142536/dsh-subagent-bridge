// ============================================================================
// tests/permission-snapshot.test.mjs — 任务权限快照（permissionMode）集成测试
//
// 被测契约（index.js 的权限快照机制，经 tests/fixture-host.mjs 真实 HTTP 宿主）：
//   1. start_task 显式传 permissionMode：只允许等于或低于当前全局权限——
//      全局 workspace（workspace-write）时传 read-only 成功入队、传
//      danger-full-access 明确报错（绝不静默降级）；成功入队的任务其权限
//      快照被固化为 "read-only"。
//      说明：MCP wait_task 的任务快照不携带 permissionMode 字段，插件把
//      "任务级权限快照"固化在落盘历史文件（persistedTaskView 的
//      permissionMode），因此这里以真实 MCP 入队结果 + 落盘任务快照双重验证；
//   2. continue_task 基于预置的已完成历史（completed + sessionId + 快照
//      read-only）：
//      a) 显式传 workspace-write（高于原任务快照）→ 明确拒绝；
//      b) 不传 permissionMode → 继承原任务快照 read-only 续跑（响应携带
//         permissionMode="read-only"，且落盘快照同样继承）；
//   3. continue_task 基于预置的已完成历史（快照 danger-full-access）而当前
//      全局为 workspace（workspace-write）：直接续跑（不传 permissionMode）
//      明确拒绝，绝不静默降级。
//
// 隔离性约定：
//   - 每个用例在系统临时目录（os.tmpdir()）下用 mkdtemp 新建唯一的临时目录，
//     作为 fixture-host 子进程的专属 USERPROFILE（HOME、CODEX_HOME 保持继承
//     值不动）；Windows 上 os.homedir() 只认 USERPROFILE，因此插件触达的
//     ~/.dsh、~/.codex 全部落在临时目录内，本测试绝不读取或修改本机真实
//     用户数据，也绝不触碰其他 DSH 任务；
//   - fixture-host 只绑 127.0.0.1 随机端口，本测试仅访问本宿主端口；
//   - 测试环境（node.exe 直接运行 fixture-host）解析不到 DSH launcher，入队
//     任务会立即 failed，全程不产生真实 DSH 子代理进程；兜底起见，用例内对
//     一切非终态任务先 cancel_task（插件内部只杀该任务自己的子进程树）再等
//     终态，停宿主时也只终止本测试启动的宿主进程树；
//   - 清理时先复核目标目录确实位于系统临时目录之内、且目录名带本测试专属
//     前缀，才递归删除——只清理本测试自己 mkdtemp 新建的目录；
//   - 不重启任何服务，只运行本文件。
// ============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 路径常量 ----------
// 同目录的 fixture-host：以子进程方式启动的真实 HTTP 测试宿主
const fixtureHostPath = fileURLToPath(new URL('./fixture-host.mjs', import.meta.url));
// fixture-host 所在目录即插件仓库根（子进程工作目录，保持确定性）
const pluginRoot = path.dirname(path.dirname(fixtureHostPath));

// ---------- 测试常量 ----------
// 本测试临时目录的专属前缀：mkdtemp 用它命名，清理时以此复核，杜绝误删
const TEMP_PREFIX = 'dsh-permission-test-';
// 插件默认的 MCP 前缀路由（fixture-host 以空 config 激活插件，走默认值）
const MCP_ROUTE = '/mcp/dsh-subagent';
// 等待 fixture-host 输出端口行的上限：正常毫秒级就绪，超时视为启动失败
const HOST_READY_TIMEOUT_MS = 15000;
// 等待子进程退出的上限：防止意外挂死测试进程
const EXIT_WAIT_TIMEOUT_MS = 10000;
// 等待插件把任务快照落盘（防抖 100ms 后写历史文件）的上限
const FILE_POLL_TIMEOUT_MS = 5000;
// 预写历史用的固定时间戳（远早于现在，保证与运行时刻可区分）
const OLD_CREATED_AT_MS = 1700000000000;

// 预置历史里 read-only 原任务的标识与会话（用例 2 续跑基准）
const READONLY_ID = 'dshx-snap-readonly';
const READONLY_SESSION = 'sess-snap-readonly';
// 预置历史里 danger-full-access 原任务的标识与会话（用例 3 续跑基准）
const FULLACCESS_ID = 'dshx-snap-fullaccess';
const FULLACCESS_SESSION = 'sess-snap-fullaccess';

// 本测试创建的全部临时目录：after() 统一复核并清理
const createdTempRoots = [];

// ---------------------------------------------------------------------------
// 临时目录与预置文件
// ---------------------------------------------------------------------------
/**
 * 在系统临时目录下 mkdtemp 一个唯一的临时目录，作为本用例 fixture-host 子进程
 * 的专属 USERPROFILE。目录记录进 createdTempRoots，全部用例结束后统一复核清理。
 * @param {string} name 用例名（拼进目录名，便于排查残留）
 * @returns {string} 临时目录绝对路径
 */
function makeTempProfile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${name}-`));
  createdTempRoots.push(dir);
  return dir;
}

// 全部用例结束后统一清理：每个目录都必须同时满足"位于系统临时目录之内"且
// "目录名带本测试专属前缀"两个条件才递归删除——只删本测试自己创建的内容。
after(() => {
  const systemTmp = path.resolve(os.tmpdir());
  for (const root of createdTempRoots) {
    const target = path.resolve(root);
    if (
      target.startsWith(systemTmp + path.sep) &&
      path.basename(target).startsWith(TEMP_PREFIX)
    ) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
});

/**
 * 在临时 USERPROFILE 下预写用户设置文件（~/.dsh/subagent-bridge.config.json），
 * 显式声明当前全局子代理权限为 workspace（工作区沙箱，注入值 workspace-write），
 * 让"现全局 workspace"成为显式事实，而不依赖内置默认值。
 * @param {string} profileDir 临时 USERPROFILE 目录
 */
function writeGlobalWorkspaceConfig(profileDir) {
  const dir = path.join(profileDir, '.dsh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'subagent-bridge.config.json'),
    `${JSON.stringify({ agentPolicy: 'workspace' }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * 在临时 USERPROFILE 下预写 version:1 的任务历史文件
 * （<USERPROFILE>/.dsh/subagent-bridge.tasks.json），字段形状与插件
 * persistedTaskView 的落盘格式一致，让 loadPersistedTasks 按真实路径恢复。
 * @param {string} profileDir 临时 USERPROFILE 目录
 * @param {Array<object>} tasks 预写的任务条目数组
 * @returns {string} 历史文件绝对路径
 */
function writeHistoryFile(profileDir, tasks) {
  const dir = path.join(profileDir, '.dsh');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'subagent-bridge.tasks.json');
  const payload = {
    version: 1,
    savedAtMs: OLD_CREATED_AT_MS,
    savedAt: new Date(OLD_CREATED_AT_MS).toISOString(),
    tasks,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * 构造一条历史 completed 任务条目：带会话 id 与任务级权限快照，
 * 模拟"宿主重启前已正常完成、带 permissionMode 快照的任务"
 * （continue_task 只对已终态且有 sessionId 的任务放行）。
 * @param {string} id 任务 id
 * @param {string} task 任务文本
 * @param {string} sessionId 已上报的 DSH 会话 id
 * @param {string} permissionMode 任务级权限快照（三值之一）
 * @returns {object} 落盘格式的任务条目
 */
function buildCompletedEntry(id, task, sessionId, permissionMode) {
  const startedAtMs = OLD_CREATED_AT_MS + 10;
  const endedAtMs = OLD_CREATED_AT_MS + 5000;
  return {
    id,
    task,
    cwd: null,
    resumeSessionId: null,
    status: 'completed',
    createdAtMs: OLD_CREATED_AT_MS,
    createdAt: new Date(OLD_CREATED_AT_MS).toISOString(),
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAtMs,
    endedAt: new Date(endedAtMs).toISOString(),
    sessionId,
    answer: '预置历史任务的最终回答',
    gotFinal: true,
    eventError: null,
    error: null,
    timedOut: false,
    cancelRequested: false,
    model: null,
    permissionMode,
    reasoningEffort: null,
    timeoutSeconds: null,
    pid: null,
  };
}

// ---------------------------------------------------------------------------
// fixture-host 子进程管理（独立 USERPROFILE 隔离）
// ---------------------------------------------------------------------------
/**
 * 以独立 USERPROFILE 启动 fixture-host 子进程：
 * - 环境只改 USERPROFILE（指向临时目录），HOME 与 CODEX_HOME 保持继承值不动：
 *   Windows 上 os.homedir() 优先读 USERPROFILE，因此插件触达的 ~/.dsh 与
 *   ~/.codex 全部落进临时目录，不碰真实用户数据；
 * - stdout 唯一输出是监听成功后的一行 JSON 端口，stderr 收集诊断信息。
 * @param {string} profileDir 子进程的专属 USERPROFILE（临时目录）
 * @returns {{ child: import('node:child_process').ChildProcess, getStdout: () => string, getStderr: () => string }}
 */
function startFixtureHost(profileDir) {
  const env = { ...process.env };
  env.USERPROFILE = profileDir; // 子进程专属用户目录：所有读写都落在这里
  const child = spawn(process.execPath, [fixtureHostPath], {
    cwd: pluginRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutText = '';
  let stderrText = '';
  child.stdout?.on('data', (chunk) => { stdoutText += chunk; });
  child.stderr?.on('data', (chunk) => { stderrText += chunk; });
  return {
    child,
    getStdout: () => stdoutText,
    getStderr: () => stderrText,
  };
}

/**
 * 从 fixture-host 的 stdout 文本里解析端口行（{"port":<port>}）；
 * 没有可解析的端口行时返回 null。
 * @param {string} text 已收集的 stdout 文本
 * @returns {number | null} 宿主监听端口，或 null（尚未就绪）
 */
function tryParsePortLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Number.isInteger(parsed?.port) && parsed.port > 0) return parsed.port;
    } catch {
      // 非 JSON 行：fixture-host 约定 stdout 只有端口行，忽略交给超时统一报错
    }
  }
  return null;
}

/**
 * 等待 fixture-host 就绪：轮询 stdout 直到出现端口行并返回端口。
 * 子进程提前退出、等待超时都会让本函数抛错（附 stdout/stderr 便于定位）。
 * @param {{ child: object, getStdout: () => string, getStderr: () => string }} host 子进程句柄
 * @returns {Promise<number>} 宿主监听端口
 */
async function waitForPortLine(host) {
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = tryParsePortLine(host.getStdout());
    if (port !== null) return port;
    if (host.child.exitCode !== null || host.child.signalCode !== null) {
      throw new Error(
        `fixture-host 在输出端口行之前退出（exitCode=${host.child.exitCode}）；stderr:\n${host.getStderr().trim()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `等待 fixture-host 端口行超时（${HOST_READY_TIMEOUT_MS}ms）；stdout:\n${host.getStdout().trim()}\nstderr:\n${host.getStderr().trim()}`,
  );
}

/**
 * 等待子进程退出并返回退出信息；超时兜底 reject，绝不挂死测试。
 * @param {import('node:child_process').ChildProcess} child 子进程
 * @returns {Promise<{ code: number | null, signal: string | null }>}
 */
function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      child.off('error', onError);
      reject(new Error(`等待 fixture-host 退出超时（${EXIT_WAIT_TIMEOUT_MS}ms）`));
    }, EXIT_WAIT_TIMEOUT_MS);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      child.off('error', onError);
      resolve({ code, signal });
    };
    const onError = (err) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      reject(err);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * 停止 fixture-host：仍在运行则终止（Windows 上 kill 即结束进程），并等待其
 * 退出；等待超时时兜底用 taskkill /T /F 只对本测试启动的宿主 pid 递归终止
 * 整棵进程树（绝不涉及其他进程）。用例内已把任务全部收进终态，这里没有
 * 运行中的任务子进程需要额外处理。
 * @param {{ child: object }} host 子进程句柄
 * @returns {Promise<void>}
 */
async function stopHost(host) {
  const { child } = host;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      // 进程恰好在检查与 kill 之间退出：忽略，等待逻辑兜底
    }
  }
  try {
    await waitForExit(child);
  } catch {
    // 兜底：只杀本测试启动的宿主进程树（taskkill /T 沿进程树递归）
    const pid = child.pid;
    if (Number.isInteger(pid)) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // taskkill 不可用时放弃兜底，等待逻辑已尽力
      }
      await waitForExit(child).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// MCP 调用（URL 直连）
// ---------------------------------------------------------------------------
// JSON-RPC 请求 id 计数器：每次 tools/call 递增，响应用同 id 配对
let rpcIdCounter = 0;

/**
 * 向 fixture-host 的 MCP 端点发起一次 tools/call（JSON-RPC 2.0），
 * 返回工具的业务结果（isError 与解析后的 payload）。桥接已取消鉴权：
 * 以 URL 直连（不带任何 Authorization/凭证头）即可调用，Host 由 fetch
 * 自动设置为监听 authority。isError=true 的业务拒绝也照常返回，
 * 由用例自行断言拒绝理由。
 * @param {number} port 宿主监听端口
 * @param {string} name 工具名（如 "start_task"）
 * @param {Record<string, unknown>} args 工具参数
 * @returns {Promise<{ isError: boolean, payload: object }>} 工具结果
 */
async function callMcpTool(port, name, args) {
  const id = ++rpcIdCounter;
  const response = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200, `MCP 端点应返回 200，实际 ${response.status}`);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0', '响应应为 JSON-RPC 2.0');
  assert.equal(body.id, id, '响应 id 应与请求一致');
  assert.equal(body.error, undefined, `不应有协议级错误: ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', 'tools/call 结果应携带 text 内容');
  return { isError: body.result?.isError === true, payload: JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// 任务收尾与落盘快照读取
// ---------------------------------------------------------------------------
/**
 * 判断任务状态是否已是终态（completed/failed/cancelled）。
 * @param {string} status 任务状态
 * @returns {boolean} true = 已终态
 */
function isFinishedStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * 把一个任务收进终态：先 wait_task 等待（上限 10 秒），仍在排队/运行则
 * cancel_task 强制取消（插件内部只杀该任务自己的子进程树），再等一次终态。
 * 用于保证任何用例结束时都不留下运行中的任务/子进程。
 * @param {number} port 宿主监听端口
 * @param {string} taskId 任务 id
 * @returns {Promise<object>} 终态任务快照
 */
async function settleTask(port, taskId) {
  // 第一次等待：任务已终态时立即返回；否则最多阻塞 10 秒后返回运行态快照
  let snapshot = (await callMcpTool(port, 'wait_task', { taskId, timeoutSeconds: 10 })).payload;
  if (!isFinishedStatus(snapshot.status)) {
    // 仍在排队/运行：强制取消（幂等，queued/running 都接受）
    const cancelled = await callMcpTool(port, 'cancel_task', { taskId });
    assert.equal(cancelled.isError, false, `cancel_task 不应报错: ${JSON.stringify(cancelled.payload)}`);
    // 取消已置终态并唤醒等待者，这里立即拿到终态快照
    snapshot = (await callMcpTool(port, 'wait_task', { taskId, timeoutSeconds: 10 })).payload;
  }
  assert.ok(
    isFinishedStatus(snapshot.status),
    `任务应已到终态: ${JSON.stringify(snapshot)}`,
  );
  return snapshot;
}

/**
 * 从落盘历史文件里找指定 id 的任务条目；文件尚未写好/条目未出现时返回 null。
 * @param {string} historyPath 历史文件路径
 * @param {string} taskId 任务 id
 * @returns {object | null} 任务条目，或 null
 */
function readPersistedEntry(historyPath, taskId) {
  try {
    const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.tasks)) return null;
    return data.tasks.find((t) => t?.id === taskId) ?? null;
  } catch {
    return null; // 读取/解析失败一律视为未就绪，交由轮询重试
  }
}

/**
 * 轮询等待落盘历史文件里出现满足条件的任务条目（插件落盘是防抖异步的），
 * 超时则返回最后一次读取结果（由调用方断言失败并给出上下文）。
 * @param {string} historyPath 历史文件路径
 * @param {string} taskId 任务 id
 * @param {(entry: object) => boolean} predicate 条目就绪判定
 * @returns {Promise<object | null>} 就绪的条目，或 null（一直未就绪）
 */
async function waitForPersistedEntry(historyPath, taskId, predicate) {
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = readPersistedEntry(historyPath, taskId);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last && predicate(last) ? last : null;
}

// ---------------------------------------------------------------------------
// 用例 1：start_task 显式 read-only → 快照固化；danger-full-access 高于全局被拒
// ---------------------------------------------------------------------------
test('start_task：read-only 入队成功且任务权限快照固化为 read-only；danger-full-access 高于全局 workspace 被拒', { timeout: 30000 }, async () => {
  // 准备：临时 USERPROFILE + 显式声明当前全局权限为 workspace（工作区沙箱）
  const profileDir = makeTempProfile('start');
  writeGlobalWorkspaceConfig(profileDir);
  const historyPath = path.join(profileDir, '.dsh', 'subagent-bridge.tasks.json');

  const host = startFixtureHost(profileDir);
  try {
    const port = await waitForPortLine(host);

    // 1) read-only 低于全局 workspace-write：允许入队，立即返回 taskId
    const started = await callMcpTool(port, 'start_task', {
      task: '权限快照验证任务（只读档）：报告当前目录的文件列表',
      permissionMode: 'read-only',
    });
    assert.equal(started.isError, false, `start_task 不应报错: ${JSON.stringify(started.payload)}`);
    assert.equal(typeof started.payload.taskId, 'string', '成功入队应返回 taskId');
    assert.ok(started.payload.taskId.length > 0, 'taskId 不应为空');
    assert.equal(
      typeof started.payload.status, 'string',
      `入队响应应携带任务状态: ${JSON.stringify(started.payload)}`,
    );

    // 2) 收尾该任务到终态（测试环境解析不到 launcher，任务会立即 failed；
    //    万一环境可启动，也由 cancel_task 只杀本任务自己的子进程树兜底）
    const snapshot = await settleTask(port, started.payload.taskId);
    assert.ok(
      isFinishedStatus(snapshot.status),
      `wait_task 应返回终态快照: ${JSON.stringify(snapshot)}`,
    );

    // 3) 任务权限快照证据：落盘历史里该任务的 permissionMode 必须固化为
    //    "read-only"（入队即固化当时实际允许的权限，不随全局漂移）
    const persisted = await waitForPersistedEntry(
      historyPath,
      started.payload.taskId,
      (entry) => entry.permissionMode === 'read-only',
    );
    assert.ok(persisted, '落盘历史应包含该任务的权限快照');
    assert.equal(
      persisted.permissionMode, 'read-only',
      '任务权限快照应为显式传入的 read-only',
    );

    // 4) 反向验证：danger-full-access 高于当前全局 workspace-write，
    //    start_task 必须明确报错，绝不静默降级，也绝不入队
    const rejected = await callMcpTool(port, 'start_task', {
      task: '权限快照验证任务（完全权限档）：不应被允许',
      permissionMode: 'danger-full-access',
    });
    assert.equal(rejected.isError, true, '高于全局权限的 start_task 必须被拒绝');
    assert.match(
      String(rejected.payload.error ?? ''),
      /exceeds the current global DSH subagent permission \("workspace-write"\)/,
      `拒绝理由应指明超出全局权限: ${JSON.stringify(rejected.payload)}`,
    );
    assert.equal(rejected.payload.taskId, undefined, '被拒绝的调用不应返回 taskId');
  } finally {
    await stopHost(host);
  }
});

// ---------------------------------------------------------------------------
// 用例 2：continue_task（read-only 原任务）——显式升权被拒；不传则继承快照
// ---------------------------------------------------------------------------
test('continue_task：read-only 原任务传 workspace-write 被拒；不传则继承快照 read-only 续跑', { timeout: 30000 }, async () => {
  // 准备：临时 USERPROFILE + 全局 workspace + 预写一条 completed 且带
  // read-only 权限快照、有 sessionId 的历史任务（续跑基准）
  const profileDir = makeTempProfile('continue-readonly');
  writeGlobalWorkspaceConfig(profileDir);
  const historyPath = writeHistoryFile(profileDir, [
    buildCompletedEntry(
      READONLY_ID,
      '历史 read-only 任务：汇总当前目录结构',
      READONLY_SESSION,
      'read-only',
    ),
  ]);

  const host = startFixtureHost(profileDir);
  try {
    const port = await waitForPortLine(host);

    // 1) 显式传 workspace-write：高于原任务快照 read-only，必须明确拒绝
    //    （拒绝发生在入队前，不产生新任务/子进程）
    const rejected = await callMcpTool(port, 'continue_task', {
      taskId: READONLY_ID,
      message: '追问：请展开说明第二层子目录',
      permissionMode: 'workspace-write',
    });
    assert.equal(rejected.isError, true, '高于原任务权限的续跑必须被拒绝');
    assert.match(
      String(rejected.payload.error ?? ''),
      /exceeds the continued task's permission \("read-only"\)/,
      `拒绝理由应指明超出原任务权限: ${JSON.stringify(rejected.payload)}`,
    );
    assert.equal(rejected.payload.taskId, undefined, '被拒绝的续跑不应返回新 taskId');

    // 2) 不传 permissionMode：继承原任务快照 read-only 续跑，响应携带实际
    //    生效的权限快照与原会话 id（而非全局的 workspace-write）
    const continued = await callMcpTool(port, 'continue_task', {
      taskId: READONLY_ID,
      message: '追问：请按只读权限继续汇总',
    });
    assert.equal(continued.isError, false, `continue_task 不应报错: ${JSON.stringify(continued.payload)}`);
    assert.equal(typeof continued.payload.taskId, 'string', '续跑成功应返回新 taskId');
    assert.equal(
      continued.payload.permissionMode,
      'read-only',
      '不传 permissionMode 时应继承原任务的 read-only 快照',
    );
    assert.equal(
      continued.payload.sessionId,
      READONLY_SESSION,
      '续跑应复用原任务的 DSH 会话 id',
    );

    // 3) 收尾续跑出的新任务到终态（不留运行中的任务/子进程）
    const snapshot = await settleTask(port, continued.payload.taskId);
    assert.ok(isFinishedStatus(snapshot.status), '续跑任务应已到终态');

    // 4) 落盘快照证据：续跑新任务的持久化条目同样继承 read-only，
    //    且以 resumeSessionId 关联原会话
    const persisted = await waitForPersistedEntry(
      historyPath,
      continued.payload.taskId,
      (entry) => entry.permissionMode === 'read-only' && entry.resumeSessionId === READONLY_SESSION,
    );
    assert.ok(persisted, '落盘历史应包含续跑新任务');
    assert.equal(persisted.permissionMode, 'read-only', '续跑任务落盘快照应为继承的 read-only');
    assert.equal(persisted.resumeSessionId, READONLY_SESSION, '续跑任务应关联原会话 id');
  } finally {
    await stopHost(host);
  }
});

// ---------------------------------------------------------------------------
// 用例 3：continue_task（danger-full-access 原任务 + 现全局 workspace）——
// 直接续跑（不传 permissionMode）明确拒绝，绝不静默降级
// ---------------------------------------------------------------------------
test('continue_task：danger-full-access 原任务在当前全局 workspace 下直接续跑被明确拒绝', { timeout: 30000 }, async () => {
  // 准备：临时 USERPROFILE + 全局显式 workspace + 预写一条 completed 且带
  // danger-full-access 权限快照、有 sessionId 的历史任务（入队后全局被调低）
  const profileDir = makeTempProfile('continue-fullaccess');
  writeGlobalWorkspaceConfig(profileDir);
  const historyPath = writeHistoryFile(profileDir, [
    buildCompletedEntry(
      FULLACCESS_ID,
      '历史完全权限任务：整理临时构建产物',
      FULLACCESS_SESSION,
      'danger-full-access',
    ),
  ]);

  const host = startFixtureHost(profileDir);
  try {
    const port = await waitForPortLine(host);

    // 直接续跑（不传 permissionMode）：原任务快照 danger-full-access 高于
    // 当前全局 workspace-write，必须明确拒绝并给出两侧权限值，
    // 绝不静默降级续跑（拒绝发生在入队前，不产生新任务/子进程）
    const rejected = await callMcpTool(port, 'continue_task', {
      taskId: FULLACCESS_ID,
      message: '追问：继续上一步的整理工作',
    });
    assert.equal(rejected.isError, true, '快照高于当前全局的续跑必须被拒绝');
    assert.match(
      String(rejected.payload.error ?? ''),
      /the continued task's permission "danger-full-access" exceeds the current global DSH subagent permission \("workspace-write"\)/,
      `拒绝理由应同时给出原任务快照与当前全局权限: ${JSON.stringify(rejected.payload)}`,
    );
    assert.equal(rejected.payload.taskId, undefined, '被拒绝的续跑不应返回新 taskId');

    // 历史文件未被续跑改动：原任务条目仍是 completed + 原快照（没有被降级改写）
    const entry = readPersistedEntry(historyPath, FULLACCESS_ID);
    assert.ok(entry, '预置历史条目应仍在');
    assert.equal(entry.status, 'completed', '原任务状态不应被拒绝调用改变');
    assert.equal(entry.permissionMode, 'danger-full-access', '原任务权限快照不应被降级改写');
  } finally {
    await stopHost(host);
  }
});
