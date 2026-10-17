/**
 * QQ 桥接：把 NapCat 事件接到陪伴体。
 *
 * 除了转发消息，这里最重要的是几个「安全阀」。没有它们，陪伴体会变成骚扰机器，
 * 而且很容易被风控。每个阀门都可以在 config.json 里调。
 *
 *   1. 白名单     —— 只回复列表里的 QQ，陌生人一律不理
 *   2. 发送间隔   —— 她一句一条发，但要有间隔，否则不像人且触发风控
 *   3. 频率上限   —— 单位时间内回太多条就闭嘴
 *   4. 主动发起   —— 每天最多 N 次，且对方最近回过话才允许
 *   5. 人工接管   —— 你在手机上回一句，她自动退开一段时间
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { imageSegmentToDataUrl, pickImages, roughTokens } from './image.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 终端着色：bridge 是常驻日志，颜色能让"已通过/未通过"一眼区分
const C_OK = (s) => `\x1b[32m${s}\x1b[0m`;
const C_WARN = (s) => `\x1b[33m${s}\x1b[0m`;
const C_DIM = (s) => `\x1b[2m${s}\x1b[0m`;

export const DEFAULT_CONFIG = {
  napcat: {
    mode: 'ws-reverse', // 'ws-reverse' = NapCat 连我们；'ws' = 我们连 NapCat
    url: 'ws://127.0.0.1:3001',
    port: 3002,
    host: '127.0.0.1',
    accessToken: '',
  },

  // 只跟这些人说话。留空数组 = 不回任何人（防止刚部署就乱回）
  allowlist: [],

  // 群聊默认不参与。要开启需要 @她，且群必须在下面列表里
  groups: [],

  send: {
    minGapMs: 550, // 两条消息之间的间隔
    maxChars: 300, // 单条上限，超了截断（防刷屏）
    burstWindowMs: 60_000,
    maxPerWindow: 25, // 每分钟最多发这么多条
  },

  // 她主动开口的规则
  initiate: {
    enabled: false, // 默认关。想开先用小号观察几天
    perDay: 2,
    minIdleHours: 8, // 对方至少这么久没说话
    maxIdleHours: 72, // 但超过这么久就别打扰了
    activeHourFrom: 8, // 只在 8 点到 23 点之间主动
    activeHourTo: 23,
    checkIntervalMs: 15 * 60_000,
  },

  // 你在手机上亲自回话后，她安静多久
  takeover: {
    manualQuietMs: 30 * 60_000,
  },

  // 离线补偿：机器人没运行时对方发的消息，下次启动时补回
  catchUp: {
    enabled: true,
    maxMessages: 20, // 每个联系人最多回看多少条历史
    maxAgeHours: 48, // 超过这么久的不再补
    maxPerRun: 5, // 一次启动最多补几个人，防止刷屏
  },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v)
        ? deepMerge(base[k] ?? {}, v)
        : v;
  }
  return out;
}

/** 从 OneBot 消息段或字符串里取纯文本 */
export function extractText(message) {
  if (typeof message === 'string') return message.trim();
  if (!Array.isArray(message)) return '';

  const parts = [];
  for (const seg of message) {
    if (seg?.type === 'text') parts.push(seg.data?.text ?? '');
    else if (seg?.type === 'image') parts.push('[图片]');
    else if (seg?.type === 'face') parts.push('[表情]');
    else if (seg?.type === 'at') parts.push(`@${seg.data?.qq ?? ''}`);
  }
  return parts.join('').trim();
}

/**
 * 从历史消息里挑出「需要补回」的那些。
 *
 * 抽成纯函数是为了能单独测试：离线补偿最怕的是重复回复，
 * 而这种 bug 只有真跑起来才暴露，代价高。
 *
 * @param {Array<object>} history   NapCat 返回的历史（旧的在前）
 * @param {object} opts
 * @param {number|string} opts.selfId   自己的 QQ 号
 * @param {number} opts.since           只取这个时间戳（ms）之后的消息
 * @param {number} opts.now             当前时间（ms）
 * @param {number} opts.maxAgeMs        超过这个年龄的消息不补
 * @returns {Array<object>} 按时间升序排列的待补消息
 */
