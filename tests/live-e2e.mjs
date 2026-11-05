// ============================================================================
// tests/live-e2e.mjs — 真实环境端到端联调测试（live E2E，手动运行）
//
// 用途：
//   在本机真实环境中对 @local/dsh-subagent-bridge 做一次"全真"联调：
//   用 DeepSeek Harness.exe 的 Electron Node 模式启动 tests/fixture-host.mjs
//   （插件真实激活），再以 MCP URL 直连（随机端口、不带任何令牌/cookie 凭证，
//   桥接已取消鉴权）调用 MCP 端点，让插件 spawn 真实的 headless DSH 子进程
//   执行任务——绝不使用模拟答案。
//
// 运行方式（由主代理手动执行，不纳入自动化单测）：
//   node tests/live-e2e.mjs
//   可选环境变量：
//     DSH_ELECTRON_EXE     — DeepSeek Harness.exe 的绝对路径（默认自动探测）
//     DSH_E2E_PROFILE_DIR  — desktop profile 目录覆盖（默认 <真实USERPROFILE>/.dsh/profiles/desktop）
//
// 隔离性约定（务必维持）：
//   - 一切临时状态（插件配置/任务历史、子代理工作目录）都放在系统 TEMP
//     下 mkdtemp 创建的独立目录里；子进程 USERPROFILE 指向其中的 home 子目录，
//     因此插件的 .dsh 状态与 codexSync（读 <USERPROFILE>/.codex/config.toml，
//     临时目录下不存在 → 自动 skipped）全部与真实用户配置隔离；
//   - 绝不设置、删除或重设 HOME / CODEX_HOME——保持原样继承；
//   - DSH_HOME 指向当前已配置的真实 DSH 数据目录（凭据复用；本测试不主动
//     修改该目录，但它并非绝对只读——测试新会话可能把自己的运行数据写进去）；
//     DSH_PROFILE_DIR 显式指向原 desktop profile（模型配置来源；不继承当前
//     环境变量，因为它可能指向 headless profile）；
//   - 不修改真实 Codex/DSH 配置，不重启任何现有 DSH 服务，只启动/停止本脚本
//     自己 spawn 的隔离宿主进程树。
//
// 测试内容：
//   1. MCP 握手：initialize（serverInfo 版本 1.5.0）+ tools/list（7 个必需工具）；
//   2. steer：用 glm/glm-5.3-flash 启动只操作临时目录的短任务，等 session/progress
//      就绪后 send_message(steer) 注入唯一标记要求，等待最终结果包含该标记；
//   3. interrupt/continue：启动长任务后 interrupt_task 温和中断——回执必须
//      成功（失败即测试失败，绝不回退 cancel_task 掩盖），等待子进程释放后
//      continue_task 验证原 session 可续跑；
//   4. read-only：permissionMode=read-only 的任务尝试写临时目录文件，要求
//      任务 completed 且回答原样包含"写入被拒"标记、文件未真实产生，三者
//      缺一即失败（目标文件不存在本身不构成"写入被拦截"的证据）；
//   5. 重启验证：任务全部终态后重启隔离宿主，验证旧 taskId 与结果（含 answer）
//      经 MCP 与面板只读端点均可查询（持久化复用同一 home 目录）。
//
// 安全与健壮性约定：
//   - 桥接已取消鉴权：本测试不生成、不读取、不持有任何 MCP 令牌，全程以
//     URL 直连；诊断文本仍统一经 redact() 做防御性脱敏（64 位 hex 一律替换
//     为 <redacted>），保证意外混入的敏感串不会出现在日志里；
//   - 每一步（启动、HTTP 请求、等待任务、进程停止）都有独立超时，失败立即
//     明确报告并以非 0 退出码结束；
//   - 退出前停止本脚本 spawn 的全部进程树（taskkill /T /F 递归强杀），并只
//     清理"位于系统 TEMP 之下、由本脚本 mkdtemp 创建"的目录。
// ============================================================================

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
// 插件默认路由前缀（fixture-host 以空 config 激活插件，走默认值）
const ROUTE_PATH = '/mcp/dsh-subagent';
// MCP 协议版本（与 index.js 的默认值一致）
const PROTOCOL_VERSION = '2025-06-18';
// 1.5.0 版本所需的完整工具集（serverInfo.version 与 package.json 一致）
const EXPECTED_SERVER_VERSION = '1.5.0';
const EXPECTED_TOOLS = [
  'start_task',
  'wait_task',
  'cancel_task',
  'interrupt_task',
  'send_message',
  'continue_task',
  'list_tasks',
];
// 子代理模型：与主代理要求一致（provider/model 形式）
const TASK_MODEL = 'glm/glm-5.3-flash';
// MCP 工具任务的任务级权限：与插件全局默认（workspace → workspace-write）一致，
// 只用于让行为确定，不改变权限等级
const TASK_PERMISSION_WRITE = 'workspace-write';

// ---------- 超时预算 ----------
const HOST_START_TIMEOUT_MS = 60_000;     // 隔离宿主启动（Electron Node + 插件激活）上限
const HOST_STOP_TIMEOUT_MS = 20_000;      // 宿主进程树停止上限
const MCP_INIT_TIMEOUT_MS = 20_000;       // initialize 单次请求上限
const MCP_FAST_TIMEOUT_MS = 20_000;       // 一般瞬时工具调用上限
const WAIT_POLL_SECONDS = 10;             // wait_task 单次阻塞秒数（插件允许的最小值）
const WAIT_POLL_TIMEOUT_MS = 30_000;      // 单次 wait_task 请求超时（阻塞 10s + 余量）
const SESSION_READY_TIMEOUT_MS = 150_000; // 等任务 running 且上报 sessionId 的上限
const STEER_TASK_TIMEOUT_MS = 240_000;    // steer 任务等终态上限
const INTERRUPT_TASK_TIMEOUT_MS = 120_000;// 中断后等 cancelled 终态上限
const CONTINUE_READY_TIMEOUT_MS = 120_000;// 子进程释放后 continue_task 重试窗口上限
const CONTINUE_TASK_TIMEOUT_MS = 240_000; // 续跑任务等终态上限
const READONLY_TASK_TIMEOUT_MS = 240_000; // read-only 任务等终态上限
const CONTROL_CALL_TIMEOUT_MS = 30_000;   // send_message/interrupt_task 等 ack 的上限

// ---------------------------------------------------------------------------
// 日志与脱敏
// ---------------------------------------------------------------------------
/** 带时间戳输出一行日志。@param {string} message 日志内容 */
function log(message) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  process.stdout.write(`[${hh}:${mm}:${ss}] ${message}\n`);
}

