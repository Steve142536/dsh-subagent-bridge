// ============================================================================
// tests/timeout-default.test.mjs — 任务运行期限只由全局 maxTaskSeconds 决定
//（任务级 timeoutSeconds 已移除）的最小回归集成测试
//
// 被测契约（index.js 的 start_task / continue_task / wait_task 工具）：
//   1. 默认路径：start_task 不传 timeoutSeconds 时入队成功，落盘条目固化
//      timeoutSeconds === null，运行期限由全局 limits.maxTaskSeconds 决定；
//   2. 参数已移除：start_task 的 inputSchema 不再暴露 timeoutSeconds 属性；
//      显式传入时明确报错（不静默忽略），错误注明改用全局 maxTaskSeconds；
//   3. 旧记录隔离：预写一条固化 timeoutSeconds=180 的 version:1 历史失败任务
//     （带 sessionId），宿主恢复后对其 continue_task：
//      a) 显式传 timeoutSeconds 续跑明确报错（不静默忽略）；
//      b) 正常续跑任务的落盘条目 timeoutSeconds 必须是 null——旧任务记录里
//         的任务级超时不影响续跑的运行期限；
//      c) 全量落盘回写后旧任务条目的 timeoutSeconds 仍是 180——历史事实
//         原样保留，持久化绝不改写；
//   4. wait_task 语义保持：其 timeoutSeconds 只是等待轮询时长（10-600 秒、
//      默认 120），与任务运行期限无关，schema 描述保持不变。
//
// 隔离性约定（进程内宿主，无任何子进程）：
//   - 本测试在测试进程内直接激活 ../index.js 的 apply()（等效
//     tests/fixture-host.mjs 的子进程模式）：HTTP 服务器只绑 127.0.0.1
//     随机端口，不 spawn 任何子进程、不发生任何模型调用；
//   - index.js 的模块级路径常量（userPatchPath/configFilePath/codexConfigPath）
//     在 import 时固化——userPatchPath/configFilePath 由 USERPROFILE 拼接，
//     codexConfigPath 由 os.homedir() 拼接。系统工作规则禁止临时重定义 HOME
//     或 CODEX_HOME（即使只在测试进程内），因此不触碰这两个变量，仅在
//     Windows 平台（os.homedir() 读 USERPROFILE）用 USERPROFILE 隔离：import
//     前先复核 os.homedir() 已落在临时目录内；非 Windows 平台保持 HOME 与
//     CODEX_HOME 原样、绝不 import 插件（避免任何读写真实 ~/.dsh / ~/.codex
//     的副作用），全部用例安全跳过；
//   - 任务历史路径 tasksFilePath 在 apply() 内求值——每个用例用自己的临时
//     profile 作为 USERPROFILE 后再 apply，落盘与预写历史彼此隔离；
//   - 插件在 fixture 环境下 resolveLauncher() 依赖 process.execPath 指向
//     DeepSeek Harness 宿主，node.exe 运行时必然解析失败，任务在 spawn 之前
//     即以 failed 收场——测试全程不会启动任何真实 DSH 子代理进程；
//   - 清理前复核目标目录确实位于系统临时目录之内、且目录名带本测试专属
//     前缀，才递归删除——只清理本测试自己 mkdtemp 新建的目录。
// ============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- 测试常量 ----------
// 本测试临时目录的专属前缀：mkdtemp 用它命名，清理时以此复核，杜绝误删
const TEMP_PREFIX = 'dsh-timeout-test-';
// 插件默认的 MCP 前缀路由（apply 以空 config 激活，走默认值）
const MCP_ROUTE = '/mcp/dsh-subagent';
// 等待任务进入终态（本环境下应为 failed）的上限
const TASK_SETTLE_TIMEOUT_MS = 10000;
// 等待任务条目落盘的上限（入队即防抖持久化，100ms 量级，留足余量）
const PERSIST_TIMEOUT_MS = 5000;
// 预写历史里旧失败任务的标识与会话（timeoutSeconds 固化 180 秒，模拟旧版本
// 任务级超时残留；续跑后新任务必须不再采用该值）
const LEGACY_ID = 'dshx-timeout-legacy';
const LEGACY_SESSION = 'sess-timeout-legacy';
const LEGACY_TIMEOUT_SECONDS = 180;

