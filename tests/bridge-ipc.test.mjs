// ============================================================================
// tests/bridge-ipc.test.mjs — bridge-ipc.js 控制通道（createControlChannel）单元测试
//
// 被测契约（只测可观察行为，不镜像实现细节）：
// bridge-ipc.js 导出 createControlChannel(child)：把一个带 IPC 通道的
// child_process 子进程包装成"控制通道"。调用方发起请求即得到 Promise，
// 子进程经 IPC 回执后按请求 id 兑现对应请求。覆盖以下行为面：
//   1. 并发请求按 id 匹配：不同请求 id 的回执一一对应，乱序到达也必须
//      兑现各自的请求；无关消息（其他通道/未知 id）不得错配任何请求。
//   2. 回执 ok:false → 请求以错误拒绝，协议错误文本必须到达调用方。
//   3. 发送失败（child.send 同步抛错 / 回调报错）→ 请求拒绝，绝不静默挂起。
//   4. 通道断连/子进程退出（child 'disconnect' / 'close' 事件）→ 所有在途
//      请求立即拒绝，通道死亡后的新请求也立即拒绝。
//   5. 短超时：request 显式传入短 timeoutMs 时，回执迟迟不来也按该短超时
//      快速拒绝，迟到的回执被安全忽略。
//   6. dispose：在途请求拒绝、后续请求立即拒绝、迟到回执无害、可重复调用。
//
// 模拟方式：
//   用 node:events 的 EventEmitter 派生 FakeChild 模拟子进程的 IPC 面：
//   - send(message, callback)：记录发出的消息（测试据此构造回执）；
//   - connected：与 child_process.ChildProcess 语义一致，断连后为 false；
//   - child.emit('message' | 'close' | 'disconnect', ...) 模拟子进程方向
//     的事件到达。
//   回执统一用"原请求消息 + ok/error 字段"构造：协议（headless-control.js
//   顶部注释，即本通道的对端实现）只约定回执按 id 原样带回并附带
//   ok:true / ok:false(+error)，因此测试不硬编码请求内部字段的形状，
//   也不假设回执处理依赖哪些字段。
//
// 隔离性约定：不触碰文件系统与全局配置，不起真实子进程，不修改被测模块。
// 每个用例自建独立的 FakeChild 与通道，互不干扰；用例兜底超时（node:test
// 的 timeout）保证被测行为若意外挂起时测试按超时失败，绝不卡死整个运行。
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createControlChannel } from '../bridge-ipc.js';

// ---------- 测试常量 ----------
// 常规用例请求的兜底超时（request 的第二参数 timeoutMs）：足够让回执路径
// 从容完成，又不至于在异常挂起时拖住进程太久（真实实现结算请求时应清理
// 自己的定时器；即便漏清，也只拖 1 秒）。
const DEFAULT_TIMEOUT_MS = 1000;
// 短超时用例传给 request 的超时：极小值，专门验证"超时路径真的会触发"；
// 用例失败时请求也只会在该量级内结算，不会把默认级长定时器留在事件循环里。
const SHORT_TIMEOUT_MS = 20;
// 每个用例的 node:test 兜底超时（毫秒）：被测行为若挂起，测试按超时失败。
const CASE_TIMEOUT_MS = 2000;

// ---------- 模拟对象 ----------
/**
 * 模拟子进程：child_process.ChildProcess 的 IPC 面（send + connected + 事件）。
 * 继承 EventEmitter，测试用 child.emit(...) 模拟来自子进程方向的事件。
 */
class FakeChild extends EventEmitter {
  /** 与真实 ChildProcess 一致：true 表示 IPC 通道仍然连接。 */
  connected = true;

  /** 记录所有经 send 发出的消息（测试据此取请求 id 构造对应回执）。 */
  sent = [];

  /**
   * @param {(message: unknown, callback: (err: Error | null) => void) => boolean} [sendImpl]
   *        可选的 send 行为覆写：默认记录消息并异步以 null 调用回调（成功）。
   *        失败类用例用它注入"同步抛错""回调报错"等发送失败形态。
   */
  constructor(sendImpl = null) {
    super();
    this.sendImpl = sendImpl;
  }

  /**
   * 模拟 child_process 的 subprocess.send(message[, callback])：
   * 先记录消息（供回执匹配），再按覆写行为或默认成功路径执行。
   */
  send(message, callback) {
    this.sent.push(message);
    if (this.sendImpl) return this.sendImpl(message, callback);
    if (typeof callback === 'function') queueMicrotask(() => callback(null));
    return true;
  }
}

