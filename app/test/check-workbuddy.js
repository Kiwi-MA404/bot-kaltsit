#!/usr/bin/env node
/**
 * WorkBuddy 后端自检。
 *
 * 登录 WorkBuddy 之后跑这个，确认能不能当她的模型来源。
 *
 *   node test/check-workbuddy.js
 *   node test/check-workbuddy.js --model glm-5.1
 */

import { WorkBuddyLlm, formatConversation } from '../src/llm-workbuddy.js';
import { createLlm } from '../src/llm.js';

const args = process.argv.slice(2);
const modelIdx = args.indexOf('--model');
const model = modelIdx >= 0 ? args[modelIdx + 1] : null;

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

console.log('\n═══ WorkBuddy 后端自检 ═══\n');

// ── 1. 可用性 ──
const wb = new WorkBuddyLlm({ model });

console.log('[1] 检查 CLI 与登录状态');
const t0 = Date.now();
const status = await wb.check();
const elapsed = Date.now() - t0;

if (!status.ok) {
  console.log(`  ${C.bad('✗')} ${status.detail}`);
  console.log(`  ${C.dim(`(${(status.reason || 'error')}，耗时 ${elapsed}ms)`)}`);
  console.log();

  if (status.reason === 'auth') {
    console.log(`${C.warn('下一步：')}`);
    console.log('  1. 打开 WorkBuddy 应用（/Applications/WorkBuddy.app）');
    console.log('  2. 完成登录');
    console.log('  3. 重新跑本脚本');
    console.log();
    console.log(C.dim('  登录信息存在 WorkBuddy 自己的目录里，这个脚本读不到也改不了。'));
  } else if (status.reason === 'missing') {
    console.log(`${C.warn('WorkBuddy 没装？')}从 https://www.codebuddy.ai 获取，或检查路径。`);
  }
  console.log();
  process.exit(1);
}

console.log(`  ${C.ok('✓')} CLI 可用且已登录`);
console.log(`  ${C.dim(`耗时 ${elapsed}ms（这是冷启动开销，每次调用都会有）`)}`);

// ── 2. 连通性 ──
console.log('\n[2] 试一次真实调用');
const t1 = Date.now();
let reply;
try {
  reply = await wb.chat([{ role: 'user', content: '只回答两个字：收到' }]);
} catch (err) {
  console.log(`  ${C.bad('✗')} ${err.message}`);
  process.exit(1);
}
const latency = Date.now() - t1;

console.log(`  ${C.ok('✓')} 回复：${reply}`);
console.log(`  ${C.dim(`延迟 ${latency}ms`)}`);

// ── 3. 延迟判断 ──
console.log('\n[3] 延迟评估');
if (latency < 8000) {
  console.log(`  ${C.ok('✓')} ${latency}ms — 够快，适合聊天`);
} else if (latency < 25000) {
  console.log(`  ${C.warn('!')} ${latency}ms — 偏慢，她回话前会有明显停顿`);
  console.log(`  ${C.dim('    聊天场景可接受但不理想；DSH 网关约 850ms')}`);
} else {
  console.log(`  ${C.bad('✗')} ${latency}ms — 太慢，不适合聊天`);
  console.log(`  ${C.dim('    每次调用都要冷启动一个 agent 进程，这是 agent CLI 的固有代价')}`);
  console.log(`  ${C.dim('    建议继续用 DSH 网关，或者只在她需要更强模型时切过来')}`);
}

// ── 4. 对比 DSH ──
console.log('\n[4] 与 DSH 网关对比');
try {
  const dsh = await createLlm({});
  const t2 = Date.now();
  const r2 = await dsh.chat([{ role: 'user', content: '只回答两个字：收到' }]);
  const dshLatency = Date.now() - t2;
  console.log(`  DSH      : ${r2} (${dshLatency}ms)`);
  console.log(`  WorkBuddy: ${reply} (${latency}ms)`);
  const ratio = (latency / Math.max(dshLatency, 1)).toFixed(1);
  console.log(`  ${C.dim(`WorkBuddy 慢 ${ratio} 倍`)}`);
} catch (err) {
  console.log(`  ${C.dim(`DSH 网关不可用（${err.message.slice(0, 40)}），跳过对比`)}`);
}

// ── 5. 怎么切 ──
console.log('\n' + '─'.repeat(50));
console.log(`${C.ok('可以用了。')}切换方式（三种任选）：\n`);
console.log(`  ${C.dim('# 临时试一次')}`);
console.log(`  node src/chat.js --backend workbuddy\n`);
console.log(`  ${C.dim('# 整个陪伴体切过去')}`);
console.log(`  COMPANION_BACKEND=workbuddy node src/bot.js\n`);
console.log(`  ${C.dim('# 写进 config.json（持久）')}`);
console.log(`  "backend": "workbuddy"${model ? `, "model": "${model}"` : ''}\n`);
console.log(`${C.warn('提醒：')}换后端不影响她的人格和记忆——`);
console.log(`     那些在 persona/ 和 data/ 里，跟模型无关。\n`);