// ---------------------------------------------------------------------------
// 隔离环境准备：模块级常量固化到临时 profile，再动态加载插件
// ---------------------------------------------------------------------------
// 收集本测试创建的全部临时目录，after 钩子里统一复核并清理
const tempDirs = [];

/**
 * 在系统临时目录下创建本测试专属的临时 profile 目录并登记待清理。
 * @param {string} label 目录标签（用于目录名，便于人工辨认）
 * @returns {string} 临时目录绝对路径
 */
function makeTempProfile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${label}-`));
  tempDirs.push(dir);
  return dir;
}

// 1) 先建"模块级 profile"：index.js 顶部的 userPatchPath/configFilePath 由
//    USERPROFILE 拼接、codexConfigPath 由 os.homedir() 拼接（import 时固化）。
//    系统工作规则禁止临时重定义 HOME 或 CODEX_HOME——因此不触碰这两个变量，
//    仅在 Windows 平台（os.homedir() 读 USERPROFILE）用 USERPROFILE 隔离；
//    其他平台的 HOME/CODEX_HOME 保持原样，且绝不 import 插件
const moduleProfileDir = makeTempProfile('module');
const isWindows = process.platform === 'win32';
const realUserprofile = process.env.USERPROFILE; // 保存真实值，结束后原样恢复
if (isWindows) process.env.USERPROFILE = moduleProfileDir;
// 2) 隔离能力检查（仅 Windows）：os.homedir() 必须已落在临时目录内（覆盖
//    codexConfigPath）；userPatchPath/configFilePath 是 USERPROFILE 字符串
//    拼接，设置后必然落在临时目录。非 Windows、或 homedir 未随 USERPROFILE
//    变化时（homedir 仍指向真实目录）绝不能 import 插件
const canIsolate =
  isWindows &&
  (os.homedir() === moduleProfileDir || os.homedir().startsWith(moduleProfileDir + path.sep));
// 3) 动态加载插件（仅当隔离确认生效）：保证上述模块级常量全部指向临时目录；
//    不可隔离时 apply 保持 null，后续用例全部跳过（import 不发生、无副作用）
const { apply } = canIsolate ? await import('../index.js') : { apply: null };

/**
 * 生成用例的 skip 选项：平台隔离确认生效时返回 false（正常运行）；
 * 否则返回跳过原因（此时插件从未被 import，绝不触碰真实 ~/.dsh / ~/.codex）。
 * @returns {boolean | string} false = 不跳过；字符串 = 跳过原因
 */
function skipUnlessIsolated() {
  return canIsolate
    ? false
    : '仅 Windows 支持经 USERPROFILE 的进程内隔离（HOME/CODEX_HOME 按规则不可临时重定义），本平台跳过以避免触碰真实 ~/.dsh / ~/.codex';
}

/**
 * 清理全部临时目录并恢复 USERPROFILE：先复核每个目录都位于系统临时目录
 * 之内、且目录名带本测试专属前缀，才递归删除——任何复核不通过的路径直接
 * 抛错提醒，绝不误删他处内容。
 * @returns {Promise<void>}
 */
after(async () => {
  // 原样恢复真实 USERPROFILE（原值缺失则删除临时设置；HOME/CODEX_HOME 从
  // 未被改动，无需恢复）
  if (realUserprofile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = realUserprofile;
  }
  const tmpRoot = path.resolve(os.tmpdir());
  for (const dir of tempDirs) {
    const resolved = path.resolve(dir);
    const inTmp = resolved.startsWith(tmpRoot + path.sep) || resolved === tmpRoot;
    const namedByThisTest = path.basename(resolved).startsWith(TEMP_PREFIX);
    if (!inTmp || !namedByThisTest) {
      throw new Error(`清理复核失败，跳过删除：${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 进程内测试宿主（等效 fixture-host.mjs 的最小 webServer 模拟 + HTTP 分发）
// ---------------------------------------------------------------------------
/**
 * 创建最小 webServer 模拟：路由表 + 真实宿主一致的匹配规则。
 * exact 表优先，prefix 表取最长匹配（`path` 精确或 `path/...`）。
 * @returns {{ register: Function, match: Function, getOrigin: Function }}
 */
function createFakeWebServer() {
  const exact = new Map();    // kind=exact：path → route
  const prefixes = new Map(); // kind=prefix：path → route
  // 绑定成功后由 createInProcessHost 写入实际端口；getOrigin 以它为准
  const listenState = { port: undefined };
  const webServer = {
    /**
     * 注册一条路由，返回注销函数（重复注册同类同路径直接抛错，
     * 与真实 webserver 的组合契约一致）。
     * @param {{ kind: 'exact'|'prefix', path: string, handler: Function }} route
     * @returns {() => void} 注销函数：从路由表移除该条目
     */
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes;
      if (table.has(route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      }
      table.set(route.path, route);
      return () => {
        table.delete(route.path);
      };
    },
    /**
     * 按真实宿主规则匹配路径：exact 命中优先，否则在 prefix 表里取最长匹配。
     * @param {string} pathname 已剥离查询串的请求路径
     * @returns {{ kind: string, path: string, handler: Function } | undefined}
     */
    match(pathname) {
      const exactRoute = exact.get(pathname);
      if (exactRoute !== undefined) return exactRoute;
      let best;
      for (const [prefix, route] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
        if (best === undefined || prefix.length > best.path.length) best = route;
      }
      return best;
    },
    /**
     * 返回监听 origin（形如 http://127.0.0.1:<port>）；绑定前抛错（插件
     * 的就绪轮询会自行捕获重试，与真实宿主行为一致）。
     * @returns {string} origin 文本
     */
    getOrigin() {
      if (listenState.port === undefined) {
        throw new Error('webserver: origin read before the listener bound a port');
      }
      return `http://127.0.0.1:${listenState.port}`;
    },
  };
  // 把 listenState 挂在返回对象外层（闭包内），供宿主绑定成功后写入端口
  webServer.__listenState = listenState;
  return webServer;
}

/**
 * 创建进程内隔离宿主：切换 USERPROFILE 到专属临时目录 → apply 激活插件
 * → 绑定 127.0.0.1 随机端口。返回端口与 close（收尾时逆序执行插件清理并
 * 关闭服务器、恢复 USERPROFILE）。不 spawn 任何子进程。
 * @param {string} profileDir 本宿主的专属临时 profile（任务历史落盘处）
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
async function createInProcessHost(profileDir) {
  // 切换 USERPROFILE：tasksFilePath 等在 apply 内求值的路径全部落到临时目录
  const prevUserprofile = process.env.USERPROFILE;
  process.env.USERPROFILE = profileDir;
  const webServer = createFakeWebServer();
  const cleanups = []; // effect 收集的插件清理函数，close 时后进先出执行
  const ctx = {
    webServer,
    /**
     * 执行 effect 回调并收集其返回的清理函数（与 cordis 语义一致）。
     * @param {() => (Function | void) | Promise<Function | void>} fn
     */
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    /**
     * 按名字取回本 ctx 已注入的服务（cordis 标准方法语义）。
     * @param {string} name 服务名（如 "webServer"）
     * @returns {unknown} 已有服务本身，或 undefined
     */
    get(name) {
      return this[name];
    },
  };
  apply(ctx, {}); // 激活插件：注册路由、恢复历史（读 profileDir 的预写文件）

  // HTTP 分发：与真实 webserver 相同——按路径剥离查询串后交给路由 handler
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const route = webServer.match(pathname);
      if (route === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      await route.handler(req, res);
    } catch {
      // handler 抛错 → 400；响应已开始则直接断开，避免半截响应挂住测试客户端
      if (res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy();
        return;
      }
      res.writeHead(400);
      res.end();
    }
  });

  /**
   * 绑定监听，成功 resolve、失败 reject（error 监听只挂一次，防止泄漏）。
   * @returns {Promise<void>}
   */
  const listenOnce = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  await listenOnce();
  webServer.__listenState.port = server.address().port;

  /**
   * 关机：逆序执行插件清理（清任务定时器/轮询等），关闭监听并断开残留
   * 连接，最后恢复 USERPROFILE（原值缺失则删除临时设置）。幂等：重复调用
   * 直接返回。
   * @returns {Promise<void>}
   */
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        await cleanups[i]();
      } catch {
        // 单个清理失败不阻断其余清理（与 fixture-host 的关机语义一致）
      }
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    if (prevUserprofile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = prevUserprofile;
    }
  };
  return { port: webServer.__listenState.port, close };
}

