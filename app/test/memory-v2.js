/**
 * 记忆 v2 最小测试：牛奶场景。
 *
 * 验证：
 *   1. 旧版 facts 能平滑迁移到 v2 schema。
 *   2. 偏好可以被覆盖，旧偏好标记为 superseded，不进入 system prompt。
 *   3. 观察（桌上牛奶）与偏好（不喝牛奶）分开存，不污染偏好库。
 *   4. auditConflicts 能检测到冲突。
 *
 * 运行：node test/memory-v2.js
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';

const TMP_DIR = new URL('./.tmp-memory-v2/', import.meta.url).pathname;

function clean() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`❌ ${msg}`);
  console.log(`✅ ${msg}`);
}

async function main() {
  clean();
  const memory = new Memory({ dir: TMP_DIR });
  const cid = 'test-user';

  // 1. 模拟旧版数据：直接写个旧格式文件，再 load，看是否迁移成功
  const oldState = {
    contactId: cid,
    createdAt: Date.now(),
    profile: {
      facts: [
        { key: 'milk', text: '他喜欢喝牛奶', at: Date.now() - 100000 },
      ],
    },
    history: [],
    summary: '',
    stats: { messages: 0, lastSeen: null },
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.writeFile(join(TMP_DIR, `${encodeURIComponent(cid)}.json`), JSON.stringify(oldState));

  let s = await memory.load(cid);
  let facts = s.profile.facts;
  assert(facts.length === 1, '旧数据成功加载');
  assert(facts[0].status === 'active', '旧事实迁移后状态为 active');
  assert(facts[0].type === 'fact', '旧事实迁移后类型为 fact');
  assert(facts[0].confidence > 0, '旧事实迁移后有置信度');

  // 2. 用户表达新偏好：不喜欢喝牛奶。应把旧偏好标记为 superseded。
  const turnId = 't_001';
  const newFact = await memory.remember(cid, {
    key: 'pref_milk',
    text: '他不喜欢喝牛奶，喝了肚子不舒服',
    type: 'preference',
    confidence: 0.95,
    source: { turnId, utterance: '我不喜欢喝牛奶', extractor: 'test' },
    tags: ['饮食'],
    supersedes: ['milk'],
  });

  assert(newFact.status === 'active', '新偏好写入后为 active');

  s = await memory.load(cid);
  const oldMilk = s.profile.facts.find((f) => f.key === 'milk');
  assert(oldMilk.status === 'superseded', '旧牛奶事实被标记为 superseded');
  assert(oldMilk.supersededBy === 'pref_milk', '旧牛奶事实 supersededBy 指向新偏好');
  assert(oldMilk.validTo != null, '旧牛奶事实有 validTo');

  const active = await memory.activeFacts(cid);
  assert(active.length === 1, '活跃事实只剩一条');
  assert(active[0].key === 'pref_milk', '活跃事实是新的牛奶偏好');

  // 3. 场景观察：桌上有杯牛奶。应作为 observation 存储，不变成偏好。
  await memory.addObservation(cid, '桌上有一杯未动的牛奶', {
    turnId: 't_002',
    utterance: '桌上这杯牛奶我没动',
    extractor: 'test',
  });

  s = await memory.load(cid);
  const obs = s.profile.facts.find((f) => f.type === 'observation');
  assert(obs != null, '观察被写入');
  assert(obs.status === 'active', '观察状态为 active');

  const prefs = await memory.activeFactsByType(cid, 'preference');
  assert(prefs.length === 1, '偏好库仍只有一条');

  // 4. 渲染 system prompt：不应再出现"喜欢喝牛奶"
  const rendered = await memory.renderFacts(cid);
  assert(rendered.includes('不喜欢喝牛奶'), '渲染中包含新偏好');
  assert(!rendered.includes('喜欢喝牛奶'), '渲染中不再包含旧偏好');
  assert(rendered.includes('桌上'), '渲染中包含观察');

  // 5. 审计冲突：应该能检测到"喜欢"与"不喜欢"牛奶之间的潜在冲突
  const conflicts = await memory.auditConflicts(cid);
  assert(conflicts.length >= 1, '审计发现至少一组潜在冲突');
  const milkConflict = conflicts.find((c) =>
    (c.textA.includes('牛奶') && c.textB.includes('牛奶')) ||
    (c.textA.includes('牛奶') && c.textB.includes('牛奶'))
  );
  assert(milkConflict != null, '审计发现了牛奶相关的冲突');

  console.log('\n--- renderFacts 输出 ---');
  console.log(rendered);
  console.log('\n--- auditConflicts 输出 ---');
  console.log(JSON.stringify(conflicts, null, 2));

  clean();
  console.log('\n🎉 牛奶场景测试全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
