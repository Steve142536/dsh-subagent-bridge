// ============================================================================
// tests/fixture-host.mjs — 本地隔离测试宿主（fixture host）
//
// 职责：模拟 DSH 宿主注入给插件的最小运行环境，在本进程内直接激活
// ../index.js 的 apply()，用一个只绑 127.0.0.1 随机端口的 node:http 服务器
// 承载插件注册的 prefix 路由，供集成测试对 MCP 端点发真实 HTTP 请求。
//
// 模拟的宿主服务（与真实宿主行为对齐，见 .tmp-inspect/ 快照）：
// - ctx.webServer.register({ kind, path, handler })：保存路由并返回注销函数；
//   分发时 exact 优先、prefix 取最长匹配；重复注册抛错。真实 webServer 只是
//   路由注册表，分发阶段不做任何全局准入/鉴权。
// - ctx.webServer.getOrigin()：返回监听 origin（绑定前抛错，插件会自行轮询）。
// - ctx.effect(fn)：立即执行 fn，收集其返回的清理函数，SIGTERM 时后进先出
//   依次执行（与 cordis 的 dispose 语义一致）。
// - ctx.connection.isTrusted(req)：用实际监听 authority（127.0.0.1:<port>）
//   校验 Host/Origin，拒绝一切不匹配请求（DNS rebinding / 跨站防线）。
// - ctx.connection.admit(req)：在 isTrusted 之上仅放行携带测试 cookie
//   `dsh_test=owner` 的请求，通过时返回 { peer: { principal: { kind: 'owner' } } }
//   （形状对齐真实宿主的浏览器准入结果），模拟真实宿主的浏览器准入围栏。
//   二者只是测试替身：宿主分发阶段不会主动调用，是否鉴权由插件 handler
//   自行决定。
//
// 隔离性约定：
// - 本脚本自身不做任何文件读写；测试前调用方会把 USERPROFILE 指向
//   临时目录，插件（apply）产生的读取与落盘全部落在临时目录里，
//   不会触碰真实用户配置（USERPROFILE 下的 .dsh、.codex）。
// - 服务器只绑 127.0.0.1 随机端口，不监听对外网卡。
// - stdout 唯一输出是监听成功后的一行 JSON 端口（{"port":<port>}），
//   任何诊断信息一律走 stderr，方便调用方机器化解析。
// ============================================================================

import { createServer } from 'node:http';

import { apply } from '../index.js';

// ---------- 常量 ----------
const BIND_HOST = '127.0.0.1'; // 只绑回环地址，保证测试宿主对外不可达
const BIND_PORT = 0;           // 端口 0 = 由操作系统分配随机空闲端口
const TEST_COOKIE_NAME = 'dsh_test';  // 测试准入 cookie 名
const TEST_COOKIE_VALUE = 'owner';    // 测试准入 cookie 值（完整 cookie 为 dsh_test=owner）

// ---------- 监听状态 ----------
// 绑定成功后由 main() 写入实际端口；getOrigin/isTrusted 都以它为准
const listenState = { port: undefined };

// ---------------------------------------------------------------------------
// webServer 模拟：路由表 + 匹配 + origin
// ---------------------------------------------------------------------------
/**
 * 创建模拟的宿主 webServer 服务。
 * 保存插件 register 的路由（本插件只用 prefix），提供与真实宿主一致的
 * 分发规则：exact 表优先，prefix 表取最长前缀（`path` 精确或 `path/...`）。
 * @returns {{ register: Function, match: Function, getOrigin: Function }}
 */
function createFakeWebServer() {
  const exact = new Map();    // kind=exact：path → route
  const prefixes = new Map(); // kind=prefix：path → route

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
     * 按真实宿主规则匹配路径：exact 命中优先，否则在 prefix 表里取
     * 最长匹配的条目（pathname 必须等于 prefix 或以 `prefix/` 开头，
     * 因此 `/mcp/dsh-subagentX` 不会命中 `/mcp/dsh-subagent`）。
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
     * 返回监听 origin（形如 http://127.0.0.1:<port>）。
     * 绑定成功前抛错——真实宿主同样如此，插件的就绪轮询会捕获后重试。
     * @returns {string} origin 文本
     */
    getOrigin() {
      if (listenState.port === undefined) {
        throw new Error('webserver: origin read before the listener bound a port');
      }
      return `http://${BIND_HOST}:${listenState.port}`;
    },
  };
  return webServer;
}

