// ============================================================================
// tests/url-only.test.mjs — URL 直连开放面 + CORS 预检集成回归（不跑真实模型）
//
// 被测契约（index.js 的 HTTP 端点，经 tests/fixture-host.mjs 真实 HTTP 宿主）：
//   1. MCP 端点不做鉴权：不带 Authorization 头的 initialize / tools/list
//      以 URL 直连即返回 200；
//   2. 旧版浏览器形态（附带旧格式假 Bearer 的 Authorization 头）的相同请求
//      同样 200——端点不校验也不拒绝该头；
//   3. GET <routePath>/info 不带任何 cookie 即返回 200（面板轮询信息端点开放）；
//   4. 带 Origin 的 OPTIONS 预检一律返回 204，且放开跨域：允许任意 origin、
//      允许 content-type 与 authorization 请求头、允许 GET/POST/OPTIONS 方法。
//
// 隔离性约定：
//   - 全程只发无副作用的 HTTP 请求（不调用任何工具），绝不启动真实模型或
//     headless 子代理进程；
//   - fixture-host 子进程的 USERPROFILE 指向系统 TEMP 下 mkdtemp 的唯一空目录
//     （DSH_PROFILE_DIR 一并钉进该目录，防止继承环境残留值泄漏真实 profile）：
//     Windows 上 os.homedir() 只认 USERPROFILE，插件触达的 ~/.dsh、~/.codex
//     全部落在临时目录内；测试自身不预写、不读取任何用户配置，也不输出任何
//     凭证内容（用到的 Bearer 是无意义占位符）；
//   - fixture-host 只绑 127.0.0.1 且监听端口固定传 0，由 OS 分配随机空闲端口，
//     测试从其 stdout 的唯一 JSON 端口行解析实际端口；
//   - 清理只终止本测试自己启动的宿主进程；临时目录先复核"位于系统 TEMP 之下
//     且带本测试专属前缀"才递归删除，绝不触碰其他内容；不重启任何服务。
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
// fixture-host 所在目录的上一级即插件仓库根（子进程工作目录，保持确定性）
const pluginRoot = path.dirname(path.dirname(fixtureHostPath));

// ---------- 测试常量 ----------
// 本测试临时目录的专属前缀：mkdtemp 用它命名，清理时以此复核，杜绝误删
const TEMP_PREFIX = 'dsh-url-only-test-';
// 插件默认的 MCP 前缀路由（fixture-host 以空 config 激活插件，走默认值）
const MCP_ROUTE = '/mcp/dsh-subagent';
// 等待 fixture-host 输出端口行的上限：正常毫秒级就绪，超时视为启动失败
const HOST_READY_TIMEOUT_MS = 15000;
// 等待子进程退出的上限：防止意外挂死测试进程
const EXIT_WAIT_TIMEOUT_MS = 10000;
// 旧版浏览器请求形态的假 Bearer 头（无意义占位值，非任何真实凭证）
const LEGACY_BEARER = 'Bearer dsh-url-only-fake-placeholder';

// 本测试创建的全部临时目录：after() 统一复核并清理
const createdTempRoots = [];

// JSON-RPC 请求 id 计数器：每次 MCP 请求递增，响应用同 id 配对
let rpcIdCounter = 0;

// ---------------------------------------------------------------------------
// 临时目录（唯一系统 TEMP 的 USERPROFILE）
// ---------------------------------------------------------------------------
/**
 * 在系统临时目录下 mkdtemp 一个唯一的空目录，作为 fixture-host 子进程的专属
 * USERPROFILE。不预写任何配置：插件读不到用户设置即走内置默认值。
 * 目录记录进 createdTempRoots，全部用例结束后统一复核清理。
 * @returns {string} 临时目录绝对路径
 */
function makeTempProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
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
// fixture-host 子进程管理（独立 USERPROFILE + 随机端口）
// ---------------------------------------------------------------------------
/**
 * 以独立 USERPROFILE 启动 fixture-host 子进程：
 * - 环境只改 USERPROFILE（指向临时唯一目录），HOME 与 CODEX_HOME 保持继承值
 *   不动；DSH_PROFILE_DIR 显式钉进临时目录内的默认派生路径，杜绝继承环境中
 *   残留值让插件读到真实 desktop profile（cordis.patch.yml）；
 * - 监听端口由 fixture-host 固定传 0，操作系统分配随机空闲端口，就绪后从其
 *   stdout 的唯一一行 JSON 端口行解析实际端口；
 * - stdout 收集端口行，stderr 收集诊断信息（仅用于失败定位）。
 * @param {string} profileDir 子进程的专属 USERPROFILE（临时目录）
 * @returns {{ child: import('node:child_process').ChildProcess, getStdout: () => string, getStderr: () => string }}
 */