// ---------- 辅助函数 ----------
/**
 * 打开被测控制通道。真实 API：createControlChannel(child) 只接受 child 一个
 * 参数；超时是 request(payload, timeoutMs) 的第二参数，不是通道级选项——
 * 因此这里绝不向 createControlChannel 传第二参数。包装 request 的目的：
 * 调用方不显式传 timeoutMs 时统一给每个请求挂 DEFAULT_TIMEOUT_MS 兜底，
 * 用例失败（回执不到）时请求至多拖 1 秒即拒绝结算，不会把实现默认的
 * 10 秒定时器留在事件循环里。
 * @param {FakeChild} child 模拟子进程
 */
function openChannel(child) {
  const channel = createControlChannel(child);
  return {
    request: (payload, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      channel.request(payload, timeoutMs),
    dispose: () => channel.dispose(),
  };
}

/**
 * 构造一条合法的控制请求载荷：字段形状取自协议对端（headless-control.js
 * 顶部注释）；channel/id 由通道自己补充，测试不代劳、不断言其内容。
 */
function controlPayload(action, sessionId) {
  return { action, sessionId, message: `msg-${sessionId}` };
}

/**
 * 取出请求消息的 id：协议约定回执按该 id 原样带回（headless-control.js）。
 * 测试只读该字段用于构造对应回执，不断言请求消息的其他内容。
 */
function requestIdOf(sentMessage) {
  return sentMessage.id;
}

/**
 * 模拟子进程回执"成功"：回执 = 原请求消息 + ok:true。
 * 复用请求消息可保证 channel/id 等字段与实现约定天然一致，无需硬编码。
 */
function replyOk(child, sentMessage) {
  child.emit('message', { ...sentMessage, ok: true });
}

/**
 * 模拟子进程回执"失败"：回执 = 原请求消息 + ok:false + error 文本。
 */
function replyFail(child, sentMessage, error) {
  child.emit('message', { ...sentMessage, ok: false, error });
}

/**
 * 等事件循环转一圈：让已排队的微任务与 immediates 执行完，用于断言
 * "某副作用已发生"或"某 Promise 在此之前仍未结算"。
 */
function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// 并发回执匹配（按请求 id 一一对应）
// ---------------------------------------------------------------------------
test('并发请求按 id 匹配：乱序到达的回执逐一兑现对应请求', { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);

  // 同时发起三个请求（不等待），模拟并发控制面流量；三个请求的载荷各不相同。
  const p1 = channel.request(controlPayload('steer', 's1'));
  const p2 = channel.request(controlPayload('followup', 's2'));
  const p3 = channel.request(controlPayload('interrupt', 's3'));
  await nextTurn();

  // 三个请求都已发出，且 id 互不相同——否则回执无法按 id 区分请求。
  assert.equal(child.sent.length, 3);
  const ids = child.sent.map(requestIdOf);
  assert.equal(new Set(ids).size, 3, '并发请求的 id 必须互不相同');

  // 回执乱序到达：先成功第 3 个，再失败第 1 个，最后成功第 2 个。
  // 每个请求必须只被自己的回执兑现，与回执到达顺序无关。
  replyOk(child, child.sent[2]);
  await p3;

  replyFail(child, child.sent[0], 'steer rejected: s1 offline');
  await assert.rejects(p1, (err) =>
    String(err?.message ?? err).includes('steer rejected: s1 offline'),
  );

  replyOk(child, child.sent[1]);
  await p2;

  channel.dispose();
});

// ---------------------------------------------------------------------------
// ok:false 错误回执
// ---------------------------------------------------------------------------
test('ok:false 回执 → 请求以协议错误文本拒绝', { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);
  const pending = channel.request(controlPayload('steer', 's9'));
  await nextTurn();

  // 对端按协议回 ok:false 并携带 error 文本：该文本必须到达调用方，
  // 这是调用方唯一的失败诊断来源（可观察契约，不锁错误对象的具体形状）。
  replyFail(child, child.sent[0], 'no agent found for sessionId: s9');
  await assert.rejects(pending, (err) =>
    String(err?.message ?? err).includes('no agent found for sessionId: s9'),
  );

  channel.dispose();
});

