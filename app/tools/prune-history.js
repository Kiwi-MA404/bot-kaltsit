#!/usr/bin/env node
/**
 * 精准修剪对话历史 —— 去掉「混乱对话」，防止它继续污染后续生成。
 *
 * 为什么需要它：
 *   一旦历史里出现自相矛盾的轮次（比如她拿旧状态质疑他："你不是去睡了吗
 *   怎么又起来了"），这段对话会一直待在最近 40 条窗口里，模型照着它继续
 *   跑偏，越滚越像。全清（clear-history.js）代价太大 —— 会连带丢掉
 *   上下文连贯性。所以需要能**只摘掉坏的那几轮**。
 *
 * 它不删任何东西：
 *   - 手改前的整份文件 → data/backup/
 *   - 被摘掉的条目     → data/archive/
 *
 * 用法：
 *   # 看最近 N 条（默认 30），带序号，用来定位
 *   node tools/prune-history.js --contact qq-1234567890 --list
 *   node tools/prune-history.js --contact qq-1234567890 --list --last 60
 *
 *   # 删指定序号（可多个，逗号分隔；序号来自 --list）
 *   node tools/prune-history.js --contact qq-1234567890 --drop 65,66
 *
 *   # 删时间区间（本地时间，含首含尾）
 *   node tools/prune-history.js --contact qq-1234567890 --from "10/15 13:50" --to "10/15 16:00"
 *
 *   # 删包含关键词的条目
 *   node tools/prune-history.js --contact qq-1234567890 --grep "怎么又起来了"
 *
 *   # 先看看会删什么，不动文件
 *   node tools/prune-history.js --contact qq-1234567890 --grep "刚起来" --dry
 *
 * 注意：她运行中时不要改 —— 记忆在进程内存里，下一次回话会覆盖回来。
 *       工具会检测并拒绝（除非加 --force）。
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const HERE = new URL('..', import.meta.url).pathname;
const DATA_DIR = join(HERE, 'data');
const BACKUP_DIR = join(DATA_DIR, 'backup');
const ARCHIVE_DIR = join(DATA_DIR, 'archive');

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const flag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const LIST = has('--list');
const DROP = flag('--drop');
const GREP = flag('--grep');
const FROM = flag('--from');
const TO = flag('--to');
const DRY = has('--dry');
const FORCE = has('--force');
const CONTACT = flag('--contact');
const LAST = Number(flag('--last', '30'));

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const fmt = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function botRunning() {
  try {
    const out = execSync('pgrep -fl "src/bot[.]js"', { encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 解析 "10/15 13:50" 这种简写成本地时间戳。
 * 也接受 "2026-10-15 13:50" / "13:50"（默认今天）。
 */
function parseWhen(text, isEnd = false) {
  const now = new Date();
  let m;

  // MM/DD HH:MM
  m = text.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +(m[5] ?? (isEnd ? 59 : 0)));
    return d.getTime();
  }

  // YYYY-MM-DD HH:MM
  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? (isEnd ? 59 : 0)));
    return d.getTime();
  }

  // HH:MM（今天）
  m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], +(m[3] ?? (isEnd ? 59 : 0)));
    return d.getTime();
  }

  return null;
}

async function pickFile() {
  const files = (await readdir(DATA_DIR)).filter(
    (f) => /^qq-.*\.json$/.test(f) && f !== 'qq-state.json',
  );
  if (!CONTACT) {
    throw new Error(
      `请指定 --contact。可选：${files.map((f) => f.replace(/\.json$/, '')).join(', ')}`,
    );
  }
  const want = CONTACT.startsWith('qq-') || CONTACT.startsWith('group-')
    ? CONTACT
    : `qq-${CONTACT}`;
  if (!files.includes(`${want}.json`)) {
    throw new Error(`找不到 ${want}.json。可选：${files.join(', ')}`);
  }
  return { path: join(DATA_DIR, `${want}.json`), name: `${want}.json` };
}

