#!/usr/bin/env node
/**
 * 端到端联调：用模拟的 NapCat 验证整条链路。
 *
 * 不需要真 QQ 号。这个脚本假扮成 NapCat，主动连上 bot 的 WebSocket 服务器，
 * 推一个真实的 OneBot 11 私聊事件，然后断言：
 *   1. bot 调了 get_login_info
 *   2. bot 把回复按条发了回来，每条都是 send_private_msg
 *   3. 非白名单的人被忽略
 *   4. 白名单里的消息真的走了模型（内容不是空的）
 *
 * 这样接真 NapCat 时，链路问题已经排除，只剩配置问题。
 */

import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 31337;
// 用固定联系人，但记忆目录是隔离的：每次跑都是全新关系，
// 避免上一次测试的对话被记住，污染断言。
const ALLOWED = 10001;
const STRANGER = 99999;

const tmp = await mkdtemp(join(tmpdir(), 'companion-e2e-'));
const configPath = join(tmp, 'config.json');
const statePath = join(tmp, 'qq-state.json');
const dataDir = join(tmp, 'data');

await writeFile(
  configPath,
  JSON.stringify({
    napcat: { mode: 'ws-reverse', port: PORT, host: '127.0.0.1', accessToken: '' },
    allowlist: [ALLOWED],
    groups: [],
    send: { minGapMs: 80 }, // 测试里缩短间隔
    initiate: { enabled: false },
  }),
  'utf8',
);

console.log('\n═══ 端到端联调（模拟 NapCat）═══\n');

const bot = spawn(process.execPath, ['src/bot.js', '--config', configPath], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    DSH_QQ_STATE: statePath,
    DSH_COMPANION_DATA: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const botLog = [];
bot.stdout.on('data', (d) => botLog.push(d.toString()));
bot.stderr.on('data', (d) => botLog.push(d.toString()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等服务起来 */
await wait(1500);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const received = [];
let loginInfoAsked = false;

ws.on('message', (buf) => {
  let msg;
  try {
    msg = JSON.parse(buf.toString());
  } catch {
    return;
  }

  if (msg.action === 'get_login_info') loginInfoAsked = true;

  received.push(msg);

  // 所有 API 调用都要回执，否则 bot 会等到超时
  if (msg.echo) {
    let data = {};
    if (msg.action === 'get_login_info') data = { user_id: 38888, nickname: '测试号' };
    if (msg.action === 'send_private_msg') data = { message_id: received.length };
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
  }
});

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
  setTimeout(() => reject(new Error('连不上 bot 的 WebSocket 服务器')), 5000);
});

console.log('✓ 已连上 bot');

// 先给个生命周期事件，让 bot 知道 self_id
ws.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 38888,
  post_type: 'meta_event',
  meta_event_type: 'lifecycle',
  sub_type: 'connect',
}));

await wait(300);
console.log(loginInfoAsked ? '✓ bot 调用了 get_login_info' : '✗ bot 没有调用 get_login_info');

// ── 测试 1：非白名单应当被忽略 ──
console.log('\n── 测试 1：陌生人发消息（应被忽略）──');
ws.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 38888,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 1,
  user_id: STRANGER,
  raw_message: '你好呀',
  message: [{ type: 'text', data: { text: '你好呀' } }],
  sender: { user_id: STRANGER, nickname: '陌生人' },
}));

await wait(2500);
const strangerReply = received.filter(
  (m) => m.action === 'send_private_msg' && m.params?.user_id === STRANGER,
);
console.log(strangerReply.length === 0
  ? '✓ 陌生人被正确忽略'
  : `\x1b[31m✗ 竟然回了陌生人 ${strangerReply.length} 条\x1b[0m`);

// ── 测试 2：白名单 + 真实模型 ──
console.log('\n── 测试 2：白名单用户发消息（应走模型并回复）──');
const before = received.filter((m) => m.action === 'send_private_msg').length;

ws.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 38888,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 2,
  user_id: ALLOWED,
  raw_message: '我今天又熬夜了 三点才睡',
  message: [{ type: 'text', data: { text: '我今天又熬夜了 三点才睡' } }],
  sender: { user_id: ALLOWED, nickname: '他' },
}));

// 等模型 + 逐条发送
await wait(30_000);

const replies = received.filter(
  (m) => m.action === 'send_private_msg' && m.params?.user_id === ALLOWED,
);

console.log(`\n收到 ${replies.length} 条回复：`);
for (const r of replies) {
  const text = typeof r.params.message === 'string'
    ? r.params.message
    : r.params.message?.map((s) => s.data?.text ?? '').join('');
  console.log(`  \x1b[38;5;80m她\x1b[0m  ${text}`);
}

console.log('\n── 断言 ──');
const checks = [
  ['忽略非白名单', strangerReply.length === 0],
  ['调用了 get_login_info', loginInfoAsked],
  ['有回复发出', replies.length > 0],
  ['回复内容非空', replies.every((r) => {
    const t = typeof r.params.message === 'string' ? r.params.message : '';
    return t.length > 0;
  })],
  ['回复条数合理(<=12)', replies.length <= 12],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${name}\x1b[0m`);
  if (!ok) failed++;
}

// ── 干跑模式的日志留痕（便于排查）──
if (failed) {
  console.log('\n── bot 日志 ──');
  console.log(botLog.join('').split('\n').slice(-30).join('\n'));
}

ws.close();
bot.kill('SIGTERM');
await wait(500);
await rm(tmp, { recursive: true, force: true });

console.log(failed === 0
  ? '\n\x1b[32m端到端通过。链路没问题，接真 NapCat 只需改配置。\x1b[0m\n'
  : `\n\x1b[31m${failed} 项失败。\x1b[0m\n`);

process.exit(failed === 0 ? 0 : 1);
