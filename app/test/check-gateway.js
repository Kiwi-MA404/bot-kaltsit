#!/usr/bin/env node
/** 网关连通性自检。接 QQ 之前先跑这个，避免链路问题和人设问题混在一起。 */

import { Llm, discoverGateway } from '../src/llm.js';

const gw = discoverGateway();
console.log('gateway :', gw.baseUrl);
console.log('api key :', gw.apiKey ? `已读取（${gw.apiKey.slice(0, 6)}…）` : '\x1b[31m缺失\x1b[0m');

if (!gw.apiKey) {
  console.error('\n找不到密钥。确认 DSH 桌面端正在运行，或设置 DSH_GATEWAY_KEY。');
  process.exit(1);
}

const llm = new Llm();

try {
  const models = await llm.listModels();
  console.log(`models  : ${models.length} 个可用`);
  if (!models.includes(llm.model)) {
    console.warn(`\x1b[33m注意：默认模型 ${llm.model} 不在列表里\x1b[0m`);
  }
} catch (err) {
  console.error(`\x1b[31m列举模型失败: ${err.message}\x1b[0m`);
  process.exit(1);
}

const t0 = Date.now();
try {
  const out = await llm.chat([{ role: 'user', content: '只回答两个字：收到' }]);
  if (!out) throw new Error('返回空内容（思考额度吃光了正文？）');
  console.log(`延迟    : ${Date.now() - t0}ms`);
  console.log(`回复    : ${out}`);
  console.log('\x1b[32m链路正常。\x1b[0m');
} catch (err) {
  console.error(`\x1b[31m对话失败: ${err.message}\x1b[0m`);
  process.exit(1);
}
