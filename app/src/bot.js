#!/usr/bin/env node
/**
 * 陪伴体 QQ 机器人入口。
 *
 *   node src/bot.js                   用 config.json 启动
 *   node src/bot.js --config my.json
 *   node src/bot.js --dry             只连 NapCat，不真的发消息（首次必跑）
 *
 * 首次部署请务必先 --dry 跑一次，确认能看到消息、但不会误发出去。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Companion } from './companion.js';
import { NapCat } from './napcat.js';
import { createLlm } from './llm.js';
import { QQBridge, DEFAULT_CONFIG } from './bridge.js';

const args = process.argv.slice(2);
const getFlag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const DRY = args.includes('--dry');

const configPath = getFlag('--config', new URL('../config.json', import.meta.url).pathname);

let config;
if (existsSync(configPath)) {
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
    console.log(`[bot] 已读取配置 ${configPath}`);
  } catch (err) {
    console.error(`[bot] 配置解析失败：${err.message}`);
    process.exit(1);
  }
} else {
  console.warn(`[bot] 没找到 ${configPath}，使用默认配置（白名单为空，不会回复任何人）`);
  config = {};
}

/**
 * 按联系人分人格。
 *
 * config.json 里可以写：
 *   "personas": {
 *     "qq-1234567891": { "persona": "persona/persona-alt.md" }
 *   }
 *
 * 路径相对 companion/ 目录。没配到的联系人用默认人格（persona/persona.md）。
 * 这样多个 QQ 号可以各自面对不同的"她"，记忆本来就已经分开了。
 */
function resolvePersonaMap(raw = {}) {
  const base = new URL('../', import.meta.url).pathname;
  const out = {};
  for (const [contactId, entry] of Object.entries(raw)) {
    out[contactId] = {
      persona: entry.persona ? base + entry.persona : undefined,
      style: entry.style ? base + entry.style : undefined,
    };
  }
  return out;
}

const companion = new Companion({
  // 默认存 data/，测试可用 DSH_COMPANION_DATA 指向隔离目录
  dataDir: process.env.DSH_COMPANION_DATA
    ?? new URL('../data/', import.meta.url).pathname,
  // 后端由 config.json 的 backend 字段或 COMPANION_BACKEND 决定
  llm: await createLlm(config),
  personaMap: resolvePersonaMap(config.personas),
});

const napcat = new NapCat(config.napcat ?? DEFAULT_CONFIG.napcat);

const bridge = new QQBridge({ companion, napcat, config });

// 提醒触发时：让她主动发消息
// 注意：必须设置 companion.reminders.onFire，而不是 companion.onReminderFire，
// 因为 Scheduler 会动态读取这个回调。
companion.reminders.onFire = async (reminder) => {
  const { contactId, content } = reminder;
  if (!bridge.config.allowlist.includes(Number(contactId.replace(/^qq-/, '')))) {
    console.log(`[reminder] 忽略非白名单联系人: ${contactId}`);
    return;
  }
  try {
    const parts = content
      ? [content]
      : await companion.initiate(contactId, '到点了，该提醒他了');
    const target = Number(contactId.replace(/^qq-/, ''));
    await bridge.sendParts(contactId, parts, target, false);

    // 关键：把「提醒已经发生」写进记忆。
    //
    // 为什么必须写：提醒内容（比如"十点了，该睡了"）本身会进历史，
    // 但那是她说的话，模型不认为它是"事实"。结果 22:01 她已经提醒过了，
    // 下一轮还会说"十点我喊你"——把已经过去的事当成将来的约定。
    // 记成 fact 之后，她就能查到「这件事已经做过了」。
    const d = new Date(reminder.fireAt ?? Date.now());
    const stamp = `${d.getMonth() + 1}月${d.getDate()}日${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await companion.memory.remember(contactId, {
      key: `reminded_${d.getMonth() + 1}${d.getDate()}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`,
      text: `${stamp} 已经提醒过他：${reminder.reason || content || '到点了'}`,
      type: 'event',
      confidence: 1.0,
      source: { extractor: 'reminder.onFire' },
    });

    console.log(`[reminder] 已提醒 ${contactId}`);
  } catch (err) {
    console.error(`[reminder] 提醒发送失败: ${err.message}`);
  }
};

if (DRY) {
  // 干跑：只记录打算发什么，不真的发
  bridge.sendParts = async (contactId, parts) => {
    console.log(`\x1b[33m[dry] 本来会发给 ${contactId}：\x1b[0m`);
    for (const p of parts ?? []) console.log(`        ${p}`);
  };
}

console.log(`[bot] 启动（${DRY ? '干跑模式' : '正式模式'}）`);

// 启动前恢复未完成的提醒
const { restored, expired } = await companion.reminders.restore();
if (restored || expired) {
  console.log(`[bot] 恢复提醒：${restored} 个未过期，${expired} 个已过期触发`);
}

await bridge.start();

const shutdown = async (sig) => {
  console.log(`\n[bot] 收到 ${sig}，正在退出…`);
  try {
    await bridge.stop();
  } catch (err) {
    console.error(`[bot] 退出时出错: ${err.message}`);
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('[bot] 未处理的 Promise 拒绝:', err?.message ?? err);
});
