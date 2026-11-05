// ============================================================================
// tests/codex-sync.test.mjs — Codex 配置同步(codex-sync.js)单元测试
//
// 被测契约(../codex-sync.js 导出的 syncCodexConfigFile(configPath, url)):
// 桥接服务不鉴权,同步只负责把 [mcp_servers."dsh-subagent"] 段的 url 刷新
// 为当前 MCP 端点地址;该段内任何既有鉴权配置都属于用户自定义,同步绝不触碰:
//   1. 裸表(尚无任何 [mcp_servers] 段)正常创建:新建
//      [mcp_servers."dsh-subagent"] 段且段内仅含 url——绝不写入
//      http_headers / Authorization / bearer_token_env_var 等鉴权配置;
//      原文件中不相关的段(model、[profiles.*] 等)原样保留;
//   2. 已有 [mcp_servers."dsh-subagent"] 且表头行尾带注释时正常更新:
//      旧 url 被替换为新 url,且该表头全文件只出现一次——绝不把
//      "带行尾注释的表头"误判为未知结构而追加重复表;
//   3. 目标段已存在以下鉴权相关配置时,一律原样保留且 url 同步成功
//      (桥接不鉴权,同步绝不覆盖、绝不删除用户的鉴权配置):
//      - inline 表 http_headers = { ... }(内含不同的 Authorization 与自定义头);
//      - 段内直接的 Authorization 键(用户自填的令牌);
//      - bearer_token_env_var(环境变量鉴权方式);
//      - http_headers.x 点键展开的自定义请求头;
//      - [mcp_servers."dsh-subagent".http_headers] 嵌套子表;
//   4. config 文件不存在时被跳过:不抛失败、不凭空创建文件;
//   5. 幂等:url 更新成功后重复调用,文件字节保持不变(约定明示 status 时
//      不得再次报告 updated)。
//
// 返回约定兼容策略(返回约定尚未定稿,测试做归一化):
//   - 抛错                    → 归一为 status:'failed'(携带 error);
//   - 返回 {status:'...'}     → 直接采用其 status 字符串;
//   - 返回 undefined/其他     → 归一为 'unknown'(约定未明),此时只依赖
//     "文件内容/字节是否变化"做硬断言,不对 status 做强断言。
//
// 隔离性约定:
//   - 每个用例在系统临时目录(os.tmpdir())下用 mkdtemp 新建唯一目录,在其中
//     写入假 TOML 配置;被测函数只接收该临时目录内的路径,绝不触达本机真实
//     用户配置(真实 ~/.codex/config.toml)或任何真实凭据;
//   - 桥接不鉴权,测试全程不涉及令牌;url 均为 example 保留域假值;
//   - 测试全程不启动任何子进程、不发起网络请求;
//   - 清理时先复核目标目录确实位于系统临时目录之内、且目录名带本测试专属
//     前缀,才递归删除——只清理本测试自己 mkdtemp 新建的目录。
// ============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- 被测模块 ----------
// 另一任务并行修改中的 codex-sync.js;此处仅静态引用,node --check 不执行导入
import { syncCodexConfigFile } from '../codex-sync.js';

// ---------- 测试常量 ----------
// 本测试临时目录的专属前缀:mkdtemp 用它命名,清理时以此复核,杜绝误删
const TEMP_PREFIX = 'dsh-codex-sync-test-';
// 同步目标:假的桥接 MCP 地址(example 保留域,绝不指向真实服务)
const NEW_URL = 'https://bridge.test.example/mcp/dsh-subagent';
// 旧地址:用于断言"url 更新后旧值不再出现"
const OLD_URL = 'https://old.test.example/mcp/dsh-subagent';

// 用例 1 初始 TOML:裸表——没有任何 [mcp_servers] 段,含不相关的段
const BARE_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  'approval_policy = "never"',
  '',
  '[profiles.fast]',
  'model = "gpt-5-mini"',
  '',
  '[profiles.fast.shell_environment_policy]',
  'inherit = "all"',
  '',
].join('\n');

