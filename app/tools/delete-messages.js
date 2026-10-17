#!/usr/bin/env node
/**
 * 精确删除某条记忆线里的几句话。
 *
 * 和 clear-history.js 的区别：
 *   clear-history.js  按「联系人」清，一次清空整条 history
 *   delete-messages.js 按「条目」清，只删你点名的那几条，其余原样保留
 *
 * 用法：
 *   node tools/delete-messages.js --contact qq-1234567890 --list
 *   node tools/delete-messages.js --contact qq-1234567890 --index 55,56,57 --dry
 *   node tools/delete-messages.js --contact qq-1234567890 --index 55,56,57
 *   node tools/delete-messages.js --contact qq-1234567890 --match "叫不了"
 *   node tools/delete-messages.js --contact qq-1234567890 --index 55 --facts
 *
 * 安全设计：
 *   1. 删除前整份文件备份到 data/backup/
 *   2. 被删的条目另存到 data/archive/deleted-*.jsonl，随时能查回来
 *   3. 默认先看预览（不写盘），确认无误再去掉 --dry
 *   4. 她在运行时拒绝执行（记忆在内存里，会被覆盖回去）
 *
 * 注意：删掉 history 里的句子**不会**自动改 summary 和 profile.facts。
 *       如果那句话也被写进了摘要或长期事实，要用 --clear-summary / --facts 一起处理。
 */

