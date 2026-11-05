// 只读：解析 asar 头部，列出文件名匹配模式的条目
import fs from 'node:fs';
import path from 'node:path';

const asarPath = process.argv[2];
const pattern = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const mode = process.argv[4] || 'list'; // list | extract
const outDir = process.argv[5];

const fd = fs.openSync(asarPath, 'r');
const headBuf = Buffer.alloc(16);
fs.readSync(fd, headBuf, 0, 16, 0);
// asar: [u32 size=4][u32 headerSize][u32 headerSize2][u32 headerStringSize] then JSON header
const jsonSize = headBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, headerBuf, 0, jsonSize, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const dataOffset = 8 + headBuf.readUInt32LE(4) + headBuf.readUInt32LE(12);
// 对齐：dataOffset 需要 4 字节对齐向上取整
const baseOffset = Math.ceil((8 + 4 + headBuf.readUInt32LE(4) + headBuf.readUInt32LE(12)) / 4) * 4;

const results = [];
function walk(node, prefix) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
  } else {
    const size = Number(node.size ?? 0);
    const offset = node.offset != null ? Number(node.offset) : null;
    results.push({ path: prefix, size, offset, unpacked: !!node.unpacked });
  }
}
walk(header, '');

if (mode === 'list') {
  for (const r of results) {
    if (!pattern || pattern.test(r.path)) {
      console.log(`${r.offset}\t${r.size}\t${r.unpacked ? 'U' : ' '}\t${r.path}`);
    }
  }
  console.error(`total entries: ${results.length}, baseOffset(data): ${baseOffset}`);
} else if (mode === 'extract') {
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of results) {
    if (!pattern || !pattern.test(r.path)) continue;
    if (r.unpacked || r.offset == null) continue;
    const abs = path.join(outDir, r.path.replace(/^\//, '').replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = Buffer.alloc(r.size);
    fs.readSync(fd, buf, 0, r.size, baseOffset + r.offset);
    fs.writeFileSync(abs, buf);
    console.log(`extracted ${r.path} (${r.size})`);
  }
}
fs.closeSync(fd);
