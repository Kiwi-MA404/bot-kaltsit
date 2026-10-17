/**
 * 陪伴体核心。
 *
 * 职责：把「人设 + 记忆 + 时间 + 状态」合成一次回复。
 *
 * 两个刻意的设计：
 *
 * 1. 回复会被拆成多条。截图里她是一句一条发的，不是一大段。
 *    所以模型按行输出，每行一条消息，空行忽略。
 *
 * 2. 时间感是真的。她知道现在几点、你多久没说话、你今天是不是又熬到了五点。
 *    这是"陪伴"和"聊天机器人"最大的区别——她活在同一个时间轴上。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Memory } from './memory.js';
import { ReminderScheduler } from './reminder.js';
import { Llm } from './llm.js';
import { TOOLS, runTool } from './web.js';

/** 工具循环最多跑几轮。3 轮够用：实测它常会先搜两次再开口。 */
const MAX_TOOL_ROUNDS = 3;

const PERSONA_PATH = new URL('../persona/persona.md', import.meta.url);
/**
 * 示例人格（底色）——由 tools/distill-style.js 从真实对话里提炼，
 * 只含性格特征、不含任何记忆。每次生成都会拼进 system，
 * 用来压住"最近 40 条历史"的惯性（历史会让她越回越短）。
 * 文件不存在就当没有，不影响运行。
 */
const STYLE_PATH = new URL('../persona/style-example.md', import.meta.url);

