#!/usr/bin/env node
/**
 * 本地 Ollama 接入助手。
 *
 * 用途：让陪伴体在没有 DSH / WorkBuddy 账号的机器上也能说话。
 *
 *   node tools/setup-ollama.js            # 检测 Ollama 并推荐模型
 *   node tools/setup-ollama.js --check    # 只检测，不改配置
 *   node tools/setup-ollama.js --use qwen2.5:7b   # 指定模型并写入配置
 *
 * 前提：目标机已装 Ollama 并拉过至少一个模型。
 *   brew install ollama
 *   ollama serve            # 或 brew services start ollama
 *   ollama pull qwen2.5:7b
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = new URL('..', import.meta.url).pathname;
const CONFIG = join(APP, 'config.json');
const DEFAULT_HOST = 'http://127.0.0.1:11434';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const flag = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const CHECK_ONLY = has('--check');
const USE_MODEL = flag('--use');
const HOST = flag('--host', DEFAULT_HOST);

/**
 * 推荐模型：按"中文对话质量 + 内存占用"排序。
 * 数值是该模型的大致内存需求，用来给用户提示。
 */
const RECOMMENDED = [
  { name: 'qwen2.5:7b', note: '中文最好，约 5GB 内存，推荐', mem: '5GB' },
  { name: 'qwen2.5:3b', note: '轻量，约 2.5GB，质量略降', mem: '2.5GB' },
  { name: 'llama3.1:8b', note: '英文强，中文一般', mem: '6GB' },
  { name: 'gemma2:9b', note: '综合均衡', mem: '7GB' },
];

async function probe() {
  try {
    const res = await fetch(`${HOST}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, models: (body.models ?? []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  console.log('\n═══ 本地模型（Ollama）检测 ═══\n');
  console.log(`服务地址：${HOST}`);

  const r = await probe();

  if (!r.ok) {
    console.log(C.bad(`\n✗ 连不上 Ollama：${r.error}\n`));
    console.log('安装方法：');
    console.log(C.dim('  brew install ollama'));
    console.log(C.dim('  brew services start ollama      # 后台常驻'));
    console.log(C.dim('  ollama pull qwen2.5:7b          # 拉一个中文模型（约 4.7GB）'));
    console.log();
    console.log('装好后再跑一次：');
    console.log(C.dim('  node tools/setup-ollama.js'));
    process.exit(1);
  }

  console.log(C.ok(`✓ Ollama 在运行`));

  if (!r.models.length) {
    console.log(C.warn(`\n! 还没有任何模型\n`));
    console.log('先拉一个：');
    for (const m of RECOMMENDED) {
      console.log(C.dim(`  ollama pull ${m.name.padEnd(16)} # ${m.note}`));
    }
    process.exit(1);
  }

  console.log(`\n已安装的模型（${r.models.length} 个）：`);
  for (const m of r.models) console.log(`  · ${m}`);

  // 选一个：命令行指定 > 推荐列表里第一个已装的 > 第一个已装的
  let chosen = USE_MODEL;
  if (!chosen) {
    const hit = RECOMMENDED.find((rec) =>
      r.models.some((m) => m === rec.name || m.startsWith(rec.name)),
    );
    chosen = hit?.name ?? r.models[0];
  }

  const modelExists = r.models.some(
    (m) => m === chosen || m.startsWith(chosen),
  );
  if (!modelExists) {
    console.log(C.bad(`\n✗ 模型 "${chosen}" 不在已安装列表里`));
    console.log(C.dim(`  先拉：ollama pull ${chosen}`));
    process.exit(1);
  }

  console.log(`\n将使用：${C.ok(chosen)}`);

  // 实跑一次，确认能出中文
  console.log(C.dim('\n试跑一次…'));
  try {
    const res = await fetch(`${HOST}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ollama' },
      body: JSON.stringify({
        model: chosen,
        messages: [{ role: 'user', content: '用中文说一句"在的"。只回答这一句。' }],
        max_tokens: 50,
        temperature: 0.5,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const json = await res.json();
    const reply = json.choices?.[0]?.message?.content ?? '';
    console.log(`${C.ok('✓')} 模型回复：${JSON.stringify(reply.trim())}`);
  } catch (err) {
    console.log(C.bad(`\n✗ 试跑失败：${err.message}`));
    console.log(C.dim('  如果是超时，说明模型首次加载较慢，多试一次通常就好。'));
    process.exit(1);
  }

  if (CHECK_ONLY) {
    console.log(`\n${C.dim('--check：只检测，未修改 config.json')}\n`);
    return;
  }

  // 写入 config.json
  if (!existsSync(CONFIG)) {
    console.log(C.bad(`\n✗ 找不到 ${CONFIG}`));
    console.log(C.dim('  先跑 ./install.sh 生成配置'));
    process.exit(1);
  }

  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  cfg.backend = 'ollama';
  cfg.model = chosen;
  cfg.ollama = {
    host: HOST,
    model: chosen,
    temperature: 0.8,
    maxTokens: 1024,
    timeoutMs: 180000,
    disableTools: true,
  };
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');

  console.log(`\n${C.ok('✓ 已写入 config.json')}`);
  console.log(C.dim(`  backend: ollama`));
  console.log(C.dim(`  model  : ${chosen}`));

  // 提示内存
  const rec = RECOMMENDED.find((x) => x.name === chosen);
  if (rec) console.log(C.dim(`  内存需求约 ${rec.mem}`));

  console.log(`\n下一步：`);
  console.log(C.dim('  cd app && ./start.sh'));
  console.log();
}

main().catch((err) => {
  console.error(C.bad(`✗ ${err.message}`));
  process.exit(1);
});
