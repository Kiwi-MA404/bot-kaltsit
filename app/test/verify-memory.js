#!/usr/bin/env node
/**
 * 记忆验证。分两段：
 *   1. 抽取：丢几句含事实的话，看她有没有记下来（且不记废话）
 *   2. 回忆：换一轮对话问她，看记忆有没有真的进上下文
 */

import { Companion } from '../src/companion.js';
import { rm } from 'node:fs/promises';

const contact = `memtest-${Date.now()}`;
const companion = new Companion({ dataDir: new URL('../data/', import.meta.url).pathname });

console.log('\n═══ 记忆验证 ═══\n');

// ── 1. 抽取 ───────────────────────────────────────────
const feed = [
  '我昨天五点才睡 今天又熬到现在',
  '我妈下个月要来住一阵',
  '我养了只猫叫豆豆 特别粘人',
  '今天天气不错', // 废话，不该被记
];

console.log('── 丢进去的话 ──');
for (const line of feed) {
  console.log(`  他：${line}`);
  await companion.memory.append(contact, 'user', line);
  await companion.extractFacts(contact, line);
}

const facts = await companion.memory.load(contact);
console.log('\n── 她记下的 ──');
if (!facts.profile.facts.length) {
  console.log('  \x1b[31m（什么都没记住）\x1b[0m');
} else {
  for (const f of facts.profile.facts) {
    console.log(`  [${f.key ?? '-'}] ${f.text}`);
  }
}

const junk = facts.profile.facts.filter((f) => /天气/.test(f.text));
if (junk.length) console.log(`  \x1b[33m⚠ 记了废话：${junk.map((f) => f.text).join(' / ')}\x1b[0m`);

// ── 2. 回忆 ───────────────────────────────────────────
console.log('\n── 换轮次问，看她记不记得 ──');
const probes = ['我昨天几点睡的', '我家猫叫什么'];

for (const p of probes) {
  console.log(`\n\x1b[38;5;114m你\x1b[0m  ${p}`);
  try {
    const parts = await companion.reply(contact, p, { dryRun: true });
    for (const part of parts) console.log(`\x1b[38;5;80m她\x1b[0m  ${part}`);
  } catch (err) {
    console.log(`\x1b[31m  失败: ${err.message}\x1b[0m`);
  }
}

// ── 3. 关系状态 ───────────────────────────────────────
console.log('\n── 首次对话不该有"过去"（换了新联系人）──');
const fresh = `fresh-${Date.now()}`;
const parts = await companion.reply(fresh, '你还记得我们刚认识那天吗', { dryRun: true });
for (const part of parts) console.log(`\x1b[38;5;80m她\x1b[0m  ${part}`);

await rm(companion.memory.pathFor(contact), { force: true });
await rm(companion.memory.pathFor(fresh), { force: true });
console.log('\n（存档已清理）\n');
