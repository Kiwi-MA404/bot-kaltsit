#!/usr/bin/env node
/**
 * 自动清理「混乱对话」—— 每次启动前跑一遍，防止污染滚雪球。
 *
 * 混乱对话从哪来（都是实测踩过的）：
 *   1. 重复条目      —— 重试/补偿把同一条写了两遍
 *   2. 时间倒序      —— 补偿重放用了错误时间戳
 *   3. 时间错位质问  —— 她拿"现在"质疑一条很旧的消息
 *                       （"你那条体育课不是四点吗 怎么现在才去"）
 *
 * 处理原则：
 *   - 高置信度的（重复、倒序）直接摘掉
 *   - 时间错位质问只**标记**，默认摘掉她那一轮，但保留他的原话，
 *     让他那条能被下次启动的离线补偿重新回应
 *   - 任何改动都先整份备份到 data/backup/，被摘条目另存 data/archive/
 *
 * 用法：
 *   node tools/auto-clean.js                    # 所有联系人，自动清理
 *   node tools/auto-clean.js --contact qq-xxx
 *   node tools/auto-clean.js --dry              # 只看会做什么
 *   node tools/auto-clean.js --quiet            # 干净时不输出（给 start.sh 用）
 *
 * 注意：她运行中时不要跑 —— 记忆在进程内存里，会被覆盖回去。
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
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

const DRY = has('--dry');
const QUIET = has('--quiet');
const FORCE = has('--force');
const CONTACT = flag('--contact');

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const fmt = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
 * 她"拿现在质疑过去"的话术特征。
 *
 * 这些词说明她把一条旧消息当成刚发生的，于是说出时间错位的话。
 * 只在「他上一条消息和她这条回复之间隔了很久」时才判定，
 * 避免误伤正常对话（比如他真的拖了两小时才去，她问一句也算合理，
 * 那种情况间隔也大 —— 所以再加"消息时间 vs 记录时间明显不符"的旁证）。
 */
const TIME_CONFUSION_PATTERNS = [
  /怎么现在才/,
  /现在才去/,
  /不是.{0,6}(点|时候)吗.{0,10}(怎么|为什么)/,
  /现在几点了?[，,。？?]/,
  /不是让你.{0,10}吗/,
];

/** 检测一个联系人的混乱情况，返回要删的序号集合 + 原因 */
function detect(history) {
  const drop = new Map(); // index -> reason
  const notes = [];

  // 1. 相邻完全重复（重试/补偿写了两遍）
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (a.role === b.role && a.content === b.content) {
      drop.set(i, '重复条目');
    }
  }

  // 2. 时间倒序（补偿用了错误时间戳）
  for (let i = 1; i < history.length; i++) {
    if (history[i].at < history[i - 1].at) {
      // 倒序的这条通常是后写的、时间戳错的 —— 摘掉它保留原序
      drop.set(i, '时间倒序');
    }
  }

  // 3. 时间错位质问：她拿"现在"质疑一条明显更早的消息
  for (let i = 1; i < history.length; i++) {
    const cur = history[i];
    if (cur.role !== 'assistant') continue;
    if (!TIME_CONFUSION_PATTERNS.some((re) => re.test(cur.content))) continue;

    // 往前找最近的他的消息
    let j = i - 1;
    while (j >= 0 && history[j].role !== 'user') j--;
    if (j < 0) continue;

    const userMsg = history[j];
    const gapMin = (cur.at - userMsg.at) / 60000;

    // 她回复和他说的时间差超过 30 分钟，且她又用了"现在"话术 → 时间错位
    if (gapMin > 30) {
      drop.set(i, `时间错位质问（隔了 ${Math.round(gapMin)} 分钟还说"现在"）`);
      notes.push(
        `  ${fmt(cur.at)} 她说"${cur.content.slice(0, 30)}"，` +
          `但他那条是 ${fmt(userMsg.at)} 发的（隔 ${Math.round(gapMin)} 分钟）`,
      );
    }
  }

  return { drop, notes };
}

async function processFile(path, name) {
  const state = JSON.parse(await readFile(path, 'utf8'));
  const history = state.history ?? [];
  if (!history.length) return null;

  const { drop, notes } = detect(history);
  if (!drop.size) return null;

  const sorted = [...drop.keys()].sort((a, b) => a - b);

  if (!QUIET) {
    console.log(`\n【${name}】发现 ${sorted.length} 条混乱对话：`);
    for (const i of sorted) {
      console.log(
        `  ${String(i).padStart(4)}  ${fmt(history[i].at)}  ` +
          `${history[i].role === 'user' ? '他' : '她'}  ` +
          `${String(history[i].content).slice(0, 50)}   ← ${drop.get(i)}`,
      );
    }
    if (notes.length) {
      console.log('  时间线疑点：');
      for (const n of notes) console.log(n);
    }
  }

  if (DRY) return { count: sorted.length, dry: true };

  // 备份 + 归档
  await mkdir(BACKUP_DIR, { recursive: true });
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const ts = stamp();

  await writeFile(join(BACKUP_DIR, `${name}.autoclean-${ts}`), JSON.stringify(state, null, 2));
  const dropped = sorted.map((i) => history[i]);
  await writeFile(
    join(ARCHIVE_DIR, `${name.replace(/\.json$/, '')}-autoclean.${ts}.json`),
    JSON.stringify(dropped, null, 2),
  );

  state.history = history.filter((_, i) => !drop.has(i));
  await writeFile(path, JSON.stringify(state, null, 2));

  if (!QUIET) {
    console.log(`  ✓ 已摘掉 ${sorted.length} 条，剩余 ${state.history.length} 条`);
    console.log(`    备份：data/backup/${name}.autoclean-${ts}`);
    console.log(`    归档：data/archive/${name.replace(/\.json$/, '')}-autoclean.${ts}.json`);
  }

  return { count: sorted.length, dry: false };
}

const main = async () => {
  const running = botRunning();
  if (running && !FORCE) {
    if (!QUIET) {
      console.log('\n⚠ 她正在运行，跳过自动清理（记忆在进程内存里，改了会被覆盖回去）');
      console.log('   要清理请先 ./stop.sh\n');
    }
    return;
  }

  const files = (await readdir(DATA_DIR)).filter(
    (f) => /^qq-.*\.json$/.test(f) && f !== 'qq-state.json',
  );
  const targets = CONTACT
    ? files.filter((f) => f === `${CONTACT.startsWith('qq-') ? CONTACT : 'qq-' + CONTACT}.json`)
    : files;

  let total = 0;
  let touched = 0;

  for (const f of targets) {
    const r = await processFile(join(DATA_DIR, f), f);
    if (r) {
      total += r.count;
      touched++;
    }
  }

  if (!QUIET) {
    if (!total) {
      console.log('✓ 没有发现混乱对话');
    } else if (!DRY) {
      console.log(`\n✓ 自动清理完成：${touched} 个联系人，摘掉 ${total} 条`);
    } else {
      console.log(`\n--dry：共会摘掉 ${total} 条，未改动文件`);
    }
  } else if (total && !DRY) {
    console.log(`[auto-clean] 摘掉 ${total} 条混乱对话（${touched} 个联系人）`);
  }
};

main().catch((err) => {
  console.error(`[auto-clean] ✗ ${err.message}`);
  process.exit(1);
});
