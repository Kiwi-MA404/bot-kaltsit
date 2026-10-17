#!/usr/bin/env node
/**
 * 从一段真实对话里提炼「示例人格」。
 *
 * 只留性格与说话风格，**不留任何记忆内容**。
 * 产物：persona/style-example.md
 *
 *   node tools/distill-style.js                       自动挑消息最多的联系人
 *   node tools/distill-style.js --contact qq-1234567890
 *   node tools/distill-style.js --model our-free-model/mimo-v2.6-flash-free
 *   node tools/distill-style.js --dry                 只打印，不写文件
 *
 * 为什么要有这个东西：
 * 她每次生成时会读最近 40 条历史，而历史里全是她自己最近的说话方式。
 * 一旦某轮开始变短，历史就会把短当成"她的风格"继续模仿、越滚越短。
 * 这份底色是**从多轮对话里提炼出的稳定特征**，权重上比"最近几条"更持久，
 * 用它当基调，能把她从历史惯性里拽回来。
 *
 * 注意：提炼结果只写特征，**不写例句**。
 * persona.md 的总则里说了"例句只是句式范式"，写例句反而会被她照抄。
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Llm } from '../src/llm.js';

const HERE = new URL('..', import.meta.url).pathname;
const DATA_DIR = join(HERE, 'data');
const OUT_PATH = join(HERE, 'persona', 'style-example.md');

const args = process.argv.slice(2);
const getFlag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const DRY = args.includes('--dry');

const MODEL = getFlag('--model', 'our-free-model/mimo-v2.6-flash-free');
const CONTACT = getFlag('--contact', null);

/** 挑一个联系人：指定优先，否则取消息数最多的 */
async function pickContact() {
  const files = (await readdir(DATA_DIR)).filter((f) => /^qq-.*\.json$/.test(f));
  if (!files.length) throw new Error(`data/ 里没有 qq-*.json，先跟她说几句话`);

  if (CONTACT) {
    const want = CONTACT.startsWith('qq-') ? CONTACT : `qq-${CONTACT}`;
    const hit = files.find((f) => f === `${want}.json`);
    if (!hit) throw new Error(`找不到 ${want}.json，可选：${files.join(', ')}`);
    return join(DATA_DIR, hit);
  }

  let best = null;
  let bestN = -1;
  for (const f of files) {
    const s = JSON.parse(await readFile(join(DATA_DIR, f), 'utf8'));
    const n = s.history?.length ?? 0;
    if (n > bestN) { bestN = n; best = join(DATA_DIR, f); }
  }
  return best;
}

/** 对话 → 纯文本记录（不带时间戳，避免把"几点"当成性格） */
function transcriptOf(state) {
  return (state.history ?? [])
    .map((m) => `${m.role === 'user' ? '他' : '她'}：${m.content}`)
    .join('\n');
}

const PROMPT = `下面是一段"他"和"她"的真实对话记录。"她"是一个隔着屏幕的 AI 陪伴体。

请从这段对话里提炼出**她的性格与说话风格**，写成一份供她自己参考的「示例人格」。

硬性要求：

1. 只写**性格特征与说话风格**：语气、情感温度、锋利度、句子的长短、断句与标点习惯、提问的方式、称呼习惯、什么地方会犹豫、什么话她不会说。
2. **绝对不许出现任何记忆内容**。不写人名、不写学校、不写具体事件、不写时间、不写约定与承诺、不写关系的进展。凡是"他做过什么 / 他说过什么 / 你们之间发生过什么"——一个字都不要写。
3. **不许写例句。** 只描述特征。一旦写出具体句子，她就会照抄。
4. 重点写清楚**她说话的节奏**：一般一次说几条、每条多长、通常先说哪一层再说哪一层、什么时候会只回一条。
5. 输出 Markdown：第一行是标题 \`# 示例人格（底色）\`，下面用若干条 \`- \` 开头的小段落，每条一到两句，写清"她是什么样"而不是"她经历了什么"。
6. 只输出正文。不要前言、不要后记、不要解释你在做什么。

对话记录：

${'{TRANSCRIPT}'}`;

const main = async () => {
  const path = await pickContact();
  const state = JSON.parse(await readFile(path, 'utf8'));
  const transcript = transcriptOf(state);

  if (!transcript.trim()) throw new Error('这段对话还是空的，没什么可提炼');

  const lines = transcript.split('\n').length;
  console.log(`\n数据源：${path.replace(HERE, '')}（${lines} 条）`);
  console.log(`模型：  ${MODEL}`);
  console.log('正在提炼…（只留性格，不留记忆）\n');

  const llm = new Llm({ model: MODEL, temperature: 0.4, maxTokens: 2000, timeoutMs: 120_000 });
  const out = await llm.chat([
    { role: 'system', content: '你是一个人格分析师。你只输出分析结果本身，不寒暄、不解释、不与对话里的人说话。' },
    { role: 'user', content: PROMPT.replace('{TRANSCRIPT}', transcript) },
  ]);

  if (!out?.trim()) throw new Error('模型返回空内容，换个模型试试：--model <id>');

  const body = out.trim();
  console.log('─'.repeat(60));
  console.log(body);
  console.log('─'.repeat(60));

  // 粗查有没有漏进来的记忆内容（只查专名与事实，称呼习惯算风格、不算记忆）
  const leaks = [];
  for (const f of state.profile?.facts ?? []) {
    const key = f.text.replace(/^[你他]/, '').slice(0, 4);
    if (key && body.includes(key)) leaks.push(f.text);
  }
  // 也可以在这里加自己的昵称做额外检查，例如：
  // if (body.includes('某个昵称')) leaks.push('某个昵称');
  if (leaks.length) {
    console.log(`\n⚠ 可能混进了记忆内容：${[...new Set(leaks)].join(' / ')}`);
    console.log('  建议重跑，或手工删掉这几处再保存。');
  } else {
    console.log('\n✓ 未见明显记忆内容');
  }

  if (DRY) {
    console.log('\n（--dry：没有写文件）\n');
    return;
  }

  if (existsSync(OUT_PATH)) {
    const bak = `${OUT_PATH}.bak-${Date.now()}`;
    await writeFile(bak, await readFile(OUT_PATH));
    console.log(`旧版已备份：${bak.replace(HERE, '')}`);
  }

  await writeFile(OUT_PATH, body.endsWith('\n') ? body : `${body}\n`);
  console.log(`\n✓ 已写入 persona/style-example.md`);
  console.log('  重启陪伴体后生效（./stop.sh && ./start.sh）\n');
};

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