import { readFile, writeFile, readdir, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const HERE = new URL('..', import.meta.url).pathname;
const DATA_DIR = join(HERE, 'data');
const BACKUP_DIR = join(DATA_DIR, 'backup');
const ARCHIVE_DIR = join(DATA_DIR, 'archive');

const args = process.argv.slice(2);
const getFlag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const has = (n) => args.includes(n);

const DRY = has('--dry');
const LIST = has('--list');
const FORCE = has('--force');
const WITH_FACTS = has('--facts');
const CLEAR_SUMMARY = has('--clear-summary');
const CONTACT = getFlag('--contact', null);
const MATCH = getFlag('--match', null);

/** 收集所有 --index，支持 --index 1,2,3 和重复传参 */
const INDEXES = (() => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index' && args[i + 1]) {
      for (const part of String(args[i + 1]).split(',')) {
        const n = Number(part.trim());
        if (Number.isInteger(n) && n >= 0) out.push(n);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
})();

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 她是不是正在运行？运行中改了会被内存里的旧状态覆盖回去。 */
function botRunning() {
  try {
    const out = execSync('pgrep -fl "src/bot[.]js"', { encoding: 'utf8' });
    return out.trim().length > 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

function fmtTime(at) {
  return new Date(at).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** 打印一条对话，带序号 */
function show(i, m, marker = ' ') {
  const c = String(m.content).replace(/\n/g, ' ').slice(0, 60);
  console.log(
    `${marker}${String(i).padStart(3)} [${fmtTime(m.at)}] ${m.role === 'user' ? '他 ' : '她 '}${c}`,
  );
}

async function pickFile() {
  const files = (await readdir(DATA_DIR)).filter(
    (f) => /^qq-.*\.json$/.test(f) && f !== 'qq-state.json',
  );
  if (!CONTACT) {
    throw new Error(`必须指定 --contact。可选：${files.map((f) => f.replace(/\.json$/, '')).join(', ')}`);
  }
  const want = CONTACT.startsWith('qq-') ? CONTACT : `qq-${CONTACT}`;
  const name = `${want}.json`;
  if (!files.includes(name)) {
    throw new Error(`找不到 ${name}。可选：${files.map((f) => f.replace(/\.json$/, '')).join(', ')}`);
  }
  return join(DATA_DIR, name);
}

const main = async () => {
  const path = await pickFile();
  const name = path.split('/').pop();
  const state = JSON.parse(await readFile(path, 'utf8'));
  const history = state.history ?? [];

  // ── 只看列表 ──
  if (LIST || (!INDEXES.length && !MATCH)) {
    console.log(`\n═══ ${name}（共 ${history.length} 条）═══\n`);
    history.forEach((m, i) => show(i, m));
    console.log(`\n删除示例：`);
    console.log(`  node tools/delete-messages.js --contact ${CONTACT} --index 55,56,57 --dry`);
    console.log(`  node tools/delete-messages.js --contact ${CONTACT} --match "叫不了" --dry\n`);
    return;
  }

  // ── 选出要删的 ──
  let targets = [];
  if (MATCH) {
    const re = new RegExp(MATCH);
    targets = history.map((m, i) => ({ i, m })).filter(({ m }) => re.test(String(m.content)));
    if (!targets.length) throw new Error(`没有一条匹配 /${MATCH}/`);
  } else {
    const bad = INDEXES.filter((i) => i >= history.length);
    if (bad.length) throw new Error(`序号越界：${bad.join(', ')}（共 ${history.length} 条，最大 ${history.length - 1}）`);
    targets = INDEXES.map((i) => ({ i, m: history[i] }));
  }

  console.log(`\n═══ ${name} ═══`);
  console.log(`当前：${history.length} 条对话 / ${state.profile?.facts?.length ?? 0} 条事实 / 摘要 ${(state.summary || '').length} 字\n`);
  console.log(`将删除 ${targets.length} 条：\n`);
  for (const { i, m } of targets) show(i, m, '  ✗ ');

  if (DRY) {
    console.log(`\n--dry：没有改动任何文件。`);
    console.log(`确认无误后去掉 --dry 重跑：`);
    const idx = targets.map((t) => t.i).join(',');
    console.log(`  node tools/delete-messages.js --contact ${CONTACT} --index ${idx}\n`);
    return;
  }

  // ── 运行检查 ──
  const running = botRunning();
  if (running && !FORCE) {
    console.log('\n⚠ 她正在运行：');
    console.log('   ' + running.split('\n')[0]);
    console.log('\n   记忆在进程内存里，现在改会被下一次回话覆盖回去。');
    console.log('   先停她：  pkill -f "src/bot.js"');
    console.log('   确实要现在改，加 --force\n');
    process.exit(1);
  }

  // ── 备份 + 归档 ──
  await mkdir(BACKUP_DIR, { recursive: true });
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const ts = stamp();

  const bakPath = join(BACKUP_DIR, `${name}.${ts}`);
  await writeFile(bakPath, await readFile(path));
  console.log(`\n✓ 整份备份：data/backup/${name}.${ts}`);

  const delPath = join(ARCHIVE_DIR, `deleted-${name.replace(/\.json$/, '')}.jsonl`);
  await appendFile(
    delPath,
    targets
      .map(({ i, m }) => JSON.stringify({ deletedAt: Date.now(), batch: ts, index: i, ...m }))
      .join('\n') + '\n',
    'utf8',
  );
  console.log(`✓ 被删条目归档：data/archive/deleted-${name.replace(/\.json$/, '')}.jsonl`);

  // ── 执行删除（倒序，避免序号漂移）──
  const drop = new Set(targets.map((t) => t.i));
  state.history = history.filter((_, i) => !drop.has(i));

  if (CLEAR_SUMMARY) {
    state.summary = '';
    console.log('✓ 摘要已清空');
  }

  if (WITH_FACTS) {
    const before = state.profile?.facts?.length ?? 0;
    const text = targets.map((t) => String(t.m.content)).join(' ');
    state.profile.facts = (state.profile?.facts ?? []).filter((f) => {
      // 同一句话里出现过的关键词，宁可留着让用户手动判断，这里只删明显重复的
      return !targets.some((t) => f.text && String(t.m.content).includes(f.text.slice(0, 8)));
    });
    console.log(`✓ 长期事实：${before} → ${state.profile.facts.length}`);
    void text;
  }

  await writeFile(path, JSON.stringify(state, null, 2), 'utf8');

  console.log(`✓ 已删除 ${targets.length} 条，剩 ${state.history.length} 条`);
  console.log(`\n恢复：cp data/backup/${name}.${ts} data/${name}\n`);
};

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
