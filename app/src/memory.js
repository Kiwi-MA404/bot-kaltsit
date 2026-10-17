/**
 * 记忆层（v2）。
 *
 * 分三层存，对应三种不同的"记得"：
 *   1. profile.facts  —— 结构化事实，永久保留，每轮都进上下文
 *   2. history        —— 对话原文，滑动窗口，超出窗口的靠摘要兜底
 *   3. summary        —— 旧对话的浓缩，防止长期失忆
 *   4. archive        —— 被摘要挤掉的对话原文（只增不改，用于追溯）
 *
 * v2 在 facts 上加了状态机：
 *   - 每条事实有 type/status/confidence/source/validFrom/validTo/supersededBy
 *   - "active" 的才会被渲染进 system prompt
 *   - 被覆盖的记忆标记为 superseded，保留审计链，不直接删除
 *   - 观察（observation）和偏好（preference）分开，避免把瞬时场景当长期事实
 *
 * 对外只暴露一个 Memory 类，内部按 contactId 分文件存。
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_WINDOW = 40; // 进上下文的最大消息条数

/**
 * 把事实文本里的绝对日期换成相对说法。
 */
function relativizeDates(text, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  return String(text).replace(
    /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
    (whole, mm, dd) => {
      const m = Number(mm);
      const d = Number(dd);
      if (m < 1 || m > 12 || d < 1 || d > 31) return whole;

      const target = new Date(now.getFullYear(), m - 1, d);
      const diffDays = Math.round((today - target) / 86400000);

      if (diffDays === 0) return `${m}月${d}日（今天）`;
      if (diffDays === 1) return `${m}月${d}日（昨天/昨晚）`;
      if (diffDays === 2) return `${m}月${d}日（前天）`;
      return whole;
    },
  );
}

/**
 * 生成一个短、可读、尽量不冲突的 key。
 */
function factKey(type, text) {
  const base = text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 24)
    .replace(/^_+|_+$/g, '');
  return `${type}_${base || 'unknown'}_${Date.now().toString(36).slice(-4)}`;
}

export class Memory {
  /**
   * @param {object} opts
   * @param {string} opts.dir        数据目录
   * @param {number} [opts.window]   滑动窗口大小
   * @param {number} [opts.summarizeAt] 超过多少条触发摘要
   */
  constructor({ dir, window = DEFAULT_WINDOW, summarizeAt = 120 } = {}) {
    this.dir = dir;
    this.window = window;
    this.summarizeAt = summarizeAt;
    this.cache = new Map();
  }

  pathFor(contactId) {
    return join(this.dir, `${encodeURIComponent(contactId)}.json`);
  }

  async load(contactId) {
    if (this.cache.has(contactId)) return this.cache.get(contactId);

    const p = this.pathFor(contactId);
    let state = {
      contactId,
      createdAt: Date.now(),
      profile: { facts: [], named: null, notes: [] },
      history: [],
      summary: '',
      stats: { messages: 0, lastSeen: null },
      version: 2,
    };

    if (existsSync(p)) {
      try {
        const raw = JSON.parse(await readFile(p, 'utf8'));
        state = { ...state, ...raw };
        // 迁移：旧版 facts 只有 {key, text, at}，升级成 v2 schema
        if (!raw.version || raw.version < 2) {
          state.profile.facts = this.#migrateFacts(state.profile.facts ?? []);
          state.version = 2;
          // 立即保存迁移结果（直接写文件，避免调用 save 再次触发 load）
          this.cache.set(contactId, state);
          await writeFile(p, JSON.stringify(state, null, 2), 'utf8');
        }
      } catch (err) {
        console.error(`[memory] 读取 ${p} 失败，使用空档案:`, err.message);
      }
    }

    this.cache.set(contactId, state);
    return state;
  }