// ---------------------------------------------------------------------------
// 发送失败
// ---------------------------------------------------------------------------
test('child.send 同步抛异常 → 请求以拒绝收场，不向外抛同步错误', { timeout: CASE_TIMEOUT_MS }, async () => {
  // send 一被调用就同步抛错（管道断裂等异常形态）：
  // 请求必须变成 rejected promise，而不是让异常同步打断调用方控制流。
  const child = new FakeChild(() => {
    throw new Error('send: EPIPE');
  });
  const channel = openChannel(child);

  await assert.rejects(() => channel.request(controlPayload('steer', 's1')), /EPIPE/);

  channel.dispose();
});

test('child.send 回调报错（IPC 通道关闭的标准形态）→ 请求拒绝', { timeout: CASE_TIMEOUT_MS }, async () => {
  // 模拟 Node IPC 的另一种标准失败形态：send 返回 false（背压/关闭），
  // 稍后回调收到 Error。请求同样必须拒绝，绝不静默挂到超时。
  const child = new FakeChild((message, callback) => {
    queueMicrotask(() => callback(new Error('channel closed')));
    return false;
  });
  const channel = openChannel(child);

  await assert.rejects(() => channel.request(controlPayload('followup', 's2')), /channel closed/);

  channel.dispose();
});

// ---------------------------------------------------------------------------
// 断连 / 子进程退出时拒绝在途请求
// ---------------------------------------------------------------------------
test("child 'disconnect' 断连 → 在途请求全部立即拒绝，新请求也立即拒绝", { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);
  const p1 = channel.request(controlPayload('steer', 's1'));
  const p2 = channel.request(controlPayload('interrupt', 's2'));
  await nextTurn();

  // IPC 通道断开：与真实 ChildProcess 一致，connected 翻转为 false，
  // 随后 'disconnect' 事件到达。所有在途请求必须立即拒绝（绝不挂到超时）。
  child.connected = false;
  child.emit('disconnect');
  await assert.rejects(p1);
  await assert.rejects(p2);

  // 通道已死：新请求必须立即拒绝，且不得再向 child.send 发出任何消息。
  const sentBefore = child.sent.length;
  await assert.rejects(() => channel.request(controlPayload('steer', 's3')));
  assert.equal(child.sent.length, sentBefore, '断连后不得再发出新的 send');

  channel.dispose();
});

test("child 'close' 子进程退出 → 在途请求全部立即拒绝", { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);
  const pending = channel.request(controlPayload('followup', 's4'));
  await nextTurn();

  // 子进程退出（'close' 事件，退出码仅为参数形状示意）：
  // 在途请求失去对端，必须立即拒绝。
  child.emit('close', 1);
  await assert.rejects(pending);

  channel.dispose();
});

// ---------------------------------------------------------------------------
// 通道死亡后的新请求（connected 尚未翻转的窗口）
// ---------------------------------------------------------------------------
// 真实 ChildProcess 上 'close'/'error' 事件到达与 connected 字段翻转之间
// 存在窗口（某些错误路径下字段甚至可能一直保持 true）。通道一旦确认对端
// 已死就必须记住这一状态：此后新建的请求应立即以"通道已关闭"类错误拒绝，
// 绝不空等超时。两个用例都给请求挂 SHORT_TIMEOUT_MS：若实现漏判该状态，
// 请求只会在 20ms 量级内走完超时路径——既不拖默认超时，也不留长定时器；
// 兜底 catch 保证这种迟到拒绝不会变成未处理拒绝。
test("child 'close' 已触发且 connected 未变 → 新请求立即以通道已关闭错误拒绝", { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);

  // 模拟窗口状态：'close' 已到达（进程退出），但 connected 仍为 true。
  child.emit('close', 1, null);
  await nextTurn();

  const pending = channel.request(controlPayload('steer', 's6'), SHORT_TIMEOUT_MS);
  pending.catch(() => {}); // 兜底：实现有 bug 时，迟到拒绝也不得成为未处理拒绝
  const settledWithinTurn = await Promise.race([
    pending.then(
      () => true,
      () => true,
    ),
    nextTurn().then(() => false),
  ]);
  assert.ok(settledWithinTurn, 'close 后的新请求应在事件循环一转内立即拒绝');

  // 拒绝原因必须是"通道已关闭"类，而不是超时——否则说明请求空等了。
  await assert.rejects(pending, (err) => {
    const text = String(err?.message ?? err);
    assert.doesNotMatch(text, /timed out/i);
    return /closed/i.test(text);
  });

  channel.dispose();
});

