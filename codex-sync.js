// ============================================================================
// @local/dsh-subagent-bridge — Codex 配置同步（codex-sync.js）
//
// 职责：把 ~/.codex/config.toml 的 [mcp_servers.dsh-subagent] 段刷新为当前
// MCP 端点（url）；段不存在时在文件尾追加（等效替用户执行 codex mcp add）。
// 撤销桥接鉴权后本工具不再生成、读取或校验任何令牌，也不写入鉴权头；段内
// http_headers、Authorization、bearer_token_env_var 等用户配置一律原样保留、
// 不修改也不拒绝。文件其余内容一律不碰。
//
// 设计约束：
// 1. 文件缺失（ENOENT）→ 返回 { status: 'skipped' }（本机未装 Codex，不建文件）；
// 2. 目标段的嵌套子表（如 [mcp_servers.dsh-subagent.http_headers]）属于用户
//    自定义配置，允许存在且原样保留；扫描进入子表时离开父段正常解析，绝不
//    覆盖子表内容；url 自身被写成子表（[...dsh-subagent.url]）时报错，因为
//    父段内将无法再写 url 行；
// 3. 目标段不存在但仅有嵌套子表时，在文件尾追加父表与 url 行是合法 TOML
//  （TOML 允许先定义子表、之后再补定义父表）；
// 4. 段不存在但目标表以其他 TOML 写法定义（数组表 [[...]]、点键、inline 表）→
//    保守报错，绝不追加重复表、绝不产出非法 TOML；
// 5. 只描述配置形态与行号的错误信息，绝不包含 url 值或任何令牌；
// 6. 写盘用同目录随机临时文件 + rename 原子替换，写入前复核原文件未被并发
//    修改；任何失败路径都保证原文件保持不变。
//
//
// 额外保守保护（一律抛错、绝不自动改写）：全文含 TOML 多行字符串定界符
//（连续三个双引号/单引号）→ 多行字符串内容会被误当表头，禁止自动修改；
// 表头行解析失败 → 一律报错；键值行解析失败且行内含等号 → 一律报错；段内
// url 值只接受完整单行字符串（跨行数组等写法报错）；段内出现 command（命令
// 式服务器）→ 与自动同步的 URL 式配置互斥，报错。
//
// TOML 支持范围（刻意不做完整解析器）：表头与键名支持裸键、单/双引号键、
// 点两侧空白与表头行尾注释（修复真实场景 `[mcp_servers."dsh-subagent"] # 注释`
// 被误判为段不存在而追加重复表的问题）；除目标段 url 行外不解析任何值，
// 一律原样保留；无法确定能否安全处理的疑似目标写法一律保守报错。
// ============================================================================

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 目标表的两级键名：[mcp_servers.dsh-subagent]
const TARGET_TABLE = ['mcp_servers', 'dsh-subagent'];

// TOML v1.0 裸键字符集：A-Za-z0-9_-（其余字符必须用引号键）
const BARE_KEY_RE = /[A-Za-z0-9_-]/;

// 从 line 的 i 位置起解析一串点分键（TOML 键：裸键 / 基本字符串 / 字面字符串），
// 点两侧允许空白；返回 { keys, i }（i 停在键序列结束后的第一个非空白字符），
// 遇到无法确定处理的写法（转义引号键、引号不闭合、空键段、非法字符等）返回
// null——调用方按"保守报错或当作无关内容"处理。刻意不实现完整 TOML。
function parseDottedKeys(line, i) {
  const n = line.length;
  const keys = [];
  for (;;) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n) return null;
    const ch = line[i];
    let key;
    if (ch === '"') {
      // 基本字符串键：目标键名不需要转义，出现反斜杠即视为无法确定的写法
      i++;
      const start = i;
      while (i < n && line[i] !== '"') {
        if (line[i] === '\\') return null;
        i++;
      }
      if (i >= n) return null; // 引号未闭合
      key = line.slice(start, i);
      i++;
    } else if (ch === "'") {
      // 字面字符串键：内容原样取到闭合单引号（无转义概念）
      i++;
      const start = i;
      while (i < n && line[i] !== "'") i++;
      if (i >= n) return null;
      key = line.slice(start, i);
      i++;
    } else if (BARE_KEY_RE.test(ch)) {
      const start = i;
      while (i < n && BARE_KEY_RE.test(line[i])) i++;
      key = line.slice(start, i);
    } else {
      return null; // 键位置出现非法字符
    }
    keys.push(key);
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i < n && line[i] === '.') {
      i++; // 点分隔：继续解析下一段键
      continue;
    }
    return { keys, i };
  }
}

