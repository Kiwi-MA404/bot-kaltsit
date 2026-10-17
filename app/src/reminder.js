/**
 * 轻量提醒调度器。
 *
 * 不依赖外部服务，纯 Node setTimeout。
 * 提醒存在 data/reminders.json，bot 启动时恢复未完成的。
 *
 * 一条提醒：
 *   {
 *     id: "r_xxx",
 *     contactId: "qq-1234567890",
 *     fireAt: 1792000000000,   // 触发时间戳
 *     reason: "用户要求11点叫他睡觉",
 *     content: "十一点了，去睡。", // 触发时让她说的内容；空则让她自己生成
 *     fired: false,
 *     cancelled: false
 *   }
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ReminderScheduler {
  /**
   * @param {object} opts
   * @param {string} opts.dir           数据目录
   * @param {function} opts.onFire      到点回调 (reminder) => Promise<void>
   * @param {string} [opts.filename]    文件名
   */
  constructor({ dir, onFire, filename = 'reminders.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, filename);
    this._onFire = onFire || (() => {});
    this._timers = new Map(); // id -> timeout
    this._cache = null;
  }

  get onFire() {
    return this._onFire;
  }

  set onFire(fn) {
    this._onFire = fn || (() => {});
  }

  async load() {
    if (!existsSync(this.path)) return [];
    try {
      const raw = await readFile(this.path, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
      return [];
    } catch (err) {
      console.error('[reminder] 读取失败:', err.message);
      return [];
    }
  }

  async save(reminders) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path, JSON.stringify(reminders, null, 2), 'utf8');
    this._cache = reminders;
  }

  async all() {
    if (this._cache) return this._cache;
    return this.load();
  }

  /**
   * 添加一条提醒。
   * @param {object} r
   * @param {string} r.contactId
   * @param {number} r.fireAt      触发时间戳
   * @param {string} [r.reason]    为什么设这个提醒
   * @param {string} [r.content]   触发时固定要说的内容；空则由发起模块生成
   * @returns {object} 完整的提醒对象
   */
  async add({ contactId, fireAt, reason = '', content = '' }) {
    const reminders = await this.all();
    const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const r = { id, contactId, fireAt, reason, content, fired: false, cancelled: false };
    reminders.push(r);
    await this.save(reminders);
    this._arm(r);
    return r;
  }

  /** 取消一条提醒 */
  async cancel(id) {
    const reminders = await this.all();
    const r = reminders.find((x) => x.id === id);
    if (!r || r.fired || r.cancelled) return false;
    r.cancelled = true;
    await this.save(reminders);
    this._disarm(id);
    return true;
  }

  /** 启动时恢复所有未完成的提醒 */
  async restore() {
    const reminders = await this.all();
    const now = Date.now();
    let restored = 0;
    let expired = 0;

    for (const r of reminders) {
      if (r.fired || r.cancelled) continue;

      if (r.fireAt <= now) {
        // 已经过期：立刻触发一次，避免用户错过
        r.fired = true;
        this.onFire(r).catch((err) => console.error('[reminder] 过期触发失败:', err.message));
        expired++;
      } else {
        this._arm(r);
        restored++;
      }
    }

    await this.save(reminders);
    return { restored, expired };
  }

  /** 清理已完成/取消超过 N 天的旧提醒 */
  async prune(keepDays = 7) {
    const reminders = await this.all();
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const kept = reminders.filter((r) => {
      if (!r.fired && !r.cancelled) return true;
      const touched = r.firedAt || r.cancelledAt || r.fireAt;
      return touched > cutoff;
    });
    if (kept.length !== reminders.length) await this.save(kept);
    return reminders.length - kept.length;
  }

  _arm(r) {
    this._disarm(r.id);
    const delay = Math.max(0, r.fireAt - Date.now());
    const t = setTimeout(() => this._fire(r), delay);
    // unref：定时器不应该让进程「活着不放」。
    // 不这么做的话，任何引用过 ReminderScheduler 的短命令（比如
    // tools/reminder-cli.js）都会挂住不退出 —— 实测踩过。
    if (typeof t.unref === 'function') t.unref();
    this._timers.set(r.id, t);
  }

  _disarm(id) {
    const t = this._timers.get(id);
    if (t) {
      clearTimeout(t);
      this._timers.delete(id);
    }
  }

  async _fire(r) {
    this._disarm(r.id);
    const reminders = await this.all();
    const target = reminders.find((x) => x.id === r.id);
    if (!target || target.fired || target.cancelled) return;

    target.fired = true;
    target.firedAt = Date.now();
    await this.save(reminders);

    try {
      await this.onFire(target);
    } catch (err) {
      console.error('[reminder] 触发失败:', err.message);
    }
  }

  stop() {
    for (const [id, t] of this._timers) clearTimeout(t);
    this._timers.clear();
  }
}
