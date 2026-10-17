/**
 * 模型客户端 —— 接 DSH 自带的本机 OpenAI 兼容网关。
 *
 * 为什么走网关而不是每次起 `dsh headless`：
 * 网关是常驻的 HTTP 服务，一次对话约 1 秒；子进程每次都要冷启动。
 * 网关地址和密钥由 DSH 自己维护，这里只读不写。
 *
 * 关于 reasoning_effort：
 * 默认 "none"。开着的话模型会把 token 全花在思考上、content 返回 null，
 * 聊天场景下表现为"闷着不说话"。她也确实不需要内心独白，她要直接说话。
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_HOST = 'http://127.0.0.1:8326';
const DEFAULT_MODEL = 'deepseek-account/deepseek-flash';


/**
 * 按配置选后端。默认走 DSH 本机网关。
 *
 *   backend: 'dsh'        —— DSH 的 OpenAI 兼容网关（默认，快）
 *   backend: 'workbuddy'  —— WorkBuddy 的 codebuddy CLI（慢，但可用它的模型）
 *   backend: 'ollama'     —— 本地 Ollama（无需任何账号，离线可用）
 *
 * 也可以用环境变量 COMPANION_BACKEND 切换，方便临时试。
 * 注意：换后端**不影响**她的人格和记忆——那些都在 persona/ 和 data/ 里。
 */
export async function createLlm(config = {}) {
  const backend = config.backend ?? process.env.COMPANION_BACKEND ?? 'dsh';

  if (backend === 'workbuddy') {
    const { WorkBuddyLlm } = await import('./llm-workbuddy.js');
    return new WorkBuddyLlm({ model: config.model ?? null });
  }

  if (backend === 'ollama') {
    // Ollama 从 0.1.24 起提供 OpenAI 兼容接口，路径和我们的 Llm 一致。
    // 差异：不支持 reasoning_effort；API key 随便填（本地服务不校验）。
    const ollama = config.ollama ?? {};
    return new Llm({
      baseUrl: ollama.host ?? 'http://127.0.0.1:11434',
      apiKey: ollama.apiKey ?? 'ollama',
      model: ollama.model ?? config.model ?? 'qwen2.5:7b',
      // 传 null 让 #request 不发送 reasoning_effort 字段
      reasoningEffort: null,
      temperature: ollama.temperature ?? 0.8,
      maxTokens: ollama.maxTokens ?? 1024,
      timeoutMs: ollama.timeoutMs ?? 180_000,
      // Ollama 的模型对工具调用的支持参差不齐，默认关掉，避免它卡在工具循环里
      disableTools: ollama.disableTools ?? true,
    });
  }

  return new Llm(config);
}

/** 自动发现 DSH 网关：端口可能变，密钥在 ~/.dsh/openai-gateway/api-key */
export function discoverGateway() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const keyFile = join(dshHome, 'openai-gateway', 'api-key');

  let apiKey = process.env.DSH_GATEWAY_KEY || '';
  if (!apiKey && existsSync(keyFile)) {
    apiKey = readFileSync(keyFile, 'utf8').trim();
  }

  return {
    baseUrl: process.env.DSH_GATEWAY_URL || DEFAULT_HOST,
    apiKey,
  };
}

