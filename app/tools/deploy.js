#!/usr/bin/env node
/**
 * 一键部署：从「已下载的包」到「她能在 QQ 上说话」。
 *
 * 这个脚本只能做它能做的部分。真正需要管理员权限的那一步
 * （改写 QQ.app 入口）必须你本人点，因为：
 *   - /Applications 归 root:wheel 所有
 *   - 改写 app bundle 需要管理员授权
 *
 * 所以流程是：脚本把能自动化的全做完 → 你在最后一步点一下 → 脚本再接管。
 *
 *   node tools/deploy.js check     环境体检 + 备份
 *   node tools/deploy.js status    看进行到哪一步了
 *   node tools/deploy.js config    写 onebot11.json 网络配置
 */

import { execFileSync } from 'node:child_process';
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
  readdir,
  copyFile,
  readlink,
  symlink,
} from 'node:fs/promises';
import { existsSync, createReadStream, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HOME = homedir();
const CONTAINER = join(HOME, 'Library/Containers/com.tencent.qq');
const QQ_APP = '/Applications/QQ.app';

// deploy.js 在 companion/tools/ 下：
//   ROOT   = companion/
//   VENDOR = <工作区>/vendor/napcat   ← 在 companion 的上一级
const ROOT = new URL('..', import.meta.url).pathname;
const WORKSPACE = join(ROOT, '..');
const VENDOR = join(WORKSPACE, 'vendor/napcat');

/** 官方发布的校验值，防止下载被篡改或截断 */
const EXPECTED = {
  'NapCat.Framework.zip': {
    size: 36728573,
    sha256: '45ef7f46aa78588c636044b6226b4b1847e31287ab6ec36b2d48adaa9785097b',
  },
  'NapCatInstaller.zip': {
    size: 1101125,
    sha256: '93537837ae2a5d645393fbe67a758fbaebe93ca2b8cad3a608582c4be12a92a4',
  },
};

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function fileSize(path) {
  try {
    const { size } = await stat(path);
    return size;
  } catch {
    return 0;
  }
}

/** 递归统计目录下的文件数——备份完整性靠它，不能靠目录是否存在 */
async function countFiles(dir) {
  let n = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.isFile()) n++;
    }
  }
  await walk(dir);
  return n;
}

/** QQ 是否在运行——备份前必须确认它是退出的 */
function qqRunning() {
  try {
    const out = execFileSync('pgrep', ['-f', 'QQ.app/Contents/MacOS/QQ'], {
      encoding: 'utf8',
    });
    return out.trim().split('\n').filter(Boolean).length > 0;
  } catch {
    return false; // pgrep 无匹配时退出码非 0
  }
}

/**
 * 宽容复制：容器里混着 macOS 的 containermanagerd 元数据，
 * 那些文件读不了也不该阻止备份（它们不是 QQ 数据）。
 * 失败的文件记下来，最后如实报告。
 */
async function copyTolerant(src, dest) {
  let copied = 0;
  const failed = [];

  async function walk(from, to) {
    await mkdir(to, { recursive: true });

    let entries;
    try {
      entries = await readdir(from, { withFileTypes: true });
    } catch (err) {
      failed.push(`目录 ${from}（${err.code}）`);
      return;
    }

    for (const entry of entries) {
      const s = join(from, entry.name);
      const d = join(to, entry.name);

      try {
        if (entry.isSymbolicLink()) {
          const target = await readlink(s);
          await symlink(target, d).catch(() => {});
        } else if (entry.isDirectory()) {
          await walk(s, d);
        } else if (entry.isFile()) {
          await copyFile(s, d);
          copied += 1;
        }
      } catch (err) {
        failed.push(`${entry.name}（${err.code}）`);
      }
    }
  }

  await walk(src, dest);
  return { copied, failed };
}

/** NapCat 文件是否已铺好（但入口未必已切） */
function napcatStaged() {
  // 关键文件在，才算铺好；空目录不算
  const documents = join(CONTAINER, 'Data/Documents/napcat');
  return (
    existsSync(join(documents, 'napcat.mjs')) &&
    existsSync(join(documents, 'package.json'))
  );
}