// 用例 2 初始 TOML:已有桥接表,且表头行尾带注释(考验解析器不误判)
const COMMENTED_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  '',
  '# 桥接子代理 MCP 配置:表头行尾带注释',
  '[mcp_servers."dsh-subagent"] # 旧桥接地址(行尾注释)',
  `url = "${OLD_URL}"`,
  '',
  '[profiles.fast]',
  'model = "gpt-5-mini"',
  '',
].join('\n');

// 用例 3 初始 TOML:桥接段内已有 inline 形态的 http_headers——内含与本同步
// 无关的 Authorization 与自定义请求头 X-Custom,均属用户自定义,须原样保留
const INLINE_HEADERS_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  `url = "${OLD_URL}"`,
  'http_headers = { "Authorization" = "Bearer local-user-token", "X-Custom" = "keep-me" }',
  '',
].join('\n');

// 用例 4 初始 TOML:桥接段内已有直接的 Authorization 键(用户自填的令牌)
const DIRECT_AUTH_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  `url = "${OLD_URL}"`,
  'Authorization = "Bearer local-user-token"',
  '',
].join('\n');

// 用例 5 初始 TOML:桥接段内已有 bearer_token_env_var(环境变量鉴权方式)
const ENV_VAR_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  `url = "${OLD_URL}"`,
  'bearer_token_env_var = "MY_BRIDGE_TOKEN"',
  '',
].join('\n');

// 用例 6 初始 TOML:桥接段内以点键展开写 http_headers 子键(自定义请求头 x)。
// 点键展开属于用户自定义写法,桥接不鉴权后不再是冲突——原样保留并同步 url
const DOTTED_HEADERS_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  `url = "${OLD_URL}"`,
  'http_headers.x = { "Authorization" = "Bearer local-user-token" }',
  '',
].join('\n');

// 用例 7 初始 TOML:桥接段下已有 [mcp_servers."dsh-subagent".http_headers]
// 嵌套子表(内含另一份不同的 Authorization)——原样保留并同步 url
const NESTED_HEADERS_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  `url = "${OLD_URL}"`,
  '',
  '[mcp_servers."dsh-subagent".http_headers]',
  'Authorization = "Bearer nested-user-token"',
  '',
].join('\n');

// 用例 9 初始 TOML:已有桥接段(仅旧 url)——用于 url 更新幂等用例
const EXISTING_TOML = [
  '# Codex CLI 根配置(本测试写入临时目录的样例)',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  `url = "${OLD_URL}"`,
  '',
].join('\n');

// ---------------------------------------------------------------------------
// 临时目录准备(每个用例独立,绝不触达真实配置与真实凭据)
// ---------------------------------------------------------------------------
// 本测试创建的全部临时目录:after() 统一复核并清理
const createdTempRoots = [];

/**
 * 在系统临时目录下 mkdtemp 一个本用例专属的临时目录,并记录进
 * createdTempRoots,全部用例结束后统一复核清理。
 * @param {string} name 用例名(拼进目录名,便于排查残留)
 * @returns {string} 临时目录绝对路径
 */
function makeTempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${name}-`));
  createdTempRoots.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 被测函数调用归一化(返回约定兼容层)
// ---------------------------------------------------------------------------
/**
 * 调用 syncCodexConfigFile(桥接不鉴权,只传 configPath 与 url)并把可能的
 * 返回约定归一为统一形状 { status, raw, error }:
 *   - 抛错 → status:'failed'(携带 error);
 *   - 返回对象携带字符串 status → 直接采用;
 *   - 返回约定未明(undefined 等)→ status:'unknown',由调用方退回
 *     "文件内容/字节是否变化"做硬断言,不对 status 做强断言。
 * @param {string} configPath 假 TOML 配置文件路径(位于用例临时目录)
 * @param {string} url 要同步的桥接 URL
 * @returns {{status: string, raw: any, error: Error|null}} 归一化后的同步结果
 */
function runSync(configPath, url) {
  let raw;
  try {
    raw = syncCodexConfigFile(configPath, url);
  } catch (err) {
    // 失败约定之一:抛错 → 归一为 failed
    return { status: 'failed', raw: undefined, error: err };
  }
  // 成功约定:对象携带字符串 status → 直接采用
  if (raw && typeof raw === 'object' && typeof raw.status === 'string') {
    return { status: raw.status, raw, error: null };
  }
  // 返回约定未明(undefined / 其他形状):仅能确认"执行未抛错"
  return { status: 'unknown', raw, error: null };
}

/**
 * 统计文本中 [mcp_servers."dsh-subagent"] 表头(兼容三种引号写法与行尾注释)
 * 出现的次数:逐行匹配并锚定行尾,嵌套子表
 * [mcp_servers."dsh-subagent".http_headers] 不会被误计入目标表头数量。
 * @param {string} text 配置文件全文
 * @returns {number} 目标表头出现次数
 */
function countBridgeHeaders(text) {
  const headerRe = /^\s*\[mcp_servers\.(?:"dsh-subagent"|'dsh-subagent'|dsh-subagent)\]\s*(?:#.*)?$/;
  return text.split(/\r?\n/).filter((line) => headerRe.test(line)).length;
}

/**
 * url 同步成功断言:不抛错/不报 failed、新 url 写入、(按需)旧 url 消失、
 * 桥接表头恰好出现一次;返回同步后的文件全文供用例继续断言其他细节。
 * @param {string} configPath 假 TOML 配置文件路径(位于用例临时目录)
 * @param {{status: string, raw: any, error: Error|null}} res runSync 的归一化结果
 * @param {{oldGone?: boolean}} [opts] oldGone=true 时额外断言旧 url 已被替换
 * @returns {string} 同步后的配置文件全文
 */
function assertUrlSynced(configPath, res, { oldGone = false } = {}) {
  assert.notStrictEqual(res.status, 'failed', `url 同步不应失败:${res.error?.stack || JSON.stringify(res.raw)}`);
  const text = fs.readFileSync(configPath, 'utf8');
  assert.ok(text.includes(NEW_URL), '同步后文件应包含新的桥接 url');
  if (oldGone) {
    assert.ok(!text.includes(OLD_URL), '旧桥接 url 应被替换掉,不再出现');
  }
  assert.strictEqual(countBridgeHeaders(text), 1, '[mcp_servers."dsh-subagent"] 表头应恰好出现一次');
  return text;
}

/**
 * 既有配置行原样保留断言:每行在同步后的文件中逐字全等且恰好出现一次
 * (既证明没被覆盖改写,也证明没被增写重复行)。
 * @param {string} text 同步后的配置文件全文
 * @param {string[]} lines 应原样保留的配置行(与初始 TOML 中逐字一致)
 */
function assertLinesPreserved(text, lines) {
  for (const line of lines) {
    const count = text.split(/\r?\n/).filter((l) => l === line).length;
    assert.strictEqual(count, 1, `既有配置行应原样保留且恰好出现一次(实际出现 ${count} 次):${line}`);
  }
}

// ---------------------------------------------------------------------------
// 清理:只删除本测试 mkdtemp 新建、且确在系统临时目录内的目录
// ---------------------------------------------------------------------------
after(() => {
  for (const dir of createdTempRoots) {
    const resolved = path.resolve(dir);
    const insideTmp = resolved.startsWith(os.tmpdir() + path.sep);
    const owned = path.basename(resolved).startsWith(TEMP_PREFIX);
    if (insideTmp && owned) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 用例 1:裸表新建桥接段,段内仅含 url
// ---------------------------------------------------------------------------
test('裸表:新建桥接段仅含 url,不相关段原样保留', () => {
  const dir = makeTempDir('bare-table');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, BARE_TOML, 'utf8');

  const res = runSync(configPath, NEW_URL);
  const text = assertUrlSynced(configPath, res);

  // 桥接不鉴权:新建段只允许写入 url,不得出现任何鉴权相关配置
  // (初始样例本身不含这些字样,同步后出现即说明实现多写了鉴权配置)
  assert.ok(!text.includes('http_headers'), '桥接不鉴权:新建段不得写入 http_headers');
  assert.ok(!text.includes('Authorization'), '桥接不鉴权:新建段不得写入 Authorization');
  assert.ok(!text.includes('bearer_token_env_var'), '桥接不鉴权:新建段不得写入 bearer_token_env_var');

  // 不相关内容原样保留
  assert.ok(text.includes('model = "gpt-5-codex"'), '顶层 model 键应保留');
  assert.ok(text.includes('approval_policy = "never"'), '顶层 approval_policy 键应保留');
  assert.ok(text.includes('[profiles.fast]'), '[profiles.fast] 段应保留');
  assert.ok(text.includes('[profiles.fast.shell_environment_policy]'), '嵌套子表段头应保留');
  assert.ok(text.includes('inherit = "all"'), '嵌套子表内容应保留');
});

// ---------------------------------------------------------------------------
// 用例 2:表头行尾带注释时正常更新且不追加重复表
// ---------------------------------------------------------------------------
test('表头行尾带注释:更新 url 且不追加重复表', () => {
  const dir = makeTempDir('commented-header');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, COMMENTED_TOML, 'utf8');

  const res = runSync(configPath, NEW_URL);
  const text = assertUrlSynced(configPath, res, { oldGone: true });

  // 不相关段保留
  assert.ok(text.includes('model = "gpt-5-codex"'), '顶层 model 键应保留');
  assert.ok(text.includes('[profiles.fast]'), '[profiles.fast] 段应保留');
});

// ---------------------------------------------------------------------------
// 用例 3:已有 inline http_headers(不同 Authorization 与自定义头)原样保留
// ---------------------------------------------------------------------------
test('已有 inline http_headers:原样保留且同步 url', () => {
  const dir = makeTempDir('inline-headers');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, INLINE_HEADERS_TOML, 'utf8');

  const res = runSync(configPath, NEW_URL);
  const text = assertUrlSynced(configPath, res, { oldGone: true });

  // 用户的鉴权配置(不同的 Authorization 与自定义请求头)原样保留
  assertLinesPreserved(text, [
    'http_headers = { "Authorization" = "Bearer local-user-token", "X-Custom" = "keep-me" }',
  ]);
});

// ---------------------------------------------------------------------------
// 用例 4:已有直接的 Authorization 键(不同令牌)原样保留
// ---------------------------------------------------------------------------
test('已有不同 Authorization 键:原样保留且同步 url', () => {
  const dir = makeTempDir('direct-auth');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, DIRECT_AUTH_TOML, 'utf8');

  const res = runSync(configPath, NEW_URL);
  const text = assertUrlSynced(configPath, res, { oldGone: true });

  // 用户自填的 Authorization 原样保留,同步不得覆盖
  assertLinesPreserved(text, ['Authorization = "Bearer local-user-token"']);
});

// ---------------------------------------------------------------------------
// 用例 5:已有 bearer_token_env_var(环境变量鉴权)原样保留
// ---------------------------------------------------------------------------
test('已有 bearer_token_env_var:原样保留且同步 url', () => {
  const dir = makeTempDir('env-var');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, ENV_VAR_TOML, 'utf8');

  const res = runSync(configPath, NEW_URL);
  const text = assertUrlSynced(configPath, res, { oldGone: true });

  // 环境变量鉴权方式与桥接不鉴权不冲突:原样保留,不得删除或报错
  assertLinesPreserved(text, ['bearer_token_env_var = "MY_BRIDGE_TOKEN"']);
});

// ---------------------------------------------------------------------------
// 用例 6:已有 http_headers.x 点键展开(自定义请求头)原样保留
// ---------------------------------------------------------------------------
test('已有 http_headers.x 点键:原样保留且同步 url', () => {
  const dir = makeTempDir('dotted-headers');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, DOTTED_HEADERS_TOML, 'utf8');

  const res = runSync(configPath, NEW_URL);
  const text = assertUrlSynced(configPath, res, { oldGone: true });

  // 点键展开的自定义请求头属于用户配置:原样保留,不得被当作本插件的
  // inline 表整行覆盖(那会删掉用户的 x 子键)
  assertLinesPreserved(text, [
    'http_headers.x = { "Authorization" = "Bearer local-user-token" }',
  ]);
});

// ---------------------------------------------------------------------------
// 用例 7:已有 [mcp_servers."dsh-subagent".http_headers] 嵌套子表原样保留
// ---------------------------------------------------------------------------
test('已有 http_headers 嵌套子表:原样保留且同步 url', () => {
  const dir = makeTempDir('nested-headers');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, NESTED_HEADERS_TOML, 'utf8');

  const res = runSync(configPath, NEW_URL);
  const text = assertUrlSynced(configPath, res, { oldGone: true });

  // 嵌套子表整段原样保留(表头与子表内另一份不同的 Authorization 均不动)
  assertLinesPreserved(text, [
    '[mcp_servers."dsh-subagent".http_headers]',
    'Authorization = "Bearer nested-user-token"',
  ]);
});

// ---------------------------------------------------------------------------
// 用例 8:config 文件不存在时被跳过
// ---------------------------------------------------------------------------
test('config 不存在:被跳过且不凭空创建文件', () => {
  const dir = makeTempDir('missing-config');
  // 故意不写入 config.toml:路径指向一个不存在的配置文件
  const configPath = path.join(dir, 'config.toml');

  const res = runSync(configPath, NEW_URL);
  // 跳过是正常路径:不得按失败处理(抛错归一的 failed 或 status=failed 都不允许)
  assert.notStrictEqual(res.status, 'failed', `config 不存在应被跳过而不是失败:${res.error?.stack || JSON.stringify(res.raw)}`);
  // 跳过时不得凭空创建配置文件
  assert.strictEqual(fs.existsSync(configPath), false, '跳过时不得创建 config 文件');
});

// ---------------------------------------------------------------------------
// 用例 9:url 更新后重复调用,文件字节不变(幂等)
// ---------------------------------------------------------------------------
test('幂等:url 更新后重复调用文件字节不变', () => {
  const dir = makeTempDir('idempotent');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, EXISTING_TOML, 'utf8');

  // 第一次调用:把旧 url 更新为新 url
  const first = runSync(configPath, NEW_URL);
  assert.notStrictEqual(first.status, 'failed', `首次同步不应失败:${first.error?.stack || JSON.stringify(first.raw)}`);
  const afterFirst = fs.readFileSync(configPath);
  assert.ok(afterFirst.toString('utf8').includes(NEW_URL), '首次同步后文件应包含新的桥接 url');
  assert.ok(!afterFirst.toString('utf8').includes(OLD_URL), '首次同步后旧 url 应被替换');

  // 第二次调用:重复同步同一 url
  const second = runSync(configPath, NEW_URL);
  assert.notStrictEqual(second.status, 'failed', `重复同步不应失败:${second.error?.stack || JSON.stringify(second.raw)}`);
  // 约定明示 status 时:不得再次报告发生了写入(updated),应表达 unchanged 类语义;
  // 约定未明(unknown)时退回下方字节断言。
  assert.notStrictEqual(second.status, 'updated', `重复调用应报告 unchanged,实际 status=${second.status}`);

  // 硬断言:重复调用后文件字节与首次同步后完全一致
  const afterSecond = fs.readFileSync(configPath);
  assert.ok(afterFirst.equals(afterSecond), '重复调用后文件字节必须保持不变');
});