const main = async () => {
  if (!LIST && !DROP && !GREP && !(FROM || TO)) {
    console.log(`
用法（先 --list 看序号，再选一种删除方式）：

  --list [--last N]        列出最近 N 条（默认 30）带序号
  --drop 12,13             删指定序号
  --from "10/15 13:50" --to "10/15 16:00"   删时间区间
  --grep "关键词"           删内容包含关键词的条目
  --dry                    只看会删什么，不动文件
  --force                  她正在运行时也强制执行（危险）

例子：
  node tools/prune-history.js --contact qq-1234567890 --list
  node tools/prune-history.js --contact qq-1234567890 --drop 65,66 --dry
  node tools/prune-history.js --contact qq-1234567890 --from "10/15 13:50" --to "10/15 16:00"
`);
    process.exit(0);
  }

  const running = botRunning();
  if (running && !FORCE) {
    console.log('\n⚠ 她正在运行：');
    console.log('   ' + running.split('\n')[0]);
    console.log('\n   她的记忆在进程内存里，现在改会被她下一次回话覆盖回去。');
    console.log('   正确顺序：  ./stop.sh   →   本工具   →   ./start.sh');
    console.log('   （确实要先改再停，可加 --force）\n');
    process.exit(1);
  }

  const { path, name } = await pickFile();
  const state = JSON.parse(await readFile(path, 'utf8'));
  const history = state.history ?? [];

  if (!history.length) {
    console.log(`· ${name}：历史为空，没什么可清的`);
    return;
  }

  // ── 只看模式 ──
  if (LIST) {
    const start = Math.max(0, history.length - LAST);
    console.log(`\n【${name}】共 ${history.length} 条，显示最近 ${history.length - start} 条：\n`);
    for (let i = start; i < history.length; i++) {
      const h = history[i];
      const who = h.role === 'user' ? '他' : '她';
      console.log(
        `${String(i).padStart(4)}  ${fmt(h.at)}  ${who}  ${String(h.content).slice(0, 80)}`,
      );
    }
    console.log(`\n删除示例： --drop ${start},${start + 1}`);
    console.log('');
    return;
  }

  // ── 算出要删哪些 ──
  let targets = new Set();

  if (DROP) {
    for (const s of DROP.split(',')) {
      const n = Number(s.trim());
      if (!Number.isInteger(n) || n < 0 || n >= history.length) {
        throw new Error(`序号 ${s} 超出范围（0 ~ ${history.length - 1}）`);
      }
      targets.add(n);
    }
  }

  if (GREP) {
    for (const [i, h] of history.entries()) {
      if (String(h.content).includes(GREP)) targets.add(i);
    }
  }

  if (FROM || TO) {
    const lo = FROM ? parseWhen(FROM, false) : -Infinity;
    const hi = TO ? parseWhen(TO, true) : Infinity;
    if (FROM && lo == null) throw new Error(`--from 无法解析：${FROM}`);
    if (TO && hi == null) throw new Error(`--to 无法解析：${TO}`);
    for (const [i, h] of history.entries()) {
      if (h.at >= lo && h.at <= hi) targets.add(i);
    }
  }

  if (!targets.size) {
    console.log(`· 没有匹配到要删除的条目`);
    return;
  }

  const sorted = [...targets].sort((a, b) => a - b);
  console.log(`\n【${name}】共 ${history.length} 条，将删除 ${sorted.length} 条：\n`);
  for (const i of sorted) {
    const h = history[i];
    const who = h.role === 'user' ? '他' : '她';
    console.log(`  ${String(i).padStart(4)}  ${fmt(h.at)}  ${who}  ${String(h.content).slice(0, 70)}`);
  }

  if (DRY) {
    console.log(`\n--dry：未改动文件。去掉 --dry 才会真正删除。\n`);
    return;
  }

  // ── 备份 + 归档 ──
  await mkdir(BACKUP_DIR, { recursive: true });
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const ts = stamp();

  const bakPath = join(BACKUP_DIR, `${name}.${ts}`);
  await writeFile(bakPath, JSON.stringify(state, null, 2));
  console.log(`\n  ✓ 整份备份：data/backup/${name}.${ts}`);

  const dropped = sorted.map((i) => history[i]);
  const arcPath = join(ARCHIVE_DIR, `${name.replace(/\.json$/, '')}-pruned.${ts}.json`);
  await writeFile(arcPath, JSON.stringify(dropped, null, 2));
  console.log(`  ✓ 被摘条目归档：data/archive/${arcPath.split('/').pop()}（${dropped.length} 条）`);

  // ── 真正删除 ──
  state.history = history.filter((_, i) => !targets.has(i));
  await writeFile(path, JSON.stringify(state, null, 2));
  console.log(`  ✓ 已删除 ${sorted.length} 条，剩余 ${state.history.length} 条`);

  console.log('\n' + '─'.repeat(56));
  console.log('  恢复方式：把 data/backup/ 里对应文件拷回 data/ 覆盖');
  console.log('  现在启动她：./start.sh\n');
};

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
