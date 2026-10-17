#!/usr/bin/env node
/**
 * 部署配置逻辑的测试。
 *
 * 之前只验证了「正确拒绝」（文件不存在时报错），从没验证过成功路径。
 * 这个测试在沙箱里用假目录把两条成功路径都跑通：
 *   1. 已有 onebot11.json  → 保留原内容，只追加 companion 适配器
 *   2. 没有 + --force      → 按 schema 生成完整默认配置
 *   3. 再跑一次            → 幂等，不重复添加
 */

import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOneBotConfig } from '../tools/deploy.js';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ${C.ok('✓')} ${name}`);
  } else {
    console.log(`  ${C.bad('✗')} ${name} ${detail}`);
    failures++;
  }
}

const tmp = await mkdtemp(join(tmpdir(), 'deploy-test-'));
console.log('\n═══ 部署配置逻辑测试 ═══\n');

// ── 场景 1：已有配置，只追加 ──────────────────────────
console.log('── 场景 1：已有 onebot11.json，应保留原内容只追加 ──');
const dir1 = join(tmp, 'existing');
await mkdir(join(dir1, 'config'), { recursive: true });
const original = {
  network: {
    httpServers: [{ name: '原有用例', enable: true, host: '0.0.0.0', port: 3000 }],
    httpSseServers: [],
    httpClients: [],
    websocketServers: [],
    websocketClients: [],
    plugins: [],
  },
  musicSignUrl: 'https://keep-me.example',
  enableLocalFile2Url: true,
  parseMultMsg: true,
  imageDownloadProxy: '',
  timeout: { baseTimeout: 5000, uploadSpeedKBps: 128, downloadSpeedKBps: 128, maxTimeout: 900000 },
};
await writeFile(join(dir1, 'config/onebot11.json'), JSON.stringify(original, null, 2), 'utf8');

const r1 = await writeOneBotConfig(dir1, { token: 'test-token', port: 3002 });
check('返回成功', r1.ok === true);
check('原配置无 companion，属于新增', r1.updated === false);
check('未标记为 created', !r1.created);

const after1 = JSON.parse(await readFile(join(dir1, 'config/onebot11.json'), 'utf8'));
check('原有 httpServers 保留', after1.network.httpServers[0].name === '原有用例');
check('原有 musicSignUrl 保留', after1.musicSignUrl === 'https://keep-me.example');
check('原有 enableLocalFile2Url 保留', after1.enableLocalFile2Url === true);
check('原有 timeout 保留', after1.timeout.baseTimeout === 5000);
check('companion 适配器已加入', after1.network.websocketServers.length === 1);
check('端口正确', after1.network.websocketServers[0].port === 3002);
check('token 正确', after1.network.websocketServers[0].token === 'test-token');
check('已启用', after1.network.websocketServers[0].enable === true);
console.log(`     ${C.dim('适配器：' + JSON.stringify(after1.network.websocketServers[0]))}`);

// ── 场景 2：幂等 ──────────────────────────────────────
console.log('\n── 场景 2：再跑一次，应幂等不重复 ──');
const r2 = await writeOneBotConfig(dir1, { token: 'test-token', port: 3002 });
check('第二次跑标记为 updated', r2.updated === true);
const after2 = JSON.parse(await readFile(join(dir1, 'config/onebot11.json'), 'utf8'));
check('仍然只有一个 companion 适配器', after2.network.websocketServers.length === 1);
check('原有用例仍在', after2.network.httpServers.length === 1);

// 改端口应生效
await writeOneBotConfig(dir1, { token: 'test-token', port: 4000 });
const after3 = JSON.parse(await readFile(join(dir1, 'config/onebot11.json'), 'utf8'));
check('改端口能生效', after3.network.websocketServers[0].port === 4000);

// ── 场景 3：--force 生成默认配置 ──────────────────────
console.log('\n── 场景 3：没有配置文件 + --force，应生成完整默认配置 ──');
const dir2 = join(tmp, 'fresh');
await mkdir(dir2, { recursive: true });
const r3 = await writeOneBotConfig(dir2, { force: true, token: 't3', port: 5001 });
check('返回成功', r3.ok === true);
check('标记为新建', r3.created === true);

const after4 = JSON.parse(await readFile(join(dir2, 'config/onebot11.json'), 'utf8'));
check('六个 network 数组都存在', [
  'httpServers', 'httpSseServers', 'httpClients',
  'websocketServers', 'websocketClients', 'plugins',
].every((k) => Array.isArray(after4.network[k])));
check('timeout 段完整', after4.timeout.baseTimeout === 10000
  && after4.timeout.maxTimeout === 1800000);
check('顶层字段齐全', ['musicSignUrl', 'enableLocal2Url', 'parseMultMsg', 'imageDownloadProxy']
  .every((k) => k === 'enableLocal2Url' || k in after4));
check('companion 适配器已写入', after4.network.websocketServers.length === 1);

// ── 场景 4：不加 --force 应拒绝 ───────────────────────
console.log('\n── 场景 4：没有配置文件且不加 --force，应拒绝而不是瞎写 ──');
const dir3 = join(tmp, 'reject');
await mkdir(dir3, { recursive: true });
const r4 = await writeOneBotConfig(dir3, {});
check('返回未成功', r4.ok === false);
check('原因是 missing', r4.reason === 'missing');
const { existsSync } = await import('node:fs');
check('没有创建文件', !existsSync(join(dir3, 'config/onebot11.json')));

// ── 场景 5：坏 JSON 应拒绝且不破坏原文件 ──────────────
console.log('\n── 场景 5：原文件是坏 JSON，应拒绝且不破坏 ──');
const dir4 = join(tmp, 'broken');
await mkdir(join(dir4, 'config'), { recursive: true });
await writeFile(join(dir4, 'config/onebot11.json'), '{ 这不是合法 JSON', 'utf8');
let threw = false;
try {
  await writeOneBotConfig(dir4, {});
} catch {
  threw = true;
}
check('抛错拒绝', threw);
const brokenContent = await readFile(join(dir4, 'config/onebot11.json'), 'utf8');
check('原文件未被破坏', brokenContent === '{ 这不是合法 JSON');

// ── 收尾 ──────────────────────────────────────────────
await rm(tmp, { recursive: true, force: true });

console.log('\n' + '─'.repeat(46));
console.log(failures === 0 ? C.ok('全部通过。') : C.bad(`${failures} 项失败。`));
console.log();
process.exit(failures === 0 ? 0 : 1);
