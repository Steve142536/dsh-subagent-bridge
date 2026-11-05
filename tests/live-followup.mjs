// ============================================================================
// tests/live-followup.mjs — send_message mode=followup 真实联测（手动运行）
//
// 用途：
//   验证 MCP 工具 send_message 的 mode="followup" 在真实链路上"下一轮真的被
//   执行"：用 DeepSeek Harness.exe 的 Electron Node 模式启动 tests/fixture-host.mjs
//   （插件真实激活、随机端口），以 MCP URL 直连（无令牌/无 cookie 凭证，桥接已
//   取消鉴权）调用 MCP，用
//   glm/glm-5.3-flash 启动一个真实的 headless DSH 任务；等任务 running 且上报
//   sessionId 后，发送 mode=followup 的消息（内含一次性唯一标记），断言回执
//   accepted=true；再等任务终态，断言最终回答包含该唯一标记——标记只存在于
//   followup 消息里（首轮任务文本绝不包含它），而任务 answer 取自最后一个
//   final 事件，因此"回答含标记"即证明 followup 确实作为下一轮被执行了。
//
// 运行方式（手动执行，不纳入自动化单测；不会真正跑单测）：
//   node tests/live-followup.mjs
//   可选环境变量：
//     DSH_ELECTRON_EXE     — DeepSeek Harness.exe 的绝对路径（默认自动探测）
//     DSH_HOME             — 真实 DSH 数据目录覆盖（默认 <真实USERPROFILE>/.dsh）
//     DSH_E2E_PROFILE_DIR  — desktop profile 目录覆盖（与 live-e2e 同名约定，
//                            默认 <真实USERPROFILE>/.dsh/profiles/desktop）
//
// 隔离性约定（务必维持）：
//   - 一切临时状态（插件配置/任务历史、子代理工作目录）都放在系统 TEMP
//     下 mkdtemp 创建的独立目录里；宿主与子代理的 USERPROFILE 指向其中的
//     home 子目录，插件状态与 codexSync（读 <USERPROFILE>/.codex/config.toml，
//     临时目录下不存在 → 自动 skipped）全部与真实用户配置隔离；
//   - 绝不设置、删除或重设 HOME / CODEX_HOME——保持原样继承；
//   - DSH_HOME 指向真实 DSH 数据目录（复用凭据；新会话可能产生自己的数据）；
//     DSH_PROFILE_DIR 显式
//     指向原 desktop profile（模型配置来源；不读当前环境变量的 DSH_PROFILE_DIR，
//     因为它可能指向 headless profile）；
//   - 只在测试临时工作目录内操作；绝不停止/重启任何既有 DSH 进程，只启动/
//     停止本脚本自己 spawn 的隔离宿主进程树；绝不调用 list_tasks 读取其他
//     任务，全程只查询本脚本自己启动的 taskId。
//
// 安全与健壮性约定：
//   - 桥接已取消鉴权：本测试不生成、不读取、不持有任何 MCP 令牌，全程以
//     URL 直连；诊断文本仍统一经 redact() 做防御性脱敏（64 位 hex 一律替换
//     为 <redacted>），保证意外混入的敏感串不会出现在日志里；
//   - 每一步（启动、握手、发送 followup、等待任务、进程停止、目录清理）都有
//     独立超时，失败立即明确报告并以非 0 退出码结束；
//   - 退出前（含失败路径）停止本脚本 spawn 的宿主进程树（taskkill /T /F 只
//     作用于本脚本的子进程 pid），并只清理"位于系统 TEMP 之下、由本脚本
//     mkdtemp 创建"的目录。
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
// 子代理模型：与主代理要求一致（provider/model 形式）
const TASK_MODEL = 'glm/glm-5.3-flash';
// 任务级权限：与插件全局默认（workspace → workspace-write）一致，只为行为确定
const TASK_PERMISSION_WRITE = 'workspace-write';
// 首轮任务里的等待秒数：给 followup 发送留出足够宽的"当前回合仍在进行"窗口
const FIRST_TURN_SLEEP_SECONDS = 20;
// 任务级超时（start_task 允许 60–604800 秒）
const TASK_TIMEOUT_SECONDS = 300;

