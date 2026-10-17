#!/usr/bin/env node
/**
 * 提醒管理命令行工具。
 *
 * 用法：
 *   node tools/reminder-cli.js --contact qq-1234567890
 *   node tools/reminder-cli.js --contact qq-1234567890 --add "23:00" "该睡了"
 *   node tools/reminder-cli.js --contact qq-1234567890 --cancel r_xxx
 *   node tools/reminder-cli.js --all
 *   node tools/reminder-cli.js --prune
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA_DIR = new URL('../data/', import.meta.url).pathname;
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', N = '\x1b[0m';

function usage() {
  const self = fileURLToPath(import.meta.url).replace(process.cwd() + '/', '');
  console.log(`用法：
  node ${self} --contact <contactId>                  列出该联系人的未完成提醒
  node ${self} --contact <contactId> --add <时间> <内容>   手动添加提醒
  node ${self} --contact <contactId> --cancel <id>     取消一条提醒
  node ${self} --all                                  列出所有未完成提醒
  node ${self} --prune                                清理已完成/取消超过7天的提醒`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--contact') args.contact = argv[++i];
    else if (a === '--add') {
      args.add = argv[++i];
      args.content = argv[++i] || '';
    } else if (a === '--cancel') args.cancel = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--prune') args.prune = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function parseTime(text, now) {
  // 支持 "23:00"、"11点"、"23:00:00"、"2024-10-15 23:00"
  const iso = Date.parse(text);
  if (!Number.isNaN(iso)) return iso;

  const m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1); // 时间已过则算明天
    return d.getTime();
  }

  const cn = text.match(/^(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?$/);
  if (cn) {
    const d = new Date(now);
    d.setHours(Number(cn[1]), Number(cn[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  return null;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN');
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || (!args.contact && !args.all && !args.prune)) {
    usage();
    process.exit(0);
  }

  if (!existsSync(DATA_DIR)) {
    console.log(`${R}✗${N} 数据目录不存在: ${DATA_DIR}`);
    process.exit(1);
  }

  const { Companion } = await import('../src/companion.js');
  const companion = new Companion({ dataDir: DATA_DIR });
  // 注意：这里刻意不调用 reminders.restore()。
  // restore 会给未到期的提醒装上定时器，CLI 只是查看/管理，
  // 不应该触发提醒（否则可能误发消息，进程也会被 timer 挂住）。

  if (args.prune) {
    const removed = await companion.reminders.prune(7);
    console.log(`${G}✓${N} 清理了 ${removed} 条旧提醒`);
    return;
  }

  if (args.contact && args.add) {
    const now = Date.now();
    const fireAt = parseTime(args.add, now);
    if (!fireAt) {
      console.log(`${R}✗${N} 无法解析时间: ${args.add}`);
      process.exit(1);
    }
    const r = await companion.reminders.add({
      contactId: args.contact,
      fireAt,
      reason: `手动添加: ${args.content}`,
      content: args.content,
    });
    console.log(`${G}✓${N} 已添加提醒`);
    console.log(`   id: ${r.id}`);
    console.log(`   触发: ${formatTime(r.fireAt)}`);
    console.log(`   内容: ${r.content}`);
    return;
  }

  if (args.contact && args.cancel) {
    const ok = await companion.cancelReminder(args.contact, args.cancel);
    if (ok) {
      console.log(`${G}✓${N} 已取消提醒 ${args.cancel}`);
    } else {
      console.log(`${R}✗${N} 找不到或未完成的提醒: ${args.cancel}`);
    }
    return;
  }

  const all = await companion.reminders.all();
  const list = args.all
    ? all.filter((r) => !r.fired && !r.cancelled)
    : all.filter((r) => r.contactId === args.contact && !r.fired && !r.cancelled);

  if (!list.length) {
    console.log(`${G}✓${N} 没有未完成的提醒`);
    return;
  }

  console.log(`${D}未完成提醒 (${list.length})：${N}`);
  for (const r of list.sort((a, b) => a.fireAt - b.fireAt)) {
    console.log(`  ${Y}·${N} ${r.id}`);
    console.log(`    contact: ${r.contactId}`);
    console.log(`    触发: ${formatTime(r.fireAt)}`);
    console.log(`    内容: ${r.content || '(让她自己生成)'}`);
    if (r.reason) console.log(`    原因: ${r.reason}`);
  }
}

main().catch((err) => {
  console.error(`${R}✗${N}`, err);
  process.exit(1);
});
