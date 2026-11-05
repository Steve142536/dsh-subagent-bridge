// ============================================================================
// @local/dsh-subagent-bridge — headless-control.js
//
// 职责：在 Host 进程内监听父进程经 IPC 发来的子代理控制指令，并路由到
// ctx.agents 中对应的会话代理：
//   - steer    ：向运行中的代理插话（引导当前进行中的回合）
//   - followup ：向运行中的代理追加一条用户消息，排到当前回合结束后的下一轮
//                执行；不是对已退出的进程发送（代理未运行时直接拒绝）
//   - interrupt：打断代理当前回合（保留收件箱中尚未消费的消息）
//
// 协议（父进程 → 本插件，经 process IPC）：
//   { channel:'dsh-subagent-control', id, sessionId,
//     action:'steer'|'followup'|'interrupt', message? }
// 本插件 → 父进程的应答（逐条对应，id 原样带回）：
//   { channel:'dsh-subagent-control', id, ok:true }
//   { channel:'dsh-subagent-control', id, ok:false, error:'...' }
//
// 约定：
// - channel 不是 'dsh-subagent-control' 的消息一律静默忽略（不回复、不报错），
//   避免干扰同一 IPC 通道上的其他协议（含 Node 内部消息）；
// - steer/followup/interrupt 仅当目标代理处于 running 时执行：一轮已结束、
//   子进程即将退出时，消息不会被消费、也没有回合可打断，此时必须回 ok:false
//   并给出明确错误，不虚报消息已接收或中断成功；运行中的代理行为保持不变；
// - 所有处理失败都会经 ok:false 反馈给父进程，绝不静默吞掉。
// ============================================================================

import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 控制协议通道名：父进程与本插件约定的唯一标识
const CHANNEL = 'dsh-subagent-control';
// 反馈给父进程的错误文本上限（异常堆栈可能极长，防止撑爆 IPC 消息）
const ERROR_TEXT_LIMIT = 2000;

// ---------------------------------------------------------------------------
// createUserMessage 的动态导入：
// Host 以 Electron（DeepSeek Harness.exe）方式运行，process.execPath 指向
// 安装目录里的可执行文件；@deepseek-ai/dsh-llm 打包在 resources/app.asar 内。
// Host 进程的 fs 能透读 asar，因此可以用 file:// URL 直接 import asar 内模块。
// 惰性导入并缓存：首次成功后复用；失败不缓存，下一条指令自动重试。
// ---------------------------------------------------------------------------
const DSH_LLM_URL = pathToFileURL(
  path.join(
    path.dirname(process.execPath),
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-llm',
    'lib',
    'index.js',
  ),
).href;

let createUserMessagePromise = null;

function loadCreateUserMessage() {
  if (!createUserMessagePromise) {
    createUserMessagePromise = import(DSH_LLM_URL)
      .then((mod) => {
        if (typeof mod?.createUserMessage !== 'function') {
          throw new Error('createUserMessage not found in @deepseek-ai/dsh-llm');
        }
        return mod.createUserMessage;
      })
      .catch((err) => {
        createUserMessagePromise = null; // 导入失败不缓存，允许下一条指令重试
        throw err;
      });
  }
  return createUserMessagePromise;
}