// 解析表头行：[a.b] / [[a.b]]，支持引号键、点两侧空白与行尾注释
// （如 `[mcp_servers."dsh-subagent"] # 注释`）；返回 { keys, array } 或 null。
function parseTableHeader(line) {
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] !== '[') return null;
  i++;
  let array = false;
  if (line[i] === '[') {
    array = true;
    i++;
  }
  const parsed = parseDottedKeys(line, i);
  if (!parsed) return null;
  i = parsed.i;
  if (line[i] !== ']') return null;
  i++;
  if (array) {
    if (line[i] !== ']') return null; // 数组表需要双闭括号
    i++;
  }
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  // 表头之后只允许行尾注释（或行尾）；其余写法视为无法确定
  if (i < n && line[i] !== '#') return null;
  return { keys: parsed.keys, array };
}

// 解析 "键 = 值" 行的键部分与值起点（值本身不解析）；键支持裸键/引号键/点键。
// 返回 { keys, valueStart } 或 null（不是可解析的键值行）。
function parseKeyValue(line) {
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  const parsed = parseDottedKeys(line, i);
  if (!parsed) return null;
  i = parsed.i;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] !== '=') return null;
  return { keys: parsed.keys, valueStart: i + 1 };
}

// 检查全文是否含有 TOML 多行字符串定界符（连续三个双引号 """ 或三个单引号 '''）。
// 多行字符串的内部内容会被逐行扫描误当成表头或键值行，导致自动同步误判配置
// 形态甚至改写错误位置，因此一经出现即抛错禁止自动修改；错误信息只给出首个
// 出现位置的行号，绝不回显该行内容（避免把配置中的令牌带进错误信息）。
function assertNoMultilineStringDelimiter(text) {
  const doubleIdx = text.indexOf('"""');
  const singleIdx = text.indexOf("'''");
  if (doubleIdx === -1 && singleIdx === -1) return;
  const firstIdx = Math.min(...[doubleIdx, singleIdx].filter((idx) => idx !== -1));
  const lineNo = text.slice(0, firstIdx).split(/\r?\n/).length;
  throw new Error(
    `codex-sync: 第 ${lineNo} 行存在 TOML 多行字符串定界符（连续三个双引号或三个单引号），` +
      `多行字符串内容会被误当表头或键值行解析，禁止自动修改，请手动检查该文件后再启用自动同步`,
  );
}

// 解析一行内从 valueStart 开始的完整单行 TOML 字符串值：只接受双引号基本
// 字符串或单引号字面字符串，且必须在本行内闭合，闭合之后只允许空白与行尾
// 注释。跨行字符串、数组、inline 表、裸值、含反斜杠转义的基本字符串等一律
// 返回 null（调用方按冲突保守抛错，绝不对这类值做自动改写）。
function parseSingleLineStringValue(line, valueStart) {
  const n = line.length;
  let i = valueStart;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  const quote = line[i];
  if (quote !== '"' && quote !== "'") return null; // 值不以引号起始
  i++;
  const start = i;
  if (quote === '"') {
    // 基本字符串：本工具写入的值不含转义序列，出现反斜杠视为无法确定的写法
    while (i < n && line[i] !== '"') {
      if (line[i] === '\\') return null;
      i++;
    }
  } else {
    // 字面字符串：无转义概念，内容原样取到闭合单引号
    while (i < n && line[i] !== "'") i++;
  }
  if (i >= n) return null; // 引号未在本行内闭合（跨行字符串等）
  const value = line.slice(start, i);
  i++;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i < n && line[i] !== '#') return null; // 闭合之后只允许行尾注释
  return { value };
}

/**
 * 把 configPath（Codex config.toml）中 [mcp_servers.dsh-subagent] 段的
 * url 行同步为传入的 url。撤销桥接鉴权：不生成、读取或校验任何令牌，也不
 * 写入鉴权头；段内已有的 http_headers、Authorization、bearer_token_env_var
 * 等用户配置一律原样保留（不修改、不校验、不拒绝），仅当 url 自身被定义成
 * 子表或段内出现 command（命令式服务器）时才报错。
 *
 * @param {string} configPath Codex 配置文件路径（如 USERPROFILE/.codex/config.toml）
 * @param {string} url 本插件 MCP 端点完整 URL
 * @returns {{status: 'skipped'|'created'|'updated'|'unchanged'}}
 *   skipped：配置文件不存在；created：文件存在但目标段不存在，已在文件尾
 *   追加父表与 url（此前仅有嵌套子表时同样追加，TOML 允许先子表后补父表）；
 *   updated：段已存在且 url 有变化或段内缺 url，已替换/插入；unchanged：
 *   url 已指向当前值，完全不写盘。
 * @throws Error 冲突或无法安全处理时抛出（原文件保持不变；消息不含 url 值）。
 */