// ---------------------------------------------------------------------------
// connection 模拟：请求信任围栏 + 测试 cookie 准入（测试替身，仅由插件自行调用）
// ---------------------------------------------------------------------------
/**
 * 从 Cookie 头里读取指定名字的值；不存在该名字时返回 undefined。
 * 只做测试所需的宽松解析：按分号切段、段内首个 '=' 分隔名与值、两侧去空白。
 * @param {string} headerValue 原始 Cookie 头文本
 * @param {string} name 目标 cookie 名
 * @returns {string | undefined} cookie 值
 */
function readCookie(headerValue, name) {
  for (const segment of String(headerValue).split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * 创建模拟的宿主 connection 服务（请求准入围栏）。
 * 仅为插件 handler 提供可调用的测试替身：宿主分发阶段不会主动执行
 * isTrusted/admit，是否鉴权由插件 handler 自行决定。
 * @returns {{ isTrusted: Function, admit: Function }}
 */
function createFakeConnection() {
  /**
   * 实际监听 authority（http://127.0.0.1:<port>，经 URL 归一化）。
   * 未绑定端口时返回 undefined——此时没有任何可信任的 authority。
   * @returns {URL | undefined}
   */
  function listeningAuthority() {
    if (listenState.port === undefined) return undefined;
    return new URL(`http://${BIND_HOST}:${listenState.port}`);
  }

  /**
   * 判断请求是否可信：Host 头必须就是本监听的 authority（挡 DNS rebinding，
   * 该头无法被浏览器伪造）；带 Origin 头时其 authority 也必须一致（挡跨站）。
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean} true = Host/Origin 均与监听 authority 匹配
   */
  function isTrusted(req) {
    const authority = listeningAuthority();
    if (authority === undefined) return false;

    // Host 必须存在且归一化后等于监听 authority（host:port）
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
    let hostUrl;
    try {
      hostUrl = new URL(`http://${hostHeader}`);
    } catch {
      return false; // Host 不可解析：直接拒绝
    }
    if (hostUrl.host !== authority.host) return false;

    // Origin 可选；一旦携带（浏览器跨站/同源都会带），authority 必须一致，
    // 且只接受 http/https 形式（origin: null 等反常值一并拒绝）
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      let originUrl;
      try {
        originUrl = new URL(origin);
      } catch {
        return false; // Origin 不可解析：直接拒绝
      }
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
      if (originUrl.host !== authority.host) return false;
    }
    return true;
  }

  /**
   * 请求准入：不可信（Host/Origin 不匹配）→ 403；
   * 可信但未携带测试 cookie `dsh_test=owner` → 401；
   * 两者都通过才放行（返回携带 peer 的准入结果，peer.principal.kind 固定为
   * "owner"，形状对齐真实宿主 client-connection 的浏览器准入结果）。
   * @param {import('node:http').IncomingMessage} req
   * @returns {{ rejection: number } | { peer: { principal: { kind: 'owner' } } }}
   */
  function admit(req) {
    if (!isTrusted(req)) return { rejection: 403 };
    const value = typeof req.headers.cookie === 'string'
      ? readCookie(req.headers.cookie, TEST_COOKIE_NAME)
      : undefined;
    if (value !== TEST_COOKIE_VALUE) return { rejection: 401 };
    return { peer: { principal: { kind: 'owner' } } }; // 放行；peer 形状对齐真实宿主
  }

  return { isTrusted, admit };
}

// ---------------------------------------------------------------------------
// ctx 组装：webServer + connection + effect 清理栈
// ---------------------------------------------------------------------------
const cleanups = []; // effect 收集的清理函数；SIGTERM 时后进先出依次执行

const webServer = createFakeWebServer();
const connection = createFakeConnection();

const ctx = {
  webServer,
  connection,
  /**
   * 按名字取回本 ctx 已注入的服务（与真实宿主 ctx.get(name) 语义一致）。
   * 只原样返回已有服务，不做任何创建、缓存或拦截；未注册的名字返回 undefined。
   * @param {string} name 服务名（如 "webServer"、"connection"）
   * @returns {unknown} 已有服务本身，或 undefined
   */
  get(name) {
    return this[name];
  },
  /**
   * 执行 effect 回调并收集其返回的清理函数（与 cordis 语义一致：
   * 回调立即执行，清理延迟到 dispose；清理函数可以是同步函数，
   * 也可以是返回 Promise 的异步函数，shutdown 时会逐个 await）。
   * @param {() => (Function | void) | Promise<Function | void>} fn
   */
  effect(fn) {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  },
};

// ---------------------------------------------------------------------------
// HTTP 服务器：请求分发（匹配路由 → 插件 handler）
// 不在分发阶段做全局准入：真实 webServer 只是路由注册表，connection 的
// isTrusted/admit 是测试替身，鉴权与否由插件 handler 自行调用决定。
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    // 与真实 webserver 相同：按路径（剥离查询串）匹配路由
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const route = webServer.match(pathname);

    // 未注册的路径：404（真实宿主在无 fallback 时也是裸 404）
    if (route === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }

    // 把请求交给注册的 handler（本插件的 handler 是 node:http 原生签名）；
    // 是否调用 connection.isTrusted/admit 做鉴权由 handler 自行决定
    await route.handler(req, res);
  } catch {
    // 与真实 webserver 相同的兜底：handler 抛错 → 400；
    // 响应已开始则只能直接断开，避免半截响应挂住测试客户端
    if (res.headersSent || res.writableEnded || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(400);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// 启动：激活插件 → 绑定随机端口 → 输出 JSON 端口
// ---------------------------------------------------------------------------
/**
 * 绑定监听，成功 resolve、失败 reject（error 监听只挂一次，防止泄漏）。
 * @returns {Promise<void>}
 */
function listenOnce() {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(BIND_PORT, BIND_HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * 关机流程：依次（后进先出）执行 effect 清理，再关闭服务器。
 * - 清理逐个 await 且互不阻断：单个清理失败打到 stderr，其余照常执行；
 * - close 同时 closeAllConnections，避免测试客户端的 keep-alive 连接
 *   拖住 close 回调导致进程迟迟不退出；
 * - 幂等：重复信号（SIGTERM+SIGINT 连发）只走一次。
 * @returns {Promise<void>}
 */
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // 1. 依次执行清理（后进先出）：本插件注册顺序是 [codex 轮询, 路由+任务收尾]，
  //    逆序执行即先注销路由并收尾任务，再清轮询定时器
  for (let i = cleanups.length - 1; i >= 0; i--) {
    try {
      await cleanups[i]();
    } catch (err) {
      console.error(`[fixture-host] cleanup ${i} failed: ${err?.message ?? err}`);
    }
  }
  // 2. 关闭监听并断开残留连接；未监听时 close 的错误经回调吞掉即可
  await new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
  process.exit(0);
}

/**
 * 主流程：先激活插件（注册路由与清理），再绑定随机端口，最后往 stdout
 * 输出唯一一行 JSON 端口，供测试调用方解析后发真实 HTTP 请求。
 */
async function main() {
  // config 传空对象：routePath 走插件默认值 /mcp/dsh-subagent（与 patch 配置一致）
  apply(ctx, {});
  await listenOnce();
  listenState.port = server.address().port;
  // 监听成功后仅输出 JSON 端口——stdout 上不允许出现其他任何内容
  process.stdout.write(`${JSON.stringify({ port: listenState.port })}\n`);
}

main().catch((err) => {
  console.error(`[fixture-host] failed to start: ${err?.message ?? err}`);
  process.exit(1);
});

// SIGTERM（测试调用方的标准停机信号）与 SIGINT（交互调试用）共用同一关机流程
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
