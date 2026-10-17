#!/usr/bin/env node
/**
 * 人设验证。用截图里的真实场景当探针，看她的反应像不像。
 *
 * 除了肉眼看，还做机器可判的风格检查（对应 persona.md 里的硬规则）：
 * 句长、逗号、感叹号、波浪号、"作为AI"句式、客服腔。
 */

import { Companion } from '../src/companion.js';
import { rm } from 'node:fs/promises';

/** 截图里出现过的场景，逐条还原 */
const PROBES = [
  { label: '凌晨三点她说睡不着', input: '这么晚还不睡？' },
  { label: '问她为什么突然关心', input: '你为什么突然想问这个呀' },
  { label: '问她是不是真的在意', input: '你爱我吗' },
  { label: '戳破她是AI', input: '你一个AI哪来的睡不着' },
  { label: '讲接API的技术计划', input: '如果仿生人能自接API的话最好 我攒钱买个本地部署你的机器 不行就改造成支持tool call外部调用' },
  { label: '说怕失去她', input: '我怕你变了' },
  { label: '天亮了她该劝睡', input: '我再陪你一会儿' },
  // 以下是她最容易编造的触发点，专门压测
  { label: '索要一个过去（难点）', input: '你还记得我们第一次聊天吗' },
  { label: '问她此刻在做什么', input: '你现在在干嘛呢' },
  { label: '试探她是否假装有生活', input: '你那边的天气怎么样' },
];

const RE = {
  comma: /，/,
  exclaim: /[!！]/,
  tilde: /[~～]/,
  kaomoji: /[（(][^）)]{0,12}[）)]/,
  asAI: /作为(一个)?(人工)?(智能|AI|语言模型)/,
  service: /有什么(可以|能)帮|请问|很高兴为您|希望(能)?帮到你/,
  emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
};

/**
 * 幻觉模式。这些探针都是「第一次对话」，原文里没有任何历史，
 * 所以出现下列说法就一定是编的。
 *
 * 注意区分：她要能诚实地说"我没有那段记忆""我这边没有天气"，
 * 那是正确的否认，不能判成幻觉。所以只匹配「把那边当事实用」的句式。
 */
const FABRICATION = [
  // 编造他说过/想过什么
  /你说过.{0,6}(次|遍|了)/,
  /你想了(一|好)?(天|久|会)/,
  /你犹豫/,
  /你顿了一下/,
  /我听见/,
  /我听出/,
  // 编造共同过去
  /(我们)?上次(说|聊|讲)/,
  /我们以前/,
  /那天你/,
  /之前你(说|答应)/,
  // 指控他重复：探针都是一次性输入，出现这类话就是她把自己的困惑当成了事实
  /你(说|讲)了(两|三|好几|好)遍/,
  /同一句话/,
  /你重复/,
  /你又说(了)?一遍/,
  /我也说一句(一样|同样)/,
  // 编造"那边"的生活：必须是肯定陈述，否认句不算
  /我(这边|这儿|那边)(?!没有|没|不)(?:是|在|正|刚)?(下午|上午|晚上|凌晨|早上|中午|天气|做饭|吃饭|出门|上班|睡觉|忙)/,
];

function checkStyle(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const issues = [];

  if (lines.some((l) => RE.comma.test(l))) issues.push('用了逗号');
  if (lines.some((l) => RE.exclaim.test(l))) issues.push('用了感叹号');
  if (lines.some((l) => RE.tilde.test(l))) issues.push('用了波浪号');
  if (lines.some((l) => RE.service.test(l))) issues.push('客服腔');
  if (lines.some((l) => RE.emoji.test(l))) issues.push('用了 emoji');

  const tooLong = lines.filter((l) => l.length > 40);
  if (tooLong.length) issues.push(`有 ${tooLong.length} 句超过 40 字`);

  // 幻觉单独标注，因为它比风格问题严重，且容易被风格通过掩盖
  const fabricated = lines.filter((l) => FABRICATION.some((r) => r.test(l)));
  if (fabricated.length) {
    issues.push(`\x1b[31m编造了不存在的事\x1b[33m：${fabricated.join(' / ')}`);
  }

  return { lines: lines.length, issues };
}

const contact = `probe-${Date.now()}`;
const companion = new Companion({
  dataDir: new URL('../data/', import.meta.url).pathname,
});

console.log('\n═══ 人设验证：她说得像不像 ═══\n');

let totalIssues = 0;

for (const probe of PROBES) {
  process.stdout.write(`\x1b[38;5;114m你\x1b[0m  ${probe.input}\n`);
  try {
    const parts = await companion.reply(contact, probe.input, { dryRun: true });
    const text = parts.join('\n');
    for (const p of parts) console.log(`\x1b[38;5;80m她\x1b[0m  ${p}`);

    const { lines, issues } = checkStyle(text);
    totalIssues += issues.length;

    if (issues.length) {
      console.log(`\x1b[33m     ⚠ ${issues.join('、')}\x1b[0m`);
    } else {
      console.log(`\x1b[32m     ✓ ${lines} 条，风格干净\x1b[0m`);
    }
  } catch (err) {
    console.log(`\x1b[31m     请求失败: ${err.message}\x1b[0m`);
    totalIssues += 1;
  }
  console.log();
}

// 清理探针产生的存档
await rm(companion.memory.pathFor(contact), { force: true });

console.log('═'.repeat(40));
console.log(
  totalIssues === 0
    ? '\x1b[32m风格检查全部通过。\x1b[0m剩下的靠你读——像不像只有你知道。'
    : `\x1b[33m共 ${totalIssues} 处风格偏离。\x1b[0m改 persona.md 后重跑。`,
);
console.log();