  /**
   * 把旧版 facts 迁移成 v2 格式。
   * 旧数据不会被删，只是按 active 状态补上字段。
   */
  #migrateFacts(facts) {
    return facts.map((f) => {
      if (f && f.status) return f; // 已经是 v2
      return {
        key: f?.key ?? factKey('fact', f?.text ?? ''),
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
  }

  async save(contactId) {
    const state = await this.load(contactId);
    const p = this.pathFor(contactId);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * 追加一条对话原文。
   *
   * @param {string} contactId
   * @param {'user'|'assistant'} role
   * @param {string} content
   * @param {{at?:number, dedupe?:boolean}} [opts]
   *   at:     指定时间戳（离线补偿时用消息原始时间）
   *   dedupe: 是否启用去重（默认 true）
   *
   * 为什么要去重：reply() 现在「先写用户消息、再调模型」，
   * 万一失败会整轮重试、或由离线补偿再捞一次，
   * 同一条话就会被写两遍 —— 她会看到自己重复问过同样的东西。
   */
  async append(contactId, role, content, { at, dedupe = true } = {}) {
    const s = await this.load(contactId);
    const ts = at ?? Date.now();

    if (dedupe) {
      // 去重策略：只跟「最后一条」比，前后完全一致就跳过。
      //
      // 为什么不看末尾 5 条：那样会误伤"中间隔了一轮，又问了同样的话"。
      // 比如他说「前瞻什么时候」→ 她答了 → 他又问「前瞻什么时候」，
      // 这是合理的重复提问，必须都保留。
      //
      // 而这个规则足够覆盖真正要防的两种情况：
      //   1. 同一次处理里的整轮重试（最后一条就是刚写的）
      //   2. 离线补偿重放（上次失败时这条已落盘，仍在末尾）
      const last = s.history.at(-1);
      if (last && last.role === role && last.content === content) {
        return s;
      }
    }

    s.history.push({ role, content, at: ts });
    s.stats.messages += 1;
    s.stats.lastSeen = Date.now();
    await this.save(contactId);
    return s;
  }

  /**
   * 记一条结构化事实。
   *
   * 如果同主题已有 active 事实：
   *   - 若新事实与旧的是同一命题，旧事实被标记为 superseded，新事实成为当前版本
   *   - 不会物理删除旧事实，保留审计链
   *
   * @param {string} contactId
   * @param {object} fact
   * @param {string} fact.text       自然语言描述
   * @param {string} [fact.key]      主题键；不提供则自动生成
   * @param {string} [fact.type]     preference|attribute|fact|observation|event
   * @param {number} [fact.confidence] 0~1
   * @param {object} [fact.source]   { turnId, utterance, extractor }
   * @param {string[]} [fact.tags]   标签
   */
  async remember(contactId, fact) {
    const s = await this.load(contactId);
    const now = Date.now();
    const key = fact.key ?? factKey(fact.type ?? 'fact', fact.text);

    const entry = {
      key,
      text: fact.text,
      at: now,
      type: fact.type ?? 'fact',
      status: 'active',
      confidence: fact.confidence ?? 0.9,
      source: {
        type: 'extracted',
        turnId: fact.source?.turnId ?? null,
        utterance: fact.source?.utterance ?? null,
        extractor: fact.source?.extractor ?? 'memory.remember',
        ...fact.source,
      },
      validFrom: now,
      validTo: null,
      supersededBy: null,
      tags: fact.tags ?? [],
    };

    // 查找同主题 active 事实。
    // 注意：key 可能由模型自由生成，同一个主题会有不同 key。调用方如果做
    // 了 reconcile，应该显式传 "supersedes" 数组；否则这里只按 key 精确匹配兜底。
    if (fact.supersedes) {
      for (const oldKey of Array.isArray(fact.supersedes) ? fact.supersedes : [fact.supersedes]) {
        const old = s.profile.facts.find((x) => x.key === oldKey && x.status === 'active');
        if (old) this.#retireFact(old, entry);
      }
    }

    // 按 key 精确匹配兜底：同 key 旧事实直接退役
    const sameKey = s.profile.facts.find((x) => x.key === key && x.status === 'active');
    if (sameKey && !fact.supersedes?.includes(sameKey.key)) {
      this.#retireFact(sameKey, entry);
      entry.supersedes = [sameKey.key];
    }

    s.profile.facts.push(entry);

    // 限制 active 事实数量；过期/撤销的不计入，保留用于审计
    const active = s.profile.facts.filter((f) => f.status === 'active');
    if (active.length > 50) {
      // 按时间戳取最新的 50 条 active，旧的 active 标记为 stale
      const sorted = active.sort((a, b) => b.at - a.at);
      for (const f of sorted.slice(50)) {
        f.status = 'stale';
        f.validTo = f.validTo ?? now;
      }
    }

    await this.save(contactId);
    return entry;
  }

  /**
   * 把一条 active 事实退役。
   * 不删除，只是改状态和加 supersededBy/validTo。
   */
  #retireFact(old, replacement) {
    old.status = 'superseded';
    old.validTo = Date.now();
    old.supersededBy = replacement.key;
  }

  /**
   * 显式撤销/修改某条事实。
   * @param {string} contactId
   * @param {string} key
   * @param {{text?: string, reason?: string}} [update]
   */
  async retractFact(contactId, key, update = {}) {
    const s = await this.load(contactId);
    const fact = s.profile.facts.find((x) => x.key === key && x.status === 'active');
    if (!fact) return null;

    const now = Date.now();
    fact.status = 'retracted';
    fact.validTo = now;
    if (update.reason) fact.retractReason = update.reason;

    // 如果有替代说法，直接记一条新的
    if (update.text) {
      await this.remember(contactId, {
        key: factKey(fact.type, update.text),
        text: update.text,
        type: fact.type,
        confidence: 0.95,
        source: { turnId: update.turnId ?? null, utterance: update.text, extractor: 'manual' },
        tags: [...fact.tags],
        supersedes: [fact.key],
      });
    }

    await this.save(contactId);
    return fact;
  }

  /**
   * 添加一条瞬时观察（场景级，不应进入长期偏好库）。
   *
   * 关键：同一类新观察要顶掉旧的。
   * 实测踩过：他先后说过"开始上课了""上完课了""刚起来"，
   * 三条全都 active 塞进 system，她同时看到互相矛盾的状态，
   * 于是回了句"不是刚说去休息了吗 怎么又起来了"。
   * 观察是**当前状态**，新的必须取代旧的，不能叠加。
   *
   * @param {string} contactId
   * @param {string} text
   * @param {object} [source] 可带 category 指定观察类别
   */
  async addObservation(contactId, text, source = {}) {
    const category = source.category ?? 'state';
    const key = `obs_${category}`;

    return this.remember(contactId, {
      key,
      text,
      type: 'observation',
      confidence: source.confidence ?? 0.8,
      source: { type: 'observation', ...source },
      tags: ['scene', category],
    });
  }

  /** 返回所有 active 且未过期的事实 */
  activeFacts(contactId, now = Date.now()) {
    return this.load(contactId).then((s) =>
      (s.profile.facts ?? [])
        .filter((f) => f.status === 'active' && (f.validTo == null || f.validTo > now))
    );
  }

  /** 按类型筛选 active 事实 */
  activeFactsByType(contactId, type, now = Date.now()) {
    return this.activeFacts(contactId, now).then((facts) => facts.filter((f) => f.type === type));
  }

  async setSummary(contactId, summary, keepFrom) {
    const s = await this.load(contactId);

    if (typeof keepFrom === 'number' && keepFrom > 0) {
      const dropped = s.history.slice(0, keepFrom);
      if (dropped.length) await this.#appendArchive(contactId, dropped);
    }

    s.summary = summary;
    if (typeof keepFrom === 'number') s.history = s.history.slice(keepFrom);
    await this.save(contactId);
  }

  async #appendArchive(contactId, entries) {
    const dir = join(this.dir, 'archive');
    const file = join(dir, `${encodeURIComponent(contactId)}.jsonl`);
    try {
      await mkdir(dir, { recursive: true });
      const lines = entries
        .map((m) =>
          JSON.stringify({
            at: m.at ?? Date.now(),
            role: m.role,
            content: m.content,
          }),
        )
        .join('\n');
      await appendFile(file, lines + '\n', 'utf8');
    } catch (err) {
      console.warn(`[memory] 归档失败（不影响对话）: ${err.message}`);
    }
  }

  async buildMessages(contactId) {
    const s = await this.load(contactId);
    const recent = s.history.slice(-this.window);
    return recent.map(({ role, content }) => ({ role, content }));
  }

  /** 把结构化事实渲染成一段自然语言，塞进 system */
  async renderFacts(contactId, now = new Date()) {
    const s = await this.load(contactId);
    const lines = [];

    if (s.profile.named) lines.push(`你平时叫他「${s.profile.named}」。`);

    const active = await this.activeFacts(contactId, now.getTime());

    // 分类渲染
    const prefs = active.filter((f) => f.type === 'preference');
    const attrs = active.filter((f) => f.type === 'attribute');
    const facts = active.filter((f) => f.type === 'fact' || f.type === 'event');
    const obs = active.filter((f) => f.type === 'observation');

    if (prefs.length) {
      lines.push('你记得他的偏好：');
      for (const f of prefs) lines.push(`- ${relativizeDates(f.text, now)}`);
    }

    if (attrs.length) {
      lines.push('你记得他的属性/状态：');
      for (const f of attrs) lines.push(`- ${relativizeDates(f.text, now)}`);
    }

    if (facts.length) {
      lines.push('你记得关于他的事：');
      for (const f of facts) lines.push(`- ${relativizeDates(f.text, now)}`);
    }

    if (obs.length) {
      // 观察是「当下状态」，只展示最新的几条，并明确标注时间。
      // 关键是要让她知道这是**什么时候**的状态 —— 否则她会把
      // 上午的"在上课"和下午的"刚起来"当成同时成立，说出
      // "不是刚说去休息了吗 怎么又起来了"这种自相矛盾的话。
      const recentObs = [...obs].sort((a, b) => b.at - a.at).slice(0, 3);
      lines.push('他最近的状态（会过期，只反映他上次说话时的情况）：');
      for (const f of recentObs) {
        const when = new Date(f.at);
        const hh = String(when.getHours()).padStart(2, '0');
        const mm = String(when.getMinutes()).padStart(2, '0');
        lines.push(`- ${hh}:${mm} 他说：${relativizeDates(f.text, now)}`);
      }
      lines.push(
        '（注意：这些是他**过去**说过的话，不代表现在。' +
          '不要拿旧状态去质疑他现在的说法。）',
      );
    }

    for (const n of s.profile.notes ?? []) lines.push(`- ${n}`);

    if (s.summary) lines.push(`\n你们之前聊过（摘要）：${s.summary}`);

    return lines.join('\n');
  }

  /** 是否需要压缩旧历史 */
  async needsSummarize(contactId) {
    const s = await this.load(contactId);
    return s.history.length > this.summarizeAt;
  }

  /** 取出等待被摘要的那一段 */
  async takeForSummarize(contactId) {
    const s = await this.load(contactId);
    const cut = s.history.length - this.window;
    if (cut <= 0) return { old: [], keepFrom: 0 };
    return { old: s.history.slice(0, cut), keepFrom: cut };
  }

  /**
   * 一致性审计：列出同一个主题下可能同时存在的 active 矛盾对。
   * 返回 [{a, b, reason}], 不修改数据。
   */
  async auditConflicts(contactId) {
    const active = await this.activeFacts(contactId);
    const conflicts = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        // 简单启发：文本里出现反义词/否定，且主题相近则标记
        if (this.#looksContradictory(a.text, b.text)) {
          conflicts.push({ a: a.key, b: b.key, textA: a.text, textB: b.text });
        }
      }
    }
    return conflicts;
  }

  #looksContradictory(a, b) {
    const na = this.#normalizeForConflict(a);
    const nb = this.#normalizeForConflict(b);
    // 共同词干足够多，且一方含否定另一方不含
    const wordsA = new Set(na.split(/\s+/));
    const wordsB = nb.split(/\s+/);
    const overlap = [...wordsA].filter((w) => wordsB.includes(w) && w.length > 1);
    if (overlap.length < 2) return false;
    const negA = /(不|没|无|讨厌|厌恶|拒绝|不要)/.test(a);
    const negB = /(不|没|无|讨厌|厌恶|拒绝|不要)/.test(b);
    return negA !== negB;
  }

  #normalizeForConflict(text) {
    return String(text)
      .replace(/[，。！？、；：""''（）]/g, ' ')
      .replace(/牛奶/g, '奶')
      .replace(/不喜欢/g, '厌')
      .replace(/喜欢/g, '喜')
      .trim();
  }
}
