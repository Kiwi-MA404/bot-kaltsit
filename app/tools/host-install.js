#!/usr/bin/env node
/**
 * 把已校验的 NapCat.Shell 铺进 QQ 容器，并生成 loadNapCat.js。
 *
 * 为什么不用 GUI 安装器：
 *   安装器查 GitHub API 和下载资产共用同一个代理前缀。
 *   走镜像时 API 会 403（ghfast.top 不支持 api.github.com），
 *   走直连时 API 只要 1 秒但资产下载只有 65KB/s 会断。
 *   两个模式都走不通——所以直接用已经 SHA256 校验过的包。
 *
 * 这个脚本不需要 sudo。唯一需要 sudo 的是切 QQ 入口，见 patch-qq.js。
 *
 *   node tools/host-install.js
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const VENDOR = join(ROOT, '..', 'vendor/napcat');
const SHELL_ZIP = join(VENDOR, 'NapCat.Shell.zip');

const DOC = join(homedir(), 'Library/Containers/com.tencent.qq/Data/Documents');
const NAPCAT = join(DOC, 'napcat');
const LOADER = join(DOC, 'loadNapCat.js');

// 官方发布的 SHA256（v4.18.38 Shell，取自 GitHub Release API 的 digest 字段）
const EXPECTED_SHA = '735f2e633247df3ffd6e8ee8b84d7039c315b2655f5807e5f0029f93d2c30016';
const EXPECTED_SIZE = 35884742;
const VERSION = '4.18.38';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

console.log('\n═══ 铺 NapCat 到 QQ 容器 ═══\n');

// ── 1. 校验包 ──
if (!existsSync(SHELL_ZIP)) {
  console.error(C.bad(`找不到 ${SHELL_ZIP}`));
  console.error('下载：');
  console.error(`  curl -L -o "${SHELL_ZIP}" \\`);
  console.error(`    https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/download/v${VERSION}/NapCat.Shell.zip`);
  process.exit(1);
}

const size = readFileSync(SHELL_ZIP).length;
const sha = createHash('sha256').update(readFileSync(SHELL_ZIP)).digest('hex');

console.log('[1] 校验包');
if (size !== EXPECTED_SIZE) {
  console.error(C.bad(`  ✗ 大小不符：${size} ≠ ${EXPECTED_SIZE}`));
  process.exit(1);
}
if (sha !== EXPECTED_SHA) {
  console.error(C.bad(`  ✗ SHA256 不匹配`));
  console.error(`    实际 ${sha}`);
  console.error(`    期望 ${EXPECTED_SHA}`);
  process.exit(1);
}
console.log(C.ok(`  ✓ 大小与 SHA256 均与官方一致`));
console.log(C.dim(`    ${sha}`));

// ── 2. 检查 QQ 未运行 ──
console.log('\n[2] 检查 QQ 状态');
let qqRunning = false;
try {
  qqRunning = Boolean(
    execFileSync('pgrep', ['-f', 'QQ.app/Contents/MacOS/QQ'], { encoding: 'utf8' }).trim(),
  );
} catch {
  /* 没在跑 */
}
if (qqRunning) {
  console.error(C.bad('  ✗ QQ 正在运行，先完全退出'));
  console.error(C.dim('    osascript -e \'quit app "QQ"\''));
  process.exit(1);
}
console.log(C.ok('  ✓ QQ 未运行'));

// ── 3. 解压 ──
console.log('\n[3] 解压到容器');
mkdirSync(DOC, { recursive: true });
if (existsSync(NAPCAT)) {
  rmSync(NAPCAT, { recursive: true, force: true });
  console.log(C.dim('  已清理旧目录'));
}
mkdirSync(NAPCAT, { recursive: true });

try {
  execFileSync('unzip', ['-q', '-o', SHELL_ZIP, '-d', NAPCAT], { stdio: 'pipe' });
} catch (err) {
  console.error(C.bad(`  ✗ 解压失败：${err.message}`));
  process.exit(1);
}
console.log(C.ok('  ✓ 解压完成'));

// 关键文件校验
for (const f of ['napcat.mjs', 'package.json']) {
  if (!existsSync(join(NAPCAT, f))) {
    console.error(C.bad(`  ✗ 缺少 ${f}`));
    process.exit(1);
  }
}

// ── 4. 补版本号（与安装器行为一致）──
const pkgPath = join(NAPCAT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = VERSION;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');

const fileCount = (function count(d) {
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) n += count(join(d, e.name));
    else n += 1;
  }
  return n;
})(NAPCAT);
console.log(C.ok(`  ✓ ${fileCount} 个文件，版本设为 ${VERSION}`));

// ── 5. 写 loader ──
console.log('\n[4] 写 loadNapCat.js');
const loader = `const path = require('node:path');
const { pathToFileURL } = require('node:url');

// NapCat 用 NAPCAT_WORKDIR 决定配置/日志/缓存放哪。
// 不设的话它会落到 ~/Library/Application Support/QQ/NapCat，
// 而安装器约定是放在 Documents/napcat。这里必须显式设置。
process.env.NAPCAT_WORKDIR = path.join(__dirname, 'napcat');

const loadNapcat = process.argv.includes('--no-sandbox');
const pkg = require('/Applications/QQ.app/Contents/Resources/app/package.json');

if (loadNapcat) {
  (async () => {
    await import(pathToFileURL(path.join(__dirname, 'napcat/napcat.mjs')).href);
  })();
} else {
  require('/Applications/QQ.app/Contents/Resources/app/app_launcher/index.js');
  setImmediate(() => {
    if (global.launcher && global.launcher.installPathPkgJson) {
      global.launcher.installPathPkgJson.main = ((version) => {
        if (version >= 29271) return './application.asar/app_launcher/index.js';
        if (version >= 28060) return './application/app_launcher/index.js';
        return './app_launcher/index.js';
      })(pkg.buildVersion);
    }
  });
}
`;
writeFileSync(LOADER, loader, 'utf8');
console.log(C.ok(`  ✓ ${LOADER}`));

// ── 6. 提示下一步 ──
const nodeBin = process.execPath;
const patchScript = join(ROOT, 'tools/patch-qq.js');

console.log('\n' + '─'.repeat(50));
console.log(C.ok('NapCat 文件已就位。'));
console.log(`\n${C.warn('还差一步（需要 sudo）：把 QQ 入口指向 NapCat')}\n`);
console.log(`  sudo "${nodeBin}" "${patchScript}"\n`);
console.log(C.dim('这一步改的是 /Applications/QQ.app 里的 package.json，'));
console.log(C.dim('属主 root:wheel，必须提权。脚本会先备份原文件。'));
console.log();
console.log(`${C.dim('之后启动 NapCat：')}  open -a QQ --args --no-sandbox`);
console.log(`${C.dim('启动原版 QQ  ：')}  open -a QQ`);
console.log();
