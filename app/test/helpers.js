#!/usr/bin/env node
/**
 * 测试用的模型构造器。
 *
 * 为什么要这个文件：测试如果直接 `new Companion({...})` 而不传 llm，
 * 就会用 llm.js 里的 DEFAULT_MODEL —— 那是硬编码的，跟 config.json 无关。
 * 结果：config.json 换了模型，测试却还在打旧模型（比如余额耗尽的账号）。
 *
 * 这里让测试走跟 bot.js 完全一样的路径：读 config.json → createLlm。
 * 这样「配置里写什么模型，测试就测什么模型」。
 *
 * 也可以临时指定：
 *   COMPANION_TEST_MODEL=our-free-model/space-bunny-free node test/verify-persona.js
 */

import { readFileSync, existsSync } from 'node:fs';
import { createLlm } from '../src/llm.js';

const CONFIG_PATH = new URL('../config.json', import.meta.url).pathname;

/** 读取 companion/config.json（不存在就返回空对象） */
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 给测试用：按 config.json（或 COMPANION_TEST_MODEL）建一个 Llm。
 * 返回的实例额外挂一个 `.model`，方便测试打印用了哪个模型。
 */
export async function testLlm(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };

  // 显式指定的模型优先级最高
  if (process.env.COMPANION_TEST_MODEL) {
    config.model = process.env.COMPANION_TEST_MODEL;
  }

  return createLlm(config);
}

/**
 * 给测试用：直接建一个走对模型的 Companion。
 * 用法：const companion = await testCompanion({ dataDir });
 */
export async function testCompanion(options = {}) {
  const { Companion } = await import('../src/companion.js');
  const llm = await testLlm(options.llmOverrides);
  return new Companion({ ...options, llm });
}

/** 打印当前测试将使用的模型，方便排查 */
export function describeModel() {
  const fromEnv = process.env.COMPANION_TEST_MODEL;
  if (fromEnv) return `${fromEnv} (来自 COMPANION_TEST_MODEL)`;
  const config = loadConfig();
  return config.model ?? 'deepseek-account/deepseek-flash (llm.js 默认)';
}