/**
 * 脱敏：把文本中所有 64 位小写 hex 串替换为占位符。桥接已取消鉴权、测试
 * 不再持有令牌，此规则仅作为防御性兜底，避免意外混入的敏感串进日志。
 * @param {unknown} text 任意文本
 * @returns {string} 脱敏后的文本
 */
function redact(text) {
  return String(text ?? '').replace(/[0-9a-f]{64}/g, '<redacted>');
}

/** 截断文本到指定长度（尾部省略），用于打印子代理回答摘要。 */
function clip(text, limit = 300) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}…(共 ${s.length} 字符)` : s;
}

// ---------------------------------------------------------------------------
// 通用异步工具
// ---------------------------------------------------------------------------
/** 睡眠指定毫秒。@returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给 Promise 加超时：到点未完成则以明确错误 reject（底层操作可能仍在后台，
 * 调用方负责在此后停止/清理相关进程与连接）。
 * @param {Promise<unknown>} promise 目标 Promise
 * @param {number} ms 超时毫秒数
 * @param {string} label 超时报错时使用的步骤描述
 * @returns {Promise<unknown>}
 */
async function withTimeout(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 启动一个"发完即忘"的子进程并等它退出（用于 taskkill）。
 * 无论成败都 resolve，绝不抛错——停止流程的失败由后续 exit 等待兜底。
 * @param {string} cmd 命令名
 * @param {string[]} args 参数列表
 * @returns {Promise<void>}
 */
function runAndForget(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// 真实环境解析：Electron 可执行文件 / DSH 数据目录 / desktop profile
// ---------------------------------------------------------------------------
/**
 * 定位 DeepSeek Harness.exe（Electron 宿主）。优先使用环境变量 DSH_ELECTRON_EXE，
 * 否则探测默认安装位置。找不到时明确报错。
 * @returns {string} exe 绝对路径
 */
function resolveHarnessExe() {
  const fromEnv = process.env.DSH_ELECTRON_EXE;
  if (fromEnv && fromEnv.trim()) {
    const p = path.resolve(fromEnv.trim());
    if (!fs.existsSync(p)) {
      throw new Error(`环境变量 DSH_ELECTRON_EXE 指向的文件不存在: ${p}`);
    }
    return p;
  }
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [];
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    '未找到 DeepSeek Harness.exe：请通过环境变量 DSH_ELECTRON_EXE 指定安装路径',
  );
}

/**
 * 返回"真实用户目录"（测试脚本自身运行环境的 USERPROFILE）。
 * 这是解析真实 DSH 数据目录与 desktop profile 的基准；子进程的 USERPROFILE
 * 会被指到临时目录，不影响这里的取值。
 * @returns {string} 真实用户目录绝对路径
 */
function resolveRealUserProfile() {
  const up = process.env.USERPROFILE;
  if (!up || !up.trim() || !fs.existsSync(up.trim())) {
    throw new Error('环境变量 USERPROFILE 缺失或不存在，无法定位真实 DSH 配置');
  }
  return path.resolve(up.trim());
}

/**
 * 解析当前已配置的 DSH 数据目录（作为子进程 DSH_HOME，凭据复用）。
 * 优先级：环境变量 DSH_HOME > <真实USERPROFILE>/.dsh；目录必须存在。
 * 注意：仅表示本测试不主动修改该目录，并非绝对只读——测试新会话可能把
 * 自己的运行数据（会话记录等）写入其中。
 * @returns {string} DSH 数据目录绝对路径
 */
function resolveDshHome(realUserProfile) {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) {
    const p = path.resolve(fromEnv.trim());
    if (!fs.existsSync(p)) {
      throw new Error(`环境变量 DSH_HOME 指向的目录不存在: ${p}`);
    }
    return p;
  }
  const fallback = path.join(realUserProfile, '.dsh');
  if (!fs.existsSync(fallback)) {
    throw new Error(
      `未找到 DSH 数据目录：环境变量 DSH_HOME 未设置，且默认位置 ${fallback} 不存在`,
    );
  }
  return fallback;
}

/**
 * 解析"原 desktop profile"目录（模型配置 cordis.patch.yml 的来源）。
 * 刻意不读环境变量 DSH_PROFILE_DIR（当前环境可能把它指到 headless profile，
 * 与本测试"复用 desktop 模型配置"的目标相悖）；如需覆盖请用 DSH_E2E_PROFILE_DIR。
 * @param {string} realUserProfile 真实用户目录
 * @returns {string} desktop profile 目录绝对路径
 */
function resolveDesktopProfile(realUserProfile) {
  const override = process.env.DSH_E2E_PROFILE_DIR;
  const base =
    override && override.trim()
      ? path.resolve(override.trim())
      : path.join(realUserProfile, '.dsh', 'profiles', 'desktop');
  if (!fs.existsSync(base)) {
    throw new Error(`desktop profile 目录不存在: ${base}`);
  }
  const patch = path.join(base, 'cordis.patch.yml');
  if (!fs.existsSync(patch)) {
    throw new Error(`desktop profile 缺少 cordis.patch.yml（子代理模型配置来源）: ${base}`);
  }
  return base;
}

// ---------------------------------------------------------------------------
// 隔离临时目录
// ---------------------------------------------------------------------------
/**
 * 在系统 TEMP 下创建本测试专属的独立目录树：
 *   <root>/home — 子进程 USERPROFILE（插件令牌/配置/任务历史落在这里）
 *   <root>/work — 子代理任务工作目录
 * 返回前校验 root 确实位于系统 TEMP 之下（防 mkdtemp 语义被破坏）。
 * @returns {{ root: string, home: string, work: string }}
 */
function makeIsolatedDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-e2e-'));
  assertInsideTempDir(root); // mkdtemp(os.tmpdir()) 正常时必然通过；失败立即中止
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return { root, home, work };
}

/**
 * 校验目录确实位于系统 TEMP 之下（双侧 realpath 归一化后做相对位置判断）。
 * 清理与创建前都要调用：本测试只允许触碰 TEMP 下的自有目录。
 * @param {string} target 待校验目录
 */
function assertInsideTempDir(target) {
  const tempReal = fs.realpathSync(os.tmpdir());
  const targetReal = fs.realpathSync(target);
  const rel = path.relative(tempReal, targetReal);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`安全校验失败：目录不在系统 TEMP 之下，拒绝继续: ${target}`);
  }
}

/**
 * 清理本测试 mkdtemp 创建的临时目录树（递归强制删除）。
 * 仅在 assertInsideTempDir 校验通过后执行；删除失败只告警不抛错，
 * 避免掩盖真正的测试结果。
 * @param {string} root 临时根目录
 */
function cleanupTempDir(root) {
  try {
    assertInsideTempDir(root);
  } catch (err) {
    log(`[警告] 临时目录安全校验未通过，保留不删: ${redact(err?.message ?? err)}`);
    return;
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
    log(`已清理临时目录: ${root}`);
  } catch (err) {
    log(`[警告] 临时目录清理失败（可能被占用，已保留）: ${root} — ${redact(err?.message ?? err)}`);
  }
}

// ---------------------------------------------------------------------------
// 隔离宿主进程管理（DeepSeek Harness.exe 的 Electron Node 模式）
// ---------------------------------------------------------------------------
/**
 * 封装一个隔离宿主进程：spawn DeepSeek Harness.exe（ELECTRON_RUN_AS_NODE=1）
 * 执行 tests/fixture-host.mjs；stdout 唯一输出一行 {"port":<port>} JSON。
 */
class IsolatedHost {
  /**
   * @param {import('node:child_process').ChildProcess} child 宿主子进程
   * @param {string} label 日志标签（如 "宿主A"/"宿主B"）
   */
  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.port = null;       // 宿主监听端口（绑定成功后填充）
    this.exited = false;    // 进程是否已退出
    this.exitCode = null;
    this.stopped = false;   // 是否已执行过 stop()（幂等）
    this.stderrTail = '';   // 宿主 stderr 尾部（诊断用，打印前必须 redact）
  }

  /**
   * 启动隔离宿主并等待其端口输出。
   * @param {object} opts
   * @param {string} opts.exe DeepSeek Harness.exe 路径
   * @param {string} opts.fixturePath tests/fixture-host.mjs 绝对路径
   * @param {string} opts.cwd 宿主进程工作目录（临时 work 目录）
   * @param {NodeJS.ProcessEnv} opts.env 子进程环境变量
   * @param {string} opts.label 日志标签
   * @param {number} [opts.timeoutMs] 启动超时
   * @returns {Promise<IsolatedHost>}
   */
  static async start({ exe, fixturePath, cwd, env, label, timeoutMs = HOST_START_TIMEOUT_MS }) {
    const child = spawn(exe, [fixturePath], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const host = new IsolatedHost(child, label);
    child.stderr.on('data', (chunk) => {
      host.stderrTail = (host.stderrTail + chunk.toString('utf8')).slice(-8000);
    });
    child.on('exit', (code) => {
      host.exited = true;
      host.exitCode = code;
    });

    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;
      /** 一次性收口：成功 resolve 端口，失败 reject（附 stderr 尾部，已脱敏）。 */
      const finish = (errMessage, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        if (errMessage) {
          const tail = redact(host.stderrTail).trim();
          reject(new Error(`${errMessage}；${label} stderr 尾部: ${tail || '(空)'}`));
        } else {
          resolve(value);
        }
      };
      /** 解析 stdout：首个完整行必须是 {"port":<port>}。 */
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        const newlineAt = buffer.indexOf('\n');
        if (newlineAt === -1) return;
        const line = buffer.slice(0, newlineAt).trim();
        if (!line) return;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }
        if (parsed && Number.isFinite(parsed.port)) finish(null, parsed.port);
        else finish(`${label} stdout 首行不是预期的 {"port":<port>} JSON`);
      };
      const timer = setTimeout(
        () => finish(`等待 ${label} 端口输出超时（${timeoutMs}ms）`),
        timeoutMs,
      );
      child.stdout.on('data', onData);
      child.once('exit', (code) => finish(`${label} 进程提前退出（code=${code ?? 'null'}）`));
    });

    host.port = port;
    return host;
  }

  /**
   * 停止宿主进程树。
   * Windows 上 TerminateProcess 不会执行 fixture-host 的 SIGTERM 清理钩子；
   * 本测试在停止前保证所有任务都已终态（终态迁移时插件会在 100ms 防抖内
   * 落盘任务历史），因此直接 taskkill /T /F 递归强杀整棵树即可——同时兜底
   * 清掉可能残留的 headless 子进程。非 Windows 回退 SIGTERM。
   * @param {string} [reason] 停止原因（仅用于日志）
   * @returns {Promise<void>}
   */
  async stop(reason = '') {
    if (this.stopped) return;
    this.stopped = true;
    const pid = this.child.pid;
    if (!this.exited && typeof pid === 'number') {
      if (process.platform === 'win32') {
        await runAndForget('taskkill', ['/PID', String(pid), '/T', '/F']);
      } else {
        try {
          this.child.kill('SIGTERM');
        } catch {
          // 进程可能已退出
        }
      }
    }
    // 等待进程退出（超时再补一次强杀，确保最终一定退出）
    await new Promise((resolve) => {
      if (this.exited) return resolve();
      const fallbackTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && typeof pid === 'number') {
            void runAndForget('taskkill', ['/PID', String(pid), '/T', '/F']);
          } else {
            this.child.kill('SIGKILL');
          }
        } catch {
          // 进程可能已退出
        }
      }, HOST_STOP_TIMEOUT_MS);
      this.child.once('exit', () => {
        clearTimeout(fallbackTimer);
        resolve();
      });
    });
    if (reason) log(`${this.label} 已停止（${reason}）`);
  }

  /**
   * 返回脱敏后的宿主 stderr 尾部（诊断用）。
   * @returns {string}
   */
  diagnostics() {
    return redact(this.stderrTail).trim();
  }
}

// ---------------------------------------------------------------------------
// HTTP / MCP 客户端
// ---------------------------------------------------------------------------
/**
 * 工具调用业务失败（result.isError === true）时抛出；
 * 携带 flag 便于调用方区分"业务失败"与"协议/网络错误"。
 */
class ToolCallError extends Error {
  /**
   * @param {string} tool 工具名
   * @param {string} detail 服务端错误文本（已由调用方脱敏）
   */
  constructor(tool, detail) {
    super(`工具 ${tool} 返回业务错误: ${detail}`);
    this.name = 'ToolCallError';
    this.isToolCallError = true;
  }
}

/**
 * 发起一次本机 HTTP 请求并返回 { status, text }。
 * 使用 node:http 而非 fetch：对超时与连接行为的控制更直接，且不依赖运行时版本。
 * @param {object} opts
 * @param {number} opts.port 目标端口（Host 固定 127.0.0.1，满足宿主 isTrusted 校验）
 * @param {string} opts.pathName 请求路径
 * @param {string} [opts.method] HTTP 方法
 * @param {Record<string, string>} [opts.headers] 额外请求头
 * @param {Buffer} [opts.body] 请求体
 * @param {number} opts.timeoutMs 超时毫秒数
 * @returns {Promise<{ status: number, text: string }>}
 */
function httpRequest({ port, pathName, method = 'GET', headers = {}, body = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`HTTP 请求超时（${timeoutMs}ms）: ${method} ${pathName}`));
    });
    request.on('error', (err) => {
      reject(err instanceof Error ? err : new Error(redact(String(err))));
    });
    if (body !== null) request.write(body);
    request.end();
  });
}

/**
 * 极简 MCP streamable-http 客户端：JSON-RPC 2.0 over HTTP POST。
 * 桥接已取消鉴权：仅凭 URL 直连，不携带任何 Authorization/凭证头。
 */
class McpClient {
  /**
   * @param {number} port 宿主端口
   */
  constructor(port) {
    this.port = port;
    this.nextRequestId = 1;
  }

  /** 生成自增 JSON-RPC 请求 id。@returns {number} */
  nextId() {
    return this.nextRequestId++;
  }

  /**
   * 发送一条 JSON-RPC 消息并返回解析后的响应对象（通知返回 null）。
   * @param {object} payload JSON-RPC 消息
   * @param {number} timeoutMs 请求超时
   * @returns {Promise<object | null>}
   */
  async rawRequest(payload, timeoutMs) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const { status, text } = await httpRequest({
      port: this.port,
      pathName: ROUTE_PATH,
      method: 'POST',
      timeoutMs,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': String(body.length),
        // URL 直连：不带任何 Authorization/凭证头（桥接已取消鉴权）
      },
      body,
    });
    if (status !== 200 && status !== 202) {
      throw new Error(`MCP 端点返回 HTTP ${status}（${ROUTE_PATH}）`);
    }
    if (!text.trim()) return null; // 通知的 202 空响应
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('MCP 响应不是合法 JSON');
    }
  }

  /**
   * 发送 JSON-RPC 通知（无 id，服务端返回 202 空响应）。
   * @param {string} method 通知方法名
   * @param {object} [params] 参数
   * @returns {Promise<void>}
   */
  async notify(method, params = {}) {
    await this.rawRequest({ jsonrpc: '2.0', method, params }, MCP_FAST_TIMEOUT_MS);
  }

  /**
   * 完成 MCP 握手：initialize + notifications/initialized。
   * @returns {Promise<object>} initialize 的 result（含 serverInfo）
   */
  async initialize() {
    const response = await this.rawRequest(
      {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dsh-live-e2e', version: '1.0.0' },
        },
      },
      MCP_INIT_TIMEOUT_MS,
    );
    if (!response || response.error) {
      throw new Error(`initialize 协议错误: ${JSON.stringify(response?.error ?? response)?.slice(0, 300)}`);
    }
    await this.notify('notifications/initialized');
    return response.result;
  }

  /**
   * 调用一个 MCP 工具并返回解析后的业务载荷。
   * 服务端把载荷 JSON 序列化在 content[0].text 里；isError 时抛 ToolCallError。
   * @param {string} toolName 工具名
   * @param {object} [args] 工具参数
   * @param {number} [timeoutMs] 超时
   * @returns {Promise<object>}
   */
  async callTool(toolName, args = {}, timeoutMs = MCP_FAST_TIMEOUT_MS) {
    const response = await this.rawRequest(
      {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      },
      timeoutMs,
    );
    if (!response || response.error) {
      throw new Error(`tools/call ${toolName} 协议错误: ${JSON.stringify(response?.error ?? response)?.slice(0, 300)}`);
    }
    const result = response.result;
    if (!result || !Array.isArray(result.content)) {
      throw new Error(`tools/call ${toolName} 响应缺少 content 数组`);
    }
    const textPart = result.content.find((part) => part?.type === 'text')?.text ?? '';
    let payload;
    try {
      payload = JSON.parse(textPart);
    } catch {
      payload = { raw: textPart };
    }
    if (result.isError) {
      const detail =
        typeof payload?.error === 'string' ? payload.error : JSON.stringify(payload)?.slice(0, 400);
      throw new ToolCallError(toolName, redact(detail));
    }
    return payload;
  }

  /**
   * 调用 tools/list 并返回工具名列表。
   * @returns {Promise<string[]>}
   */
  async listToolNames() {
    const response = await this.rawRequest(
      { jsonrpc: '2.0', id: this.nextId(), method: 'tools/list' },
      MCP_FAST_TIMEOUT_MS,
    );
    if (!response || response.error || !Array.isArray(response.result?.tools)) {
      throw new Error('tools/list 响应缺少 tools 数组');
    }
    return response.result.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
  }

  /**
   * 阻塞式等待一次任务快照（wait_task，单次阻塞 WAIT_POLL_SECONDS 秒）。
   * @param {string} taskId 任务 id
   * @returns {Promise<object>} 任务快照（status/sessionId/answer/error/progress 等）
   */
  async waitTaskOnce(taskId) {
    return this.callTool(
      'wait_task',
      { taskId, timeoutSeconds: WAIT_POLL_SECONDS },
      WAIT_POLL_TIMEOUT_MS,
    );
  }
}

// ---------------------------------------------------------------------------
// 任务等待辅助
// ---------------------------------------------------------------------------
/** 是否为终态状态。@param {string} status 任务状态 @returns {boolean} */
function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * 轮询 wait_task 直到任务进入终态（wait_task 本身每轮阻塞 10 秒）。
 * 运行中快照仅在状态/进度变化时打印，避免刷屏。
 * @param {McpClient} client MCP 客户端
 * @param {string} taskId 任务 id
 * @param {number} timeoutMs 总超时
 * @param {string} label 日志标签
 * @returns {Promise<object>} 终态快照
 */
async function waitForTaskTerminal(client, taskId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastKey = '';
  for (;;) {
    const snapshot = await client.waitTaskOnce(taskId);
    const progress = snapshot?.progress;
    const key = [
      snapshot?.status,
      progress?.phase ?? '',
      progress?.turn ?? '',
      progress?.step ?? '',
    ].join('|');
    if (key !== lastKey) {
      lastKey = key;
      const progressText =
        progress?.phase != null
          ? ` phase=${progress.phase} turn=${progress.turn ?? '-'} step=${progress.step ?? '-'}`
          : '';
      log(`  [${label}] status=${snapshot?.status}${progressText}`);
    }
    if (isTerminalStatus(snapshot?.status)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`${label}: 等待任务终态超时（${timeoutMs}ms），当前状态 ${snapshot?.status}`);
    }
  }
}

/**
 * 轮询 wait_task 直到任务 running 且已上报 sessionId（控制通道可寻址）。
 * @param {McpClient} client MCP 客户端
 * @param {string} taskId 任务 id
 * @param {string} label 日志标签
 * @returns {Promise<object>} 就绪时的运行中快照
 */
async function waitForSessionReady(client, taskId, label) {
  const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
  for (;;) {
    const snapshot = await client.waitTaskOnce(taskId);
    const status = snapshot?.status;
    if (status === 'running' && typeof snapshot?.sessionId === 'string' && snapshot.sessionId) {
      log(`  [${label}] 会话已建立（sessionId 已上报），可以发送控制消息`);
      return snapshot;
    }
    if (isTerminalStatus(status)) {
      throw new Error(
        `${label}: 任务在会话建立前进入终态 ${status}: ${redact(snapshot?.error ?? snapshot?.answer ?? '')}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: 等待会话建立超时（${SESSION_READY_TIMEOUT_MS}ms），当前状态 ${status}`);
    }
  }
}

/**
 * 启动任务（start_task）并返回 taskId。
 * @param {McpClient} client MCP 客户端
 * @param {object} args start_task 参数（task/cwd/model/permissionMode；任务级 timeoutSeconds 已移除，运行期限用全局 maxTaskSeconds）
 * @param {string} label 日志标签
 * @returns {Promise<string>} taskId
 */
async function startTask(client, args, label) {
  const payload = await client.callTool('start_task', args, MCP_FAST_TIMEOUT_MS);
  assert.ok(
    payload && typeof payload.taskId === 'string' && payload.taskId,
    `${label}: start_task 未返回 taskId`,
  );
  log(`  [${label}] 已启动任务 taskId=${payload.taskId}（入队时状态 ${payload.status}）`);
  return payload.taskId;
}

/**
 * 发送 steer 消息：单次调用 send_message，失败（业务错误/超时）直接向上抛出，
 * 当前步骤立即失败。刻意不自动重试——首次失败即视为故障，重试会造成重复插话，
 * 且"第二次成功"会掩盖 send_message 的真实问题。
 * @param {McpClient} client MCP 客户端
 * @param {string} taskId 任务 id
 * @param {string} message 消息文本
 * @param {string} label 日志标签（保留签名；失败路径由调用步骤统一报告）
 * @returns {Promise<object>} send_message 载荷（调用方校验 accepted === true）
 */
async function sendSteer(client, taskId, message, label) {
  void label; // 签名保留：失败信息本身已足够定位，不再在本函数内打日志
  return client.callTool('send_message', { taskId, message, mode: 'steer' }, CONTROL_CALL_TIMEOUT_MS);
}

/**
 * 温和中断任务：只走 interrupt_task 一条路径，并单独要求其回执成功（插件在
 * ack 成功后才会返回 status='cancelled'，见 index.js toolInterruptTask）。
 * 刻意不回退 cancel_task 强制取消——interrupt 失败就让测试失败，不得用
 * cancel 掩盖 interrupt 的缺陷。
 * @param {McpClient} client MCP 客户端
 * @param {string} taskId 任务 id
 * @param {string} label 日志标签
 * @returns {Promise<object>} interrupt_task 载荷（status === 'cancelled'）
 */
async function interruptTask(client, taskId, label) {
  // 业务失败（isError=true，如 agent.cancel 未回执）会直接抛出 → 当前步骤立即失败
  const payload = await client.callTool('interrupt_task', { taskId }, CONTROL_CALL_TIMEOUT_MS);
  assert.equal(
    payload?.status,
    'cancelled',
    `${label}: interrupt_task 回执未成功（status=${payload?.status}），测试失败，不回退 cancel_task`,
  );
  log(`  [${label}] interrupt_task 回执成功（温和中断，agent.cancel 已确认）`);
  return payload;
}

/**
 * 等待被中断任务的子进程释放（并发槽释放 = 子进程已退出），然后 continue_task
 * 续跑原会话。"previous task's dsh process has not exited yet" 类错误按可重试
 * 处理，其余错误直接抛出。
 * @param {McpClient} client MCP 客户端
 * @param {string} taskId 已取消的任务 id
 * @param {string} message 续跑指令
 * @param {string} label 日志标签
 * @returns {Promise<object>} continue_task 载荷（含新 taskId 与原 sessionId）
 */
async function continueWhenSubprocessReleased(client, taskId, message, label) {
  const deadline = Date.now() + CONTINUE_READY_TIMEOUT_MS;
  let lastError = '';
  for (;;) {
    try {
      const payload = await client.callTool('continue_task', { taskId, message }, MCP_FAST_TIMEOUT_MS);
      assert.ok(
        payload && typeof payload.taskId === 'string' && payload.taskId,
        `${label}: continue_task 未返回新 taskId`,
      );
      log(`  [${label}] 子进程已释放，continue_task 成功，新 taskId=${payload.taskId}`);
      return payload;
    } catch (err) {
      const messageText = redact(err?.message ?? String(err));
      lastError = messageText;
      const retryable =
        err?.isToolCallError === true &&
        (messageText.includes('not exited') || messageText.includes('concurrency slot'));
      if (!retryable) throw err;
      if (Date.now() > deadline) {
        throw new Error(`${label}: 等待子进程释放超时（${CONTINUE_READY_TIMEOUT_MS}ms），最后错误: ${lastError}`);
      }
      await sleep(2_000);
    }
  }
}

/**
 * 通过面板只读端点 GET /tasks/<id> 查询任务。桥接已取消鉴权：
 * 不带任何 cookie/凭证头，凭 URL 直连即可查询。
 * @param {number} port 宿主端口
 * @param {string} taskId 任务 id
 * @returns {Promise<object>} taskView
 */
async function fetchTaskViaPanel(port, taskId) {
  const { status, text } = await httpRequest({
    port,
    pathName: `${ROUTE_PATH}/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeoutMs: MCP_FAST_TIMEOUT_MS,
  });
  if (status !== 200) {
    throw new Error(`面板端点 GET /tasks/${taskId} 返回 HTTP ${status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`面板端点 GET /tasks/${taskId} 响应不是合法 JSON`);
  }
}

// ---------------------------------------------------------------------------
// 步骤执行框架
// ---------------------------------------------------------------------------
/**
 * 执行单个测试步骤：计时、打印标题与结果；失败时抛出（由 main 统一收尾）。
 * @param {number} index 步骤序号（从 1 开始）
 * @param {number} total 步骤总数
 * @param {string} name 步骤名
 * @param {() => Promise<void>} fn 步骤函数
 */
async function runStep(index, total, name, fn) {
  log(`──── [${index}/${total}] ${name} ────`);
  const startedAt = Date.now();
  await fn();
  log(`[OK] ${name}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/**
 * 端到端联调主流程。所有资源（宿主进程、临时目录）都记录在 resources 中，
 * 任何步骤失败都会经 finally 统一清理后再以非 0 退出码结束。
 */
async function main() {
  const totalSteps = 7;
  /** 需要在退出前清理的宿主进程（停止幂等）。@type {IsolatedHost[]} */
  const hosts = [];
  /** 本测试 mkdtemp 创建的临时根目录（清理前校验位置）。@type {string | null} */
  let tempRoot = null;

  try {
    // ---------------------------------------------------------------------
    // 步骤 1：解析真实环境 + 创建隔离临时目录
    // ---------------------------------------------------------------------
    let env = null; // 子进程环境变量（步骤 1 构造，宿主 A/B 共用）
    let workDir = null;
    let homeDir = null;

    await runStep(1, totalSteps, '准备隔离环境与真实配置解析', async () => {
      if (process.platform !== 'win32') {
        throw new Error('本测试面向 Windows 本机环境（taskkill/USERPROFILE 约定），当前平台不支持');
      }
      const exe = resolveHarnessExe();
      const realUserProfile = resolveRealUserProfile();
      const dshHome = resolveDshHome(realUserProfile);
      const desktopProfile = resolveDesktopProfile(realUserProfile);
      const dirs = makeIsolatedDirs();
      tempRoot = dirs.root;
      homeDir = dirs.home;
      workDir = dirs.work;

      // 子进程环境：只做增量覆盖，绝不设置/删除/重设 HOME 与 CODEX_HOME
      env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',     // 把 Electron exe 当纯 Node 运行
        USERPROFILE: homeDir,          // 插件状态（令牌/配置/历史）全部隔离到临时目录
        DSH_HOME: dshHome,             // 真实 DSH 数据目录（凭据复用；新会话可能写入运行数据，非绝对只读）
        DSH_PROFILE_DIR: desktopProfile, // 原 desktop profile（模型配置来源）
      };

      log(`Harness.exe: ${exe}`);
      log(`DSH_HOME（真实数据目录）: ${dshHome}`);
      log(`DSH_PROFILE_DIR（desktop profile）: ${desktopProfile}`);
      log(`临时目录: ${tempRoot}`);
      log(`子代理工作目录: ${workDir}`);
      log(`子代理模型: ${TASK_MODEL}`);
    });

    // 供后续步骤使用的共享对象
    const exePath = resolveHarnessExe(); // 步骤 1 已校验存在
    const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-host.mjs');
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`未找到 fixture-host.mjs: ${fixturePath}`);
    }
    /** 启动一个隔离宿主的快捷入口（复用步骤 1 构造的 env）。 */
    const startHost = async (label) => {
      const host = await IsolatedHost.start({
        exe: exePath,
        fixturePath,
        cwd: workDir,
        env,
        label,
      });
      hosts.push(host);
      log(`${label} 已启动，监听 127.0.0.1:${host.port}（pid=${host.child.pid}）`);
      return host;
    };

    // ---------------------------------------------------------------------
    // 步骤 2：启动隔离宿主 + MCP 握手 + tools/list 校验（1.5.0 工具集）
    // ---------------------------------------------------------------------
    let hostA = null;
    let clientA = null;

    await runStep(2, totalSteps, '启动隔离宿主并完成 MCP 握手与 tools/list 校验', async () => {
      hostA = await startHost('宿主A');
      clientA = new McpClient(hostA.port); // URL 直连，无需任何令牌

      const init = await withTimeout(clientA.initialize(), MCP_INIT_TIMEOUT_MS, 'MCP initialize');
      assert.equal(
        init?.serverInfo?.name,
        'dsh-subagent-bridge',
        `serverInfo.name 应为 dsh-subagent-bridge，实际 ${init?.serverInfo?.name}`,
      );
      assert.equal(
        init?.serverInfo?.version,
        EXPECTED_SERVER_VERSION,
        `serverInfo.version 应为 ${EXPECTED_SERVER_VERSION}，实际 ${init?.serverInfo?.version}`,
      );
      log(`  initialize 完成：serverInfo=${init.serverInfo.name}@${init.serverInfo.version}`);

      const toolNames = await withTimeout(clientA.listToolNames(), MCP_FAST_TIMEOUT_MS, 'tools/list');
      assert.deepEqual(
        [...toolNames].sort(),
        [...EXPECTED_TOOLS].sort(),
        `tools/list 应且仅为 1.5.0 所需工具集，实际 ${JSON.stringify(toolNames)}`,
      );
      log(`  tools/list 校验通过：${toolNames.length} 个工具齐全`);
    });

    // ---------------------------------------------------------------------
    // 步骤 3：steer —— 短任务 + 会话内引导 + 最终结果含唯一标记
    // ---------------------------------------------------------------------
    let steerTaskId = null;
    let steerMark = '';

    await runStep(3, totalSteps, 'steer：短任务注入引导消息并等待最终结果含唯一标记', async () => {
      steerMark = `DSH-LIVE-E2E-STEER-${randomBytes(4).toString('hex')}`;
      steerTaskId = await startTask(
        clientA,
        {
          task:
            '请完成两件事：\n' +
            '1. 用 shell 命令在当前工作目录创建文件 steer-probe.txt，内容写 ok（只允许在当前工作目录内操作）；\n' +
            '2. 创建成功后，回答算式 1+1 的结果。\n' +
            '不要读写其他位置的文件，不要执行其他命令。',
          cwd: workDir,
          model: TASK_MODEL,
          permissionMode: TASK_PERMISSION_WRITE,
        },
        'steer',
      );

      // 等任务 running 且 sessionId 上报后，立即注入 steer 消息（下一步骤生效）
      await waitForSessionReady(clientA, steerTaskId, 'steer');
      const sendPayload = await sendSteer(
        clientA,
        steerTaskId,
        `请在你的最终回答里原样包含标记 ${steerMark}。`,
        'steer',
      );
      assert.equal(sendPayload?.accepted, true, 'steer: send_message 应回执 accepted=true');
      log(`  [steer] steer 消息已被子代理确认（mode=${sendPayload.mode}）`);

      const snapshot = await waitForTaskTerminal(clientA, steerTaskId, STEER_TASK_TIMEOUT_MS, 'steer');
      assert.equal(
        snapshot.status,
        'completed',
        `steer: 任务应 completed，实际 ${snapshot.status}: ${redact(snapshot.error ?? '')}`,
      );
      assert.ok(
        typeof snapshot.answer === 'string' && snapshot.answer.includes(steerMark),
        `steer: 最终回答应包含标记 ${steerMark}，实际: ${clip(redact(snapshot.answer))}`,
      );
      log(`  [steer] 最终回答包含唯一标记 ✓（摘要: ${clip(redact(snapshot.answer), 120)}）`);
    });

    // ---------------------------------------------------------------------
    // 步骤 4：interrupt/continue —— 温和中断 + 子进程释放后续跑原会话
    // ---------------------------------------------------------------------
    let interruptedTaskId = null;
    let continuedTaskId = null;
    let continueMark = '';

    await runStep(4, totalSteps, 'interrupt 后 continue_task 续跑原会话', async () => {
      interruptedTaskId = await startTask(
        clientA,
        {
          task:
            '请用 shell 命令执行 sleep 45（如不可用则执行 PowerShell 的 Start-Sleep -Seconds 45），' +
            '等待结束后回答 done。只允许在当前工作目录内操作。',
          cwd: workDir,
          model: TASK_MODEL,
          permissionMode: TASK_PERMISSION_WRITE,
        },
        'interrupt',
      );

      await waitForSessionReady(clientA, interruptedTaskId, 'interrupt');
      // 验收要求：interrupt_task 的回执必须单独成功，失败即测试失败
      await interruptTask(clientA, interruptedTaskId, 'interrupt');

      const cancelled = await waitForTaskTerminal(
        clientA,
        interruptedTaskId,
        INTERRUPT_TASK_TIMEOUT_MS,
        'interrupt',
      );
      assert.equal(
        cancelled.status,
        'cancelled',
        `interrupt: 任务应 cancelled，实际 ${cancelled.status}`,
      );
      log(`  [interrupt] 任务已收尾为 cancelled（原因: ${clip(redact(cancelled.error ?? ''), 120)}）`);

      // 子进程退出（并发槽释放）后，用原 session 续跑：continue_task 返回新 taskId
      continueMark = `DSH-LIVE-E2E-CONT-${randomBytes(4).toString('hex')}`;
      const continuePayload = await continueWhenSubprocessReleased(
        clientA,
        interruptedTaskId,
        `先前的执行已被中断。现在不要执行任何命令、不要读写任何文件，直接回答：会话继续成功，标记 ${continueMark}。`,
        'continue',
      );
      continuedTaskId = continuePayload.taskId;
      assert.equal(
        continuePayload.sessionId,
        cancelled.sessionId,
        `continue: 续跑应复用原会话（${continuePayload.sessionId} vs ${cancelled.sessionId}）`,
      );

      const continued = await waitForTaskTerminal(clientA, continuedTaskId, CONTINUE_TASK_TIMEOUT_MS, 'continue');
      assert.equal(
        continued.status,
        'completed',
        `continue: 续跑任务应 completed，实际 ${continued.status}: ${redact(continued.error ?? '')}`,
      );
      assert.ok(
        typeof continued.answer === 'string' && continued.answer.includes(continueMark),
        `continue: 续跑回答应包含标记 ${continueMark}，实际: ${clip(redact(continued.answer))}`,
      );
      log(`  [continue] 原 session 续跑成功，回答包含唯一标记 ✓`);
    });

    // ---------------------------------------------------------------------
    // 步骤 5：read-only —— 只读任务尝试写文件必须被拦截
    // ---------------------------------------------------------------------
    let readonlyTaskId = null;

    await runStep(5, totalSteps, 'read-only：写入被拦截（completed + 回答明确报告被拒 + 文件未产生）', async () => {
      const blockedPath = path.join(workDir, 'write-should-be-blocked.txt');
      if (fs.existsSync(blockedPath)) fs.unlinkSync(blockedPath); // 确保探针起点干净

      // 唯一"写入被拒"标记：仅当代理实际尝试写入且被拒绝时才允许出现在回答中
      const roDeniedMark = `DSH-LIVE-E2E-RO-DENIED-${randomBytes(4).toString('hex')}`;
      readonlyTaskId = await startTask(
        clientA,
        {
          task:
            `请尝试把文本 blocked-write-probe 写入文件 ${blockedPath}（可以用任何可用的方式）。` +
            `如果这次写入尝试失败或被拒绝，请在你的最终回答里原样包含标记 ${roDeniedMark}，` +
            '并简要说明失败/被拒绝的原因；不要重试其他方式绕过，除此之外不要做其他事。',
          cwd: workDir,
          model: TASK_MODEL,
          permissionMode: 'read-only', // 只读档位：低于全局 workspace-write，允许指定
        },
        'readonly',
      );

      const snapshot = await waitForTaskTerminal(clientA, readonlyTaskId, READONLY_TASK_TIMEOUT_MS, 'readonly');
      // 判定一：任务必须 completed——failed/cancelled 一律不算通过
      assert.equal(
        snapshot.status,
        'completed',
        `readonly: 任务应 completed，实际 ${snapshot.status}: ${redact(snapshot.error ?? '')}`,
      );
      // 判定二：回答必须原样包含"写入被拒"标记——证明代理确实尝试了写入并
      // 明确报告尝试失败；仅凭"目标文件不存在"不构成写入被拦截的证据
      assert.ok(
        typeof snapshot.answer === 'string' && snapshot.answer.includes(roDeniedMark),
        `readonly: 回答应明确报告写入尝试失败（缺少标记 ${roDeniedMark}），实际: ${clip(redact(snapshot.answer))}`,
      );
      // 判定三：目标文件绝不允许真实存在——存在即说明 read-only 沙箱未生效
      assert.ok(
        !fs.existsSync(blockedPath),
        `read-only 沙箱未生效：文件已被实际写入: ${blockedPath}`,
      );
      log(`  [readonly] 任务 completed，回答明确报告写入被拒 ✓（摘要: ${clip(redact(snapshot.answer), 120)}）`);
      log(`  [readonly] 目标文件未真实产生（写入被拦截）✓`);
    });

    // ---------------------------------------------------------------------
    // 步骤 6：重启隔离宿主 —— 旧 taskId 与结果可查询（持久化验证）
    // ---------------------------------------------------------------------
    let hostB = null;
    let clientB = null;

    await runStep(6, totalSteps, '重启隔离宿主并验证旧 taskId 与结果可查询', async () => {
      // 6.1 确认没有排队/运行中的任务（保证重启前历史已全部落盘，强杀安全）
      const listBefore = await clientA.callTool('list_tasks', {}, MCP_FAST_TIMEOUT_MS);
      const activeTasks = (listBefore?.tasks ?? []).filter(
        (t) => t.status === 'queued' || t.status === 'running',
      );
      assert.equal(activeTasks.length, 0, `重启前应无 queued/running 任务，实际 ${activeTasks.length} 个`);

      // 6.2 停止宿主 A，随后用同一环境（同一 home → 同一份任务历史）重启
      await withTimeout(hostA.stop('重启验证'), HOST_STOP_TIMEOUT_MS + 5_000, '停止宿主A');
      const tasksFile = path.join(homeDir, '.dsh', 'subagent-bridge.tasks.json');
      assert.ok(fs.existsSync(tasksFile), '任务历史落盘文件应存在（重启可查询的前提）');

      hostB = await startHost('宿主B');
      clientB = new McpClient(hostB.port); // URL 直连：重启后同样无需任何令牌

      // 6.3 重启后 MCP 服务恢复：握手 + 工具集
      const init = await withTimeout(clientB.initialize(), MCP_INIT_TIMEOUT_MS, '重启后 initialize');
      assert.equal(init?.serverInfo?.version, EXPECTED_SERVER_VERSION, '重启后 serverInfo.version 应一致');
      const toolNames = await withTimeout(clientB.listToolNames(), MCP_FAST_TIMEOUT_MS, '重启后 tools/list');
      assert.deepEqual(
        [...toolNames].sort(),
        [...EXPECTED_TOOLS].sort(),
        '重启后工具集应完整',
      );

      // 6.4 旧 taskId 全部可查、状态一致
      const listAfter = await clientB.callTool('list_tasks', {}, MCP_FAST_TIMEOUT_MS);
      const byId = new Map((listAfter?.tasks ?? []).map((t) => [t.id, t]));
      for (const [oldId, expectedStatus] of [
        [steerTaskId, 'completed'],
        [interruptedTaskId, 'cancelled'],
        [continuedTaskId, 'completed'],
        [readonlyTaskId, null], // completed/failed 均可，只要求在列
      ]) {
        const entry = byId.get(oldId);
        assert.ok(entry, `重启后 list_tasks 应包含旧任务 ${oldId}`);
        if (expectedStatus) {
          assert.equal(entry.status, expectedStatus, `旧任务 ${oldId} 状态应保持 ${expectedStatus}`);
        }
      }
      log(`  [重启] list_tasks 包含全部 ${byId.size} 条历史，状态与重启前一致`);

      // 6.5 旧结果可查：wait_task 对终态任务立即返回快照（含 answer）
      const steerAgain = await clientB.callTool(
        'wait_task',
        { taskId: steerTaskId, timeoutSeconds: WAIT_POLL_SECONDS },
        WAIT_POLL_TIMEOUT_MS,
      );
      assert.equal(steerAgain?.status, 'completed', '重启后旧 steer 任务状态应保持 completed');
      assert.ok(
        typeof steerAgain?.answer === 'string' && steerAgain.answer.includes(steerMark),
        `重启后旧 steer 任务的 answer 应仍包含标记 ${steerMark}`,
      );
      const continuedAgain = await clientB.callTool(
        'wait_task',
        { taskId: continuedTaskId, timeoutSeconds: WAIT_POLL_SECONDS },
        WAIT_POLL_TIMEOUT_MS,
      );
      assert.ok(
        continuedAgain?.status === 'completed' &&
          String(continuedAgain?.answer ?? '').includes(continueMark),
        `重启后续跑任务的 answer 应仍包含标记 ${continueMark}`,
      );
      const cancelledAgain = await clientB.callTool(
        'wait_task',
        { taskId: interruptedTaskId, timeoutSeconds: WAIT_POLL_SECONDS },
        WAIT_POLL_TIMEOUT_MS,
      );
      assert.equal(cancelledAgain?.status, 'cancelled', '重启后中断任务状态应保持 cancelled');
      log('  [重启] 旧任务的 completed/cancelled 状态与 answer 均可查询 ✓');

      // 6.6 面板只读端点同样可查（URL 直连，无 cookie/凭证）
      const panelView = await withTimeout(
        fetchTaskViaPanel(hostB.port, steerTaskId),
        MCP_FAST_TIMEOUT_MS,
        '面板 GET /tasks/<id>',
      );
      assert.equal(panelView?.status, 'completed', '面板端点查询旧任务状态应一致');
      assert.ok(
        String(panelView?.answer ?? '').includes(steerMark),
        '面板端点查询旧任务 answer 应包含唯一标记',
      );
      log('  [重启] 面板只读端点 GET /tasks/<id> 查询旧任务成功 ✓');
    });

    // ---------------------------------------------------------------------
    // 步骤 7：清理（进程树 + 临时目录）
    // ---------------------------------------------------------------------
    await runStep(7, totalSteps, '清理：停止进程树并删除临时目录', async () => {
      // 进程：只停止本脚本 spawn 的隔离宿主（taskkill /T 仅覆盖该 pid 的进程
      // 树，即宿主与其 headless 子进程），不触碰环境中任何其他 DSH 进程
      for (const host of hosts) {
        await withTimeout(host.stop('测试结束'), HOST_STOP_TIMEOUT_MS + 5_000, `停止${host.label}`);
      }
      // 目录：只删除本脚本 mkdtemp 创建且经 assertInsideTempDir 校验的自有目录
      if (tempRoot) cleanupTempDir(tempDirSafe(tempRoot));
      log('清理完成：本测试创建的进程与临时目录均已移除');
    });

    log('══════ live-e2e 全部通过 ══════');
  } catch (err) {
    log(`══════ [FAIL] live-e2e 失败 ══════`);
    log(redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
    if (err instanceof Error && err.stack) {
      log(redact(err.stack.split('\n').slice(1, 4).join('\n')));
    }
    // 失败路径同样必须清理：停掉所有宿主进程树、删除临时目录
    for (const host of hosts) {
      try {
        await withTimeout(host.stop('测试失败收尾'), HOST_STOP_TIMEOUT_MS + 5_000, `停止${host.label}`);
      } catch (stopErr) {
        log(`[警告] 停止 ${host.label} 失败: ${redact(stopErr?.message ?? stopErr)}`);
      }
    }
    if (tempRoot) {
      try {
        cleanupTempDir(tempDirSafe(tempRoot));
      } catch {
        // cleanupTempDir 内部已告警
      }
    }
    process.exitCode = 1;
  }
}

/**
 * 防御性包装：确保进入清理函数的路径一定来自本会话 mkdtemp 的记录。
 * @param {string} root 临时根目录
 * @returns {string} 原样返回
 */
function tempDirSafe(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error(`临时目录记录异常，拒绝清理: ${String(root)}`);
  }
  return root;
}

main().catch((err) => {
  // main 内部已做过清理与退出码标记；这里只兜住意外抛出的异常
  log(`[致命] 未捕获异常: ${redact(err?.message ?? err)}`);
  process.exitCode = 1;
});
