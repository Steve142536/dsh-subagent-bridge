// ============================================================================
// @local/dsh-subagent-bridge — bridge-ipc.js
//
// 职责：Host 侧（父进程）对 headless 子代理 IPC 控制通道的封装。
//   - createControlChannel(child) 返回 { request, dispose }；
//   - request(...) 经 child.send 发送 dsh-subagent-control 协议消息，并等待
//     子进程内 headless-control.js 插件对同一 id 的 ok/error 回执；
//   - 并发请求各持唯一 id，靠在途表（pending Map）按 id 与回执一一匹配，
//     互不串扰；
//   - 发送失败、等待超时、child close/error/disconnect、dispose 均以明确的
//     reject 收场，绝不静默吞错、绝不自动重试（动作与输入的业务校验由外层
//     负责，本文件不重复校验也不重试）；
//   - close/error/disconnect 属不可逆的通道关闭：首次触发即把原因固化记录
//     并 reject 全部在途请求，此后所有新 request 立即以同一原因拒绝，绝不
//     依赖 connected 标志空等超时；
//   - 只消费 channel === 'dsh-subagent-control' 且 id 仍在等待中的回执；
//     其他 channel 的消息（含 Node 内部消息）、格式异常消息、迟到回执一律
//     静默忽略，不回复、不报错；
//   - 全程不打印任何请求输入与回执内容。
//
// 协议（与 headless-control.js 的约定一一对应，经 process IPC）：
//   请求：{ channel:'dsh-subagent-control', id, sessionId,
//           action:'steer'|'followup'|'interrupt', message? }
//   回执：{ channel:'dsh-subagent-control', id, ok:true }
//         { channel:'dsh-subagent-control', id, ok:false, error:'...' }
// ============================================================================

