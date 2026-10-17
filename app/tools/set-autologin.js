#!/usr/bin/env node
/**
 * 设置 NapCat 自动登录的 QQ 号。
 *
 * 为什么需要：NapCat 默认要扫码登录，而扫码需要手机 + 浏览器，
 * 无人值守时很麻烦。如果目标 QQ 号**在这台机器上登录过**
 * （有保存的会话），填进 autoLoginAccount 就能免扫码自动登录。
 *
 *   node tools/set-autologin.js 1234567891
 *   node tools/set-autologin.js --list    看这台机器登录过哪些号
 *   node tools/set-autologin.js --clear   清除自动登录
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONTAINER = join(homedir(), 'Library/Containers/com.tencent.qq/Data');
const WEBUI = join(CONTAINER, 'Documents/napcat/config/webui.json');
const PARTITIONS = join(CONTAINER, 'Library/Application Support/QQ/Partitions');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

/** 从 Partitions 目录名里看出哪些 QQ 号登录过 */
function knownAccounts() {
  if (!existsSync(PARTITIONS)) return [];
  return [
    ...new Set(
      readdirSync(PARTITIONS)
        .map((n) => n.match(/^qqnt_(\d{5,12})$/)?.[1])
        .filter(Boolean),
    ),
  ];
}

const arg = process.argv[2];

// ── --list ──
if (arg === '--list' || !arg) {
  const known = knownAccounts();
  console.log('\n这台机器上登录过的 QQ 号：\n');
  if (!known.length) {
    console.log(C.warn('  没有找到。可能是首次安装，或容器结构不同。'));
    console.log(C.dim(`  看了：${PARTITIONS}`));
  } else {
    for (const a of known) console.log(`  ${a}`);
  }

  if (existsSync(WEBUI)) {
    const w = JSON.parse(readFileSync(WEBUI, 'utf8'));
    console.log(`\n当前 autoLoginAccount: ${JSON.stringify(w.autoLoginAccount)}`);
  }

  console.log(`\n用法：node tools/set-autologin.js <QQ号>\n`);
  process.exit(0);
}

// ── 前置检查 ──
if (!existsSync(WEBUI)) {
  console.error(C.bad(`\n找不到 ${WEBUI}`));
  console.error('先铺 NapCat 文件并至少启动一次：');
  console.error('  node tools/host-install.js');
  console.error(C.dim('（WebUI 的配置文件要 NapCat 跑过一次才会生成）'));
  process.exit(1);
}

const w = JSON.parse(readFileSync(WEBUI, 'utf8'));
const before = w.autoLoginAccount;

// ── --clear ──
if (arg === '--clear') {
  w.autoLoginAccount = '';
  writeFileSync(WEBUI, JSON.stringify(w, null, 2), 'utf8');
  console.log(`\n${C.ok('✓ 已清除自动登录')}（原值 ${JSON.stringify(before)}）\n`);
  process.exit(0);
}

// ── 设置 ──
if (!/^\d{5,12}$/.test(arg)) {
  console.error(C.bad(`\n"${arg}" 不像 QQ 号，应该是一串数字。`));
  process.exit(1);
}

const known = knownAccounts();
console.log(`\n目标号  : ${arg}`);
console.log(`改前    : ${JSON.stringify(before)}`);

if (known.includes(arg)) {
  console.log(`${C.ok('✓ 这个号在本机登录过')}，自动登录应该能成`);
} else {
  console.log(`${C.warn('⚠ 这个号没在本机登录过')}`);
  console.log(C.dim('  自动登录可能失败，那就需要扫码。'));
  if (known.length) console.log(C.dim(`  本机登录过的号：${known.join(', ')}`));
}

w.autoLoginAccount = arg;
writeFileSync(WEBUI, JSON.stringify(w, null, 2), 'utf8');

console.log(`改后    : ${JSON.stringify(arg)}`);
console.log(`\n${C.ok('✓ 已写入')} ${WEBUI}`);
console.log(`\n${C.dim('重启 NapCat 生效：')}`);
console.log(C.dim('  osascript -e \'quit app "QQ"\' && sleep 3 && open -a QQ --args --no-sandbox'));
console.log();
