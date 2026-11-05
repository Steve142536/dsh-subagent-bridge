// ============================================================================
// tests/persistence.test.mjs — 任务历史持久化（version:1）集成测试
//
// 被测契约（index.js 的任务状态持久化，经 tests/fixture-host.mjs 真实 HTTP 宿主）：
//   1. version:1 历史恢复（宿主重启后旧任务仍可查、绝不自动重跑）：
//      预写 USERPROFILE/.dsh/subagent-bridge.tasks.json（version:1，含一条
//      completed 与一条 running 的历史任务），以独立 USERPROFILE 启动
//      fixture-host 子进程，以 MCP URL 直连（不带任何 Authorization/凭证头，
//      桥接已取消鉴权）调用 wait_task / list_tasks 验证：
//      a) 旧 completed 任务的 id / sessionId / 最终回答（answer）原样可查；
//      b) 旧 running 任务恢复为 failed：sessionId 保留，error 注明
//         "host was interrupted ... without re-executing"；
//      c) 不自动执行：恢复态写回的历史文件里该条目仍是 failed 且没有 pid
//         （未启动任何子进程），再次 wait_task 状态也保持 failed。
//   2. 历史文件损坏（非法 JSON，模拟进程中断留下的半截文件）：
//      宿主启动直接失败（子进程非 0 退出、stderr 指明 JSON 损坏、stdout
//      无监听端口），且历史文件逐字节保持原样——绝不以空历史覆盖原文件。
//
// 隔离性约定：
//   - 每个用例在系统临时目录（os.tmpdir()）下用 mkdtemp 新建唯一的临时目录，
//     作为 fixture-host 子进程的专属 USERPROFILE（环境里的 HOME、CODEX_HOME
//     保持继承值、不做改动），Windows 上 os.homedir() 只认 USERPROFILE，因此
//     插件触达的 ~/.dsh、~/.codex 全部落在临时目录内，本测试绝不读取或修改
//     本机真实用户数据（真实 ~/.dsh、~/.codex）；
//   - 清理时先复核目标目录确实位于系统临时目录之内、且目录名带本测试专属
//     前缀，才递归删除——只清理本测试自己 mkdtemp 新建的目录；
//   - 恢复出的任务不重跑：测试全程不触发任何真实的 DSH 子代理进程。
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
const TEMP_PREFIX = 'dsh-persistence-test-';
// 插件默认的 MCP 前缀路由（fixture-host 以空 config 激活插件，走默认值）
const MCP_ROUTE = '/mcp/dsh-subagent';
// 等待 fixture-host 输出端口行的上限：正常毫秒级就绪，超时视为启动失败
const HOST_READY_TIMEOUT_MS = 15000;
// 等待子进程退出的上限：防止意外挂死测试进程
const EXIT_WAIT_TIMEOUT_MS = 10000;
// 等待恢复态写回历史文件的上限：插件防抖 100ms 后落盘，留足余量
const FILE_REWRITE_TIMEOUT_MS = 5000;
// 预写历史用的固定时间戳（远早于现在，保证与恢复时刻可区分）
const OLD_CREATED_AT_MS = 1700000000000;

// 预写历史里旧 completed 任务的标识与会话/结果
const COMPLETED_ID = 'dshx-persist-completed';
const COMPLETED_SESSION = 'sess-persist-completed';
const COMPLETED_ANSWER = '历史 completed 任务的最终回答（持久化恢复测试）';
// 预写历史里旧 running 任务的标识与会话（宿主中断时它已上报 DSH 会话）
const RUNNING_ID = 'dshx-persist-running';
const RUNNING_SESSION = 'sess-persist-running';

// 本测试创建的全部临时目录：after() 统一复核并清理
const createdTempRoots = [];

// ---------------------------------------------------------------------------
// 临时目录管理
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

// ---------------------------------------------------------------------------
// 历史文件预写
// ---------------------------------------------------------------------------
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
 * 构造一条历史 completed 任务条目：带会话 id 与最终回答，
 * 模拟"宿主重启前已正常完成的任务"。
 * @returns {object} 落盘格式的任务条目
 */
function buildCompletedEntry() {
  const startedAtMs = OLD_CREATED_AT_MS + 10;
  const endedAtMs = OLD_CREATED_AT_MS + 5000;
  return {
    id: COMPLETED_ID,
    task: '历史 completed 任务：汇总当前目录结构',
    cwd: null,
    resumeSessionId: null,
    status: 'completed',
    createdAtMs: OLD_CREATED_AT_MS,
    createdAt: new Date(OLD_CREATED_AT_MS).toISOString(),
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAtMs,
    endedAt: new Date(endedAtMs).toISOString(),
    sessionId: COMPLETED_SESSION,
    answer: COMPLETED_ANSWER,
    gotFinal: true,
    eventError: null,
    error: null,
    timedOut: false,
    cancelRequested: false,
    model: null,
    permissionMode: null,
    reasoningEffort: null,
    timeoutSeconds: null,
    pid: null,
  };
}

