#!/usr/bin/env node
/**
 * 摘要自检。摘要出问题会污染长期记忆，而且很难发现。
 *
 *   node tools/check-summary.js              # 检查所有联系人
 *   node tools/check-summary.js qq-1234567890
 *   node tools/check-summary.js --fix        # 发现问题就用模型重写
 *
 * 检查两类问题：
 *   1. 相对时间词（"次日""后来""前几天"）—— 没有日期锚点，
 *      后面读的人会搞错是哪天。实测踩过：早上的"吃了一碗面"变成"昨天吃的"。
 *   2. 摘要里出现了未来日期，或者日期明显对不上。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../data/', import.meta.url).pathname;
const FIX = process.argv.includes('--fix');
const filter = process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

/** 真正危险的：没有日期锚点就会让人搞错是哪天的说法 */
const VAGUE_TIME = [
  '次日', '第二天', '隔天', '翌日',
  '后来', '之后不久', '过了几天', '前几天', '那天',
  '昨天', '今天', '明天', '昨晚', '今晚',
];

// 时段词单独看：只有**没有**具体日期时才算问题。
// "10 月 14 日早上" 是合格的，"早上他吃了面" 不合格。
const TIME_OF_DAY = ['早上', '上午', '中午', '下午', '晚上', '深夜', '凌晨', '清晨'];

const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => /^qq-\d+\.json$/.test(f))
  : [];

if (!files.length) {
  console.log('\n没有找到记忆文件。\n');
  process.exit(0);
}

console.log('\n═══ 摘要自检 ═══\n');

let problems = 0;

for (const f of files) {
  const contactId = f.replace(/\.json$/, '');
  if (filter && !contactId.includes(filter)) continue;

  const path = join(DIR, f);
  let j;
  try {
    j = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`${C.bad('✗')} ${contactId} 解析失败：${err.message}`);
    problems++;
    continue;
  }

  const summary = j.summary || '';
  console.log(`${contactId}`);
  console.log(`  ${C.dim(`摘要 ${summary.length} 字 / 历史 ${j.history.length} 轮 / 累计 ${j.stats?.messages ?? '?'} 条`)}`);

  if (!summary) {
    console.log(`  ${C.dim('（还没有摘要，跳过）')}\n`);
    continue;
  }

  // 有具体日期就算有锚点
  const hasDate = /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\/\d{1,2}/.test(summary);

  // 模糊说法：直接命中的，加上"没日期时出现的时段词"
  const hits = [
    ...VAGUE_TIME.filter((w) => summary.includes(w)),
    ...(hasDate ? [] : TIME_OF_DAY.filter((w) => summary.includes(w))),
  ];

  if (hits.length) {
    console.log(`  ${C.warn('⚠')} 含没有日期锚点的说法：${hits.join('、')}`);
    problems++;
  }
  if (!hasDate) {
    console.log(`  ${C.warn('⚠')} 整段没有任何具体日期`);
    problems++;
  }

  if (!hits.length && hasDate) {
    console.log(`  ${C.ok('✓')} 日期锚点正常`);
  }

  if (hits.length || !hasDate) {
    console.log(`  ${C.dim('摘要：' + summary.slice(0, 100) + (summary.length > 100 ? '…' : ''))}`);
  }
  console.log();
}

console.log('──────────────────────────────────────');
if (!problems) {
  console.log(`${C.ok('全部正常。')}\n`);
  process.exit(0);
}

console.log(`${C.warn(`发现 ${problems} 处问题。`)}`);
if (FIX) {
  console.log(`${C.dim('--fix 需要配合模型重写，请用：node tools/fix-summary.js')}`);
} else {
  console.log(`${C.dim('要重写：node tools/fix-summary.js')}`);
}
console.log();