export function syncCodexConfigFile(configPath, url) {
  // ---------- 参数校验（错误信息只描述形态，绝不回显 url 值） ----------
  if (typeof configPath !== 'string' || configPath === '') {
    throw new Error('codex-sync: configPath 必须是非空字符串路径');
  }
  // url 会以 TOML 双引号基本字符串写入，含引号/反斜杠/换行时无法安全表达
  if (typeof url !== 'string' || url === '' || /["\\\r\n]/.test(url)) {
    throw new Error('codex-sync: url 必须是非空且不含引号、反斜杠或换行的字符串');
  }

  const urlLine = `url = "${url}"`;

  // ---------- 第一步：读取文件（缺失 → skipped） ----------
  let text;
  let beforeStat;
  try {
    text = fs.readFileSync(configPath, 'utf8');
    beforeStat = fs.statSync(configPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { status: 'skipped' }; // 没有 ~/.codex/config.toml：本机未装 Codex
    }
    // 非 ENOENT 的读取错误（权限不足、IO 故障等）明确抛错，不静默跳过
    throw new Error(`codex-sync: 读取 ${configPath} 失败：${err?.message ?? err}`);
  }
  const originalText = text; // 保存原始内容（含 BOM），供写入前一致性复核
  // 保留 UTF-8 BOM（如有）：解析时剥离，写回时原样补回
  const hasBom = text.charCodeAt(0) === 0xfeff;
  if (hasBom) text = text.slice(1);

  // 全文含多行字符串定界符（""" / '''）时禁止自动修改：其内部内容会被下面的
  // 逐行扫描误当成表头或键值行（详见方法注释）
  assertNoMultilineStringDelimiter(text);

  // ---------- 第二步：全文只读扫描，在内存中完成全部检查 ----------
  const lines = text.split(/\r?\n/);
  // 行尾风格保持原样（避免把 CRLF 文件整体重写成 LF；混合行尾按 CRLF 统一）
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  let sectionIndex = -1; // 目标段头所在行下标（-1 = 未找到）
  let urlIndex = -1; // 段内 url 键所在行下标
  let sectionKeys = []; // 当前所在段的键路径（首个表头之前视为顶层）
  let inTarget = false; // 当前是否位于 [mcp_servers.dsh-subagent] 段内

  // 统一的冲突/无法安全处理错误：只描述配置形态与行号，绝不包含 url 值
  const fail = (message) => {
    throw new Error(`codex-sync: ${message}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // 空行与整行注释

    if (trimmed.startsWith('[')) {
      // ---- 表头行：识别段边界与目标段 ----
      const header = parseTableHeader(line);
      if (!header) {
        // 表头写法无法解析：一律保守抛错。解析失败时段边界不可知，继续扫描
        // 可能把后续键值行错误地归属到其他段，因此禁止自动修改
        fail(`第 ${i + 1} 行的表头写法无法安全解析，请手动检查该行`);
      }
      if (header.array) {
        // 数组表 [[...]]：把 mcp_servers 定义成数组时，追加/更新目标段都会
        // 产生非法 TOML，保守报错
        if (header.keys.length === 1 && header.keys[0] === TARGET_TABLE[0]) {
          fail(
            `第 ${i + 1} 行的 [[${TARGET_TABLE[0]}]] 数组表与自动同步的 [${TARGET_TABLE.join('.')}] 段冲突，请手动处理后再启用自动同步`,
          );
        }
        if (header.keys[0] === TARGET_TABLE[0] && header.keys[1] === TARGET_TABLE[1]) {
          fail(
            `第 ${i + 1} 行的 [[${TARGET_TABLE.join('.')}]]) 数组表写法无法自动同步，请改为 [${TARGET_TABLE.join('.')}] 标准表`,
          );
        }
        inTarget = false;
        sectionKeys = header.keys;
        continue;
      }
      const k = header.keys;
      if (k.length === 2 && k[0] === TARGET_TABLE[0] && k[1] === TARGET_TABLE[1]) {
        // 目标段头（已覆盖裸键/单双引号键/点两侧空格/行尾注释等写法）
        if (sectionIndex !== -1) {
          fail(`第 ${i + 1} 行出现了第二个 [${TARGET_TABLE.join('.')}] 段头（重复定义），无法自动处理`);
        }
        sectionIndex = i;
        inTarget = true;
        continue;
      }
      if (k.length >= 3 && k[0] === TARGET_TABLE[0] && k[1] === TARGET_TABLE[1]) {
        // 嵌套子表（如 [mcp_servers.dsh-subagent.http_headers]）：用户自定义
        // 配置，允许存在且原样保留；离开父段，把子表当普通段继续扫描，子表
        // 内容绝不覆盖。url 自身被写成子表时例外：父段内将无法再写 url 行，
        // 任何深度都使同步后的 url 行成为非法 TOML，必须报错
        if (k[2] === 'url') {
          fail(
            `第 ${i + 1} 行的 [${TARGET_TABLE.join('.')}.${k.slice(2).join('.')}] 子表把 url 定义成了表，段内无法再同步 url 行，请手动处理后再启用自动同步`,
          );
        }
        inTarget = false;
        sectionKeys = k;
        continue;
      }
      // 其他普通段：离开目标段
      inTarget = false;
      sectionKeys = k;
      continue;
    }

    // ---- 非表头行 ----
    const kv = parseKeyValue(line);
    if (!kv) {
      // 键值行解析失败：行内含等号说明它是某个键的值配置（如跨行数组、多行
      // 值等无法单行安全处理的写法），一律保守抛错；不含等号的行（多行值的
      // 中间续行等）仍按原逻辑处理：疑似指向目标的写法保守报错，其余跳过
      if (line.includes('=')) {
        fail(`第 ${i + 1} 行的键值行写法无法安全解析（行内含等号），请手动检查该行`);
      }
      // 无法解析为键值行的内容（多行值的续行、非法行等）：
      // 疑似指向目标的写法保守报错，其余按无关续行保持不变
      if (/mcp_servers|dsh-subagent/.test(line)) {
        fail(`第 ${i + 1} 行的写法无法安全解析，且疑似与 [${TARGET_TABLE.join('.')}] 相关，请手动检查`);
      }
      if (inTarget && /^\s*url\b/.test(line)) {
        fail(`第 ${i + 1} 行疑似 url 配置但写法无法安全解析，请手动检查`);
      }
      continue;
    }

    if (inTarget) {
      const k = kv.keys;
      if (k[0] === 'url') {
        if (k.length !== 1) {
          fail(`第 ${i + 1} 行以点键展开 url 子键，与自动同步的 url 行冲突，请手动处理`);
        }
        if (urlIndex !== -1) {
          fail(`第 ${i + 1} 行出现重复的 url 键（TOML 不允许重复键），无法自动处理`);
        }
        // url 值只接受完整的单行双引号/单引号字符串：跨行数组、inline 表、
        // 裸值等其他写法无法安全原位替换，一律保守抛错
        if (!parseSingleLineStringValue(line, kv.valueStart)) {
          fail(`第 ${i + 1} 行的 url 值不是完整的单行字符串，无法自动同步，请手动检查该行`);
        }
        urlIndex = i;
        continue;
      }
      if (k[0] === 'command') {
        // Codex 的 MCP 服务器要么用 command 启动本地进程（命令式），要么用
        // url 连接远程端点（URL 式），两者互斥；段内出现 command 说明是用户
        // 配置的命令式服务器，自动同步绝不能把它改写成 URL 式
        fail(
          `第 ${i + 1} 行的 [${TARGET_TABLE.join('.')}] 段已配置 command（命令式服务器），与自动同步的 URL 式配置互斥，无法自动同步；请手动处理后再启用自动同步`,
        );
      }
      // 其余键（http_headers/Authorization、bearer_token_env_var、args/env
      // 及其点键展开等用户配置）：一律原样保留，不修改也不拒绝
      continue;
    }

    // 目标段之外：检查是否存在以其他写法定义目标表的内容。这一步保证
    // "绝不追加重复表"——所有能定义 mcp_servers.dsh-subagent 的 TOML 写法
    // 要么已在表头分支被识别为段，要么在这里保守报错，不会漏成"段不存在"。
    // 例外：目标段自身的嵌套子表（如 [mcp_servers.dsh-subagent.http_headers]）
    // 内的键值行属于用户自定义内容，原样保留，不参与本检查。
    const inTargetSubtree =
      (sectionKeys?.length ?? 0) >= 2 && sectionKeys[0] === TARGET_TABLE[0] && sectionKeys[1] === TARGET_TABLE[1];
    if (!inTargetSubtree) {
      const fullPath = [...(sectionKeys ?? []), ...kv.keys];
      if (fullPath.length >= 2 && fullPath[0] === TARGET_TABLE[0] && fullPath[1] === TARGET_TABLE[1]) {
        // 例：[mcp_servers] 段内的 dsh-subagent = {...} / dsh-subagent.url = ...
        // 或顶层的 mcp_servers.dsh-subagent... 点键
        fail(
          `第 ${i + 1} 行以点键或 inline 表方式定义 ${TARGET_TABLE.join('.')}（写法无法自动同步），请改为 [${TARGET_TABLE.join('.')}] 段或手动处理`,
        );
      }
      if (fullPath.length === 1 && fullPath[0] === TARGET_TABLE[0] && /^\s*\{/.test(line.slice(kv.valueStart))) {
        // mcp_servers 本身被定义成 inline 表：inline 表是封闭的，之后再追加
        // [mcp_servers.dsh-subagent] 段头会产生非法 TOML，保守报错
        fail(
          `第 ${i + 1} 行把 ${TARGET_TABLE[0]} 定义为 inline 表，无法安全追加 ${TARGET_TABLE.join('.')} 段，请改为普通表或手动处理`,
        );
      }
    }
  }

  // ---------- 第三步：检查全部通过，构造新内容 ----------
  let status;
  if (sectionIndex === -1) {
    // 段不存在：文件尾追加父表与 url 行（先去掉结尾多余空行，再保证一个空行
    // 分隔）。此前仅有嵌套子表（如 [mcp_servers.dsh-subagent.http_headers]）
    // 时同样追加——TOML 允许先定义子表、之后再补定义父表，这是合法 TOML。
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `[${TARGET_TABLE.join('.')}]`, urlLine, '');
    status = 'created';
  } else if (urlIndex !== -1 && lines[urlIndex].trim() === urlLine) {
    return { status: 'unchanged' }; // url 已指向当前值，完全不写盘
  } else {
    if (urlIndex !== -1) {
      lines[urlIndex] = urlLine; // 原位替换（不改变行数）
    } else {
      // 段内没有 url：插到父表头之后。即使段头之后紧跟嵌套子表头，url 行也
      // 会先于子表头出现，仍然归属父表，不进入子表
      lines.splice(sectionIndex + 1, 0, urlLine);
    }
    status = 'updated';
  }
  const newText = (hasBom ? '﻿' : '') + lines.join(eol);

  // ---------- 第四步：写盘（临时文件 + rename 原子替换） ----------
  // 写入前复核原文件未被并发修改（stat + 内容全等双重校验）：该检查只能发现
  // 此刻之前已发生的改动，一旦发现被改动立即放弃写入；检查通过到 rename 之间
  // 仍存在竞态窗口，本机制不能完全排除覆盖他人后续修改的可能。
  let nowStat;
  let reread;
  try {
    nowStat = fs.statSync(configPath);
    reread = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`codex-sync: 写入前复核 ${configPath} 失败：${err?.message ?? err}`);
  }
  if (reread !== originalText || nowStat.size !== beforeStat.size || nowStat.mtimeMs !== beforeStat.mtimeMs) {
    throw new Error(`codex-sync: 检测到 ${configPath} 在同步过程中被修改，已放弃写入（原文件保持不变）`);
  }

  // 同目录随机临时文件（随机名避免并发冲突），写完后 rename 原子替换：
  // 要么完整生效，要么原文件原样保留，不会出现半写状态
  const tmpPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    // 临时文件沿用原文件权限位（Windows 上无实际作用，POSIX 上保持原 mode）
    fs.writeFileSync(tmpPath, newText, { mode: beforeStat.mode & 0o777 });
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    // 写入失败时清理临时文件：临时文件里可能留有含令牌的配置内容，不能无声
    // 残留在磁盘上。仅当临时文件已不存在（ENOENT）时静默跳过；其余清理失败
    // 一并合并进抛出的错误上报（只含路径与系统级原因，不含文件内容/令牌）。
    let cleanupNote = '';
    try {
      fs.unlinkSync(tmpPath);
    } catch (unlinkErr) {
      if (unlinkErr?.code !== 'ENOENT') {
        cleanupNote = `；临时文件清理失败（${unlinkErr?.code ?? '未知错误'}：${unlinkErr?.message ?? unlinkErr}），同目录可能残留该 .tmp 文件`;
      }
    }
    throw new Error(`codex-sync: 原子写入 ${configPath} 失败（原文件保持不变）：${err?.message ?? err}${cleanupNote}`);
  }
  return { status };
}
