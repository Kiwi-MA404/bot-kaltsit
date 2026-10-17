#!/usr/bin/env node
/**
 * 清空某条记忆线的「对话原文」，保留长期事实。
 *
 * 为什么需要它：
 *   她每次生成会读最近 40 条历史。一旦历史里全是她自己"只回一句"的回复，
 *   模型会照着继续只回一句，越滚越短，人设/底色/指令都压不住。
 *   清掉历史 = 把她从这段惯性里放出来（实测：回复条数 1 → 2~3）。
 *
 * 它**不删除**任何东西：
 *   - 清空前的整份文件 → data/backup/
 *   - 被清掉的对话原文   → data/archive/
 *   随时可以拷回去恢复。
 *
 *   node tools/clear-history.js                    # 所有联系人：清对话，留事实
 *   node tools/clear-history.js --contact qq-1234567890
 *   node tools/clear-history.js --all              # 连长期事实一起清（彻底白纸）
 *   node tools/clear-history.js --dry              # 只看会做什么，不动文件
 *
 * 注意：她运行中时不要清 —— 她的记忆在进程内存里，下一次回话会把旧历史写回来。
 *       所以本工具会在检测到她正在运行时直接拒绝（除非加 --force）。
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
const getFlag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const DRY = args.includes('--dry');
const ALL = args.includes('--all');
const FORCE = args.includes('--force');
const CONTACT = getFlag('--contact', null);

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 她是不是正在运行？运行中清了会被内存里的旧状态覆盖回去。 */
function botRunning() {
  try {
    // [.] 是为了让 pgrep 的命令行自身不匹配自己（否则 shell 会把自己算成 bot）
    const out = execSync('pgrep -fl "src/bot[.]js"', { encoding: 'utf8' });
    return out.trim().length > 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

async function pickFiles() {
  // qq-state.json 是运行状态（发送频率/接管时间），不是记忆线，必须排除
  const files = (await readdir(DATA_DIR)).filter(
    (f) => /^qq-.*\.json$/.test(f) && f !== 'qq-state.json',
  );
  if (!files.length) throw new Error('data/ 里没有 qq-*.json');
  if (!CONTACT) return files.map((f) => join(DATA_DIR, f));

  const want = CONTACT.startsWith('qq-') ? CONTACT : `qq-${CONTACT}`;
  const hit = files.find((f) => f === `${want}.json`);
  if (!hit) throw new Error(`找不到 ${want}.json，可选：${files.join(', ')}`);
  return [join(DATA_DIR, hit)];
}

const main = async () => {
  const running = botRunning();
  if (running && !FORCE) {
    console.log('\n⚠ 她正在运行：');
    console.log('   ' + running.split('\n')[0]);
    console.log('\n   她的记忆在进程内存里，现在清会被她下一次回话覆盖回去。');
    console.log('   正确顺序：  ./stop.sh   →   本工具   →   ./start.sh');
    console.log('   （确实要先清再停，可加 --force）\n');
    process.exit(1);
  }

  const paths = await pickFiles();
  if (!DRY) {
    await mkdir(BACKUP_DIR, { recursive: true });
    await mkdir(ARCHIVE_DIR, { recursive: true });
  }

  const ts = stamp();
  let touched = 0;

  for (const path of paths) {
    const name = path.split('/').pop();
    const state = JSON.parse(await readFile(path, 'utf8'));
    const nHist = state.history?.length ?? 0;
    const nFact = state.profile?.facts?.length ?? 0;

    if (nHist === 0 && !(ALL && nFact > 0)) {
      console.log(`· ${name}：已经是干净的（0 条对话${ALL ? '、0 条事实' : ''}），跳过`);
      continue;
    }

    console.log(`\n【${name}】`);
    console.log(`  当前：${nHist} 条对话原文 / ${nFact} 条长期事实 / 摘要 ${(state.summary || '').length} 字`);

    if (DRY) {
      console.log(`  --dry：将清空 ${nHist} 条对话${ALL ? ` 与 ${nFact} 条事实` : '（事实保留）'}`);
      touched++;
      continue;
    }

    // 1. 整份文件先备份
    const bakPath = join(BACKUP_DIR, `${name}.${ts}`);
    await writeFile(bakPath, await readFile(path));
    console.log(`  ✓ 整份备份：data/backup/${name}.${ts}`);

    // 2. 对话原文另存一份（便于只找回聊天记录）
    if (nHist > 0) {
      const arcPath = join(ARCHIVE_DIR, `${state.contactId ?? name.replace(/\.json$/, '')}-history.${ts}.json`);
      await writeFile(arcPath, JSON.stringify(state.history, null, 2));
      console.log(`  ✓ 对话归档：data/archive/${arcPath.split('/').pop()}（${nHist} 条）`);
    }

    // 3. 清空
    state.history = [];
    state.summary = '';
    if (ALL) {
      state.profile = { facts: [], named: null, notes: [] };
    }
    await writeFile(path, JSON.stringify(state, null, 2));
    console.log(`  ✓ 已清空${ALL ? '（含长期事实）' : '对话，长期事实保留'}`);
    touched++;
  }

  console.log('\n' + '─'.repeat(56));
  if (DRY) {
    console.log(`--dry 结束：会处理 ${touched} 个联系人，未改动任何文件\n`);
    return;
  }
  console.log(`✓ 完成，处理 ${touched} 个联系人`);
  console.log('  备份目录：data/backup/    归档目录：data/archive/');
  console.log('  恢复方式：把 data/backup/ 里的文件拷回 data/ 覆盖同名文件');
  console.log('  现在启动她：./start.sh\n');
};

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