// ---------- 超时预算 ----------
const HOST_START_TIMEOUT_MS = 60_000;      // 隔离宿主启动（Electron Node + 插件激活）上限
const HOST_STOP_TIMEOUT_MS = 20_000;       // 宿主进程树停止上限
const MCP_INIT_TIMEOUT_MS = 20_000;        // initialize 单次请求上限
const MCP_FAST_TIMEOUT_MS = 20_000;        // 一般瞬时工具调用上限
const WAIT_POLL_SECONDS = 10;              // wait_task 单次阻塞秒数（插件允许的最小值）
const WAIT_POLL_TIMEOUT_MS = 30_000;       // 单次 wait_task 请求超时（阻塞 10s + 余量）
const SESSION_READY_TIMEOUT_MS = 150_000;  // 等任务 running 且上报 sessionId 的上限
const CONTROL_CALL_TIMEOUT_MS = 30_000;    // send_message 回执上限（> 插件侧 ack 超时 15s）
const FOLLOWUP_TASK_TIMEOUT_MS = 300_000;  // followup 任务等终态上限

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

/**
 * 截断文本到指定长度（尾部省略），用于打印任务回答摘要等长文本。
 * @param {unknown} text 任意文本
 * @param {number} [limit] 最大保留字符数
 * @returns {string} 截断后的文本
 */
