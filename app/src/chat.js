#!/usr/bin/env node
/**
 * 本地试聊。先确认"她像不像"，再谈接 QQ。
 *
 *   node src/chat.js            跟她说
 *   node src/chat.js --contact me
 *   node src/chat.js --once "睡不着"
 *   node src/chat.js --initiate "他三天没来了"
 *
 * 输入 /quit 退出，/facts 看她记得你什么，/reset 清空这条记忆线。
 */

import { createInterface } from 'node:readline/promises';
import { rm, readFile } from 'node:fs/promises';
import { Companion } from './companion.js';
import { createLlm } from './llm.js';

const args = process.argv.slice(2);
const getFlag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);
/** --dry：只生成，不写记忆。调试 --initiate 时务必带上。 */
const DRY = has('--dry');

const contactId = getFlag('--contact', 'local');
// 后端可由 --backend workbuddy 或 COMPANION_BACKEND 环境变量切换
const backendIdx = args.indexOf('--backend');
const backend = backendIdx >= 0 ? args[backendIdx + 1] : undefined;

// 跟 bot.js 走同一份配置：模型也从 config.json 读。
// 否则试聊会用 llm.js 的硬编码默认模型，跟线上不是同一个——
// 出现过"线上换了模型，试聊还在打旧账号（余额已耗尽）"的情况。
let fileConfig = {};
try {
  fileConfig = JSON.parse(
    await readFile(new URL('../config.json', import.meta.url), 'utf8'),
  );
} catch {
  // 没有 config.json 就用默认
}

const companion = new Companion({
  dataDir: new URL('../data/', import.meta.url).pathname,
  llm: await createLlm({ ...fileConfig, ...(backend ? { backend } : {}) }),
});

/** 她一条一条发，这里模拟出消息气泡的节奏 */
async function say(parts) {
  for (const [i, p] of parts.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 320));
    console.log(`\x1b[38;5;80m她\x1b[0m  ${p}`);
  }
}

/** 一次性调用：出错时给人话，不吐堆栈 */
async function runOnce(fn) {
  try {
    await say(await fn());
    process.exit(0);
  } catch (err) {
    console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m\n`);
    // 后端类错误给一句下一步怎么做
    if (/WorkBuddy/i.test(err.message)) {
      console.error('  你用的是 WorkBuddy 后端。先打开 WorkBuddy 应用完成登录，');
      console.error('  然后跑：node test/check-workbuddy.js');
      console.error();
    }
    process.exit(1);
  }
}

const once = getFlag('--once');
if (once) {
  await runOnce(() => companion.reply(contactId, once, { dryRun: DRY }));
}

const initiateReason = getFlag('--initiate');
if (initiateReason) {
  // --dry：只生成，不写进记忆。调试主动发起时务必带上，
  // 否则一次试验就会混进你们真实的对话历史。
  await runOnce(() => companion.initiate(contactId, initiateReason, { dryRun: DRY }));
}

console.log('\x1b[2m本地试聊。她记得你，也知道现在几点。/facts 看记忆，/reset 清空，/quit 退出。\x1b[0m\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });

for (;;) {
  let line;
  try {
    line = (await rl.question('\x1b[38;5;114m你\x1b[0m  ')).trim();
  } catch {
    break; // Ctrl-D
  }

  if (!line) continue;
  if (line === '/quit' || line === '/exit') break;

  if (line === '/facts') {
    const facts = await companion.memory.renderFacts(contactId);
    console.log(facts ? `\n\x1b[2m${facts}\x1b[0m\n` : '\x1b[2m（还没记住什么）\x1b[0m\n');
    continue;
  }

  if (line === '/reset') {
    await rm(companion.memory.pathFor(contactId), { force: true });
    companion.memory.cache.delete(contactId);
    console.log('\x1b[2m（记忆已清空）\x1b[0m\n');
    continue;
  }

  try {
    await say(await companion.reply(contactId, line));
    await companion.maybeSummarize(contactId);
    console.log();
  } catch (err) {
    console.error(`\x1b[31m[错误] ${err.message}\x1b[0m\n`);
  }
}

rl.close();
console.log('\x1b[2m（结束）\x1b[0m');