export function selectMissedMessages(history, { selfId, since, now, maxAgeMs }) {
  return (history ?? [])
    .filter((m) => {
      // 自己发的不补
      if (String(m.sender?.user_id) === String(selfId)) return false;

      const ts = (m.time ?? 0) * 1000;
      if (!ts) return false;
      if (ts <= since) return false; // 已经处理过
      if (now - ts > maxAgeMs) return false; // 太旧了，不补
      return true;
    })
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

export class QQBridge {
  /**
   * @param {object} opts
   * @param {import('./companion.js').Companion} opts.companion
   * @param {import('./napcat.js').NapCat} opts.napcat
   * @param {object} [opts.config]
   * @param {string} [opts.statePath] 持久化运行状态（频率、接管）
   */
  constructor({ companion, napcat, config = {}, statePath }) {
    this.companion = companion;
    this.napcat = napcat;
    this.config = deepMerge(DEFAULT_CONFIG, config);
    this.statePath = statePath
      ?? process.env.DSH_QQ_STATE
      ?? new URL('../data/qq-state.json', import.meta.url).pathname;

    this.state = {
      sends: [],
      lastInitiate: {},
      quietUntil: {},
      lastUserAt: {},
      lastHandledAt: {},
    };
    this._busy = new Set(); // 正在处理的联系人，防止并发交叉回复
    this._timer = null;
  }

  async loadState() {
    if (existsSync(this.statePath)) {
      try {
        this.state = { ...this.state, ...JSON.parse(await readFile(this.statePath, 'utf8')) };
      } catch (err) {
        console.error('[bridge] 状态读取失败，用空状态:', err.message);
      }
    }
  }

  async saveState() {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state), 'utf8');
  }

  async start() {
    await this.loadState();

    this.napcat.on('event', (ev) => {
      this.handleEvent(ev).catch((err) =>
        console.error('[bridge] 事件处理失败:', err.message),
      );
    });

    this.napcat.on('warn', (m) => console.warn(`[napcat] ${m}`));
    this.napcat.on('connected', () => console.log('[napcat] 已连接'));
    this.napcat.on('disconnected', () => console.warn('[napcat] 连接断开'));
    this.napcat.on('listening', (a) => console.log(`[napcat] 等待 NapCat 连入 ${a}`));

    await this.napcat.start();

    // 连接可能还没建立（尤其 ws 模式要等 NapCat 连过来），
    // 拿不到登录信息不算致命，重试几次即可。
    const info = await this._waitLoginInfo();
    if (info) console.log(`[bridge] 登录号 ${info.user_id}（${info.nickname ?? ''}）`);
    else console.warn('[bridge] 暂时拿不到登录信息，等 NapCat 连上后会补上');

    if (this.config.initiate.enabled) {
      this._timer = setInterval(
        () => this.tickInitiate().catch((e) => console.error('[bridge] 主动发起失败:', e.message)),
        this.config.initiate.checkIntervalMs,
      );
      console.log(`[bridge] 主动发起已开启：每天最多 ${this.config.initiate.perDay} 次`);
    }

    console.log(`[bridge] 就绪。白名单 ${this.config.allowlist.length} 人`);
    if (!this.config.allowlist.length) {
      console.warn('[bridge] 白名单是空的，她不会回复任何人。先填上你小号要聊的 QQ。');
    }

    // 离线补偿：把停机期间漏掉的消息补回。
    // 放在就绪之后、异步执行，避免拖慢启动。
    if (this.config.catchUp?.enabled) {
      this.catchUpMissedMessages().catch((err) =>
        console.error('[bridge] 离线补偿失败:', err.message),
      );
    }
  }

  /**
   * 拉取每个白名单联系人的历史消息，把「机器人没在时」对方发的话补回。
   *
   * 判定标准：
   *   1. 消息来自对方（不是她自己发的）
   *   2. 时间晚于 lastHandledAt（上次处理过的位置）
   *   3. 在 maxAgeHours 之内
   *
   * 补的时候按时间顺序，逐条走正常回复流程 —— 这样记忆、提醒、
   * 事实抽取都会自然发生，和在线时没有区别。
   */
  async catchUpMissedMessages() {
    const cfg = this.config.catchUp;
    if (!this.napcat.connected) {
      console.warn('[bridge] 离线补偿跳过：NapCat 未连接');
      return;
    }

    const now = Date.now();
    const maxAgeMs = (cfg.maxAgeHours ?? 48) * 3_600_000;
    let acted = 0;

    for (const userId of this.config.allowlist) {
      if (acted >= (cfg.maxPerRun ?? 5)) break;

      const contactId = `qq-${userId}`;

      let history;
      try {
        history = await this.napcat.getFriendMsgHistory(
          userId,
          cfg.maxMessages ?? 20,
        );
      } catch (err) {
        console.warn(`[${contactId}] 拉历史失败，跳过: ${err.message}`);
        continue;
      }
      if (!history.length) continue;

      // 上次处理到的时间点。第一次运行时没有记录，
      // 就用「记忆里最后一条的时间」兜底，避免把陈年老消息全补一遍。
      let since = this.state.lastHandledAt?.[contactId];
      if (!since) {
        const s = await this.companion.memory.load(contactId);
        since = s.history.at(-1)?.at ?? now - maxAgeMs;
      }

      const pending = selectMissedMessages(history, {
        selfId: this.napcat.selfId,
        since,
        now,
        maxAgeMs,
      });

      if (!pending.length) continue;

      console.log(
        `[${contactId}] 发现 ${pending.length} 条离线消息，开始补回…`,
      );

      for (const m of pending) {
        const ts = (m.time ?? 0) * 1000;
        const text = extractText(m.message);
        const imgs = pickImages(m.message);
        if (!text && !imgs.length) continue;

        // 关键护栏：补偿期间可能正好来了实时消息，那条已经被正常流程回过、
        // 并把 lastHandledAt 往前推了。这里逐条重新比对，避免重复回复。
        const handled = this.state.lastHandledAt?.[contactId];
        if (handled && ts <= handled) {
          console.log(`[${contactId}] 该条已处理过，跳过`);
          continue;
        }

        // 同一个人的实时消息正在处理中，也让开，避免交叉回复
        if (this._busy.has(contactId)) {
          console.log(`[${contactId}] 正在处理实时消息，暂停补偿`);
          break;
        }

        // 离线补偿也要受人工接管约束：你亲自回过话，她就别插嘴
        const quiet = this.state.quietUntil[contactId];
        if (quiet && Date.now() < quiet) {
          console.log(`[${contactId}] 处于人工接管期，跳过补回`);
          break;
        }

        try {
          let images = [];
          for (const seg of imgs.slice(0, 3)) {
            const got = await imageSegmentToDataUrl(seg.data ?? {});
            if (got.dataUrl) images.push({ dataUrl: got.dataUrl });
          }

          const displayText = text || '（他发了张图）';
          console.log(`[${contactId}] 补回：${text || '[图片]'}`);

          // 关键：把消息的**原始时间**传下去。
          // 不传的话她会拿"重放时刻"当现在，说出"你那条体育课不是四点吗
          // 怎么现在才去"这种时间错位的话 —— 实测踩过。
          const parts = await this.companion.reply(contactId, displayText, {
            images,
            atTime: ts,
          });
          await this.sendParts(
            contactId,
            Array.isArray(parts) ? parts : [],
            userId,
            false,
          );

          // 游标推进到「这条消息的时间」，不能用 Date.now()：
          // 补第二条时 Date.now() 已经晚于第二条的时间戳，会被误判成
          // 「已处理过」而跳过 —— 实测踩过。
          this.state.lastHandledAt = this.state.lastHandledAt ?? {};
          this.state.lastHandledAt[contactId] = Math.max(
            this.state.lastHandledAt[contactId] ?? 0,
            ts,
          );
          await this.saveState();
        } catch (err) {
          console.error(`[${contactId}] 补回单条失败: ${err.message}`);
          break; // 这条卡住就别继续堆了，免得越滚越多
        }
      }

      await this.companion.maybeSummarize(contactId);
      acted++;
    }

    // 顺手把正常在线处理的位置也记下来，供下次启动比对
    await this.saveState();
    if (acted) console.log(`[bridge] 离线补偿完成，处理了 ${acted} 个联系人`);
  }

  /** 等连接就绪再问登录信息，最多试 maxTries 次 */
  async _waitLoginInfo(maxTries = 20, gapMs = 500) {
    for (let i = 0; i < maxTries; i++) {
      if (this.napcat.connected) {
        try {
          const info = await this.napcat.getLoginInfo();
          if (info?.user_id) {
            // 顺便补上 selfId，方便群消息判断有没有 @ 到自己
            this.napcat.selfId = info.user_id;
            return info;
          }
        } catch {
          // 继续重试
        }
      } else if (this.napcat.selfId) {
        // 已经通过 meta_event 拿到号了
        return { user_id: this.napcat.selfId, nickname: '' };
      }
      await sleep(gapMs);
    }
    return null;
  }

  /** 收到事件的总入口 */
  async handleEvent(ev) {
    // 人工接管信号：你在别的设备上亲自发消息，OneBot 会推 message_sent
    if (ev.post_type === 'message_sent') {
      const id = ev.user_id ?? ev.group_id;
      this.state.quietUntil[id] = Date.now() + this.config.takeover.manualQuietMs;
      await this.saveState();
      console.log(`[bridge] 检测到人工发言，她在 ${Math.round(this.config.takeover.manualQuietMs / 60000)} 分钟内不插话`);
      return;
    }

    // 好友请求 / 加群请求：OneBot 只在事件里给一次 flag，
    // 不处理就永远错过了——所以必须在这里接住。
    if (ev.post_type === 'request') {
      await this.handleRequest(ev);
      return;
    }

    if (ev.post_type !== 'message') return;
    if (ev.user_id === this.napcat.selfId) return; // 自己的消息
    if (ev.sub_type === 'notice' || ev.sub_type === 'anonymous') return;

    const isGroup = ev.message_type === 'group';
    const contactId = isGroup ? `group-${ev.group_id}` : `qq-${ev.user_id}`;
    const text = extractText(ev.message);

    // 他可能只发了张图、没打字。那种情况也要处理，不能直接丢掉。
    const imageSegs = pickImages(ev.message);

    if (!text && !imageSegs.length) return;

    // ── 白名单 ──
    if (isGroup) {
      if (!this.config.groups.includes(ev.group_id)) return;
      // 群里必须 @ 她才理
      const mentioned = Array.isArray(ev.message)
        && ev.message.some((s) => s?.type === 'at' && String(s.data?.qq) === String(this.napcat.selfId));
      if (!mentioned) return;
    } else if (!this.config.allowlist.includes(ev.user_id)) {
      console.log(`[bridge] 忽略非白名单 ${ev.user_id}: ${text.slice(0, 20)}`);
      return;
    }

    // ── 人工接管 ──
    const quiet = this.state.quietUntil[contactId];
    if (quiet && Date.now() < quiet) return;

    // ── 并发锁：同一个人上一条还没回完，先不接新的 ──
    if (this._busy.has(contactId)) {
      console.warn(`[${contactId}] 上一条还在处理中，跳过这条`);
      return;
    }
    this._busy.add(contactId);

    // 从这里开始必须保证锁一定释放：
    // 之前 try/finally 只包住了后半段，中间任何一步抛错都会让锁泄漏，
    // 结果这个人的消息被永久静默丢弃（实测踩过，排查了 40 分钟）。
    try {
      this.state.lastUserAt[contactId] = Date.now();
      await this.saveState();

      // 图不能和文字一样直接进记忆（base64 会把记忆文件撑爆），
      // 所以这里先下载编码，只在这一次请求里用，记忆里留一行占位。
      let images = [];
      if (imageSegs.length) {
        // 去重：QQ 的一个表情包常常被 NapCat 拆成两段（本体 + 缩略图），
        // 按 file/url 去重，避免同一张图被看两遍、也算两次 token。
        const uniq = [];
        const seenKey = new Set();
        for (const seg of imageSegs) {
          const key = seg.data?.file || seg.data?.url || JSON.stringify(seg.data ?? {});
          if (seenKey.has(key)) continue;
          seenKey.add(key);
          uniq.push(seg);
        }

        // 一次最多看 3 张。再多就是刷图了，token 也吃不消。
        for (const seg of uniq.slice(0, 3)) {
          const got = await imageSegmentToDataUrl(seg.data ?? {});
          if (got.dataUrl) {
            images.push({ dataUrl: got.dataUrl });
            console.log(
              `[${contactId}] 收到图片 ${(got.bytes / 1024).toFixed(0)}KB ` +
                `(${got.mime}, 约 ${roughTokens(got.bytes)} token)`,
            );
          } else {
            console.warn(`[${contactId}] 图片取失败：${got.error}`);
          }
        }
      }

      // 传给 reply 的正文：只有他说的话（不含图片占位符）。
      // 图片以 images 参数单独传，记忆里存什么由 companion 决定 ——
      // 它会用模型生成一句描述，而不是只留 "[图片]"。
      const displayText = text || '（他发了张图）';

      console.log(`[${contactId}] 他：${text || '[图片]'}`);

      // 带重试的回复：LLM 层已经会重试临时故障，这里再兜一层 ——
      // 因为一次完整回复包含「生成 + 工具调用 + 事实抽取」多个请求，
      // 任何一个中间环节抖动都会让整轮失败。
      let parts;
      let lastErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          parts = await this.companion.reply(contactId, displayText, { images });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) {
            const wait = 2000 * attempt;
            console.warn(
              `[${contactId}] 回复失败，${wait / 1000}s 后整轮重试: ${err.message}`,
            );
            await sleep(wait);
          }
        }
      }
      if (lastErr) throw lastErr;

      await this.sendParts(
        contactId,
        Array.isArray(parts) ? parts : [],
        isGroup ? ev.group_id : ev.user_id,
        isGroup,
      );

      await this.companion.maybeSummarize(contactId);

      // 记下处理位置，供下次启动做离线补偿时比对。
      // 用 Math.max 而不是直接赋值：补偿流程可能已经把游标推到更靠后的位置，
      // 不能被一次实时消息拉回来。
      //
      // 注意：只有到这里才推进游标。上面任何一步抛错都会跳过它，
      // 于是这条消息会被下次启动的离线补偿重新捞回来 —— 这正是我们要的。
      this.state.lastHandledAt = this.state.lastHandledAt ?? {};
      this.state.lastHandledAt[contactId] = Math.max(
        this.state.lastHandledAt[contactId] ?? 0,
        Date.now(),
      );
      await this.saveState();
    } catch (err) {
      // 回复失败：消息已在 companion 里落盘，游标不推进。
      // 下次启动离线补偿会把它补回，用户不会永远收不到回应。
      console.error(
        `[${contactId}] 处理消息失败（游标不推进，留待离线补偿）: ${err.message}`,
      );
    } finally {
      this._busy.delete(contactId);
    }
  }

  /**
   * 处理好友请求 / 加群请求。
   *
   * OneBot 的 request 事件只给一次 flag，不接就永久错过——所以不能忽略。
   * 默认策略：**只自动通过白名单里的人**，其他人只记录、不处理，
   * 由你决定。这样既能让你自己顺利加上，又不会被陌生人自动加进来。
   */
  async handleRequest(ev) {
    const who = ev.user_id;

    if (ev.request_type === 'friend') {
      const known = this.config.allowlist.includes(who);
      console.log(`[bridge] 好友请求：${who}${ev.comment ? `（验证信息：${ev.comment}）` : ''}`);

      if (known) {
        try {
          await this.napcat.call('set_friend_add_request', {
            flag: ev.flag,
            approve: true,
          });
          console.log(`[bridge] ${C_OK('✓ 已通过（在白名单里）')}`);
        } catch (err) {
          console.error(`[bridge] 通过好友请求失败: ${err.message}`);
        }
      } else {
        // 不自动通过陌生人，但把 flag 留着，方便你手动处理
        console.log(
          `[bridge] ${C_WARN('⏸ 未通过（不在白名单）')}。` +
            `flag=${ev.flag}`,
        );
        console.log(
          C_DIM('       要放行就把它加进 config.json 的 allowlist，然后手动调 set_friend_add_request'),
        );
      }
      return;
    }

    if (ev.request_type === 'group') {
      console.log(
        `[bridge] 加群${ev.sub_type === 'invite' ? '邀请' : '请求'}：群 ${ev.group_id}，来自 ${who}`,
      );
      console.log(C_DIM(`       flag=${ev.flag}（默认不处理，需要你自己决定）`));
    }
  }

  /** 一条一条发，带间隔和频率上限 */
  async sendParts(contactId, parts, target, isGroup) {
    if (!parts?.length) return;

    // 频率上限
    const now = Date.now();
    const w = this.config.send.burstWindowMs;
    this.state.sends = this.state.sends.filter((t) => now - t < w);
    if (this.state.sends.length >= this.config.send.maxPerWindow) {
      console.warn(`[bridge] 达到频率上限，跳过 ${parts.length} 条`);
      return;
    }

    for (const [i, raw] of parts.entries()) {
      if (i > 0) await sleep(this.config.send.minGapMs);

      try {
        if (typeof raw === 'object' && raw?.type === 'image') {
          // 图片消息段
          if (isGroup) await this.napcat.sendGroup(target, [raw]);
          else await this.napcat.sendPrivate(target, [raw]);
          this.state.sends.push(Date.now());
          console.log(`[${contactId}] 她：[图片]`);
        } else {
          const text =
            String(raw).length > this.config.send.maxChars
              ? String(raw).slice(0, this.config.send.maxChars)
              : String(raw);
          if (isGroup) await this.napcat.sendGroup(target, text);
          else await this.napcat.sendPrivate(target, text);
          this.state.sends.push(Date.now());
          console.log(`[${contactId}] 她：${text}`);
        }
      } catch (err) {
        console.error(`[bridge] 发送失败: ${err.message}`);
        break; // 发不出去就别继续连着发了
      }
    }

    await this.saveState();
  }

  /** 主动发起：定时检查，条件都满足才开口 */
  async tickInitiate() {
    const cfg = this.config.initiate;
    if (!cfg.enabled || !this.napcat.connected) return;

    const hour = new Date().getHours();
    if (hour < cfg.activeHourFrom || hour >= cfg.activeHourTo) return;

    const today = new Date().toDateString();

    for (const userId of this.config.allowlist) {
      const contactId = `qq-${userId}`;

      const sentToday = (this.state.lastInitiate[contactId] ?? [])
        .filter((t) => new Date(t).toDateString() === today);
      if (sentToday.length >= cfg.perDay) continue;

      const last = this.state.lastUserAt[contactId];
      if (!last) continue; // 从没聊过，不主动

      const idleH = (Date.now() - last) / 3_600_000;
      if (idleH < cfg.minIdleHours || idleH > cfg.maxIdleHours) continue;

      // 她最后一句之后，短时间内不再追加，免得像连珠炮。
      //
      // 但这只是"短时间"——之前写成"只要最后一条是她发的就永远不主动"，
      // 结果：她回了句话，他没接，之后她再也不会主动找他了。
      // 用户实测踩到过：等了三个多小时，一条消息都没有。
      // 所以改成看**她最后那句话是什么时候说的**，超过冷却期就允许再开口。
      const mem = await this.companion.memory.load(contactId);
      const lastEntry = mem.history.at(-1);
      if (lastEntry?.role === 'assistant') {
        const sinceHerMs = Date.now() - (lastEntry.at ?? 0);
        const cooldownMs = (cfg.afterHerMessageMinutes ?? 20) * 60_000;
        if (sinceHerMs < cooldownMs) continue;
      }

      const reason = `他大概 ${Math.round(idleH)} 小时没说话了`;
      try {
        const parts = await this.companion.initiate(contactId, reason);
        await this.sendParts(contactId, parts, userId, false);
        this.state.lastInitiate[contactId] = [...sentToday, Date.now()];
        await this.saveState();
      } catch (err) {
        console.error(`[bridge] 主动发起给 ${contactId} 失败: ${err.message}`);
      }
    }
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    await this.saveState();
    await this.napcat.stop();
  }
}