/** 把毫秒差说成人话 */
function humanGap(ms) {
  if (ms == null) return null;
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 往前推 n 天，返回 "10月12日" 这种格式 */
function prevDate(from, n) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function clockOf(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function partOfDay(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return '凌晨';
  if (h < 9) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

export class Companion {
  constructor({
    dataDir = new URL('../data/', import.meta.url).pathname,
    llm = new Llm(),
    personaPath = PERSONA_PATH,
    stylePath = STYLE_PATH,
    // 按联系人分人格：{ 'qq-123': { persona, style }, ... }
    // 没匹配到的用上面的默认值。空对象就等于"所有人都用默认人格"。
    personaMap = {},
    clock = () => new Date(),
  } = {}) {
    this.memory = new Memory({ dir: dataDir });
    this.reminders = new ReminderScheduler({ dir: dataDir, onFire: (r) => this.onReminderFire(r) });
    this.llm = llm;
    this.personaPath = personaPath;
    this.stylePath = stylePath;
    this.personaMap = personaMap;
    this.clock = clock;
    // 按联系人缓存人格，key 是 contactId
    this._personaCache = new Map();
    this._styleCache = new Map();
    // 提醒触发时的回调，外部（如 bridge）可以覆盖 companion.reminders.onFire
    this.onReminderFire = async (reminder) => {
      console.log(`[companion] 提醒触发：${reminder.contactId}`);
    };
  }

  /** 找出这个联系人该用哪套人格（没配就用默认） */
  _pathsFor(contactId) {
    const entry = this.personaMap?.[contactId];
    if (!entry) return { persona: this.personaPath, style: this.stylePath };
    return {
      persona: entry.persona ?? this.personaPath,
      style: entry.style ?? this.stylePath,
    };
  }

  async persona(contactId) {
    const key = contactId ?? '';
    if (!this._personaCache.has(key)) {
      const { persona } = this._pathsFor(contactId);
      this._personaCache.set(key, await readFile(persona, 'utf8'));
    }
    return this._personaCache.get(key);
  }

  /** 示例人格（底色）。和 persona 一样：启动时读一次，改了要重启。 */
  async style(contactId) {
    const key = contactId ?? '';
    if (!this._styleCache.has(key)) {
      const { style } = this._pathsFor(contactId);
      this._styleCache.set(
        key,
        existsSync(style) ? (await readFile(style, 'utf8')).trim() : '',
      );
    }
    return this._styleCache.get(key);
  }

  /** 组装 system：人设 + 底色 + 记得的事 + 此刻的时间感 */
  async buildSystem(contactId, now) {
    const [persona, style, facts] = await Promise.all([
      this.persona(contactId),
      this.style(contactId),
      this.memory.renderFacts(contactId),
    ]);

    const state = await this.memory.load(contactId);
    const gap = humanGap(now - (state.stats.lastSeen ?? now));

    // 把时间说清楚。之前只给"现在几点"，她看不到"他刚睡过""隔了多久"，
    // 结果早上八点还在劝人睡觉——因为她默认所有对话都发生在夜里。
    const hh = now.getHours();
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    const dateCn = `${now.getMonth() + 1} 月 ${now.getDate()} 日 ${weekday}`;
    const isLateNight = hh >= 23 || hh < 5;
    const isMorning = hh >= 5 && hh < 11;

    // 他上次说话到现在跨没跨过一夜？这决定了她该不该提"睡"。
    const lastAt = state.stats.lastSeen ?? now;
    const crossedNight =
      lastAt < now &&
      (hh >= 5 && hh < 12) &&
      new Date(lastAt).getHours() >= 18;

    // 读该联系人的提醒，算出「已触发 / 待触发」。
    // 为什么要代码硬算：模型会凭对话惯性瞎编时间（实测"现在才九点四十"，
    // 而真实时间是 22:05）。这种错误没法靠 prompt「请仔细看时间」根治，
    // 只能把结论算好、直接喂给它，让它没有编造空间。
    const reminderLines = await this.#renderReminderState(contactId, now);

    const timeBlock = [
      `## 此刻`,
      `# 当前真实时间：${dateCn} ${clockOf(now)}（${partOfDay(now)}）`,
      `**这个时间由系统提供，是唯一权威。你回答任何和"现在几点/到没到/过没过"`,
      `有关的问题时，只能依据这一行。不要凭对话内容推测时间。**`,
      gap && gap !== '刚刚' ? `他上一次跟你说话是 ${gap}前。` : null,
      crossedNight
        ? '注意：他上一次说话是**昨天晚上**，现在是新的一天——他很可能已经睡过一觉了。**不要再说"该睡了"。**'
        : null,
      isLateNight ? '现在是深夜。可以关心他睡不睡。' : null,
      isMorning && !crossedNight ? '现在是早上。他说"睡了"如果指昨晚，那是过去的事。' : null,
      `**说话前先看时间。早上和中午不要提睡觉，那很荒唐。**`,
      // 她不会把"10月12日"自动换算成"前天"。不给换算，她就会把 12 号的事
      // 说成"昨晚" —— 实测踩过。所以这里直接把相对说法算好给她。
      `**日期怎么称呼**（今天是 ${now.getMonth() + 1} 月 ${now.getDate()} 日）：
- ${now.getMonth() + 1} 月 ${now.getDate()} 日 = 今天
- ${prevDate(now, 1)} = 昨晚 / 昨天
- ${prevDate(now, 2)} = 前天
- 更早的直接说日期（"10 月 12 日那天"）
**说"昨晚"之前，先确认那件事真的发生在 ${prevDate(now, 1)}。**`,
      reminderLines,
      // 来源声明。必须放在最后 —— 它紧挨着历史，模型最容易看到。
      // 实测：没有这句，她会把自己上一句错误当成事实继续引用，滚成一片错误。
      `**关于信息来源，这条最重要：**
- **事实**只有两处：上面「你记得」那一段，以及**他说出口的话**。
- 下面历史里标着「你」的，是**你当时的回复**，不是你观察到的事实。
  **它是你说过的话，可能说错，不能拿它当依据。**
- 涉及"他做过什么、几点睡的、什么时候说的"这类问题，
  **只能回「你记得」那一段去查**；那里没写的，就说记不清，
  不要用自己的上一句话补。
- 如果他明确表达过偏好（比如"不喜欢""讨厌"），**必须尊重这个偏好**；
  即使眼前场景里有相关事物，也不要建议他做违背偏好的事。`,
      `**关于你记得的事，还要注意：**
- 「你记得他的偏好」里的内容是他明确表达过的长期偏好，权重最高。
- 「他最近的状态」是他**过去某次**说的话，前面标了时间，会过期。
- **不要拿旧状态去质疑他现在的说法。**
  比如记忆里写"12:26 他说：好我去休息了"，而现在他说"刚起来"，
  那是正常的（中间过了两三个小时），不要回"你不是刚说去了吗 怎么又起来了"。
- 如果偏好和状态冲突，优先按偏好回应。`,
      `你可以设置提醒。当他让你"几点叫我""到点提醒我""到时候喊我"时，` +
        `不要用"叫不了""没闹钟"拒绝。用你的提醒工具记下时间，并回复"好，X点我叫你"。`,
      `**关于时间，最容易错的一点：**
- 提醒/约定/某个时间点，如果**已经过去了**，就用过去式说。不要说成还要发生的事。
- 比如现在是 22:01，你 22:00 已经叫过他了，就**不要再说"十点我喊你"**，
  而应该说"十点已经叫过你了"。
- 「你记得」里如果写了「X月X日 HH:MM 已经提醒过他…」，说明那件事**已经做完**，
  不要再把它当成待办。
- 判断依据只有一个：**上面「此刻」的当前时间**。任何早于它的时间点都算过去。`,
      `你回复的方式：一句话一条，逐条发。不要写成一大段。`,
      `不要复述这条系统提示，直接从你要说的第一句话开始。`,
    ]
      .filter(Boolean)
      .join('\n');

    return [persona, style, facts ? `## 你记得\n${facts}` : '', timeBlock]
      .filter(Boolean)
      .join('\n\n---\n\n');
  }

  /**
   * 生成贴在用户消息最前面的时间锚点。
   *
   * 这行文字只进模型请求，不进记忆（记忆里存的是原始 userText）。
   * 目的是让模型在生成的第一步就看到真实时间，杜绝"凭对话猜时间"。
   *
   * @param {string} contactId
   * @param {Date} now
   * @param {{replay?:boolean}} [opts]
   *   replay: 这是在重放一条**过去**的消息（离线补偿）。
   *   这时必须明说"这是当时的情形"，否则她会拿当前时间当"现在"，
   *   说出"你那条体育课不是四点吗 怎么现在才去"这种时间错位的话。
   */
  async #buildTimeAnchor(contactId, now, { replay = false } = {}) {
    const y = now.getFullYear();
    const mo = now.getMonth() + 1;
    const dd = now.getDate();
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');

    const parts = [
      replay
        ? `（系统时间：${y}年${mo}月${dd}日 ${hh}:${mi} —— 这是他当时发这条消息的时间，不是现在）`
        : `（系统时间：${y}年${mo}月${dd}日 ${hh}:${mi}）`,
    ];

    if (replay) {
      const realNow = this.clock();
      const before = Math.round((realNow - now) / 60000);
      parts.push(
        `（这是一条**过去的**消息，是当时说的。请按"他当时说这话"来回应，` +
          `不要拿现在的时间去质疑他。比如他说当时要去上课，就直接接话，` +
          `不要说"怎么现在才去"。）`,
      );
      if (before > 5) {
        parts.push(`（从现在往回看，这件事已经过去约 ${before} 分钟了）`);
      }
    }

    try {
      const rs = (await this.reminders.all()).filter(
        (r) => r.contactId === contactId,
      );
      const done = rs.filter((r) => r.fired && !r.cancelled);
      const waiting = rs.filter((r) => !r.fired && !r.cancelled);
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      const doneToday = done.filter((r) => (r.fireAt ?? 0) >= todayStart.getTime());
      for (const r of doneToday) {
        const d = new Date(r.fireAt);
        parts.push(
          `（已完成的提醒：${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 已经叫过他了，是过去的事）`,
        );
      }
      for (const r of waiting) {
        const d = new Date(r.fireAt);
        parts.push(
          `（待触发的提醒：${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}，还没到）`,
        );
      }
    } catch {
      // 提醒读失败不影响对话
    }

    parts.push('（以上时间由系统提供，是唯一事实来源；说几点/到没到时只能依据它）');
    return parts.join('');
  }

  /**
   * 把该联系人的提醒状态渲染成「已经发生 / 还没到」的明确结论。
   *
   * 这是为了防止模型瞎编时间：与其让它自己推理"十点到了没"，
   * 不如直接把答案写给它，并明确禁止它推翻。
   */
  async #renderReminderState(contactId, now) {
    let reminders = [];
    try {
      reminders = (await this.reminders.all()).filter(
        (r) => r.contactId === contactId,
      );
    } catch {
      return null;
    }
    if (!reminders.length) return null;

    const hhmm = (ts) => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const done = reminders.filter((r) => r.fired && !r.cancelled);
    const waiting = reminders.filter((r) => !r.fired && !r.cancelled);

    // 只展示今天的，避免把陈年提醒翻出来干扰
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const recentDone = done.filter(
      (r) => (r.fireAt ?? 0) >= todayStart.getTime(),
    );

    const lines = [`**你的提醒状态（系统已核对，不要推翻）：**`];

    if (recentDone.length) {
      for (const r of recentDone) {
        lines.push(
          `- ${hhmm(r.fireAt)} 的提醒**已经发过了**（内容："${r.content || r.reason || '到点了'}"）。` +
            `这件事已经完成，不要再把它说成"到时候我叫你"。`,
        );
      }
    }

    if (waiting.length) {
      for (const r of waiting) {
        const remain = r.fireAt - now.getTime();
        const mins = Math.round(remain / 60000);
        lines.push(
          `- ${hhmm(r.fireAt)} 的提醒**还没到**（还有约 ${mins} 分钟）。这个才是将来要发生的事。`,
        );
      }
    }

    if (!recentDone.length && !waiting.length) return null;
    return lines.join('\n');
  }

  /**
   * 让模型用一句话描述图片，存进记忆用。
   *
   * 为什么要单独做：图片本体进不了记忆（base64 太大），
   * 但只留 "[图片]" 两个字，下一轮她就完全不记得图是什么了。
   * 折中方案：存一句 30 字以内的描述，占几十字节。
   *
   * 失败就返回空字符串，调用方会退回 "[图片]"。
   */
  async describeImages(images) {
    if (!images?.length) return '';
    try {
      const content = [
        {
          type: 'text',
          text:
            '用一句话描述这些图（30 字以内，中文）。只描述画面里客观有什么，' +
            '不要评论、不要抒情、不要加"这是一张"。直接给描述。',
        },
        ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
      ];
      const r = await this.llm.chatRaw([{ role: 'user', content }], {
        maxTokens: 120,
        reasoningEffort: null,
      });
      return (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    } catch (err) {
      console.warn('[companion] 图片描述失败:', err.message);
      return '';
    }
  }

  /**
   * 带工具的生成：她可以决定"先上网查一下再说话"。
   *
   * 流程：模型如果返回 tool_calls → 执行 → 把结果塞回对话 → 再问一次。
   * 最多 MAX_TOOL_ROUNDS 轮，防止她陷进去查个不停。
   *
   * ── 关于工具结果的回传方式（踩过的坑）──
   * 按理说应该用 { role: 'tool', tool_call_id }。实测这台机器的网关
   * **不认这种消息**：模型会完全无视它，然后说"我没有实时信息"。
   * 但把同样的内容包成一条 user 消息，它就正常读了。
   *
   * 所以这里刻意用 user 消息回传，而不是标准的 tool 角色。
   * 如果哪天换了网关、标准的能用，可以改回去。
   */
  async _chatWithTools(messages) {
    let convo = messages;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const r = await this.llm.chatRaw(convo, { tools: TOOLS });

      if (!r.tool_calls?.length) {
        return r.content;
      }

      // 助手这一轮要调工具。content 通常是空的，保留它以防有过渡语。
      convo = [...convo, { role: 'assistant', content: r.content || '' }];

      const gathered = [];
      for (const call of r.tool_calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        if (process.env.COMPANION_DEBUG_TOOLS) {
          console.log(`[tool] ${name}(${JSON.stringify(args).slice(0, 120)})`);
        }
        const result = await runTool(name, args);
        gathered.push(result.slice(0, 4000));
      }

      // 关键：不按标准塞 role:'tool'，而是当成一条"系统转述给你"的 user 消息。
      convo = [
        ...convo,
        {
          role: 'user',
          content:
            `（系统：你刚才查到了下面的内容）\n\n${gathered.join('\n\n')}\n\n` +
            `现在用你自己的话接着跟他说。别念标题，别列条目，别宣布你查过。`,
        },
      ];
    }

    // 用完了轮数还在要工具：强制她说话，不再给工具
    const last = await this.llm.chatRaw(convo, { tools: null });
    return last.content;
  }

  /**
   * 收到一条消息，返回她要发的若干条。
   *
   * @param {string} contactId
   * @param {string} userText   正文（图片会被转成 "[图片]" 这类占位符存在这里）
   * @param {{dryRun?:boolean, images?:Array<{dataUrl:string}>, atTime?:number}} [opts]
   *   images: 当前这条消息附带的图片（data URL）。
   *   **图片只用于这一次请求，不会被写进记忆** —— 否则记忆文件会被 base64 撑爆。
   *   atTime: 把这条消息当成「这个时间」发生的（离线补偿重放旧消息时用）。
   */
  async reply(contactId, userText, { dryRun = false, images = [], atTime } = {}) {
    // 补偿重放旧消息时必须用消息原始时间。
    // 实测踩过：他 15:57 说"准备去上体育课"，离线补偿在 18:10 才重放，
    // 她拿 18:10 当"现在"，就回了"你那条体育课不是四点吗 怎么现在才去" ——
    // 时间错位两小时，看起来像她糊涂了。
    const now = atTime ? new Date(atTime) : this.clock();
    const system = await this.buildSystem(contactId, now);
    const history = await this.memory.buildMessages(contactId);

    // 有图时用多模态格式：content 是数组，文字和图片并列。
    // 没图时保持原来的纯字符串，避免给不支持数组的模型添麻烦。
    const userContent = images.length
      ? [
          { type: 'text', text: userText || '（他发了张图）' },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: img.dataUrl },
          })),
        ]
      : userText;

    // 先把「他说的话」落盘，再做任何可能失败的 LLM 调用。
    //
    // 为什么顺序这么重要：以前是全部算完、成功后才写历史。
    // 上游一抖（502 / 429），这条消息就**彻底消失** ——
    // 她事后查记忆看不到，离线补偿也补不回来（补偿只处理游标之后的消息）。
    // 实测踩过：连问两次"前瞻什么时候"都没回，那两条在记忆里根本不存在。
    // 现在先写，最坏情况也只是"她没答上"，但你说了什么不会丢。
    let memoryLine = userText;
    if (!dryRun) {
      if (images.length) {
        // 图片描述也依赖 LLM，失败就退回占位符，不能让消息丢失
        const desc = await this.describeImages(images).catch(() => '');
        memoryLine = desc
          ? `[图：${desc}]${userText ? ' ' + userText : ''}`
          : `[图片]${userText ? ' ' + userText : ''}`;
      }
      // 补偿重放时用消息原始时间落盘，否则记录的时间会变成"重放时刻"，
      // 和 NapCat 的真实时间对不上（实测踩过：15:57 的消息被记成 18:10）。
      await this.memory.append(contactId, 'user', memoryLine, atTime ? { at: now.getTime() } : {});
    }

    // 前置：检测提醒请求。如果是纯提醒请求，直接设提醒并返回确认语，
    // 不进入聊天模型，避免她说"叫不了你"。
    if (!dryRun && !images.length) {
      let reminder = null;
      try {
        reminder = await this.scheduleReminderFromText(contactId, userText);
      } catch (err) {
        // 提醒解析失败不能影响正常聊天，继续往下走
        console.warn('[companion] 提醒解析失败，按普通消息处理:', err.message);
      }
      if (reminder?.ackText) {
        await this.memory.append(contactId, 'assistant', reminder.ackText);
        return [reminder.ackText];
      }
    }

    // 时间锚点：贴在用户消息最前面。
    //
    // 为什么放这里而不是只放 system：实测这个 flash 模型会忽略 system 中段的
    // 时间说明，凭空编出"现在才九点四十"（真实 22:05），5 次里错 3 次。
    // 紧贴用户消息是模型注意力最强的地方，放这里才压得住。
    const anchor = await this.#buildTimeAnchor(contactId, now, { replay: Boolean(atTime) });

    const anchoredContent = Array.isArray(userContent)
      ? userContent.map((seg, i) =>
          i === 0 && seg.type === 'text'
            ? { ...seg, text: `${anchor}\n${seg.text}` }
            : seg,
        )
      : `${anchor}\n${userContent}`;

    const messages = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: anchoredContent },
    ];

    // 生成前记忆一致性守卫：先检查冲突，必要时插入冲突提示
    const guard = await this.memoryGuard(contactId, userText);
    if (guard) {
      messages.push({ role: 'system', content: guard });
    }

    let raw;
    try {
      raw = await this._chatWithTools(messages);
    } catch (err) {
      // 回复失败：消息已经落盘，不要重复写。往上抛，让 bridge 记录并保留游标。
      console.error('[companion] 生成回复失败:', err.message);
      throw err;
    }
    const parts = splitMessages(raw);

    if (!dryRun) {
      // 补偿重放时，她的回复也用消息原始时间落盘
      for (const p of parts) {
        await this.memory.append(contactId, 'assistant', p, atTime ? { at: now.getTime() } : {});
      }
      // 事实抽取不阻塞回复
      this.extractFacts(contactId, userText).catch((e) =>
        console.error('[companion] 抽取记忆失败:', e.message),
      );
      // 如果用户消息可能是观察（比如"桌上有杯牛奶"），也尝试抽取为 observation
      this.extractObservations(contactId, userText).catch((e) =>
        console.error('[companion] 抽取观察失败:', e.message),
      );
      // 兑现承诺：她自己说"到点我喊你"时，得真的设上提醒。
      // 以前只有"用户要求提醒"才会设，她主动承诺时纯口惠 ——
      // 实测踩过：她说"到点我喊你"，到点却什么都没发生。
      this.fulfillPromisedReminder(contactId, parts, now).catch((e) =>
        console.error('[companion] 承诺兑现检查失败:', e.message),
      );
    }

    return parts;
  }

  /**
   * 检查她的回复里有没有「我几点喊你/叫你/提醒你」这类承诺，
   * 有就真的设一个提醒。
   *
   * 为什么需要：`scheduleReminderFromText` 只在**用户要求**时触发。
   * 她自己主动承诺时（"一点睡到两点半，到点我喊你"），
   * 没有任何代码去设提醒 —— 说了等于没说。
   *
   * @param {string} contactId
   * @param {string[]} parts 她这一轮发出的所有消息
   * @param {Date} now
   */
  async fulfillPromisedReminder(contactId, parts, now) {
    const text = (parts ?? []).join('\n');
    if (!text) return null;

    // 快速预筛：不含这些词就不用调模型
    if (!/(喊|叫|提醒)你|会叫|会喊/.test(text)) return null;

    let parsed;
    try {
      const out = await this.llm.chat(
        [
          {
            role: 'system',
            content: '你是一个提醒承诺解析器。你只输出 JSON，不输出其他文字。',
          },
          {
            role: 'user',
            content: `下面是她对他说的几句话。判断她有没有承诺"在某个具体时间叫他/提醒他"。
如果有，输出：
{"hasPromise": true, "fireAtIso": "YYYY-MM-DDTHH:MM:00", "reason": "简短说明"}
如果没有具体时间，或只是随口说说，输出 {"hasPromise": false}。

【重要】年份必须是 ${now.getFullYear()}。
现在时间：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}

她的话：${JSON.stringify(text)}`,
          },
        ],
        { temperature: 0, maxTokens: 200, reasoningEffort: 'none' },
      );
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return null;
      parsed = JSON.parse(m[0]);
    } catch (err) {
      console.warn('[companion] 承诺解析失败:', err.message);
      return null;
    }

    if (!parsed?.hasPromise || !parsed.fireAtIso) return null;

    const fireAt = this.#resolveFireAt(parsed.fireAtIso, now);
    if (fireAt == null) return null;

    // 别和已有的提醒重复
    const existing = await this.reminders
      .all()
      .then((rs) =>
        rs.find(
          (r) =>
            r.contactId === contactId &&
            !r.cancelled &&
            Math.abs((r.fireAt ?? 0) - fireAt) < 60_000,
        ),
      );
    if (existing) return existing;

    const r = await this.reminders.add({
      contactId,
      fireAt,
      reason: `她承诺：${parsed.reason || text.slice(0, 40)}`,
      content: '',
    });
    console.log(
      `[companion] 已为她自己的承诺设提醒: ${new Date(fireAt).toLocaleString('zh-CN')}`,
    );
    return r;
  }

  /**
   * 让她主动开口。不是定时骚扰，是"她想起了你"。
   * 调用方负责控制频率（见 scheduler 逻辑）。
   */
  async initiate(contactId, reason = '', { dryRun = false } = {}) {
    const now = this.clock();
    const system = await this.buildSystem(contactId, now);
    const history = await this.memory.buildMessages(contactId);

    const nudge = [
      `你现在想主动跟他说句话。不是提醒，不是问候模板。`,
      reason ? `起因：${reason}` : '',
      `如果你想说"看到个东西"，那就要是真的看到——需要就先查，别空口说看到了。`,
      `就一句或者两句，说完就好。`,
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await this._chatWithTools([
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: `（系统：${nudge}）` },
    ]);

    const parts = splitMessages(raw);
    // dryRun：试聊/测试时不把内容写进真实记忆线，
    // 否则一次试验就会污染你们真实的对话历史。
    if (!dryRun) {
      for (const p of parts) await this.memory.append(contactId, 'assistant', p);
    }
    return parts;
  }

  /**
   * 从他这句话里抽出值得长期记住的事。
   * 用一次独立的小调用，失败不影响主流程。
   */
  async extractFacts(contactId, userText) {
    // 带上日期。之前不带，导致"某天熬夜到两点"被记成"你常熬夜，两点左右睡"——
    // 一次性的行为被升级成了长期习惯，而且时间点也丢了锚。
    const now = this.clock();
    const stamp = `${now.getMonth() + 1}月${now.getDate()}日`;
    const partOfDayNow =
      now.getHours() < 5 ? '凌晨'
      : now.getHours() < 11 ? '早上'
      : now.getHours() < 14 ? '中午'
      : now.getHours() < 18 ? '下午'
      : '晚上';

    const turnId = `t_${Date.now()}`;

    const prompt = `从下面这句话里，抽出关于他的长期记忆。只输出 JSON 数组，没有就输出 []。

每条格式：
{
  "key":"简短英文键",
  "text":"中文，第二人称视角记他，不超过20字",
  "type":"preference|attribute|fact|event",
  "confidence":0.95
}

type 含义：
- "preference"：稳定偏好、喜欢/不喜欢、能/不能吃/喝/做。
- "attribute"：身份、属性、身体状况、长期习惯。
- "fact"：值得记住的人际/生活事实。
- "event"：一次性但重要的事件。

【重要】凌晨 0-5 点发生的事，属于**前一天晚上**。写日期时用前一天。

【重要】区分"一次"和"总是"：
- 他说"我昨晚两点睡"→ 那是一次的事，**不要**写成"你常熬夜"
- 只有他明确说"我每天""我一般""我经常"时，才能记成习惯
- 拿不准就按"一次"记，并且**带上日期**：「${stamp}他熬夜到两点」

不要记：寒暄、情绪波动、一次性的日常琐事（吃了什么、现在在干嘛、桌上有什么）。

现在时间：${stamp} ${partOfDayNow}
他这句话：${JSON.stringify(userText)}`;

    // 这是一个纯工具调用，必须用 system 把它钉死成「抽取器」。
    // 否则模型会以为自己在跟他聊天，把那段话当对话回，浪费时间还可能串扰。
    const out = await this.llm.chat(
      [
        {
          role: 'system',
          content:
            '你是一个信息抽取器。你只输出 JSON 数组，不输出任何其他文字，' +
            '不与用户对话，不评论、不回应、不提问。没有可抽取的事实就输出 []。',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0, maxTokens: 300, reasoningEffort: 'none' },
    );

    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return [];

    let facts;
    try {
      facts = JSON.parse(m[0]);
    } catch {
      return [];
    }
    if (!Array.isArray(facts)) return [];

    // 存之前先跟已有事实对一遍，处理三种情况：
    //   1. 全新的          → 直接加
    //   2. 和旧的同一件事   → 合并（不重复堆）
    //   3. 和旧的矛盾/过期  → 沿用旧 key，覆盖掉
    //
    // 为什么需要：key 是模型自由生成的，同一件事会被生成成不同 key
    // （实测"学生身份"被记成了 is_student / in_class / education_status /
    //   studying_english 四条）。光靠 key 精确匹配去不了重。
    const incoming = facts
      .slice(0, 5)
      .filter((f) => f?.text && typeof f.text === 'string')
      .map((f) => ({
        ...f,
        type: ['preference', 'attribute', 'fact', 'event'].includes(f.type) ? f.type : 'fact',
      }));
    if (!incoming.length) return facts;

    const existing = (await this.memory.load(contactId)).profile.facts ?? [];
    const merged = await this.reconcileFacts(existing, incoming, {
      turnId,
      utterance: userText,
      extractor: 'extractFacts',
    });

    for (const f of merged) {
      await this.memory.remember(contactId, {
        key: f.key,
        text: f.text,
        type: f.type ?? 'fact',
        confidence: f.confidence ?? 0.9,
        source: { turnId, utterance: userText, extractor: 'extractFacts/reconcile' },
        tags: f.tags ?? [],
        supersedes: f.supersedes ?? [],
      });
    }
    return facts;
  }

  /**
   * 把新抽到的事实和已有事实对账。
   * v2：用结构化 JSON，显式区分 merge/update/contradict/new，并返回 supersededBy 信息。
   */
  async reconcileFacts(existing, incoming, source = {}) {
    if (!existing.length) {
      return incoming.map((f, i) => ({
        key: f.key ?? `f${i}`,
        text: f.text,
        type: f.type,
        confidence: f.confidence,
        tags: f.tags ?? [],
      }));
    }

    const prompt = `已有记忆：
${existing.map((f, i) => `[${i}] (${f.key}) type=${f.type ?? 'fact'} ${f.text}`).join('\n')}

新抽到的：
${incoming.map((f, i) => `[${i}] type=${f.type ?? 'fact'} ${f.text}`).join('\n')}

对每一条新事实，判断它跟已有记忆的关系：
- "new"    —— 全新的信息，已有记忆里没有
- "merge"  —— 和某条说的是同一件事，应当合并成一条（用 mergeInto 指定那条的序号）
- "update" —— 和某条矛盾、或者那条已过期，应当被这条取代（用 mergeInto 指定序号）

只输出 JSON 数组，每项格式：
{
  "text":"最终要存的那句话",
  "relation":"new|merge|update",
  "mergeInto":序号,
  "key":"简短英文键",
  "type":"preference|attribute|fact|event|observation",
  "confidence":0.9
}

要求：
- "merge/update" 的 text 写**合并或更新之后**的最终说法。
- "new" 的 mergeInto 填 -1。
- 如果新事实表达"不喜欢/不能/拒绝"而旧事实说"喜欢/能/接受"，必须判为 "update"。
- 如果新事实是场景观察（桌上有什么、现在在哪），已有记忆是偏好，不要 update 偏好，判为 "new" 或忽略。
- 一次性的日常琐事不要记。
- 只输出 JSON，不要别的文字。`;

    let raw;
    try {
      raw = await this.llm.chat(
        [
          {
            role: 'system',
            content:
              '你是一个记忆管理器。你只输出 JSON 数组，不输出任何其他文字。',
          },
          { role: 'user', content: prompt },
        ],
        { temperature: 0, maxTokens: 600, reasoningEffort: 'none' },
      );
    } catch (err) {
      console.warn('[companion] 记忆对账失败，退回简单模式:', err.message);
      return incoming.map((f, i) => ({
        key: f.key ?? `f${i}`,
        text: f.text,
        type: f.type,
        confidence: f.confidence,
      }));
    }

    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) {
      return incoming.map((f, i) => ({
        key: f.key ?? `f${i}`,
        text: f.text,
        type: f.type,
        confidence: f.confidence,
      }));
    }

    let parsed;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return incoming.map((f, i) => ({
        key: f.key ?? `f${i}`,
        text: f.text,
        type: f.type,
        confidence: f.confidence,
      }));
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      return incoming.map((f, i) => ({
        key: f.key ?? `f${i}`,
        text: f.text,
        type: f.type,
        confidence: f.confidence,
      }));
    }

    const out = [];
    for (const [i, item] of parsed.entries()) {
      if (!item?.text) continue;
      const idx = Number(item.mergeInto);
      const result = {
        key: item.key ?? `f${i}`,
        text: item.text,
        type: item.type ?? 'fact',
        confidence: item.confidence ?? 0.9,
        tags: item.tags ?? [],
      };

      if (
        (item.relation === 'merge' || item.relation === 'update') &&
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < existing.length
      ) {
        result.supersedes = [existing[idx].key];
      }

      out.push(result);
    }

    return out.length ? out : incoming.map((f, i) => ({
      key: f.key ?? `f${i}`,
      text: f.text,
      type: f.type,
      confidence: f.confidence,
    }));
  }

  /**
   * 把用户消息中可能包含的"场景观察"抽成 observation，避免污染偏好库。
   */
  async extractObservations(contactId, userText) {
    const prompt = `下面这句话是在描述他当下的状态/场景，还是一个偏好/长期事实？
只输出 JSON 数组，没有就输出 []。

如果是当下状态，输出：
{"text":"不超过20字","type":"observation","category":"类别","confidence":0.8}

category 从这几个里选一个（用来判断是否要顶掉旧状态）：
- "whereabouts"  他在哪 / 在做什么（上课、下课、回宿舍、吃饭）
- "awake"        睡没睡（刚起来、要睡了、熬夜）
- "mood"         当下的心情（无聊、心累、开心）
- "health"       身体状态（不舒服、头疼、累了）
- "scene"        眼前场景（桌上有杯牛奶、天气）
- "other"        其他

【重要】只记"当下状态"，不记长期偏好（那些由另一个模块处理）。
如果是长期偏好/身份/习惯，输出 []。

他这句话：${JSON.stringify(userText)}`;

    const out = await this.llm.chat(
      [
        {
          role: 'system',
          content: '你是一个观察抽取器。你只输出 JSON 数组，不输出任何其他文字。',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0, maxTokens: 200, reasoningEffort: 'none' },
    );

    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return [];

    let obs;
    try {
      obs = JSON.parse(m[0]);
    } catch {
      return [];
    }
    if (!Array.isArray(obs)) return [];

    for (const o of obs) {
      if (o?.text && o.type === 'observation') {
        await this.memory.addObservation(contactId, o.text, {
          turnId: `t_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          utterance: userText,
          extractor: 'extractObservations',
          confidence: o.confidence ?? 0.8,
          // 类别决定顶掉哪条旧观察：同类新状态取代旧状态
          category: o.category ?? 'state',
        });
      }
    }
    return obs;
  }

  /**
   * 生成前记忆一致性守卫。
   * 检查当前活跃记忆中是否有冲突，并返回一段追加到 system 的提示。
   * 返回空字符串表示无需干预。
   */
  async memoryGuard(contactId, currentUserText = '') {
    const conflicts = await this.memory.auditConflicts(contactId);
    if (!conflicts.length) return '';

    const active = await this.memory.activeFacts(contactId);
    const lines = [
      '（系统：检测到「你记得」里有两条信息可能互相冲突，请优先按下面这个原则处理：',
      '- 如果一条是「偏好/明确态度」，另一条是「观察/场景」，以偏好为准。',
      '- 如果两条都是偏好/态度，以更新时间更近的为准。',
      '- 不要同时承认两条矛盾的说法。）',
    ];

    for (const c of conflicts.slice(0, 3)) {
      const a = active.find((f) => f.key === c.a);
      const b = active.find((f) => f.key === c.b);
      if (!a || !b) continue;
      const newer = a.at >= b.at ? a : b;
      const older = a.at >= b.at ? b : a;
      lines.push(`- "${older.text}" 和 "${newer.text}" 看起来冲突，**以更新的"${newer.text}"为准**。`);
    }

    return lines.join('\n');
  }

  /**
   * 尝试从用户消息中解析提醒意图，并安排定时提醒。
   * 如果解析失败返回 null。
   */
  async scheduleReminderFromText(contactId, userText, opts = {}) {
    const now = this.clock();
    const y = now.getFullYear();
    const mo = now.getMonth() + 1;
    const dd = now.getDate();
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const stamp = `${mo}月${dd}日`;

    const prompt = `分析下面这句话，判断用户是否在要求设置提醒/闹钟/到点叫他。
如果是，输出 JSON：
{
  "hasReminder": true,
  "fireAtIso": "${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}T23:00:00",
  "content": "十一点了，该睡了。",
  "ackText": "好，十一点我叫你。"
}
如果不是，输出 {"hasReminder": false}。

【重要】年份必须是 ${y}（当前年份），不要用示例里的数字。
如果他说的时间今天已经过了，就用明天。

现在时间：${y}年${mo}月${dd}日 ${hh}:${mi}
用户说：${JSON.stringify(userText)}`;

    const out = await this.llm.chat(
      [
        {
          role: 'system',
          content:
            '你是一个提醒意图解析器。你只输出 JSON，不输出任何其他文字。',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0, maxTokens: 200, reasoningEffort: 'none' },
    );

    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return null;

    let parsed;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
    if (!parsed.hasReminder || !parsed.fireAtIso) return null;

    const fireAt = this.#resolveFireAt(parsed.fireAtIso, now);
    if (fireAt == null) {
      console.warn(`[companion] 提醒时间无法解析: ${parsed.fireAtIso}`);
      return null;
    }

    const reminder = await this.reminders.add({
      contactId,
      fireAt,
      reason: userText,
      content: parsed.content || '',
      ...opts,
    });

    return {
      ...reminder,
      ackText: parsed.ackText || '',
    };
  }

  /**
   * 把模型给的时间字符串解析成时间戳，并纠正常见错误。
   *
   * 实测踩过的坑：prompt 示例里写了「2024-10-15」，模型会照抄年份，
   * 结果设出来的是 2024 年 —— 早已过去，提醒永远不触发。
   * 这里做两层兜底：
   *   1. 年份明显不对（早于今年）就换成今年
   *   2. 换完还是过去时间，就顺延到明天同一时刻
   *
   * @returns {number|null} 时间戳；无法解析返回 null
   */
  #resolveFireAt(iso, now) {
    let t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;

    const oneYear = 365 * 24 * 3600_000;

    // 年份偏差超过一年：说明模型抄了示例年份，改成今年
    if (now.getTime() - t > oneYear) {
      const d = new Date(t);
      d.setFullYear(now.getFullYear());
      const shifted = d.getTime();
      if (shifted > now.getTime()) return shifted;
      t = shifted;
    }

    // 还是过去时间：顺延到明天同一时刻
    if (t <= now.getTime()) {
      const d = new Date(t);
      while (d.getTime() <= now.getTime()) {
        d.setDate(d.getDate() + 1);
      }
      return d.getTime();
    }

    return t;
  }

  /** 列出某个联系人的未完成的提醒 */
  async listReminders(contactId) {
    const all = await this.reminders.all();
    return all.filter((r) => r.contactId === contactId && !r.fired && !r.cancelled);
  }

  /** 取消某个联系人的某条提醒 */
  async cancelReminder(contactId, id) {
    const r = await this.reminders.all().then((all) =>
      all.find((x) => x.id === id && x.contactId === contactId),
    );
    if (!r) return false;
    return this.reminders.cancel(id);
  }

  /** 压缩过长的历史，避免上下文爆掉 */
  async maybeSummarize(contactId) {
    if (!(await this.memory.needsSummarize(contactId))) return false;

    const { old, keepFrom } = await this.memory.takeForSummarize(contactId);
    if (!old.length) return false;

    // 每条都带上日期。之前不带日期，模型会用"次日""后来"这类相对说法，
    // 而相对说法一旦写进摘要就失去了锚点 —— 之后读到它，
    // 会把"次日"当成"昨天"，导致"几分钟前吃的一碗面"变成"昨天吃的"。
    const transcript = old
      .map((m) => {
        const d = new Date(m.at ?? Date.now());
        const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `[${stamp}] ${m.role === 'user' ? '他' : '你'}：${m.content}`;
      })
      .join('\n');

    const summary = await this.llm.chat(
      [
        {
          role: 'user',
          content:
            `把下面这段对话压缩成 200 字以内的摘要，保留事实和关系进展，去掉寒暄。用第三人称。\n\n` +
            `**每条前面都有日期时间，写摘要时必须原样保留日期**（比如"10/14 早上他吃了面"）。\n` +
            `不要用"次日""后来""前几天"这种没有锚点的相对说法——那种写法会让后面读的人搞错是哪天。\n` +
            `**凌晨 0-5 点发生的事算前一天晚上**（"10月13日 01:10"要写成"10月12日晚上"）。\n\n` +
            transcript,
        },
      ],
      { temperature: 0, maxTokens: 400, reasoningEffort: 'none' },
    );

    if (summary) await this.memory.setSummary(contactId, summary, keepFrom);
    return Boolean(summary);
  }
}

/**
 * 把模型的整段输出切成"一条一条消息"。
 * 她一句一条发，所以按行切；行内多余空白去掉；空行丢弃。
 */
export function splitMessages(raw) {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 12); // 防止刷屏被风控，也防止她话痨
}