// ---------------------------------------------------------------------------
// 预写 version:1 历史文件（供旧记录隔离用例）
// ---------------------------------------------------------------------------
/**
 * 构造一条旧版本的失败任务条目：带 sessionId（可续跑）、固化
 * timeoutSeconds=180（历史版本任务级超时的残留形态）。
 * @returns {object} 符合 version:1 落盘结构的任务条目
 */
function buildLegacyFailedEntry() {
  const nowMs = 1700000000000; // 固定时间戳（远早于现在，与恢复时刻可区分）
  return {
    id: LEGACY_ID,
    task: '旧版本遗留的失败任务（固化 timeoutSeconds=180，仅用于验证续跑隔离）',
    cwd: null,
    resumeSessionId: null,
    status: 'failed',
    createdAtMs: nowMs,
    createdAt: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    startedAt: new Date(nowMs).toISOString(),
    endedAtMs: nowMs,
    endedAt: new Date(nowMs).toISOString(),
    sessionId: LEGACY_SESSION,
    answer: '',
    gotFinal: false,
    eventError: null,
    error: 'dsh exited with code 1',
    timedOut: false,
    cancelRequested: false,
    model: null,
    permissionMode: 'workspace-write',
    reasoningEffort: null,
    timeoutSeconds: LEGACY_TIMEOUT_SECONDS,
    pid: null,
  };
}

