/**
 * 离线补偿选择逻辑测试（纯函数，不需要连 QQ）。
 *
 * 覆盖：
 *   1. 自己发的消息不会被补
 *   2. 已处理过（<= since）的不会被补
 *   3. 太旧（超过 maxAge）的不会被补
 *   4. 多补充时按时间升序，保证对话顺序正确
 *
 * 运行：node test/catchup.js
 */

import { selectMissedMessages, extractText } from '../src/bridge.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.log(`❌ ${name}\n   期望: ${e}\n   实际: ${a}`);
    failed++;
  }
}

const SELF = 1234567891;
const PEER = 1234567890;
const NOW = 1_800_000_000_000;

/** 构造一条历史消息。当秒时间戳用。 */
const msg = (sec, from, text) => ({
  time: sec,
  sender: { user_id: from },
  message: [{ type: 'text', data: { text } }],
});

console.log('=== 离线补偿选择逻辑 ===\n');

// 1. 过滤自己发的
{
  const history = [
    msg(NOW / 1000 - 100, PEER, '在吗'),
    msg(NOW / 1000 - 90, SELF, '在的'),
  ];
  const got = selectMissedMessages(history, {
    selfId: SELF,
    since: NOW - 1000 * 1000,
    now: NOW,
    maxAgeMs: 48 * 3600 * 1000,
  });
  check('自己发的消息不补', got.map((m) => extractText(m.message)), ['在吗']);
}

// 2. 已处理过的不补（<= since）
{
  const t = Math.floor(NOW / 1000);
  const history = [
    msg(t - 100, PEER, '早前已回过'),
    msg(t - 10, PEER, '新的这条'),
  ];
  const got = selectMissedMessages(history, {
    selfId: SELF,
    since: (t - 50) * 1000, // 只处理这之后
    now: NOW,
    maxAgeMs: 48 * 3600 * 1000,
  });
  check('已处理的跳过，只补新的', got.map((m) => extractText(m.message)), ['新的这条']);
}

// 3. 太旧的不补
{
  const t = Math.floor(NOW / 1000);
  const history = [
    msg(t - 3600 * 100, PEER, '一百小时前'), // 超过 48h
    msg(t - 3600 * 1, PEER, '一小时前'),
  ];
  const got = selectMissedMessages(history, {
    selfId: SELF,
    since: 0,
    now: NOW,
    maxAgeMs: 48 * 3600 * 1000,
  });
  check('超过 maxAge 的不补', got.map((m) => extractText(m.message)), ['一小时前']);
}

// 4. 乱序历史要按时间升序补，保证对话顺序
{
  const t = Math.floor(NOW / 1000);
  const history = [
    msg(t - 10, PEER, '第三条'),
    msg(t - 30, PEER, '第一条'),
    msg(t - 20, PEER, '第二条'),
  ];
  const got = selectMissedMessages(history, {
    selfId: SELF,
    since: 0,
    now: NOW,
    maxAgeMs: 48 * 3600 * 1000,
  });
  check('按时间升序补回', got.map((m) => extractText(m.message)), [
    '第一条',
    '第二条',
    '第三条',
  ]);
}

// 5. 空历史 / 全已处理，不该补
{
  check(
    '空历史不补',
    selectMissedMessages([], { selfId: SELF, since: 0, now: NOW, maxAgeMs: 1e12 }),
    [],
  );
  const t = Math.floor(NOW / 1000);
  check(
    '全部已处理时不补',
    selectMissedMessages([msg(t - 5, PEER, 'x')], {
      selfId: SELF,
      since: NOW,
      now: NOW,
      maxAgeMs: 1e12,
    }),
    [],
  );
}

// 6. extractText 对图片/表情的降级
{
  check('图片段降级为 [图片]', extractText([{ type: 'image', data: {} }]), '[图片]');
  check('混合文本正确拼接', extractText([
    { type: 'text', data: { text: '好看' } },
    { type: 'image', data: {} },
  ]), '好看[图片]');
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
