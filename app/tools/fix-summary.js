#!/usr/bin/env node
/**
 * 用模型重写有问题的摘要，把相对时间说法换成具体日期。
 *
 *   node tools/fix-summary.js                # 处理所有
 *   node tools/fix-summary.js qq-1234567890  # 只处理一个
 *   node tools/fix-summary.js --dry          # 只看会改成什么，不写回
 *
 * 背景：摘要是长期记忆的唯一载体（原文被切掉了，只留归档）。
 * 一旦摘要里出现"次日""后来"这种没有锚点的说法，
 * 后面读的人（包括她自己）就会搞错时间。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLlm } from '../src/llm.js';

const DIR = new URL('../data/', import.meta.url).pathname;
const DRY = process.argv.includes('--dry');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const VAGUE = ['次日', '第二天', '隔天', '翌日', '后来', '过了几天', '前几天', '那天', '昨天', '今天', '明天'];
const TIME_OF_DAY = ['早上', '上午', '中午', '下午', '晚上', '深夜', '凌晨', '清晨'];

const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => /^qq-\d+\.json$/.test(f))
  : [];

if (!files.length) {
  console.log('\n没有找到记忆文件。\n');
  process.exit(0);
}

// 直接读 config.json，跟 bot.js 走同一个模型
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const llm = await createLlm(config);

console.log(`\n═══ 重写摘要 ${DRY ? '（干跑，不写回）' : ''} ═══`);
console.log(`${C.dim(`模型：${llm.model ?? '(默认)'}\n`)}`);

const now = new Date();
const todayCn = `${now.getMonth() + 1} 月 ${now.getDate()} 日`;

let changed = 0;

for (const f of files) {
  const contactId = f.replace(/\.json$/, '');
  if (filter && !contactId.includes(filter)) continue;

  const path = join(DIR, f);
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const old = j.summary || '';
  if (!old) continue;

  const hits = VAGUE.filter((w) => old.includes(w));
  const hasDate = /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\/\d{1,2}/.test(old);
  if (!hits.length && hasDate) {
    console.log(`${C.dim(`${contactId} 无需处理`)}`);
    continue;
  }

  console.log(`\n${contactId}`);
  console.log(`  ${C.warn('问题：')}${hits.length ? hits.join('、') : '没有日期'}`);

  const prompt = `下面是一段关系记忆的摘要。它用了"次日""后来"这类没有日期锚点的说法，
读的人会搞错时间。请改写：
1. 把所有相对时间换成**具体日期**（今天是 ${todayCn}）
2. 保留原本的事实和关系进展，不要新增、不要删减信息
3. 不超过 200 字，第三人称
4. 不要用"次日""第二天""后来""那天"这类相对说法

原文：
${old}`;

  let fixed;
  try {
    fixed = await llm.chat([{ role: 'user', content: prompt }], {
      temperature: 0,
      maxTokens: 400,
      reasoningEffort: 'none',
    });
  } catch (err) {
    console.log(`  ${C.bad('✗ 生成失败：')}${err.message.slice(0, 80)}`);
    continue;
  }

  if (!fixed || fixed.length < 20) {
    console.log(`  ${C.bad('✗ 生成结果无效，跳过')}`);
    continue;
  }

  console.log(`  ${C.dim('旧：' + old.slice(0, 80) + '…')}`);
  console.log(`  ${C.ok('新：' + fixed.slice(0, 80) + '…')}`);

  if (DRY) {
    console.log(`  ${C.dim('（干跑，未写回）')}`);
  } else {
    // 写回前留个备份，改坏了能退
    const bak = `${path}.summary-bak-${Date.now()}`;
    writeFileSync(bak, JSON.stringify(j, null, 2), 'utf8');
    j.summary = fixed;
    writeFileSync(path, JSON.stringify(j, null, 2), 'utf8');
    console.log(`  ${C.ok('✓ 已写回')} ${C.dim(`（备份：${bak.split('/').pop()}）`)}`);
  }
  changed++;
}

console.log('\n──────────────────────────────────────');
console.log(changed ? `${C.ok(`处理了 ${changed} 条摘要。`)}\n` : `${C.dim('没有需要处理的。')}\n`);