/**
 * 把预写条目写成 version:1 历史文件（apply 激活时由宿主恢复读取）。
 * @param {string} profileDir 临时 USERPROFILE 目录
 * @param {object[]} tasks 预写任务条目数组
 * @returns {string} 历史文件路径
 */
function writeHistoryFile(profileDir, tasks) {
  const dshDir = path.join(profileDir, '.dsh');
  fs.mkdirSync(dshDir, { recursive: true });
  const historyPath = path.join(dshDir, 'subagent-bridge.tasks.json');
  const savedAtMs = Date.now();
  fs.writeFileSync(
    historyPath,
    JSON.stringify({ version: 1, savedAtMs, savedAt: new Date(savedAtMs).toISOString(), tasks }),
  );
  return historyPath;
}

// ---------------------------------------------------------------------------
// MCP 调用（URL 直连；桥接已取消鉴权，无任何凭证头）
// ---------------------------------------------------------------------------
/**
 * 向进程内宿主的 MCP 端点发起一次 JSON-RPC 2.0 请求（tools/call 或
 * tools/list），返回 result 内容。
 * @param {number} port 宿主监听端口
 * @param {'tools/call'|'tools/list'} method JSON-RPC 方法名
 * @param {Record<string, unknown>} [params] 请求参数（tools/list 可省略）
 * @returns {Promise<object>} JSON-RPC result 对象
 */
