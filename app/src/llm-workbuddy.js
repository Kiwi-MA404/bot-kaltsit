/**
 * WorkBuddy 后端 —— 用 codebuddy CLI 当她的模型来源。
 *
 * 为什么这样接（重要）：
 *
 *   WorkBuddy 自己有一套人格系统（SOUL.md / IDENTITY.md / USER.md）
 *   和会话记忆（--session-id）。如果我们让它接管，她的记忆就会
 *   被劈成两半：一半在 WorkBuddy 里，一半在 companion/data/ 里。
 *
 *   所以这里把 WorkBuddy 当**无状态文本生成器**用：
 *   - 每次把完整上下文（人设 + 记忆 + 对话）拼成一个 prompt 传进去
 *   - 不传 --session-id，不碰 WorkBuddy 的会话存储
 *   - 她的记忆始终只存在于 companion/data/
 *
 * 代价：每次调用要冷启动一个 agent 进程，比 DSH 网关慢。
 * 好处：她的人格和记忆完全可控、可迁移、可备份。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CODEBUDDY_CLI =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';

/** CLI 需要 PATH 里有 node */
function withNodeInPath(env = process.env) {
  const candidates = [
    process.execPath ? dirname(process.execPath) : null,
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin',
  ].filter(Boolean);

  const extra = candidates.filter((p) => existsSync(p)).join(':');
  if (!extra) return env;

  return { ...env, PATH: `${extra}:${env.PATH ?? ''}` };
}

/** 把消息数组压成一段 prompt —— codebuddy -p 只接受单个 prompt 字符串 */
export function formatConversation(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');

  const parts = [];

  if (system) {
    parts.push(system);
    parts.push('\n———\n');
  }

  if (turns.length > 0) {
    // 最后一条是我们要他回应的那句话，单独标出来
    const last = turns[turns.length - 1];
    const earlier = turns.slice(0, -1);

    if (earlier.length) {
      parts.push('以下是你们之前的对话：\n');
      for (const m of earlier) {
        parts.push(`${m.role === 'user' ? '他' : '你'}：${m.content}`);
      }
      parts.push('\n———\n');
    }

    parts.push(
      `他刚刚说：${last.content}\n\n`,
      '现在轮到你回他。按上面人设里说的方式来——一句话一条，逐条输出。',
    );
  }

  return parts.join('\n');
}

export class WorkBuddyLlm {
  /**
   * @param {object} opts
   * @param {string} [opts.cli]      codebuddy 可执行路径
   * @param {string} [opts.model]    指定模型（不传用它的默认）
   * @param {number} [opts.timeoutMs]
   */
  constructor({ cli = CODEBUDDY_CLI, model = null, timeoutMs = 180_000 } = {}) {
    this.cli = cli;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /** 检查 CLI 是否可用、是否已登录 */
  async check() {
    if (!existsSync(this.cli)) {
      return { ok: false, reason: 'missing', detail: `找不到 ${this.cli}` };
    }

    try {
      const { stdout, stderr } = await this._run(['-p', '--tools', '', '只回答两个字：收到'], 60_000);

      // 注意：认证失败时 codebuddy 把提示写到 stderr，
      // 而且**退出码仍然是 0**。所以必须同时看两边。
      const combined = `${stdout}\n${stderr}`;
      if (/Authentication required/i.test(combined)) {
        return {
          ok: false,
          reason: 'auth',
          detail: 'WorkBuddy 未登录。先打开 WorkBuddy 应用完成 /login。',
        };
      }

      const text = stdout.trim();
      if (!text) {
        return {
          ok: false,
          reason: 'empty',
          detail: `返回空内容。stderr: ${stderr.trim().slice(0, 200) || '(空)'}`,
        };
      }

      return { ok: true, detail: text.slice(0, 60) };
    } catch (err) {
      return { ok: false, reason: 'error', detail: err.message };
    }
  }

  /**
   * @param {Array<{role:string,content:string}>} messages
   * @returns {Promise<string>}
   */
  async chat(messages) {
    const prompt = formatConversation(messages);

    const args = ['-p', '--tools', '', '--output-format', 'text'];
    if (this.model) args.push('--model', this.model);
    args.push(prompt);

    const { stdout, stderr } = await this._run(args, this.timeoutMs);
    const combined = `${stdout}\n${stderr}`;

    if (/Authentication required/i.test(combined)) {
      throw new Error('WorkBuddy 未登录，先在 WorkBuddy 应用里 /login');
    }

    const text = stdout.trim();
    if (!text) {
      throw new Error(
        `WorkBuddy 返回空内容（退出码 0）。stderr: ${stderr.trim().slice(0, 200) || '(空)'}`,
      );
    }

    return text;
  }

  _run(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, args, {
        env: withNodeInPath(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(new Error(`WorkBuddy 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);

        // 认证失败时退出码是 0，所以不能靠退出码判断。
        // 只有「有错误输出且完全没有 stdout」才算真失败。
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`codebuddy 退出码 ${code}: ${stderr.slice(0, 200)}`));
          return;
        }
        resolve({ stdout, stderr, code });
      });
    });
  }
}

export { withNodeInPath };
