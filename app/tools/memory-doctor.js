#!/usr/bin/env node
/**
 * 记忆医生 ——  lightweight 命令行工具。
 *
 * 不调用 LLM，只读 data/*.json，做结构化检查和手动修复。
 *
 * 用法：
 *   node tools/memory-doctor.js --contact qq-1234567890
 *   node tools/memory-doctor.js --contact qq-1234567890 --conflicts
 *   node tools/memory-doctor.js --contact qq-1234567890 --retract pref_milk --reason "用户改口"
 *   node tools/memory-doctor.js --all
 *   node tools/memory-doctor.js --all --conflicts
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = new URL('../data/', import.meta.url).pathname;
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', N = '\x1b[0m';

function usage() {
  const self = fileURLToPath(import.meta.url).replace(process.cwd() + '/', '');
  console.log(`用法：
  node ${self} --contact <contactId>           列出该联系人的所有事实
  node ${self} --contact <contactId> --conflicts  只显示潜在冲突
  node ${self} --contact <contactId> --retract <key> [--reason "..."]  撤销一条事实
  node ${self} --all                           检查所有联系人
  node ${self} --all --conflicts               只显示所有冲突`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--contact') args.contact = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--conflicts') args.conflicts = true;
    else if (a === '--retract') args.retract = argv[++i];
    else if (a === '--reason') args.reason = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function looksContradictory(a, b) {
  const na = String(a)
    .replace(/[，。！？、；：""''（）]/g, ' ')
    .replace(/牛奶/g, '奶')
    .replace(/不喜欢/g, '厌')
    .replace(/喜欢/g, '喜')
    .trim();
  const nb = String(b)
    .replace(/[，。！？、；：""''（）]/g, ' ')
    .replace(/牛奶/g, '奶')
    .replace(/不喜欢/g, '厌')
    .replace(/喜欢/g, '喜')
    .trim();
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = nb.split(/\s+/);
  const overlap = [...wordsA].filter((w) => wordsB.includes(w) && w.length > 1);
  if (overlap.length < 2) return false;
  const negA = /(不|没|无|讨厌|厌恶|拒绝|不要)/.test(a);
  const negB = /(不|没|无|讨厌|厌恶|拒绝|不要)/.test(b);
  return negA !== negB;
}

function auditConflicts(facts) {
  const active = facts.filter((f) => f.status === 'active');
  const conflicts = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (looksContradictory(a.text, b.text)) {
        conflicts.push({ a, b });
      }
    }
  }
  return conflicts;
}

async function listFacts(memory, contactId, { onlyConflicts = false } = {}) {
  const s = await memory.load(contactId);
  const facts = s.profile?.facts ?? [];
  const active = facts.filter((f) => f.status === 'active');
  const superseded = facts.filter((f) => f.status === 'superseded' || f.status === 'retracted');

  if (onlyConflicts) {
    const conflicts = auditConflicts(facts);
    if (!conflicts.length) {
      console.log(`${G}✓${N} ${contactId} 未发现活跃记忆冲突`);
      return;
    }
    console.log(`${Y}⚠${N} ${contactId} 发现 ${conflicts.length} 组潜在冲突：`);
    for (const { a, b } of conflicts) {
      const newer = a.at >= b.at ? a : b;
      const older = a.at >= b.at ? b : a;
      console.log(`  - ${D}[${older.key}]${N} "${older.text}"`);
      console.log(`    ${D}[${newer.key}]${N} "${newer.text}" ← 更新，优先采信这条`);
    }
    return;
  }

  console.log(`\n${D}联系人：${N}${contactId}`);
  console.log(`${D}活跃事实 (${active.length})：${N}`);
  for (const f of active.sort((a, b) => b.at - a.at)) {
    const date = new Date(f.at).toLocaleString('zh-CN');
    console.log(`  ${G}●${N} [${f.key}] ${f.text}`);
    console.log(`      type=${f.type ?? 'fact'}, conf=${f.confidence ?? '-'}, at=${date}`);
  }

  if (superseded.length) {
    console.log(`${D}已退役事实 (${superseded.length})：${N}`);
    for (const f of superseded.sort((a, b) => b.at - a.at)) {
      const date = new Date(f.at).toLocaleString('zh-CN');
      console.log(`  ${Y}○${N} [${f.key}] ${f.text}`);
      console.log(`      status=${f.status}, at=${date}${f.supersededBy ? `, supersededBy=${f.supersededBy}` : ''}`);
    }
  }

  const conflicts = auditConflicts(facts);
  if (conflicts.length) {
    console.log(`${Y}⚠ 潜在冲突 (${conflicts.length})：${N}`);
    for (const { a, b } of conflicts) {
      console.log(`  - "${a.text}" vs "${b.text}"`);
    }
  } else {
    console.log(`${G}✓${N} 未发现活跃记忆冲突`);
  }
}

async function retractFact(memory, contactId, key, reason) {
  const s = await memory.load(contactId);
  const fact = s.profile?.facts?.find((f) => f.key === key && f.status === 'active');
  if (!fact) {
    console.log(`${R}✗${N} 找不到活跃的 key: ${key}`);
    return false;
  }
  fact.status = 'retracted';
  fact.validTo = Date.now();
  fact.retractReason = reason || 'manual';
  await memory.save(contactId);
  console.log(`${G}✓${N} 已撤销 [${key}]: "${fact.text}"`);
  if (reason) console.log(`   原因: ${reason}`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || (!args.contact && !args.all)) {
    usage();
    process.exit(0);
  }

  if (!existsSync(DATA_DIR)) {
    console.log(`${R}✗${N} 数据目录不存在: ${DATA_DIR}`);
    process.exit(1);
  }

  // 动态 import Memory，避免顶层依赖问题
  const { Memory } = await import('../src/memory.js');
  const memory = new Memory({ dir: DATA_DIR });

  if (args.contact) {
    if (args.retract) {
      await retractFact(memory, args.contact, args.retract, args.reason);
    } else {
      await listFacts(memory, args.contact, { onlyConflicts: args.conflicts });
    }
    return;
  }

  if (args.all) {
    const files = (await readdir(DATA_DIR)).filter(
      (f) => extname(f) === '.json' && f !== 'package.json'
    );
    if (!files.length) {
      console.log(`${Y}·${N} 数据目录为空`);
      return;
    }

    let totalConflicts = 0;
    for (const file of files.sort()) {
      const contactId = decodeURIComponent(file.replace(/\.json$/, ''));
      if (args.conflicts) {
        const s = await memory.load(contactId);
        const conflicts = auditConflicts(s.profile?.facts ?? []);
        if (conflicts.length) {
          totalConflicts += conflicts.length;
          console.log(`\n${Y}⚠${N} ${contactId} (${conflicts.length} 组冲突)`);
          for (const { a, b } of conflicts) {
            const newer = a.at >= b.at ? a : b;
            const older = a.at >= b.at ? b : a;
            console.log(`  - ${D}[${older.key}]${N} "${older.text}"`);
            console.log(`    ${D}[${newer.key}]${N} "${newer.text}" ← 优先`);
          }
        }
      } else {
        await listFacts(memory, contactId, { onlyConflicts: false });
      }
    }

    if (args.conflicts) {
      if (totalConflicts === 0) {
        console.log(`${G}✓${N} 所有联系人均未发现活跃记忆冲突`);
      } else {
        console.log(`\n${Y}总计 ${totalConflicts} 组潜在冲突${N}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(`${R}✗${N}`, err);
  process.exit(1);
});
