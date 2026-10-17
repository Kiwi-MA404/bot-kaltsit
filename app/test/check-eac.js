#!/usr/bin/env node
/**
 * 检查 EAC（协付）通道是否已解锁，并测免费 DeepSeek 模型。
 *
 * 背景：our-free-model 插件里的 EAC 模型走 GitHub Copilot 的协付车道，
 * 需要「GitHub 登录 + star 仓库」才放行。免费车道的模型不受影响。
 *
 *   node test/check-eac.js
 *   node test/check-eac.js --use    解锁后直接把陪伴体切到免费模型
 */

import { Llm } from '../src/llm.js';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';

const FREE_DS = 'our-free-model/deepseek-ai/deepseek-v4.1-flash';
const REPO = 'https://github.com/Ebony-Vinyl/dsh-our-free-model';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

console.log('\n═══ EAC 通道自检 ═══\n');
console.log(`目标模型 : ${FREE_DS}`);
console.log(`需要 star: ${REPO}\n`);

const llm = new Llm({ model: FREE_DS });

let ok = false;
let failure = null;

const t0 = Date.now();
try {
  const out = await llm.chat([{ role: 'user', content: '只回答两个字：收到' }], {
    maxTokens: 50,
  });
  const ms = Date.now() - t0;

  if (out) {
    ok = true;
    console.log(`${C.ok('✓ 已解锁')}`);
    console.log(`  回复 : ${out}`);
    console.log(`  延迟 : ${ms}ms`);
  } else {
    failure = '返回空内容';
  }
} catch (err) {
  failure = err.message;
}

if (!ok) {
  console.log(`${C.bad('✗ 还没解锁')}\n`);
  console.log(`  错误：${failure?.slice(0, 160)}\n`);

  const isAuth = /AUTHORIZATION_REQUIRED|GitHub 授权|star/i.test(failure ?? '');

  if (isAuth) {
    console.log(`${C.warn('需要你手动做两件事（都要用你的 GitHub 账号）：')}\n`);
    console.log(`  1. 给这个仓库点 star：`);
    console.log(`     ${C.ok(REPO)}\n`);
    console.log(`  2. 在 DSH 里用 GitHub 登录：`);
    console.log(`     打开 DSH 设置 → 找到「our-free-model」插件页`);
    console.log(`     → 展开「${C.ok('EAC 渠道授权')}」区块 → 点 GitHub 登录\n`);
    console.log(`${C.dim('  做完后重新跑本脚本。')}`);
    console.log(`${C.dim('  授权状态由插件保存，这个脚本读不到也改不了。')}\n`);
  } else {
    console.log(`${C.dim('  不是授权问题，可能是别的原因。')}\n`);
  }

  process.exit(1);
}

// ── 对比当前在用的模型 ──
console.log('\n[对比] 与当前模型的速度差异');
try {
  const cur = new Llm({});
  const t1 = Date.now();
  const r = await cur.chat([{ role: 'user', content: '只回答两个字：收到' }], { maxTokens: 50 });
  console.log(`  当前 ${cur.model.padEnd(38)} ${r} (${Date.now() - t1}ms)`);
  const t2 = Date.now();
  const r2 = await llm.chat([{ role: 'user', content: '只回答两个字：收到' }], { maxTokens: 50 });
  console.log(`  免费 ${FREE_DS.padEnd(38)} ${r2} (${Date.now() - t2}ms)`);
} catch (err) {
  console.log(`  ${C.dim(`对比失败：${err.message.slice(0, 60)}`)}`);
}

// ── 可选：切过去 ──
if (process.argv.includes('--use')) {
  console.log('\n[切换] 把陪伴体切到免费模型');
  const cfgPath = new URL('../config.json', import.meta.url).pathname;

  if (!existsSync(cfgPath)) {
    console.log(`  ${C.bad('✗')} 找不到 config.json`);
    process.exit(1);
  }

  const raw = readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);

  if (cfg.model === FREE_DS) {
    console.log(`  ${C.dim('已经是这个模型了，无需修改')}`);
  } else {
    copyFileSync(cfgPath, `${cfgPath}.bak-${Date.now()}`);
    cfg.model = FREE_DS;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`  ${C.ok('✓')} 已写入 config.json（原文件已备份）`);
    console.log(`  ${C.dim('重启陪伴体生效：./stop.sh 然后 ./start.sh')}`);
  }
} else {
  console.log(`\n${C.dim('要把陪伴体切到免费模型：node test/check-eac.js --use')}`);
}

console.log();
