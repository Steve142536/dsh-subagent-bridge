// ============================================================================
// tests/codex-conflicts.test.mjs — syncCodexConfigFile 冲突形态逐例测试
//
// 被测契约（../codex-sync.js 导出的 syncCodexConfigFile(configPath, url)）：
// 桥接不鉴权、同步只负责写 [mcp_servers."dsh-subagent"] 段的 url，但下列
// 配置形态"看似可自动同步、实则会产生非法/重复 TOML"，实现必须保守拒绝，
// 并满足两条硬性约定：
//   A. 必须抛错（错误信息只描述配置形态与行号，不回显文件内容）；
//   B. 抛错时原始配置文件逐字节保持不变（绝不部分写入、绝不以空内容覆盖）。
//
// 逐例说明：
//   用例 1. TOML 多行基本字符串（""" ... """）的正文中出现
//          [mcp_servers.dsh-subagent] 字样——它只是字符串内容，不是段头。
//          逐行扫描若把它误判成段头，就会往字符串里插 url 行，
//          破坏用户配置 → 必须抛错；
//   用例 2. 目标段内 url 写成跨多行的数组（url = [ ... ] 换行书写）——
//          只替换首行会留下孤儿续行、产出非法 TOML → 必须抛错；
//   用例 3. 目标段带 command/args（stdio 型 MCP server）——与 URL 式
//          （url）互斥，往该段插入 url 毫无意义且污染配置 → 必须抛错；
//   用例 4. 目标表头的两个键名都通过 TOML Unicode 转义书写：
//          ["mcp\u005Fservers"."dsh\u002Dsubagent"]（\u005F 即下划线 _、
//          \u002D 即连字符 -）。按 TOML 语义它就是 [mcp_servers.dsh-subagent]，
//          只是字面上不含目标字样；若识别不出又不报错，就会追加重复表
//          → 必须抛错。
//
// 不再属于冲突的形态：inline/嵌套子表形态的 http_headers、不同的
// Authorization、bearer_token_env_var、http_headers.x 点键展开——桥接
// 不鉴权后同步只写 url，这些既有鉴权配置应原样保留且同步成功
// （见 codex-sync.test.mjs）。
//
// 隔离性约定：
//   - 每个用例在系统临时目录（os.tmpdir()）下用 mkdtemp 新建唯一目录，在其中
//     写入假 TOML 配置；被测函数只接收该临时目录内的路径，绝不触达本机真实
//     用户配置（真实 ~/.codex/config.toml）或任何真实凭据；
//   - 桥接不鉴权，测试全程不涉及令牌；url 均为 example 保留域假值；
//   - 全程不启动子进程、不发起网络请求；
//   - 清理前逐一复核：目录确在系统临时目录之内、目录名带本测试专属前缀，
//     才递归删除——只清理本测试自己 mkdtemp 新建的目录。
//
// 说明：本文件只要求通过 node --check 语法检查；行为断言固化的是修复中的
// codex-sync.js 契约（上述四形态在当前实现下可能尚未全部抛错），本任务不
// 运行测试，也不修改其他文件。
// ============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- 被测模块 ----------
// 仅静态引用：node --check 只做语法检查，不会真正执行该导入
import { syncCodexConfigFile } from '../codex-sync.js';

// ---------- 测试常量 ----------
// 本测试临时目录的专属前缀：mkdtemp 用它命名，清理时以此复核，杜绝误删
const TEMP_PREFIX = 'dsh-codex-conflicts-test-';
// 同步目标：假的桥接 MCP 地址（example 保留域，绝不指向真实服务）
const NEW_URL = 'https://bridge.test.example/mcp/dsh-subagent';

// 用例 1 初始 TOML：多行基本字符串（"""..."""）正文里"出现"目标段头字样——
// prompt 是 [profiles.fast] 段内的一个多行字符串值，字符串里的
// [mcp_servers.dsh-subagent] 只是内容，并不是真正的段头
const MULTILINE_STRING_TOML = [
  '# Codex CLI 根配置（本测试写入临时目录的样例）',
  'model = "gpt-5-codex"',
  '',
  '[profiles.fast]',
  'prompt = """',
  '[mcp_servers.dsh-subagent]',
  '这一行只是多行字符串的正文，不是 TOML 段头，也不是键值对。',
  '"""',
  '',
].join('\n');

// 用例 2 初始 TOML：目标段内 url 写成跨多行的数组——只替换首行会留下
// 孤儿续行、产出非法 TOML，必须整体保守拒绝
const MULTILINE_URL_TOML = [
  '# Codex CLI 根配置（本测试写入临时目录的样例）',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  'url = [',
  '  "https://old.test.example/mcp/a",',
  '  "https://old.test.example/mcp/b",',
  ']',
  '',
].join('\n');

// 用例 3 初始 TOML：目标段是 stdio 型（command 启动）的 MCP server——
// command/args 与 URL 式（url）互斥，不能往里插 url
const STDIO_COMMAND_TOML = [
  '# Codex CLI 根配置（本测试写入临时目录的样例）',
  'model = "gpt-5-codex"',
  '',
  '[mcp_servers."dsh-subagent"]',
  'command = "npx"',
  'args = ["-y", "fake-bridge-pkg"]',
  '',
].join('\n');

