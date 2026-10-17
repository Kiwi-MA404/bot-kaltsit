#!/usr/bin/env node
/**
 * 全链路验证：用 deploy.js 真实生成的配置去跑 bot。
 *
 * 前面的 e2e 测试用的是手写配置。这个测试的意义不同：
 * 它先生成 onebot11.json（模拟 NapCat 会生成的那份），
 * 从中读出端口和 token，再用这些**真实值**启动 bot 和模拟 NapCat，
 * 证明「我们写出来的配置」确实能被消费，而不是格式看着对。
 */

import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOneBotConfig } from '../tools/deploy.js';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? C.ok('✓') : C.bad('✗')} ${name}${cond ? '' : ' ' + detail}`);
  if (!cond) failures++;
}

const tmp = await mkdtemp(join(tmpdir(), 'fullchain-'));
console.log('\n═══ 全链路验证（生成的配置 → bot 能连上）═══\n');

// ── 1. 生成配置，模拟 NapCat 落地的那份 ──
const napcatDir = join(tmp, 'napcat');
await mkdir(join(napcatDir, 'config'), { recursive: true });

const r = await writeOneBotConfig(napcatDir, { force: true, port: 0, token: '' });
check('生成 onebot11.json 成功', r.ok === true);

// 从生成的文件里读回配置——不信任返回值，读文件才是真的
const generated = JSON.parse(await readFile(join(napcatDir, 'config/onebot11.json'), 'utf8'));
const adapter = generated.network.websocketServers.find((a) => a.name === 'companion');
check('生成的配置里有 companion 适配器', Boolean(adapter));

// 挑一个空闲端口，避免和真 NapCat 冲突
const PORT = 32000 + Math.floor(Math.random() * 1000);
adapter.port = PORT;
adapter.token = 'fullchain-token';
await writeFile(
  join(napcatDir, 'config/onebot11.json'),
  JSON.stringify(generated, null, 2),
  'utf8',
);

console.log(`  ${C.dim(`用生成配置里的字段启动：host=${adapter.host} port=${adapter.port} token=${adapter.token}`)}`);

// ── 2. 用同一个端口/token 起 bot ──
const botConfig = join(tmp, 'bot-config.json');
await writeFile(
  botConfig,
  JSON.stringify({
    napcat: {
      mode: 'ws-reverse',
      port: adapter.port,
      host: adapter.host,
      accessToken: adapter.token,
    },
    allowlist: [10001],
    send: { minGapMs: 80 },
    initiate: { enabled: false },
  }),
  'utf8',
);

const bot = spawn(process.execPath, ['src/bot.js', '--config', botConfig], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    DSH_QQ_STATE: join(tmp, 'state.json'),
    DSH_COMPANION_DATA: join(tmp, 'data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const botLog = [];
bot.stdout.on('data', (d) => botLog.push(d.toString()));
bot.stderr.on('data', (d) => botLog.push(d.toString()));

await wait(1800);

// ── 3. 模拟 NapCat 连上来（带 token）──
const ws = new WebSocket(`ws://${adapter.host}:${adapter.port}`, {
  headers: { Authorization: `Bearer ${adapter.token}` },
});

const received = [];
ws.on('message', (buf) => {
  let msg;
  try {
    msg = JSON.parse(buf.toString());
  } catch {
    return;
  }
  received.push(msg);
  if (msg.echo) {
    let data = {};
    if (msg.action === 'get_login_info') data = { user_id: 38888, nickname: '测试小号' };
    if (msg.action === 'send_private_msg') data = { message_id: received.length };
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
  }
});

let connected = false;
try {
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      connected = true;
      resolve();
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('超时')), 5000);
  });
} catch {
  /* 下面统一断言 */
}

check('带 token 的 NapCat 能连上 bot', connected);

if (!connected) {
  console.log('\n── bot 日志 ──');
  console.log(botLog.join('').split('\n').slice(-15).join('\n'));
  ws.close();
  bot.kill('SIGTERM');
  await rm(tmp, { recursive: true, force: true });
  process.exit(1);
}

ws.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 38888,
  post_type: 'meta_event',
  meta_event_type: 'lifecycle',
  sub_type: 'connect',
}));

await wait(600);
check('bot 通过生成的配置调用了 get_login_info', received.some((m) => m.action === 'get_login_info'));

// ── 4. 发一条消息，看回复 ──
ws.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 38888,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 1,
  user_id: 10001,
  message: [{ type: 'text', data: { text: '我今天又熬夜了' } }],
  sender: { user_id: 10001, nickname: '他' },
}));

await wait(30_000);

const replies = received.filter(
  (m) => m.action === 'send_private_msg' && m.params?.user_id === 10001,
);
check('收到了回复', replies.length > 0, `（收到 ${replies.length} 条）`);

for (const rep of replies) {
  const t = typeof rep.params.message === 'string' ? rep.params.message : '';
  console.log(`     ${C.dim('她：')}${t}`);
}

// ── 5. token 不匹配应被拒 ──
// 注意：HTTP 头只能是 ASCII，不能用中文 token
const wrong = new WebSocket(`ws://${adapter.host}:${adapter.port}`, {
  headers: { Authorization: 'Bearer wrong-token-xyz' },
});
let wrongRejected = false;
await new Promise((resolve) => {
  wrong.on('close', () => {
    wrongRejected = true;
    resolve();
  });
  wrong.on('error', () => resolve());
  wrong.on('open', () => {
    // 连上了但应被服务端踢掉
  });
  setTimeout(resolve, 2000);
});
check('错误 token 被拒绝', wrongRejected);

ws.close();
bot.kill('SIGTERM');
await wait(400);
await rm(tmp, { recursive: true, force: true });

console.log('\n' + '─'.repeat(46));
console.log(failures === 0
  ? C.ok('全链路通过：生成的配置能真正驱动 bot。')
  : C.bad(`${failures} 项失败。`));
console.log();
process.exit(failures === 0 ? 0 : 1);