export class Llm {
  constructor({
    baseUrl,
    apiKey,
    model = DEFAULT_MODEL,
    reasoningEffort = 'none',
    temperature = 1.1,
    maxTokens = 400,
    timeoutMs = 90_000,
    disableTools = false,
  } = {}) {
    const gw = discoverGateway();
    this.baseUrl = (baseUrl ?? gw.baseUrl).replace(/\/$/, '');
    this.apiKey = apiKey ?? gw.apiKey;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.disableTools = disableTools;
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`models ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return body.data.map((m) => m.id);
  }

  /**
   * 原始调用：返回完整的 message 对象，包含 tool_calls。
   *
   * 为什么要单独一个方法：chat() 只吐字符串，工具循环需要看到
   * tool_calls 字段才能决定要不要去搜索。把两者分开，chat() 保持简单。
   *
   * @param {Array<object>} messages
   * @param {{tools?:Array<object>, temperature?:number, maxTokens?:number, reasoningEffort?:string|null}} [opts]
   * @returns {Promise<{content:string, tool_calls:Array<object>}>}
   */
  async chatRaw(messages, { tools, temperature, maxTokens, reasoningEffort } = {}) {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens ?? this.maxTokens,
      temperature: temperature ?? this.temperature,
      stream: false,
    };
    // disableTools 时忽略工具定义（Ollama 小模型常卡在工具循环）
    if (tools?.length && !this.disableTools) body.tools = tools;

    // reasoningEffort 显式传 null 时表示"这次不带这个字段"
    const effort = reasoningEffort === null ? null : reasoningEffort ?? this.reasoningEffort;
    if (effort) body.reasoning_effort = effort;

    const msg = await this.#request(body);

    return {
      content: (msg.content ?? '').trim(),
      tool_calls: msg.tool_calls ?? [],
    };
  }

  /**
   * @param {Array<{role:string,content:string}>} messages
   * @returns {Promise<string>}
   */
  async chat(messages, { temperature, maxTokens, reasoningEffort } = {}) {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens ?? this.maxTokens,
      temperature: temperature ?? this.temperature,
      stream: false,
    };

    const effort = reasoningEffort ?? this.reasoningEffort;
    if (effort) body.reasoning_effort = effort;

    const msg = await this.#request(body);

    // content 为空但 reasoning_content 有东西：说明思考额度吃光了正文，
    // 这种情况宁可回一句短的，也不要让她发出空消息。
    if (!msg.content || !msg.content.trim()) {
      const r = (msg.reasoning_content || '').trim();
      if (r) console.warn('[llm] 正文为空，思考内容占满额度，考虑调大 max_tokens');
      return '';
    }

    return msg.content.trim();
  }

  /**
   * 发一次请求，带临时故障重试。
   *
   * 为什么必须重试：上游（workbuddy）经常抖 —— 502 upstream 500、
   * 429 队列满、连接超时。以前一抖这条消息就永久丢了：
   * 用户看到的是"她不回我"，而日志里只有一行 502。
   * 实测踩过：连问两次"前瞻什么时候"都没回，因为那两次刚好都 502。
   *
   * 重试策略：指数退避（1s / 2s / 4s），最多 3 次。
   * 只重试**临时**错误；401/402/403 这类永久错误直接抛，重试没意义。
   *
   * @returns {Promise<object>} 响应的 message 对象
   */
  async #request(body) {
    const MAX_ATTEMPTS = 3;
    let lastErr;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);

      let res;
      try {
        res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        // 网络层错误（超时、连接被拒）也算临时故障
        clearTimeout(timer);
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          const wait = 1000 * 2 ** (attempt - 1);
          console.warn(
            `[llm] 请求失败（${err.message}），${wait / 1000}s 后重试（${attempt}/${MAX_ATTEMPTS}）`,
          );
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const json = await res.json();
        return json.choices?.[0]?.message ?? {};
      }

      const text = await res.text().catch(() => '');

      // 永久错误：重试也不会好，直接抛
      const permanent = [400, 401, 402, 403, 404, 422];
      if (permanent.includes(res.status)) {
        throw new Error(`chat ${res.status}: ${text}`);
      }

      // 临时错误：5xx、429，以及上游包装成 502 的 soft_rate
      lastErr = new Error(`chat ${res.status}: ${text}`);
      const transient =
        res.status >= 500 ||
        res.status === 429 ||
        /soft_rate|queue\.full|upstream server|RATE_LIMIT|SERVER/.test(text);

      if (transient && attempt < MAX_ATTEMPTS) {
        const wait = 1000 * 2 ** (attempt - 1);
        console.warn(
          `[llm] 上游暂时不可用（${res.status}），${wait / 1000}s 后重试（${attempt}/${MAX_ATTEMPTS}）`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      throw lastErr;
    }

    throw lastErr ?? new Error('chat: 未知错误');
  }
}