/**
 * 构造一条历史 running 任务条目：带会话 id、无结束时间，
 * 模拟"宿主被中断时仍在运行的任务"（恢复方必须标 failed 且不重跑）。
 * @returns {object} 落盘格式的任务条目
 */
function buildRunningEntry() {
  const startedAtMs = OLD_CREATED_AT_MS + 10;
  return {
    id: RUNNING_ID,
    task: '历史 running 任务：被宿主中断的长任务',
    cwd: null,
    resumeSessionId: null,
    status: 'running',
    createdAtMs: OLD_CREATED_AT_MS + 10000,
    createdAt: new Date(OLD_CREATED_AT_MS + 10000).toISOString(),
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAtMs: null,
    endedAt: null,
    sessionId: RUNNING_SESSION,
    answer: '',
    gotFinal: false,
    eventError: null,
    error: null,
    timedOut: false,
    cancelRequested: false,
    model: null,
    permissionMode: null,
    reasoningEffort: null,
    timeoutSeconds: null,
    pid: null, // 中断后子进程已不存在；恢复方也绝不能启动任何新子进程
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
 * 等待子进程退出并返回退出信息；超时兜底返回当前状态，绝不挂死测试。
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
 * 停止 fixture-host：仍在运行则终止（Windows 上 kill 即结束进程；
 * 本测试结束时宿主已完成使命，无需优雅关机），并等待其退出。
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
  await waitForExit(child).catch(() => {});
}

// ---------------------------------------------------------------------------
// MCP 调用（URL 直连）
// ---------------------------------------------------------------------------
/**
 * 向 fixture-host 的 MCP 端点发起一次 tools/call（JSON-RPC 2.0），
 * 返回工具的业务结果。桥接已取消鉴权：以 URL 直连（不带任何
 * Authorization/凭证头）即可调用，Host 由 fetch 自动设置为监听 authority。
 * @param {number} port 宿主监听端口
 * @param {string} name 工具名（如 "wait_task"）
 * @param {Record<string, unknown>} args 工具参数
 * @returns {Promise<{ isError: boolean, payload: object }>} outcome
 */
async function callMcpTool(port, name, args) {
  const response = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200, `MCP 端点应返回 200，实际 ${response.status}`);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0', '响应应为 JSON-RPC 2.0');
  assert.equal(body.id, 1, '响应 id 应与请求一致');
  assert.equal(body.error, undefined, `不应有协议级错误: ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', 'tools/call 结果应携带 text 内容');
  return { isError: body.result?.isError === true, payload: JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// 恢复态写回的等待与读取
// ---------------------------------------------------------------------------
/**
 * 读取历史文件里 RUNNING 条目的最新落盘状态；仅当该条目已被恢复为
 * failed（恢复态固化回文件）时返回条目，否则返回 null（未就绪）。
 * @param {string} historyPath 历史文件路径
 * @returns {object | null} 恢复后的条目，或 null
 */
function readRewrittenRunningEntry(historyPath) {
  try {
    const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.tasks)) return null;
    const entry = data.tasks.find((t) => t?.id === RUNNING_ID);
    if (!entry || entry.status !== 'failed') return null;
    return entry;
  } catch {
    return null; // 读取/解析失败一律视为未就绪，交由轮询重试
  }
}

/**
 * 轮询等待恢复态写回历史文件（插件恢复后经 100ms 防抖固化回文件），
 * 超时则返回最后一次读取结果（由调用方断言失败并给出上下文）。
 * @param {string} historyPath 历史文件路径
 * @returns {Promise<object | null>} 恢复后的条目，或 null（一直未写回）
 */
async function waitForRewrittenRunningEntry(historyPath) {
  const deadline = Date.now() + FILE_REWRITE_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = readRewrittenRunningEntry(historyPath);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

// ---------------------------------------------------------------------------
// 用例 1：version:1 历史恢复
// ---------------------------------------------------------------------------
test('version:1 历史恢复：completed 结果可查；running 恢复为 failed 且保留 sessionId，不自动执行', { timeout: 30000 }, async () => {
  // 准备：临时 USERPROFILE + 预写一条 completed 与一条 running 的 version:1 历史
  const profileDir = makeTempProfile('restore');
  const historyPath = writeHistoryFile(profileDir, [
    buildCompletedEntry(),
    buildRunningEntry(),
  ]);

  const host = startFixtureHost(profileDir);
  try {
    const port = await waitForPortLine(host);

    // 1) 旧 completed 任务：wait_task 立即返回快照，id/会话/最终回答原样可查
    const completed = await callMcpTool(port, 'wait_task', { taskId: COMPLETED_ID });
    assert.equal(completed.isError, false, `wait_task 不应报错: ${JSON.stringify(completed.payload)}`);
    assert.equal(completed.payload.taskId, COMPLETED_ID);
    assert.equal(completed.payload.status, 'completed');
    assert.equal(completed.payload.sessionId, COMPLETED_SESSION, '旧任务的会话 id 应可查');
    assert.equal(completed.payload.answer, COMPLETED_ANSWER, '旧任务的最终回答应原样可查');

    // 2) 旧 running 任务：恢复为 failed，sessionId 保留，错误注明中断且不重跑
    const recovered = await callMcpTool(port, 'wait_task', { taskId: RUNNING_ID });
    assert.equal(recovered.isError, false, `wait_task 不应报错: ${JSON.stringify(recovered.payload)}`);
    assert.equal(recovered.payload.taskId, RUNNING_ID);
    assert.equal(recovered.payload.status, 'failed', '中断时 running 的任务恢复后必须是 failed');
    assert.equal(
      recovered.payload.sessionId,
      RUNNING_SESSION,
      '宿主中断恢复必须保留原 DSH 会话 id（供后续 continue_task）',
    );
    const errorText = String(recovered.payload.error ?? '');
    assert.match(errorText, /host was interrupted while the task was running/);
    assert.match(errorText, /without re-executing/, '错误信息必须注明不自动重新执行');

    // 3) 不自动执行（落盘证据）：恢复态固化回历史文件后，该条目仍是 failed、
    //    没有 pid（未启动任何子进程）、结束时间为恢复时刻补齐
    const rewritten = await waitForRewrittenRunningEntry(historyPath);
    assert.ok(rewritten, '恢复态应在防抖窗口内被写回历史文件');
    assert.equal(rewritten.sessionId, RUNNING_SESSION, '写回文件同样保留会话 id');
    assert.equal(rewritten.pid, null, '恢复出的任务不得关联任何子进程');
    assert.notEqual(rewritten.endedAtMs, null, '恢复时应补齐终态时间');

    // 4) 不自动执行（时间证据）：再次 wait_task 状态仍保持 failed，
    //    未被重新入队/执行成 running 或 completed
    const again = await callMcpTool(port, 'wait_task', { taskId: RUNNING_ID });
    assert.equal(again.isError, false);
    assert.equal(again.payload.status, 'failed', '恢复的 failed 任务不得被自动重跑');

    // 5) 旧任务可被 list_tasks 查到（按 id 查询旧结果的另一入口）
    const listed = await callMcpTool(port, 'list_tasks', {});
    assert.equal(listed.isError, false);
    const ids = (listed.payload.tasks ?? []).map((t) => t.id);
    assert.ok(ids.includes(COMPLETED_ID), 'list_tasks 应包含旧 completed 任务');
    assert.ok(ids.includes(RUNNING_ID), 'list_tasks 应包含恢复为 failed 的旧任务');

    // 6) 健全性：宿主 stderr 没有持久化错误（写盘失败必须可见，本用例不应出现）
    assert.ok(
      !host.getStderr().includes('task state persistence'),
      `不应有持久化错误输出: ${host.getStderr().trim()}`,
    );
  } finally {
    await stopHost(host);
  }
});

// ---------------------------------------------------------------------------
// 用例 2：历史文件损坏 → 启动失败且原字节不变
// ---------------------------------------------------------------------------
test('历史文件损坏（非法 JSON）：宿主启动失败，历史文件原字节不变', { timeout: 30000 }, async () => {
  // 准备：临时 USERPROFILE + 半截 JSON（模拟进程中断留下的损坏历史文件）
  const profileDir = makeTempProfile('corrupt');
  const dir = path.join(profileDir, '.dsh');
  fs.mkdirSync(dir, { recursive: true });
  const historyPath = path.join(dir, 'subagent-bridge.tasks.json');
  const corruptedBytes = Buffer.from('{"version":1,"tasks":[{"id":"dshx-broken"', 'utf8');
  fs.writeFileSync(historyPath, corruptedBytes);

  const host = startFixtureHost(profileDir);
  try {
    // 宿主必须直接启动失败（loadPersistedTasks 抛错 → fixture-host 非 0 退出），
    // 绝不以空历史继续运行
    const exit = await waitForExit(host.child);
    assert.notEqual(exit.code, 0, `加载损坏历史必须失败退出，实际 exitCode=${exit.code}`);
    assert.match(host.getStderr(), /failed to start/, 'stderr 应说明宿主启动失败');
    assert.match(
      host.getStderr(),
      /corrupted \(invalid JSON\)/,
      'stderr 应指明历史文件 JSON 损坏',
    );
    // stdout 不应有端口行：HTTP 宿主从未就绪
    assert.equal(tryParsePortLine(host.getStdout()), null, '启动失败的宿主不应输出监听端口');

    // 历史文件必须逐字节保持原样——绝不以空历史/重置状态覆盖原文件
    const after = fs.readFileSync(historyPath);
    assert.ok(corruptedBytes.equals(after), '损坏的历史文件必须原字节保留，不得被覆盖');
  } finally {
    await stopHost(host);
  }
});