// 协议通道名：与 headless-control.js 约定的唯一标识，两侧必须一致
const CHANNEL = 'dsh-subagent-control';
// request 未显式传 timeoutMs 时的默认等待上限（毫秒）
const DEFAULT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// createControlChannel(child)：为单个带 IPC 通道的子进程创建控制通道。
// child 须是 child_process.spawn/fork 且 stdio 含 'ipc' 的子进程对象。
// 同步抛出（而非返回坏通道）当且仅当 child 不具备 IPC 能力或通道已断开——
// 这类输入错误必须当场暴露，绝不返回一个只会空等超时的假通道。
// ---------------------------------------------------------------------------
export function createControlChannel(child) {
  // child 必须能收发消息（on/off/send），否则无法承载本协议
  if (
    !child ||
    typeof child.send !== 'function' ||
    typeof child.on !== 'function' ||
    typeof child.off !== 'function'
  ) {
    throw new TypeError(
      'createControlChannel requires a child process with an IPC channel (send/on/off)',
    );
  }
  // IPC 通道已断开的 child 永远等不到回执：直接报错，不留隐患
  if (child.connected === false) {
    throw new Error('child process IPC channel is already disconnected');
  }

  // 在途请求表：id -> { resolve, reject, timer, settled }；并发请求各占一条，
  // 回执按 id 精确匹配到各自的 Promise
  const pending = new Map();
  // 请求 id 计数器：本通道内单调递增，保证 id 唯一
  let seq = 0;
  // dispose 标志：置位后一切新请求直接拒绝
  let disposed = false;
  // 不可逆的通道关闭原因：close/error/disconnect 首次触发时固化记录。
  // 非 null 表示通道已永久无法收发回执——在途请求全部 reject，此后一切新
  // 请求立即以此原因拒绝，不再依赖 connected 标志、也绝不空等超时。
  // dispose 是外层主动终止，不走这里（新请求由 disposed 标志拒绝）。
  let fatalReason = null;

  // 生成下一个请求 id：前缀标识协议来源，数字保证通道内唯一
  function nextRequestId() {
    return `ctl-${++seq}`;
  }

  // 结算单个请求（幂等）：清定时器、移出在途表，再以 resolve/reject 落定。
  // settled 标志防止回执、超时、通道失败、dispose 多方竞争下重复落定。
  function settle(entry, error) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    pending.delete(entry.id);
    if (error) entry.reject(error);
    else entry.resolve(undefined); // ok:true 回执不携带数据
  }

  // 通道级失败：close/error/disconnect 共用。首次触发即把原因固化为不可逆
  // 关闭记录（fatalReason，重复触发不覆盖），并 reject 全部在途请求；
  // 在途表已空时同样记录原因，天然幂等。
  function failAll(message) {
    if (fatalReason === null) {
      fatalReason = message;
    }
    for (const entry of [...pending.values()]) {
      settle(entry, new Error(message));
    }
  }

  // child 'message' 监听：只消费本协议且 id 仍在等待中的回执。
  // 其他 channel 的消息、非对象消息、未知 id / 迟到回执（如已超时或
  // dispose 后到达）一律静默忽略，不回复、不打印。
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.channel !== CHANNEL) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.ok === true) {
      settle(entry);
    } else {
      // ok:false 携带子进程内的失败原因文本，原样转成 Error reject
      settle(
        entry,
        new Error(
          typeof msg.error === 'string' && msg.error
            ? msg.error
            : 'control request failed',
        ),
      );
    }
  }

  // child 'close' 监听：进程退出且 stdio 全部收尾，通道不可逆关闭——固化
  // 原因供新请求立即拒绝，并 reject 全部在途请求（此后不可能再有回执）
  function onClose(code, signal) {
    failAll(
      `child process closed (code=${code ?? 'null'}, signal=${signal ?? 'null'}) before a control response arrived`,
    );
  }

  // child 'error' 监听：spawn/发送等错误，同样视为不可逆通道失败——固化
  // 原因并 reject 全部在途请求（此后通常还会触发 close，重复触发只保留
  // 首次记录的原因）
  function onError(err) {
    failAll(`child process error: ${err?.message ?? err}`);
  }

  // child 'disconnect' 监听：IPC 通道关闭，不可逆——固化原因并 reject
  // 全部在途请求
  function onDisconnect() {
    failAll('child process IPC channel disconnected');
  }

  // 注册通道级监听（dispose 时按引用精确移除自己的四个，不碰 child 上
  // 其他使用者的监听器）
  child.on('message', onMessage);
  child.on('close', onClose);
  child.on('error', onError);
  child.on('disconnect', onDisconnect);

  // dispose：停止本通道的一切活动——reject 全部在途请求、移除监听器
  // （请求各自的超时定时器已在 settle 里逐一清理）。这里只清在途请求、
  // 不写 fatalReason：dispose 是外层主动终止而非通道事件，新请求由 disposed
  // 标志拒绝，不可逆关闭原因只留给真实的 close/error/disconnect 记录。
  // 幂等：重复调用直接返回。不关闭 child 本身，子进程的生命周期归外层管理。
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of [...pending.values()]) {
      settle(entry, new Error('control channel disposed'));
    }
    child.off('message', onMessage);
    child.off('close', onClose);
    child.off('error', onError);
    child.off('disconnect', onDisconnect);
  }

  // request：发出一条控制指令并等待对应 id 的回执。
  // input 形如 { sessionId, action, message? }（sessionId/action 传字符串，
  // interrupt 可省略 message）；动作与输入的业务校验由外层负责，这里只做
  // 结构防御（input 必须是对象），非法参数明确 reject，绝不静默兜底。
  // timeoutMs 默认 10000：到点仍未收到回执即 reject 超时，此后迟到的回执
  // 因 id 已移出在途表而被忽略，绝不自动重试。
  // 成功（收到该 id 的 ok:true 回执）时 resolve undefined（回执不携带数据）。
  function request(input, timeoutMs = DEFAULT_TIMEOUT_MS) {
    // dispose 后通道已死：明确拒绝
    if (disposed) {
      return Promise.reject(new Error('control channel has been disposed'));
    }
    // 通道已不可逆关闭（close/error/disconnect 曾触发）：原因已固化记录，
    // 不会再有回执，立即以该原因拒绝——此时 connected 标志可能尚未翻转，
    // 若只依赖它新请求将空等到超时
    if (fatalReason !== null) {
      return Promise.reject(new Error(fatalReason));
    }
    if (!input || typeof input !== 'object') {
      return Promise.reject(new TypeError('request input must be an object'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new TypeError(
          `timeoutMs must be a positive finite number, got: ${String(timeoutMs)}`,
        ),
      );
    }
    // 兜底防御：connected 标志已翻转但未收到过 close/error/disconnect 事件
    // （如事件被外层吞掉）时同样当场拒绝，绝不空等超时
    if (child.connected === false) {
      return Promise.reject(new Error('child process IPC channel is not connected'));
    }

    return new Promise((resolve, reject) => {
      const id = nextRequestId();
      const entry = { id, resolve, reject, timer: null, settled: false };
      pending.set(id, entry);

      // 超时定时器：到点 settle（reject）；错误文本只含内部 id 与时长，
      // 不含任何请求内容
      entry.timer = setTimeout(() => {
        settle(
          entry,
          new Error(`control request timed out after ${timeoutMs}ms (id=${id})`),
        );
      }, timeoutMs);

      // 按协议组装消息；message 为 undefined 时（interrupt 无需文本）
      // 经 JSON 序列化自动省略该字段
      const payload = {
        channel: CHANNEL,
        id,
        sessionId: input.sessionId,
        action: input.action,
        message: input.message,
      };
      try {
        // child.send 的 callback 捕获异步发送失败（发送瞬间通道关闭等）；
        // 同步抛出的异常（通道已关闭等）由 catch 兜住。两条失败路径都
        // 明确 reject，绝不假装发送成功。
        child.send(payload, (err) => {
          if (err) {
            settle(
              entry,
              new Error(`failed to send control request: ${err?.message ?? err}`),
            );
          }
        });
      } catch (err) {
        settle(
          entry,
          new Error(`failed to send control request: ${err?.message ?? err}`),
        );
      }
    });
  }

  return { request, dispose };
}
