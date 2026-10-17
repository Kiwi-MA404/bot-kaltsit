#!/usr/bin/env node
/**
 * 把 data/*.json 里的旧版 facts 全量迁移到 v2 schema。
 *
 * 启动时跑一次，避免后续对话中触发惰性迁移。
 * 幂等：已经 v2 的文件不会被改动。
 *
 * 运行：node tools/migrate-memory-v2.js [数据目录]
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';

const DATA_DIR = process.argv[2] || new URL('../data/', import.meta.url).pathname;

async function main() {
  if (!existsSync(DATA_DIR)) {
    console.log('[migrate-memory] 数据目录不存在，无需迁移');
    return;
  }

  // 只迁移"记忆档案"文件：qq-*.json 和 group-*.json。
  // 不能碰 reminders.json / qq-state.json 这类非记忆文件 ——
  // 之前用「所有 .json」过滤，把 reminders.json 清空了。
  const files = (await readdir(DATA_DIR)).filter(
    (f) => extname(f) === '.json' && /^(qq|group)-/.test(f)
  );

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const p = join(DATA_DIR, file);
    try {
      const raw = await readFile(p, 'utf8');
      const state = JSON.parse(raw);

      // 已经是 v2 就跳过
      if (state.version && state.version >= 2) {
        skipped++;
        continue;
      }

      // 给 profile.facts 加 v2 字段
      const facts = state.profile?.facts ?? [];
      state.profile = state.profile || {};
      state.profile.facts = facts.map((f) => {
        if (f && f.status) return f; // 已经是 v2
        return {
          key: f?.key ?? `fact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          text: f?.text ?? '',
          at: f?.at ?? Date.now(),
          type: 'fact',
          status: 'active',
          confidence: 0.85,
          source: { type: 'migration', turnId: null, utterance: null },
          validFrom: f?.at ?? Date.now(),
          validTo: null,
          supersededBy: null,
          tags: [],
        };
      });

      state.version = 2;

      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(state, null, 2), 'utf8');
      migrated++;
      console.log(`[migrate-memory] 已迁移：${file}`);
    } catch (err) {
      failed++;
      console.error(`[migrate-memory] 迁移失败 ${file}: ${err.message}`);
    }
  }

  console.log(
    `[migrate-memory] 完成：迁移 ${migrated} 个，跳过 ${skipped} 个，失败 ${failed} 个`
  );
}

main().catch((err) => {
  console.error('[migrate-memory] 异常:', err);
  process.exit(1);
});