// 错误对象 → 可读文本：Error/类错误对象取 message，其余原样字符串化
function errorText(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

// 截断错误文本
function clampError(text) {
  const s = String(text ?? 'unknown error');
  return s.length > ERROR_TEXT_LIMIT ? s.slice(0, ERROR_TEXT_LIMIT) : s;
}

// ---------------------------------------------------------------------------
// apply：Cordis 插件入口
// ---------------------------------------------------------------------------
export function apply(ctx) {
  let disposed = false; // dispose 后不再向父进程发送任何回复

  // 向父进程回复；通道已断开或已 dispose 时静默放弃（彼时已无从反馈）
  function reply(payload) {
    if (disposed || !process.connected) return;
    try {
      process.send(payload);
    } catch {
      // 发送瞬间通道关闭：无法反馈，只能放弃
    }
  }

  // 单条控制指令的完整处理：校验 → 查 agent → 执行 → 回复。
  // 每个失败路径都经 fail() 把错误文本反馈给父进程。
  async function handleControlMessage(msg) {
    // 只认本协议的消息，其余一律静默忽略
    if (!msg || typeof msg !== 'object' || msg.channel !== CHANNEL) return;

    // id 原样带回；缺失/类型非法时以 id:null 应答失败（父进程按孤儿错误处理）
    const hasId =
      typeof msg.id === 'string' ||
      (typeof msg.id === 'number' && Number.isFinite(msg.id));
    const id = hasId ? msg.id : null;

    const fail = (error) =>
      reply({ channel: CHANNEL, id, ok: false, error: clampError(error) });
    const ok = () => reply({ channel: CHANNEL, id, ok: true });

    if (!hasId) return fail('invalid or missing id');

    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
    if (!sessionId) return fail('sessionId must be a non-empty string');

    const action = msg.action;
    if (action !== 'steer' && action !== 'followup' && action !== 'interrupt') {
      return fail(
        `action must be "steer", "followup" or "interrupt", got: ${String(action)}`,
      );
    }

    // steer/followup 必须携带非空文本；interrupt 不需要
    let message = null;
    if (action !== 'interrupt') {
      if (typeof msg.message !== 'string' || !msg.message.trim()) {
        return fail(`action "${action}" requires a non-empty string message`);
      }
      message = msg.message;
    }

    // 在 ctx.agents 服务里按 sessionId 查找会话代理
    const agents = ctx.agents;
    if (!agents || typeof agents.get !== 'function') {
      return fail('agents service is not available on this host context');
    }
    let agent;
    try {
      agent = agents.get(sessionId);
    } catch (err) {
      return fail(`agents.get(${sessionId}) failed: ${errorText(err)}`);
    }
    if (!agent) {
      return fail(`no agent found for sessionId: ${sessionId}`);
    }

    try {
      // 运行中前置校验：agent.status 不是 'running'（该轮已结束、子进程即将
      // 退出）时，steer/followup 的消息不会被消费、interrupt 无回合可打断，
      // 必须明确回 ok:false，不虚报消息已接收或中断成功；读取状态放在 try 内，
      // 万一取值抛异常也走统一的 fail 路径反馈给父进程。
      if (agent.status !== 'running') {
        const statusText =
          agent.status == null ? String(agent.status) : JSON.stringify(agent.status);
        return fail(
          `agent for sessionId "${sessionId}" is not running (status: ${statusText}); ` +
            `"${action}" is only accepted while the agent is running`,
        );
      }

      if (action === 'interrupt') {
        // 打断当前回合；keepInbox 保留收件箱中尚未消费的消息
        await agent.cancel({ kind: 'user' }, { keepInbox: true });
      } else {
        // steer/followup 都以"用户消息"为载体：先动态导入 dsh-llm 的工厂函数
        const createUserMessage = await loadCreateUserMessage();
        const userMessage = createUserMessage({
          content: [{ type: 'text', text: message }],
          source: { kind: 'user' },
        });
        // agent.steer（运行中插话，引导当前回合）或 agent.followup（运行中
        // 追加，排到当前回合后的下一轮执行；并非对已退出的进程发送——代理
        // 未运行时已被上方校验拒绝）
        await agent[action](userMessage);
      }
      return ok();
    } catch (err) {
      return fail(`${action} failed: ${errorText(err)}`);
    }
  }

  // process 'message' 回调：同步入口只负责把异步处理挂起来并兜住顶层异常，
  // 绝不让异常冒泡成宿主进程的 uncaughtException
  function onMessage(msg) {
    handleControlMessage(msg).catch((err) => {
      console.warn(`[dsh-subagent-control] unhandled message error: ${errorText(err)}`);
    });
  }

  // IPC 监听跟随插件生命周期：dispose 时移除监听并停止回复
  ctx.effect(() => {
    process.on('message', onMessage);
    return () => {
      disposed = true;
      process.off('message', onMessage);
    };
  }, 'dsh-subagent-control: process message listener');
}