async function callMcp(port, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
  });
  assert.equal(response.status, 200, `MCP 端点应返回 200，实际 ${response.status}`);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0', '响应应为 JSON-RPC 2.0');
  assert.equal(body.id, 1, '响应 id 应与请求一致');
  assert.equal(body.error, undefined, `不应有协议级错误: ${JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * 调用一次工具并解析 text 负载（业务层 outcome）。
 * @param {number} port 宿主监听端口
 * @param {string} name 工具名（如 "start_task"）
 * @param {Record<string, unknown>} args 工具参数
 * @returns {Promise<{ isError: boolean, payload: object }>} outcome
 */
async function callMcpTool(port, name, args) {
  const result = await callMcp(port, 'tools/call', { name, arguments: args });
  const text = result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', 'tools/call 结果应携带 text 内容');
  return { isError: result?.isError === true, payload: JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// 落盘历史读取与终态等待
// ---------------------------------------------------------------------------
/**
 * 读取临时 USERPROFILE 下的任务历史文件，返回指定任务的落盘条目；
 * 文件尚未写出或该条目尚未出现时返回 null（交由轮询重试）。
 * @param {string} profileDir 临时 USERPROFILE 目录
 * @param {string} taskId 任务 id
 * @returns {object | null} 落盘条目，或 null
 */
function readHistoryEntry(profileDir, taskId) {
  try {
    const historyPath = path.join(profileDir, '.dsh', 'subagent-bridge.tasks.json');
    const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.tasks)) return null;
    return data.tasks.find((t) => t?.id === taskId) ?? null;
  } catch {
    return null; // 读取/解析失败一律视为未就绪，交由轮询重试
  }
}

/**
 * 轮询等待指定任务的落盘条目出现（防抖落盘有延迟），超时返回最后一次结果。
 * @param {string} profileDir 临时 USERPROFILE 目录
 * @param {string} taskId 任务 id
 * @returns {Promise<object | null>} 落盘条目，或 null（一直未落盘）
 */
async function waitForHistoryEntry(profileDir, taskId) {
  const deadline = Date.now() + PERSIST_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = readHistoryEntry(profileDir, taskId);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

/**
 * 轮询等待任务进入终态（本环境下预期 failed：launcher 无法解析，任务在
 * spawn 之前即收场），超时返回最后一次快照。
 * @param {number} port 宿主监听端口
 * @param {string} taskId 任务 id
 * @returns {Promise<object>} 任务快照（终态或最后一次轮询结果）
 */
async function waitForTerminal(port, taskId) {
  const deadline = Date.now() + TASK_SETTLE_TIMEOUT_MS;
  let snapshot = null;
  while (Date.now() < deadline) {
    const outcome = await callMcpTool(port, 'wait_task', { taskId });
    assert.equal(outcome.isError, false, `wait_task 不应报错: ${JSON.stringify(outcome.payload)}`);
    snapshot = outcome.payload;
    if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return snapshot;
}

/**
 * 从 tools/list 结果里取出指定工具的定义。
 * @param {object[]} tools tools/list 返回的工具定义数组
 * @param {string} name 工具名
 * @returns {object} 工具定义
 */
function findTool(tools, name) {
  const tool = tools.find((t) => t?.name === name);
  assert.ok(tool, `工具列表应包含 ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// 用例 1：默认路径 —— 不传 timeoutSeconds 入队成功且固化 null
// ---------------------------------------------------------------------------
test('start_task 不传 timeoutSeconds：入队成功且落盘固化 null（运行期限由全局 maxTaskSeconds 决定）', { timeout: 30000, skip: skipUnlessIsolated() }, async () => {
  const profileDir = makeTempProfile('omit');
  const host = await createInProcessHost(profileDir);
  try {
    // 1) 不传 timeoutSeconds：入队成功（默认路径不再需要也不能传任务级超时）
    const started = await callMcpTool(host.port, 'start_task', {
      task: '超时默认行为验证：不传 timeoutSeconds 的占位任务',
    });
    assert.equal(started.isError, false, `start_task 不应报错: ${JSON.stringify(started.payload)}`);
    const taskId = started.payload.taskId;
    assert.equal(typeof taskId, 'string', 'start_task 应返回 taskId');

    // 2) 任务进入终态（本环境 launcher 解析失败 → failed，无子进程）
    const snapshot = await waitForTerminal(host.port, taskId);
    assert.equal(snapshot.status, 'failed', '本环境下任务应以 failed 收场（未启动子代理）');

    // 3) 落盘条目固化 timeoutSeconds === null：运行期限一律由全局 maxTaskSeconds 决定
    const entry = await waitForHistoryEntry(profileDir, taskId);
    assert.ok(entry, '任务条目应已落盘');
    assert.equal(
      entry.timeoutSeconds,
      null,
      '默认路径落盘的 timeoutSeconds 必须是 null（运行期限由全局 maxTaskSeconds 决定）',
    );
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 2：参数已移除 —— schema 不暴露 + 显式传入明确报错
// ---------------------------------------------------------------------------
test('start_task 不再暴露 timeoutSeconds：schema 无该属性，显式传入 90 明确报错（不静默忽略）', { timeout: 30000, skip: skipUnlessIsolated() }, async () => {
  const profileDir = makeTempProfile('removed');
  const host = await createInProcessHost(profileDir);
  try {
    // 1) schema 层：inputSchema.properties 不再包含 timeoutSeconds
    const tools = (await callMcp(host.port, 'tools/list')).tools;
    const startTool = findTool(tools, 'start_task');
    assert.equal(
      Object.hasOwn(startTool.inputSchema?.properties ?? {}, 'timeoutSeconds'),
      false,
      'start_task 的 schema 不应再暴露 timeoutSeconds',
    );

    // 2) 行为层：显式传入时明确报错（桥接不做 schema 强校验，必须由实现兜底）
    const rejected = await callMcpTool(host.port, 'start_task', {
      task: '超时默认行为验证：显式传已移除的 timeoutSeconds 应被拒绝',
      timeoutSeconds: 90,
    });
    assert.equal(rejected.isError, true, '显式传入 timeoutSeconds 必须明确报错');
    assert.match(
      String(rejected.payload.error ?? ''),
      /no longer accepts arguments\.timeoutSeconds/,
      '错误信息应注明该参数已不再接受',
    );
    assert.match(
      String(rejected.payload.error ?? ''),
      /global maxTaskSeconds/,
      '错误信息应注明任务运行期限改用全局 maxTaskSeconds',
    );
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 3：旧记录隔离 —— 固化 180 秒的历史任务续跑后不再采用该值，
// 但旧记录本身作为历史事实原样保留（持久化不改写）
// ---------------------------------------------------------------------------
test('旧记录 timeoutSeconds=180：续跑明确拒绝显式传参、新任务回归全局（null），旧记录保留 180', { timeout: 30000, skip: skipUnlessIsolated() }, async () => {
  const profileDir = makeTempProfile('legacy');
  // 预写一条固化 180 秒的历史失败任务（带 sessionId），随 apply 激活恢复
  writeHistoryFile(profileDir, [buildLegacyFailedEntry()]);
  const host = await createInProcessHost(profileDir);
  try {
    // 1) 旧任务已恢复且可查（wait_task 立即返回其快照）
    const restored = await callMcpTool(host.port, 'wait_task', { taskId: LEGACY_ID });
    assert.equal(restored.isError, false, `wait_task 不应报错: ${JSON.stringify(restored.payload)}`);
    assert.equal(restored.payload.status, 'failed', '预写的失败任务恢复后仍为 failed');
    assert.equal(restored.payload.sessionId, LEGACY_SESSION, '旧任务的 sessionId 应保留（可续跑）');

    // 2) continue_task 显式传 timeoutSeconds：明确报错（不静默忽略）
    const rejected = await callMcpTool(host.port, 'continue_task', {
      taskId: LEGACY_ID,
      message: '续跑验证：显式传已移除的 timeoutSeconds 应被拒绝',
      timeoutSeconds: 90,
    });
    assert.equal(rejected.isError, true, 'continue_task 显式传入 timeoutSeconds 必须明确报错');
    assert.match(
      String(rejected.payload.error ?? ''),
      /no longer accepts arguments\.timeoutSeconds/,
      '错误信息应注明该参数已不再接受',
    );
    assert.match(
      String(rejected.payload.error ?? ''),
      /global maxTaskSeconds/,
      '错误信息应注明任务运行期限改用全局 maxTaskSeconds',
    );

    // 3) 正常续跑（不传任务级超时）：入队成功并返回新 taskId
    const continued = await callMcpTool(host.port, 'continue_task', {
      taskId: LEGACY_ID,
      message: '续跑验证：新任务的运行期限必须回归全局 maxTaskSeconds',
    });
    assert.equal(continued.isError, false, `continue_task 不应报错: ${JSON.stringify(continued.payload)}`);
    const newTaskId = continued.payload.taskId;
    assert.notEqual(newTaskId, LEGACY_ID, '续跑应返回新的 taskId');

    // 4) 新任务进入终态后，落盘条目的 timeoutSeconds 必须是 null——
    //    旧记录里固化的 180 秒不影响续跑任务的运行期限
    await waitForTerminal(host.port, newTaskId);
    const entry = await waitForHistoryEntry(profileDir, newTaskId);
    assert.ok(entry, '续跑任务条目应已落盘');
    assert.equal(
      entry.timeoutSeconds,
      null,
      '续跑任务不得采用旧记录的任务级超时（180 秒），落盘必须是 null（全局 maxTaskSeconds 生效）',
    );

    // 5) 历史事实保留：续跑触发全量落盘回写后，旧任务条目的 timeoutSeconds
    //    仍必须是 180——持久化绝不改写旧任务记录的历史值
    const legacyAfterRewrite = await waitForHistoryEntry(profileDir, LEGACY_ID);
    assert.ok(legacyAfterRewrite, '旧任务条目应仍在落盘历史中');
    assert.equal(
      legacyAfterRewrite.timeoutSeconds,
      LEGACY_TIMEOUT_SECONDS,
      '全量落盘回写不得改写旧任务记录的 timeoutSeconds（历史事实原样保留）',
    );
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 4：wait_task 语义保持 —— timeoutSeconds 只是等待轮询时长
// ---------------------------------------------------------------------------
test('wait_task.timeoutSeconds 描述保持等待时长语义（10-600 秒、默认 120），与任务运行期限无关', { timeout: 30000, skip: skipUnlessIsolated() }, async () => {
  const profileDir = makeTempProfile('wait-semantics');
  const host = await createInProcessHost(profileDir);
  try {
    const tools = (await callMcp(host.port, 'tools/list')).tools;
    const waitTool = findTool(tools, 'wait_task');
    assert.equal(
      String(waitTool.inputSchema?.properties?.timeoutSeconds?.description ?? ''),
      'Max seconds to block, 10-600; default 120.',
      'wait_task.timeoutSeconds 的等待时长语义必须保持不变',
    );

    // 行为侧验证：wait_task 的 timeoutSeconds 只影响阻塞时长，不影响任务运行期限——
    // 对已终态任务调用立即返回，与等待时长无关
    const started = await callMcpTool(host.port, 'start_task', {
      task: '超时默认行为验证：wait_task 语义保持的占位任务',
    });
    assert.equal(started.isError, false, `start_task 不应报错: ${JSON.stringify(started.payload)}`);
    await waitForTerminal(host.port, started.payload.taskId);
    const instant = await callMcpTool(host.port, 'wait_task', { taskId: started.payload.taskId, timeoutSeconds: 10 });
    assert.equal(instant.isError, false, '终态任务的 wait_task 应立即返回');
    assert.equal(instant.payload.status, 'failed', '终态任务快照状态应保持 failed');
  } finally {
    await host.close();
  }
});