test("child 'error' 已触发且 connected 未变 → 新请求立即以通道错误拒绝", { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);

  // 模拟窗口状态：'error' 已到达（如 spawn 失败），但 connected 仍为 true。
  child.emit('error', new Error('spawn failed'));
  await nextTurn();

  const pending = channel.request(controlPayload('followup', 's8'), SHORT_TIMEOUT_MS);
  pending.catch(() => {}); // 兜底：实现有 bug 时，迟到拒绝也不得成为未处理拒绝
  const settledWithinTurn = await Promise.race([
    pending.then(
      () => true,
      () => true,
    ),
    nextTurn().then(() => false),
  ]);
  assert.ok(settledWithinTurn, 'error 后的新请求应在事件循环一转内立即拒绝');

  // 拒绝原因必须是通道错误，而不是超时——否则说明请求空等了。
  await assert.rejects(pending, (err) => {
    const text = String(err?.message ?? err);
    assert.doesNotMatch(text, /timed out/i);
    return /error/i.test(text);
  });

  channel.dispose();
});

// ---------------------------------------------------------------------------
// 短超时
// ---------------------------------------------------------------------------
test('短超时：回执不到 → 快速拒绝，迟到回执被安全忽略', { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);
  // 超时是 request 的第二参数（真实 API），不是 createControlChannel 的选项：
  // 显式传 SHORT_TIMEOUT_MS，回执不到时请求必须在 20ms 量级内拒绝，
  // 而不是空等实现默认的 10 秒超时。
  const pending = channel.request(controlPayload('steer', 's5'), SHORT_TIMEOUT_MS);
  const startedAt = Date.now();

  // 不回执：请求必须在短超时量级内拒绝（远小于用例兜底超时），
  // 证明传入的短超时真的生效，而不是退回某个默认长超时。
  await assert.rejects(pending);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `应在短超时内拒绝，实际耗时 ${elapsed}ms`);

  // 迟到的回执不得造成任何副作用（崩溃 / 未处理拒绝）：
  // 请求已在超时处结算，通道应安全丢弃它。
  replyOk(child, child.sent[0]);
  await nextTurn();

  channel.dispose();
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------
test('dispose：在途请求拒绝、后续请求立即拒绝、迟到回执无害、可重复调用', { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);
  const p1 = channel.request(controlPayload('steer', 's1'));
  const p2 = channel.request(controlPayload('followup', 's2'));
  await nextTurn();

  // dispose 时所有在途请求必须立即拒绝。
  channel.dispose();
  await assert.rejects(p1);
  await assert.rejects(p2);

  // dispose 后通道不再可用：新请求立即拒绝，且不产生新的 send。
  const sentBefore = child.sent.length;
  await assert.rejects(() => channel.request(controlPayload('steer', 's3')));
  assert.equal(child.sent.length, sentBefore, 'dispose 后不得再发出新的 send');

  // dispose 后到达的迟到回执不得抛错或引发未处理拒绝。
  replyOk(child, child.sent[0]);
  await nextTurn();

  // dispose 必须幂等：重复调用不得抛错。
  channel.dispose();
});

// ---------------------------------------------------------------------------
// id 匹配的排他性（无关消息不得错配）
// ---------------------------------------------------------------------------
test('无关消息不错配：只有对应 id 的回执兑现请求', { timeout: CASE_TIMEOUT_MS }, async () => {
  const child = new FakeChild();
  const channel = openChannel(child);
  const pending = channel.request(controlPayload('steer', 's7'));
  await nextTurn();

  // 结算探针：无论 resolve 还是 reject，只要请求被结算就置位。
  let settled = false;
  pending.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  // 两条无关消息：完全无关的通道消息，以及"同协议但 id 对不上"的回执。
  // 两者都不得结算在途请求（既不能错配兑现，也不能误伤拒绝）。
  child.emit('message', { channel: 'some-other-channel', id: 'whatever', ok: true });
  child.emit('message', { ...child.sent[0], id: 'no-such-id', ok: true });
  await nextTurn();
  assert.equal(settled, false, '无关消息不得结算在途请求');

  // 只有 id 对应的回执到达时，请求才兑现。
  replyOk(child, child.sent[0]);
  await pending;
  assert.equal(settled, true);

  channel.dispose();
});