// 用例 4 初始 TOML：目标表头的两个键名都通过 TOML Unicode 转义书写。
// JS 源码里的 \\u005F 写入文件后即字面 \u005F（下划线 _）、\\u002D 即
// \u002D（连字符 -）：按 TOML 语义该表头就是 [mcp_servers.dsh-subagent]，
// 只是字面上不含目标字样（考验实现不能只做字面匹配）
const UNICODE_ESCAPED_TOML = [
  '# Codex CLI 根配置（本测试写入临时目录的样例）',
  'model = "gpt-5-codex"',
  '',
  '["mcp\\u005Fservers"."dsh\\u002Dsubagent"]',
  'url = "https://old.test.example/mcp/dsh-subagent"',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// 临时目录准备（每个用例独立，绝不触达真实配置与真实凭据）
// ---------------------------------------------------------------------------
// 本测试创建的全部临时目录：after() 统一复核并清理
const createdTempRoots = [];

/**
 * 在系统临时目录下 mkdtemp 一个本用例专属的临时目录，并记录进
 * createdTempRoots，全部用例结束后统一复核清理。
 * @param {string} name 用例名（拼进目录名，便于排查残留）
 * @returns {string} 临时目录绝对路径
 */
function makeTempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${name}-`));
  createdTempRoots.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 冲突用例的统一断言：必须抛错，且原始文件字节不变
// ---------------------------------------------------------------------------
/**
 * 调用 syncCodexConfigFile（桥接不鉴权，只传 configPath 与 url）并断言两点：
 *   1. 必须抛错（冲突/无法安全处理形态的唯一约定失败方式）；
 *   2. 抛错时原始配置文件逐字节保持不变（绝不部分写入或以空内容覆盖）。
 * @param {string} configPath 假 TOML 配置文件路径（位于用例临时目录）
 * @param {string} url 要同步的假桥接 URL
 * @param {string} label 用例标签（拼进断言消息，便于定位失败用例）
 */
function assertConflicted(configPath, url, label) {
  // 先留档原始字节，供"文件不变"硬断言使用
  const before = fs.readFileSync(configPath);

  let threw = null;
  try {
    syncCodexConfigFile(configPath, url);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof Error, `${label}：syncCodexConfigFile 必须抛错，实际却正常返回`);

  // 原始文件逐字节保持不变
  const afterBuf = fs.readFileSync(configPath);
  assert.ok(before.equals(afterBuf), `${label}：抛错时原始配置文件字节必须原样保留`);
}

// ---------------------------------------------------------------------------
// 清理：只删除本测试 mkdtemp 新建、且确在系统临时目录内的目录（清理前核实范围）
// ---------------------------------------------------------------------------
after(() => {
  for (const dir of createdTempRoots) {
    const resolved = path.resolve(dir);
    // 复核两项范围条件：目录确在系统临时目录之内 + 目录名带本测试专属前缀
    const insideTmp = resolved.startsWith(os.tmpdir() + path.sep);
    const owned = path.basename(resolved).startsWith(TEMP_PREFIX);
    if (insideTmp && owned) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 用例 1：多行字符串正文里出现 [mcp_servers.dsh-subagent] 字样
// ---------------------------------------------------------------------------
test('用例 1：多行字符串中出现目标段头字样 → 抛错且原始字节不变', () => {
  const dir = makeTempDir('multiline-string');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, MULTILINE_STRING_TOML, 'utf8');

  assertConflicted(configPath, NEW_URL, '多行字符串中的目标段头字样');
});

// ---------------------------------------------------------------------------
// 用例 2：目标段内 url 为跨行数组（非单行 url）
// ---------------------------------------------------------------------------
test('用例 2：目标段内 url 为跨行数组 → 抛错且原始字节不变', () => {
  const dir = makeTempDir('multiline-url');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, MULTILINE_URL_TOML, 'utf8');

  assertConflicted(configPath, NEW_URL, 'url 跨行数组写法');
});

// ---------------------------------------------------------------------------
// 用例 3：目标段带 command（stdio 型，与 URL 式互斥）
// ---------------------------------------------------------------------------
test('用例 3：目标段带 command（stdio 型，与 URL 式互斥）→ 抛错且原始字节不变', () => {
  const dir = makeTempDir('stdio-command');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, STDIO_COMMAND_TOML, 'utf8');

  assertConflicted(configPath, NEW_URL, 'stdio 型（command）目标段');
});

// ---------------------------------------------------------------------------
// 用例 4：两个键名都通过 TOML Unicode 转义书写的目标表头
// ---------------------------------------------------------------------------
test('用例 4：两个键名均以 TOML Unicode 转义书写的目标表头 → 抛错且原始字节不变', () => {
  const dir = makeTempDir('unicode-escaped-header');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, UNICODE_ESCAPED_TOML, 'utf8');

  assertConflicted(configPath, NEW_URL, 'Unicode 转义的目标表头');
});
