#!/usr/bin/env node
/**
 * 把 QQ 的入口指向 NapCat 的 loadNapCat.js。
 *
 * 为什么单独做成脚本、且必须用 sudo：
 *   /Applications/QQ.app/Contents/Resources/app/package.json
 *   属主是 root:wheel，macOS 的 rootless 保护会拒绝非特权写入。
 *
 * 做两件事：
 *   1. 备份原 package.json
 *   2. 把 main 改为指向 loadNapCat.js 的相对路径
 *
 *   sudo node tools/patch-qq.js          # 切到 NapCat
 *   sudo node tools/patch-qq.js --restore # 切回原版 QQ
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const QQ_APP = '/Applications/QQ.app/Contents/Resources/app';
const PKG = join(QQ_APP, 'package.json');
const DOC = join(homedir(), 'Library/Containers/com.tencent.qq/Data/Documents');
const LOADER = join(DOC, 'loadNapCat.js');
const NAPCAT = join(DOC, 'napcat');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const restore = process.argv.includes('--restore');

if (process.getuid?.() !== 0) {
  console.error(C.bad('\n必须用 sudo 运行。'));
  console.error(`  sudo node ${new URL(import.meta.url).pathname}`);
  process.exit(1);
}

if (!existsSync(PKG)) {
  console.error(C.bad(`\n找不到 ${PKG}`));
  process.exit(1);
}

// QQ 运行中改入口会让本次启动失效，甚至状态不一致
try {
  const running = execFileSync('pgrep', ['-f', 'QQ.app/Contents/MacOS/QQ'], { encoding: 'utf8' }).trim();
  if (running) {
    console.error(C.bad('\nQQ 正在运行。请先完全退出 QQ 再执行。'));
    console.error(C.dim('  或：osascript -e \'quit app "QQ"\''));
    process.exit(1);
  }
} catch {
  // pgrep 无匹配时退出码非 0，说明没在跑，继续
}

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const original = './application.asar/app_launcher/index.js';

// 相对路径：从 QQ 的 app 目录走到 loadNapCat.js
const loaderRel = `../../../../..${LOADER}`;

console.log(`\nQQ package.json : ${PKG}`);
console.log(`当前 main       : ${pkg.main}`);

if (restore) {
  // ── 切回原版 ──
  if (pkg.main === original) {
    console.log(C.dim('\n已经是原版入口，无需修改。'));
    process.exit(0);
  }
  const bak = `${PKG}.napcat-bak`;
  if (existsSync(bak)) {
    copyFileSync(PKG, `${PKG}.napcat-restore-backup`);
  }
  pkg.main = original;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(`\n${C.ok('✓ 已切回原版 QQ 入口')}`);
  console.log(C.dim('  现在启动 QQ 就是原版 QQ，不会加载 NapCat。'));
  process.exit(0);
}

// ── 切到 NapCat ──
if (!existsSync(LOADER)) {
  console.error(C.bad(`\n找不到 loader：${LOADER}`));
  console.error('先跑 host-install.js 铺好文件。');
  process.exit(1);
}
if (!existsSync(join(NAPCAT, 'napcat.mjs'))) {
  console.error(C.bad(`\n找不到 ${join(NAPCAT, 'napcat.mjs')}`));
  console.error('先跑 host-install.js 铺好文件。');
  process.exit(1);
}

if (pkg.main === loaderRel) {
  console.log(C.dim('\n已经指向 NapCat，无需修改。'));
} else {
  // 备份一次，且不覆盖已有备份
  const bak = `${PKG}.napcat-bak`;
  if (!existsSync(bak)) {
    copyFileSync(PKG, bak);
    console.log(`\n原文件已备份 → ${bak}`);
  } else {
    console.log(`\n备份已存在，跳过：${bak}`);
  }

  pkg.main = loaderRel;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(`${C.ok('✓ 已把 QQ 入口指向 NapCat')}`);
}

console.log(`\n新 main         : ${loaderRel}`);
console.log(`解析为          : ${LOADER}`);
console.log(`\n${C.warn('怎么用：')}`);
console.log(`  启动 NapCat : open -a QQ --args --no-sandbox`);
console.log(`  启动原版 QQ : open -a QQ`);
console.log(C.dim('  （同一个 QQ.app，靠 --no-sandbox 区分）\n'));
console.log(`${C.dim('要切回原版：sudo node tools/patch-qq.js --restore')}\n`);