function startFixtureHost(profileDir) {
  const env = { ...process.env };
  env.USERPROFILE = profileDir; // 子进程专属用户目录：所有读写都落在这里
  // 显式钉住 desktop profile 目录：即使继承环境残留 DSH_PROFILE_DIR（指向
  // 真实 DSH 数据目录），也只会落在临时目录内，绝不触碰真实用户数据
  env.DSH_PROFILE_DIR = path.join(profileDir, '.dsh', 'profiles', 'desktop');
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
 * @returns {Promise<number>} 宿主监听端口（随机分配）
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
 * 清理宿主：只终止本测试自己 spawn 的宿主进程。先常规 kill 并等待退出；
 * 等待超时才兜底用 taskkill /T /F 只对该宿主 pid 递归终止整棵进程树
 * （绝不涉及其他进程）。本测试不产生任何任务/子代理进程，无其他残留。
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
// MCP 请求辅助（URL 直连，不带任何凭证）
// ---------------------------------------------------------------------------
/**
 * 向 MCP 端点 POST 一条 JSON-RPC 2.0 请求：断言 HTTP 200、JSON-RPC 2.0 回显
 * （jsonrpc/id 与请求对齐、无协议级 error），返回 result 供用例继续断言。
 * Host 由 fetch 自动设置为监听 authority；默认不带任何 Authorization 头，
 * 需要模拟旧版浏览器形态时经 extraHeaders 显式传入。
 * @param {number} port 宿主监听端口
 * @param {string} method JSON-RPC 方法名（initialize / tools/list）
 * @param {object} params JSON-RPC params
 * @param {Record<string, string>} [extraHeaders] 额外请求头（如旧格式假 Bearer）
 * @returns {Promise<object>} JSON-RPC result 对象
 */
async function postMcp(port, method, params, extraHeaders = {}) {
  const id = ++rpcIdCounter;
  const response = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(response.status, 200, `${method} 应返回 200，实际 ${response.status}`);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0', `${method} 响应应为 JSON-RPC 2.0`);
  assert.equal(body.id, id, `${method} 响应 id 应与请求一致`);
  assert.equal(body.error, undefined, `${method} 不应有协议级错误`);
  return body.result;
}

// ---------------------------------------------------------------------------
// 用例：URL 直连开放面 + CORS 预检（单个宿主实例覆盖全部场景）
// ---------------------------------------------------------------------------
test('URL 直连即可用：MCP 无 Authorization 200、旧格式假 Bearer 仍 200、/info 无 cookie 200、OPTIONS 预检 204 且放开跨域', { timeout: 30000 }, async () => {
  // 准备：唯一临时 USERPROFILE（空目录、零预置文件）+ 随机端口宿主
  const host = startFixtureHost(makeTempProfile());
  try {
    const port = await waitForPortLine(host);
    // initialize 的标准客户端参数（protocolVersion 由端点原样回显）
    const initParams = {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-url-only-test', version: '0.0.0' },
    };

    // 1) 不带 Authorization 的 MCP initialize / tools/list：URL 直连即 200
    const initResult = await postMcp(port, 'initialize', initParams);
    assert.equal(typeof initResult?.protocolVersion, 'string', 'initialize 应回协议版本');
    assert.ok(
      initResult?.serverInfo && typeof initResult.serverInfo === 'object',
      `initialize 应回 serverInfo: ${JSON.stringify(initResult)}`,
    );
    const toolsResult = await postMcp(port, 'tools/list', {});
    assert.ok(
      Array.isArray(toolsResult?.tools) && toolsResult.tools.length > 0,
      'tools/list 应返回非空工具列表',
    );
    assert.ok(
      toolsResult.tools.some((tool) => tool?.name === 'start_task'),
      '工具列表应包含 start_task',
    );

    // 2) 附带旧格式假 Bearer 的相同请求：端点不校验该头，照常 200
    await postMcp(port, 'initialize', initParams, { authorization: LEGACY_BEARER });
    await postMcp(port, 'tools/list', {}, { authorization: LEGACY_BEARER });

    // 3) 不带 cookie 的 GET /info：面板信息端点开放，200 且 mcpUrl 指向本宿主
    const infoResponse = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}/info`);
    assert.equal(infoResponse.status, 200, `/info 应返回 200，实际 ${infoResponse.status}`);
    const info = await infoResponse.json();
    assert.equal(
      info.mcpUrl,
      `http://127.0.0.1:${port}${MCP_ROUTE}`,
      `/info 的 mcpUrl 应指向本宿主的 MCP 端点: ${JSON.stringify(info.mcpUrl)}`,
    );

    // 4) 带 Origin 的 OPTIONS 预检：一律 204 且放开跨域（允许任意来源的网页访问）
    const preflight = await fetch(`http://127.0.0.1:${port}${MCP_ROUTE}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://web-panel.example' }, // 外部网页 origin：验证任意来源均放行
    });
    assert.equal(preflight.status, 204, `OPTIONS 预检应返回 204，实际 ${preflight.status}`);
    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      '*',
      'CORS 应允许任意 origin',
    );
    const allowHeaders = preflight.headers.get('access-control-allow-headers') ?? '';
    assert.match(allowHeaders, /\bauthorization\b/i, `CORS 应允许 authorization 请求头: ${allowHeaders}`);
    assert.match(allowHeaders, /\bcontent-type\b/i, `CORS 应允许 content-type 请求头: ${allowHeaders}`);
    assert.equal(
      preflight.headers.get('access-control-allow-methods'),
      'GET, POST, OPTIONS',
      'CORS 应允许 GET/POST/OPTIONS 方法',
    );
  } finally {
    // 清理：只杀本测试启动的宿主进程；临时目录由 after() 复核位置后删除
    await stopHost(host);
  }
});