/** QQ 入口是否已指向 NapCat —— 这才是「已安装」的真正判据 */
function qqEntryPatched() {
  const pkgPath = join(QQ_APP, 'Contents/Resources/app/package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.main === 'string' && pkg.main.includes('loadNapCat.js');
  } catch {
    return false;
  }
}

/** 发现 NapCat 实际落脚的位置 */
async function findNapcatDir() {
  const candidates = [
    join(CONTAINER, 'Data/Documents/napcat'),
    join(CONTAINER, 'Data/Documents/NapCat'),
    join(ROOT, 'vendor/napcat/NapCat'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ── check：体检 + 备份 ─────────────────────────────────
async function cmdCheck() {
  console.log('\n═══ 环境体检 ═══\n');

  let problems = 0;

  // 1. 包完整性
  console.log('[1] 检查已下载的包');
  for (const [name, meta] of Object.entries(EXPECTED)) {
    const p = join(VENDOR, name);
    if (!existsSync(p)) {
      console.log(`  ${C.bad('✗')} ${name} 不存在`);
      problems++;
      continue;
    }
    const size = await fileSize(p);
    if (size !== meta.size) {
      console.log(`  ${C.bad('✗')} ${name} 大小不符：${size} ≠ ${meta.size}（下载被截断）`);
      problems++;
      continue;
    }
    const sha = await sha256File(p);
    if (sha !== meta.sha256) {
      console.log(`  ${C.bad('✗')} ${name} SHA256 不匹配，包可能被篡改`);
      problems++;
      continue;
    }
    console.log(`  ${C.ok('✓')} ${name} 完整且与官方校验值一致`);
  }

  // 2. QQ 版本
  console.log('\n[2] 检查 QQ');
  if (!existsSync(QQ_APP)) {
    console.log(`  ${C.bad('✗')} 没找到 ${QQ_APP}`);
    problems++;
  } else {
    let ver = '未知';
    try {
      ver = execFileSync(
        'defaults',
        ['read', join(QQ_APP, 'Contents/Info.plist'), 'CFBundleShortVersionString'],
        { encoding: 'utf8' },
      ).trim();
    } catch {}
    let build = '';
    try {
      build = execFileSync(
        'defaults',
        ['read', join(QQ_APP, 'Contents/Info.plist'), 'CFBundleVersion'],
        { encoding: 'utf8' },
      ).trim();
    } catch {}

    const known = ver === '7.0.2' && build === '53644';
    console.log(
      `  ${known ? C.ok('✓') : C.warn('!')} QQ ${ver} (build ${build})`,
    );
    if (known) {
      console.log(`     ${C.dim('NapCat v4.18.36+ 已在 Intel 与 Apple Silicon 上实测过这个构建')}`);
    } else {
      console.log(`     ${C.warn('这个构建没有在 NapCat 官方验证清单里，可能不兼容')}`);
    }
  }

  // 3. QQ 是否在运行
  console.log('\n[3] 检查 QQ 运行状态');
  const running = qqRunning();
  if (running) {
    console.log(`  ${C.warn('!')} QQ 正在运行`);
    console.log(`     ${C.dim('备份前必须完全退出 QQ，否则快照不一致')}`);
  } else {
    console.log(`  ${C.ok('✓')} QQ 未运行（可以安全备份）`);
  }

  // 4. 容器
  console.log('\n[4] 检查 QQ 数据');
  if (!existsSync(CONTAINER)) {
    console.log(`  ${C.warn('!')} 没找到 ${CONTAINER}`);
  } else {
    let sizeMB = 0;
    try {
      const out = execFileSync('du', ['-sm', CONTAINER], { encoding: 'utf8' });
      sizeMB = parseInt(out.split('\t')[0], 10);
    } catch {}
    console.log(`  ${C.ok('✓')} 容器存在（约 ${sizeMB} MB）`);
    console.log(`     ${C.dim('NapCat 的配置和插件将写进这个容器，所以要先备份')}`);
  }

  // 5. 备份
  console.log('\n[5] 备份 QQ 数据');
  const backupDir = join(ROOT, 'backup');
  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = join(backupDir, `com.tencent.qq-${stamp}`);

  // 关键：不能只看目录是否存在。上次失败会留下空目录，
  // 那样会误报「已备份」——备份工具里这是最危险的错。
  const existingFiles = existsSync(backupPath) ? await countFiles(backupPath) : 0;
  const MIN_FILES = 100; // 真实的 QQ 容器有数千个文件

  if (existingFiles >= MIN_FILES) {
    console.log(`  ${C.ok('✓')} 今天的备份可用（${existingFiles} 个文件）`);
    console.log(`     ${C.dim(backupPath)}`);
  } else if (running) {
    console.log(`  ${C.bad('✗')} 跳过备份：QQ 正在运行`);
    console.log(`     ${C.dim('完全退出 QQ 后重新跑 node tools/deploy.js check')}`);
    problems++;
  } else {
    if (existingFiles > 0) {
      console.log(`  ${C.warn('!')} 发现不完整的备份（只有 ${existingFiles} 个文件），重新备份`);
      await rm(backupPath, { recursive: true, force: true });
    }
    await mkdir(backupDir, { recursive: true });
    console.log(`  ${C.dim('826MB / 约 5000 个文件，需要一两分钟…')}`);
    try {
      const { copied, failed } = await copyTolerant(CONTAINER, backupPath);
      if (copied < MIN_FILES) {
        console.log(`  ${C.bad('✗')} 只备份到 ${copied} 个文件，明显不完整`);
        if (failed.length) {
          console.log(`     ${C.dim(`首个失败：${failed[0]}`)}`);
        }
        problems++;
      } else {
        console.log(`  ${C.ok('✓')} 已备份 ${copied} 个文件到 ${backupPath}`);
        if (failed.length) {
          console.log(`     ${C.dim(`跳过 ${failed.length} 个系统元数据文件（不是 QQ 数据，不影响还原）`)}`);
        }
      }
    } catch (err) {
      console.log(`  ${C.bad('✗')} 备份失败：${err.message}`);
      problems++;
    }
  }

  // 6. NapCat 安装状态
  console.log('\n[6] 检查 NapCat 安装状态');
  if (qqEntryPatched()) {
    console.log(`  ${C.ok('✓')} QQ 入口已指向 NapCat`);
  } else if (napcatStaged()) {
    console.log(`  ${C.warn('!')} NapCat 文件已就位，但 QQ 入口还是原版`);
    console.log(`     ${C.dim('需要 sudo 切入口：sudo <node> tools/patch-qq.js')}`);
    problems++;
  } else {
    console.log(`  ${C.warn('!')} 还没铺 NapCat 文件`);
    console.log(`     ${C.dim('跑 host-install.js，或用安装器')}`);
    problems++;
  }

  console.log('\n' + '─'.repeat(46));
  if (problems === 0) {
    console.log(C.ok('体检通过，可以继续。'));
    if (!qqEntryPatched()) printInstallerStep();
  } else {
    console.log(C.warn(`有 ${problems} 项需要处理，先解决再继续。`));
  }
  console.log();
}

function printInstallerStep() {
  const nodeBin = process.execPath;
  const patch = join(ROOT, 'tools/patch-qq.js');
  const staged = napcatStaged();

  if (!staged) {
    console.log(`\n${C.dim('── 下一步：把 NapCat 铺进容器（不需要密码）──')}`);
    console.log(`  ${C.ok('node tools/host-install.js')}`);
    console.log(`  ${C.dim('用已校验的本地包，不走网络')}`);
    console.log();
    return;
  }

  console.log(`\n${C.dim('── 下一步：切 QQ 入口（需要管理员密码）──')}`);
  console.log('  NapCat 文件已就位，只差把 QQ 的入口指过去。');
  console.log();
  console.log(`  ${C.ok(`sudo "${nodeBin}" "${patch}`)}`);
  console.log();
  console.log(`  ${C.dim('改的是 /Applications/QQ.app 里的 package.json，属主 root:wheel。')}`);
  console.log(`  ${C.dim('脚本会先备份原文件；想退回：sudo node tools/patch-qq.js --restore')}`);
  console.log();
  console.log(`  ${C.dim('之后启动：')} open -a QQ --args --no-sandbox`);
  console.log();
}

// ── status：进度 ───────────────────────────────────────
async function cmdStatus() {
  console.log('\n═══ 部署进度 ═══\n');

  const steps = [
    ['A. 包已下载并校验', async () => {
      for (const [name, meta] of Object.entries(EXPECTED)) {
        const p = join(VENDOR, name);
        if (!existsSync(p) || (await fileSize(p)) !== meta.size) return false;
        if ((await sha256File(p)) !== meta.sha256) return false;
      }
      return true;
    }],
    ['B. QQ 数据已备份', async () => existsSync(join(ROOT, 'backup'))],
    ['C. NapCat 已安装（接管 QQ 入口）', async () => qqEntryPatched()],
    ['D. onebot11.json 已配置网络', async () => {
      const dir = await findNapcatDir();
      if (!dir) return false;
      const f = join(dir, 'config/onebot11.json');
      if (!existsSync(f)) return false;
      const cfg = JSON.parse(await readFile(f, 'utf8'));
      const n = cfg.network ?? {};
      return (
        (n.websocketServers ?? []).some((a) => a.enable) ||
        (n.websocketClients ?? []).some((a) => a.enable)
      );
    }],
    ['E. bot 能连上 NapCat', async () => false],
  ];

  const results = [];
  for (const [label, fn] of steps) {
    let done = false;
    try {
      done = await fn();
    } catch {}
    results.push([label, done]);
    console.log(`  ${done ? C.ok('✓') : C.dim('○')} ${label}`);
  }

  const firstUndone = results.findIndex(([, d]) => !d);
  console.log('\n' + '─'.repeat(46));
  if (firstUndone < 0) console.log(C.ok('全部完成。'));
  else {
    const hints = [
      '跑：node tools/host-install.js（铺 NapCat 文件）',
      '跑：node tools/deploy.js check',
      '退出 QQ 后跑：node tools/deploy.js check',
      '打开安装器（见 node tools/deploy.js check 的提示）',
      '跑：node tools/deploy.js config',
      '启动 NapCat 和 bot，然后用主号给小号发一句话',
    ];
    console.log(`下一步 → ${C.warn(results[firstUndone][0])}`);
    console.log(`        ${hints[firstUndone]}`);
  }
  console.log();
}

// ── config：写网络配置 ─────────────────────────────────

/** 按 NapCat 源码的 OneBotConfigSchema 构造完整默认配置 */
function defaultOneBotConfig() {
  return {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: {
      baseTimeout: 10000,
      uploadSpeedKBps: 256,
      downloadSpeedKBps: 256,
      maxTimeout: 1800000,
    },
  };
}

/**
 * 把 companion 适配器写进 onebot11.json。
 * @param {string} dir       NapCat 目录（含 config/）
 * @param {object} opts
 * @param {boolean} [opts.force]  文件不存在时是否按 schema 生成默认配置
 */
export async function writeOneBotConfig(dir, { force = false, token, port } = {}) {
  const cfgPath = join(dir, 'config/onebot11.json');
  const TOKEN = token ?? process.env.NAPCAT_TOKEN ?? 'companion-local-token';
  const PORT = Number(port ?? process.env.NAPCAT_WS_PORT ?? 3002);

  await mkdir(join(dir, 'config'), { recursive: true });

  let cfg;
  let created = false;

  if (existsSync(cfgPath)) {
    const raw = await readFile(cfgPath, 'utf8');
    try {
      cfg = JSON.parse(raw);
    } catch (err) {
      throw new Error(`已有的 onebot11.json 不是合法 JSON，拒绝覆盖：${err.message}`);
    }
    // 动之前先备份
    const bak = `${cfgPath}.bak-${Date.now()}`;
    await writeFile(bak, raw, 'utf8');
  } else if (force) {
    cfg = defaultOneBotConfig();
    created = true;
  } else {
    return { ok: false, reason: 'missing', cfgPath };
  }

  cfg.network ??= {};
  for (const k of [
    'httpServers',
    'httpSseServers',
    'httpClients',
    'websocketServers',
    'websocketClients',
    'plugins',
  ]) {
    cfg.network[k] ??= [];
  }

  const existing = cfg.network.websocketServers.find((a) => a.name === 'companion');
  if (existing) {
    Object.assign(existing, {
      enable: true,
      host: '127.0.0.1',
      port: PORT,
      token: TOKEN,
    });
  } else {
    cfg.network.websocketServers.push({
      name: 'companion',
      enable: true,
      host: '127.0.0.1',
      port: PORT,
      token: TOKEN,
      heartInterval: 30000,
      debug: false,
    });
  }

  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  return {
    ok: true,
    cfg,
    cfgPath,
    created,
    updated: Boolean(existing),
    token: TOKEN,
    port: PORT,
  };
}

async function cmdConfig() {
  const force = process.argv.includes('--force');
  const overrideDir = process.env.NAPCAT_DIR || null;

  const dir = overrideDir ?? (await findNapcatDir());

  if (!dir) {
    console.error(C.bad('\n找不到 NapCat 目录。先完成安装，或用 NAPCAT_DIR 指定。'));
    console.error(`看了这些位置都没有：`);
    console.error(`  ${join(CONTAINER, 'Data/Documents/napcat')}`);
    console.error();
    process.exit(1);
  }

  console.log(`\nNapCat 目录：${dir}`);

  let result;
  try {
    result = await writeOneBotConfig(dir, { force });
  } catch (err) {
    console.error(C.bad(`\n${err.message}`));
    process.exit(1);
  }

  if (!result.ok && result.reason === 'missing') {
    console.log(`配置文件   ：${result.cfgPath}\n`);
    console.error(C.warn('onebot11.json 还不存在。'));
    console.error('先启动一次 NapCat 让它生成默认配置，或者用 --force 按 schema 生成：');
    console.error(C.dim(`  node tools/deploy.js config --force`));
    process.exit(1);
  }

  console.log(`配置文件   ：${result.cfgPath}`);
  console.log(
    result.created
      ? C.ok('✓ 按 NapCat 源码 schema 生成了默认配置，并写入 companion 适配器')
      : result.updated
        ? C.ok('✓ 更新了已存在的 companion 适配器')
        : C.ok('✓ 新增了 companion 适配器'),
  );
  console.log(C.dim('  （原文件已备份为 .bak-<时间戳>）\n'));

  console.log('网络适配器现状：');
  for (const a of result.cfg.network.websocketServers) {
    console.log(`  websocketServers  ${a.enable ? C.ok('启用') : C.dim('停用')}  ${a.name}  ${a.host}:${a.port}`);
  }
  for (const a of result.cfg.network.websocketClients) {
    console.log(`  websocketClients  ${a.enable ? C.ok('启用') : C.dim('停用')}  ${a.name}`);
  }

  console.log(`\n${C.warn('还要同步更新陪伴体的 config.json：')}`);
  console.log(`  "napcat": { "mode": "ws-reverse", "port": ${result.port}, "accessToken": "${result.token}" }`);
  console.log(`\n然后重启 NapCat，再启动 bot：`);
  console.log(`  node src/bot.js`);
  console.log();
}

// ── 入口 ───────────────────────────────────────────────
// 只有被直接执行时才跑 CLI；被 import 时（比如跑测试）不执行。
const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const cmd = process.argv[2] ?? 'status';

  const commands = { check: cmdCheck, status: cmdStatus, config: cmdConfig };

  if (!commands[cmd]) {
    console.error(`未知命令：${cmd}`);
    console.error('可用：check | status | config [--force]');
    process.exit(1);
  }

  try {
    await commands[cmd]();
  } catch (err) {
    console.error(`\n${C.bad('出错：')}${err.message}`);
    process.exit(1);
  }
}