function clip(text, limit = 300) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}…(共 ${s.length} 字符)` : s;
}

// ---------------------------------------------------------------------------
// 通用异步工具
// ---------------------------------------------------------------------------
/** 睡眠指定毫秒。@param {number} ms 毫秒 @returns {Promise<void>} */
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
 * 否则探测本机默认安装位置（%LOCALAPPDATA%\Programs\DeepSeek Harness\）。
 * 宿主必须以它运行：插件 spawn headless 子代理时用的是 process.execPath
 * （即该 exe）+ ELECTRON_RUN_AS_NODE。找不到时明确报错。
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
 * 返回"真实用户目录"（本测试脚本自身运行环境的 USERPROFILE）。
 * 这是解析真实 DSH 数据目录与 desktop profile 的基准；宿主子进程的
 * USERPROFILE 会被指到临时目录，不影响这里的取值。
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
 * 解析当前已配置的 DSH 数据目录（作为宿主/子代理的 DSH_HOME，复用凭据，
 * 新会话可能产生自己的数据）。
 * 优先级：环境变量 DSH_HOME > <真实USERPROFILE>/.dsh；目录必须存在。
 * @param {string} realUserProfile 真实用户目录
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
 * 解析"原 desktop profile"目录（子代理模型配置 cordis.patch.yml 的来源）。
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
 *   <root>/home — 宿主与子代理的 USERPROFILE（插件令牌/配置/任务历史落在这里）
 *   <root>/work — 子代理任务工作目录（也是宿主进程的 cwd）
 * 返回前校验 root 确实位于系统 TEMP 之下（防 mkdtemp 语义被破坏）。
 * @returns {{ root: string, home: string, work: string }}
 */
function makeIsolatedDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-followup-'));
  assertInsideTempDir(root); // mkdtemp(os.tmpdir()) 正常时必然通过；失败立即中止
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return { root, home, work };
}

/**
 * 校验目录确实位于系统 TEMP 之下（双侧 realpath 归一化后做相对位置判断）。
 * 创建与清理前都要调用：本测试只允许触碰 TEMP 下的自有目录。
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
 * 执行 tests/fixture-host.mjs；宿主 stdout 唯一输出一行 {"port":<port>} JSON。
 * 停止时只强杀本进程树（taskkill /T /F 以本脚本子进程 pid 为限），
 * 绝不触碰机器上的任何其他 DSH 进程。
 */
class IsolatedHost {
  /**
   * @param {import('node:child_process').ChildProcess} child 宿主子进程
   * @param {string} label 日志标签
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
   * 启动隔离宿主并等待其端口输出（端口由操作系统随机分配）。
   * @param {object} opts
   * @param {string} opts.exe DeepSeek Harness.exe 路径
   * @param {string} opts.fixturePath tests/fixture-host.mjs 绝对路径
   * @param {string} opts.cwd 宿主进程工作目录（临时 work 目录）
   * @param {NodeJS.ProcessEnv} opts.env 宿主子进程环境变量
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

    // 解析 stdout：首个完整行必须是 {"port":<port>}；失败附带脱敏后的 stderr 尾部
    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;
      /** 一次性收口：成功 resolve 端口，失败 reject（附脱敏 stderr 尾部）。 */
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
      /** 累积 stdout 并解析首行 JSON 端口。@param {Buffer} chunk 输出块 */
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
   * 停止宿主进程树（幂等）。只针对本脚本 spawn 的 pid：
   * Windows 上用 taskkill /T /F 递归强杀（TerminateProcess 不会执行
   * fixture-host 的 SIGTERM 清理钩子；调用前保证任务已终态、历史已落盘）；
   * 非 Windows 回退 SIGTERM。等待退出，超时再补一次强杀确保最终一定退出。
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
 * 工具调用业务失败（result.isError === true）时抛出；
 * 携带 isToolCallError 标记便于调用方区分"业务失败"与"协议/网络错误"。
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
          clientInfo: { name: 'dsh-live-followup', version: '1.0.0' },
        },
      },
      MCP_INIT_TIMEOUT_MS,
    );
    if (!response || response.error) {
      throw new Error(`initialize 协议错误: ${JSON.stringify(response?.error ?? response)?.slice(0, 300)}`);
    }
    await this.rawRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      MCP_FAST_TIMEOUT_MS,
    );
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
// 任务等待与控制辅助
// ---------------------------------------------------------------------------
/** 是否为终态状态。@param {string} status 任务状态 @returns {boolean} */
function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * 启动任务（start_task）并返回 taskId。
 * @param {McpClient} client MCP 客户端
 * @param {object} args start_task 参数（task/cwd/model/permissionMode/timeoutSeconds）
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
 * 轮询 wait_task 直到任务进入终态（wait_task 本身每轮阻塞 10 秒）。
 * 运行中快照仅在状态/进度变化时打印，避免刷屏；同时记录观察到的最大
 * progress.turn（轮次计数），供"下一轮真的执行"的辅助诊断使用。
 * @param {McpClient} client MCP 客户端
 * @param {string} taskId 任务 id
 * @param {number} timeoutMs 总超时
 * @param {string} label 日志标签
 * @returns {Promise<{ snapshot: object, maxTurn: number | null }>} 终态快照与观察到的最大轮次
 */
async function waitForTaskTerminal(client, taskId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let maxTurn = null; // 观察到的最大 progress.turn（轮次可能从 0 或 1 计数，不做假设）
  let lastKey = '';
  for (;;) {
    const snapshot = await client.waitTaskOnce(taskId);
    const progress = snapshot?.progress;
    const turn = progress?.turn;
    if (Number.isFinite(turn) && (maxTurn === null || turn > maxTurn)) maxTurn = turn;
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
    if (isTerminalStatus(snapshot?.status)) return { snapshot, maxTurn };
    if (Date.now() > deadline) {
      throw new Error(`${label}: 等待任务终态超时（${timeoutMs}ms），当前状态 ${snapshot?.status}`);
    }
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
 * followup 真实联测主流程。所有资源（宿主进程、临时目录）统一记录，
 * 任何步骤失败都会经 finally 停止宿主进程树并清理临时目录后再退出。
 */
async function main() {
  const totalSteps = 4;
  /** 需要在退出前清理的宿主进程（停止幂等）。@type {IsolatedHost[]} */
  const hosts = [];
  /** 本测试 mkdtemp 创建的临时根目录（清理前校验位置）。@type {string | null} */
  let tempRoot = null;
  /** 是否全部步骤通过（用于 finally 里区分成功/失败收尾日志）。 */
  let passed = false;

  try {
    // ---------------------------------------------------------------------
    // 步骤 1：解析真实环境 + 创建隔离临时目录
    // ---------------------------------------------------------------------
    let harnessExe = null;  // DeepSeek Harness.exe 绝对路径（步骤 2 启动宿主用）
    let env = null;         // 宿主子进程环境变量
    let workDir = null;     // 子代理任务工作目录（也是宿主 cwd）

    await runStep(1, totalSteps, '准备隔离环境与真实配置解析', async () => {
      if (process.platform !== 'win32') {
        throw new Error('本测试面向 Windows 本机环境（taskkill/USERPROFILE 约定），当前平台不支持');
      }
      harnessExe = resolveHarnessExe();
      const realUserProfile = resolveRealUserProfile();
      const dshHome = resolveDshHome(realUserProfile);
      const desktopProfile = resolveDesktopProfile(realUserProfile);
      const dirs = makeIsolatedDirs();
      tempRoot = dirs.root;
      workDir = dirs.work;

      // 宿主子进程环境：只做增量覆盖，绝不设置/删除/重设 HOME 与 CODEX_HOME。
      // USERPROFILE 指向临时 home → 插件配置/任务历史全部隔离；
      // DSH_HOME 复用真实数据目录（凭据只读）；DSH_PROFILE_DIR 指向原
      // desktop profile（子代理模型配置来源）。
      env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        USERPROFILE: dirs.home,
        DSH_HOME: dshHome,
        DSH_PROFILE_DIR: desktopProfile,
      };

      log(`Harness.exe: ${harnessExe}`);
      log(`DSH_HOME（真实数据目录）: ${dshHome}`);
      log(`DSH_PROFILE_DIR（desktop profile）: ${desktopProfile}`);
      log(`临时目录: ${tempRoot}`);
      log(`子代理工作目录: ${workDir}`);
      log(`子代理模型: ${TASK_MODEL}`);
    });

    // ---------------------------------------------------------------------
    // 步骤 2：启动隔离宿主 + MCP 握手（URL 直连）
    // ---------------------------------------------------------------------
    let client = null;

    await runStep(2, totalSteps, '启动隔离宿主并完成 MCP 握手', async () => {
      const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-host.mjs');
      if (!fs.existsSync(fixturePath)) {
        throw new Error(`未找到 fixture-host.mjs: ${fixturePath}`);
      }
      const host = await IsolatedHost.start({
        exe: harnessExe,
        fixturePath,
        cwd: workDir,
        env,
        label: '隔离宿主',
      });
      hosts.push(host);
      log(`隔离宿主已启动，监听 127.0.0.1:${host.port}（pid=${host.child.pid}）`);

      client = new McpClient(host.port); // URL 直连，无需任何令牌

      const init = await withTimeout(client.initialize(), MCP_INIT_TIMEOUT_MS, 'MCP initialize');
      assert.equal(
        init?.serverInfo?.name,
        'dsh-subagent-bridge',
        `serverInfo.name 应为 dsh-subagent-bridge，实际 ${init?.serverInfo?.name}`,
      );
      log(`  initialize 完成：serverInfo=${init.serverInfo.name}@${init.serverInfo.version}`);
    });

    // ---------------------------------------------------------------------
    // 步骤 3：启动真实任务，等 running + sessionId 后发送 followup 并断言回执
    // ---------------------------------------------------------------------
    let followupTaskId = null;
    let followupMark = '';
    let turnAtSend = null; // 发送 followup 时观察到的轮次（诊断用，可能为 null）

    await runStep(3, totalSteps, '启动真实任务并在运行中发送 followup', async () => {
      // 唯一标记在任务启动之后才生成：首轮任务文本不可能包含它，
      // 最终回答里出现标记只能是 followup 消息带来的
      followupMark = `DSH-LIVE-FOLLOWUP-${randomBytes(6).toString('hex')}`;
      followupTaskId = await startTask(
        client,
        {
          // 首轮任务：先等待一段固定时间再回答，保证"当前回合仍在进行"的
          // 窗口足够宽；任务文本刻意不包含任何标记
          task:
            `请先执行一条 shell 命令 sleep ${FIRST_TURN_SLEEP_SECONDS}` +
            `（如不可用则执行 PowerShell 的 Start-Sleep -Seconds ${FIRST_TURN_SLEEP_SECONDS}），` +
            '等待结束后回答：第一阶段完成。\n' +
            '只允许在当前工作目录内操作，不要读写其他位置的文件，不要执行其他命令。',
          cwd: workDir,
          model: TASK_MODEL,
          permissionMode: TASK_PERMISSION_WRITE,
          timeoutSeconds: TASK_TIMEOUT_SECONDS,
        },
        'followup',
      );

      // 等任务 running 且 sessionId 上报后，立即发送 followup
      const ready = await waitForSessionReady(client, followupTaskId, 'followup');
      turnAtSend = Number.isFinite(ready?.progress?.turn) ? ready.progress.turn : null;
      log(`  [followup] 发送前轮次 turn=${turnAtSend ?? '-'}，标记 ${followupMark}`);
      // 只发送一次、失败即失败：不做自动重试，避免重复插话与掩盖故障
      const sendPayload = await client.callTool(
        'send_message',
        {
          taskId: followupTaskId,
          mode: 'followup',
          message:
            `这是追加的后续请求：请在你的最终回答里原样包含标记 ${followupMark}。` +
            '不要执行任何命令、不要读写任何文件，直接回答即可。',
        },
        CONTROL_CALL_TIMEOUT_MS,
      );
      // 回执硬断言：accepted=true 且 mode 回显为 followup（等子代理 ack 后才返回）
      assert.equal(
        sendPayload?.accepted,
        true,
        `followup: send_message 应回执 accepted=true，实际 ${JSON.stringify(sendPayload ?? null).slice(0, 200)}`,
      );
      assert.equal(
        sendPayload?.mode,
        'followup',
        `followup: 回执 mode 应为 followup，实际 ${sendPayload?.mode}`,
      );
      log('  [followup] 子代理已确认接收（accepted=true, mode=followup），消息将作为下一轮执行');
    });

    // ---------------------------------------------------------------------
    // 步骤 4：等待任务终态，断言最终回答包含唯一标记（下一轮真的被执行）
    // ---------------------------------------------------------------------
    await runStep(4, totalSteps, '等待任务完成并验证最终回答包含唯一标记', async () => {
      const { snapshot, maxTurn } = await waitForTaskTerminal(
        client,
        followupTaskId,
        FOLLOWUP_TASK_TIMEOUT_MS,
        'followup',
      );
      assert.equal(
        snapshot.status,
        'completed',
        `followup: 任务应 completed，实际 ${snapshot.status}: ${redact(snapshot.error ?? '')}`,
      );

      // 轮次诊断（辅助信号，不做硬断言）：followup 作为"下一轮"执行时，
      // 等待期间观察到的最大轮次应超过发送时刻的轮次；个别运行可能因
      // status 事件窗口错过而观察不到，此时以下方标记断言为准。
      if (turnAtSend !== null && maxTurn !== null) {
        if (maxTurn > turnAtSend) {
          log(`  [followup] 轮次已从 ${turnAtSend} 推进到 ${maxTurn}（观察到下一轮执行）✓`);
        } else {
          log(`  [followup] [提示] 未观察到轮次递增（发送时 ${turnAtSend}，最大 ${maxTurn}），以标记断言为准`);
        }
      }

      // 硬断言：最终回答（最后一个 final 事件）必须包含 followup 的唯一标记。
      // 标记只存在于 followup 消息里，出现即证明排队消息确实作为下一轮执行了。
      assert.ok(
        typeof snapshot.answer === 'string' && snapshot.answer.includes(followupMark),
        `followup: 最终回答应包含唯一标记 ${followupMark}（说明下一轮未被执行），` +
          `实际: ${clip(redact(snapshot.answer))}`,
      );
      log(`  [followup] 最终回答包含唯一标记 ✓（下一轮确实被执行；摘要: ${clip(redact(snapshot.answer), 160)}）`);
      passed = true;
    });
  } catch (err) {
    log('══════ [FAIL] live-followup 失败 ══════');
    log(redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
    if (err instanceof Error && err.stack) {
      log(redact(err.stack.split('\n').slice(1, 4).join('\n')));
    }
    // 失败时附带宿主 stderr 尾部诊断（已脱敏，且在停止宿主前采集），
    // 便于人工排查插件激活/宿主启动阶段的问题
    for (const host of hosts) {
      const diag = host.diagnostics();
      if (diag) log(`${host.label} stderr 尾部: ${clip(diag, 600)}`);
    }
    process.exitCode = 1;
  } finally {
    // 成功与失败路径都必须收尾：停止本脚本 spawn 的宿主进程树（只针对自己的
    // pid），并只清理位于系统 TEMP 之下、由本脚本 mkdtemp 创建的临时目录
    for (const host of hosts) {
      try {
        await withTimeout(host.stop(passed ? '测试结束' : '测试失败收尾'), HOST_STOP_TIMEOUT_MS + 5_000, `停止${host.label}`);
      } catch (stopErr) {
        log(`[警告] 停止 ${host.label} 失败: ${redact(stopErr?.message ?? stopErr)}`);
      }
    }
    if (tempRoot) {
      try {
        cleanupTempDir(tempRoot);
      } catch {
        // cleanupTempDir 内部已告警
      }
    }
    if (passed) {
      log('══════ live-followup 全部通过（宿主进程与临时目录已清理）══════');
    }
  }
}

main().catch((err) => {
  // main 内部已做过清理与退出码标记；这里只兜住意外抛出的异常
  log(`[致命] 未捕获异常: ${redact(err?.message ?? err)}`);
  process.exitCode = 1;
});
