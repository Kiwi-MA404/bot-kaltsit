/**
 * 她的手 —— 上网查东西。
 *
 * 两个能力，对应两个工具：
 *   web_search   全网搜索（走 Bing，因为这台机器上 DuckDuckGo 和 Google 都不通）
 *   read_page    打开一个网页，取回正文
 *
 * 为什么要 Bing 而不是更"标准"的搜索接口：
 *   实测这台机器 duckduckgo.com / github.com 都是 HTTP 000（不通），
 *   只有 cn.bing.com 和 baidu.com 通。Bing 的 HTML 结构还算稳，够用。
 *
 * 关于抓取礼貌：
 *   只读，不登录，不改任何东西。请求之间留间隔，避免把对方打疼。
 *   遇到 403 就老实返回"打不开"，不要伪造内容——她的人设里不允许编造。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SEARCH_TIMEOUT_MS = 25_000;
const PAGE_TIMEOUT_MS = 25_000;

/** 上一个请求的时间，用来维持最小间隔 */
let lastRequestAt = 0;
const MIN_GAP_MS = 800;

/** HTML 实体还原。顺序有讲究：&amp; 必须最后处理，否则会二次解码。 */
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** 去标签，压空白 */
function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    // Bing 会把空格编码成 &ensp;/&emsp;，解完实体后残留 \u2002 等宽空格，清掉
    .replace(/[\u2000-\u200b\u202f\u205f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 请求之间留间隔 */
async function throttle() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function httpGet(url, timeoutMs) {
  await throttle();
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

/**
 * 全网搜索。
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {Promise<{query:string, results:Array<{title:string,url:string,snippet:string}>, error?:string}>}
 */
export async function webSearch(query, { limit = 5 } = {}) {
  const q = String(query ?? '').trim().slice(0, 200);
  if (!q) return { query: q, results: [], error: '搜索词是空的' };

  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=${limit * 2}`;

  let html;
  try {
    const res = await httpGet(url, SEARCH_TIMEOUT_MS);
    if (!res.ok) return { query: q, results: [], error: `搜索返回 HTTP ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { query: q, results: [], error: `搜索失败：${err.message}` };
  }

  // Bing 的结果块。结构偶有变动，所以标题和摘要分开抓，不依赖固定嵌套。
  const results = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];

  for (const block of blocks) {
    if (results.length >= limit) break;

    const titleM = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (!titleM) continue;
    const title = stripTags(titleM[1]);
    if (!title) continue;

    // 真实地址优先从 <cite> 取；它没被 Bing 包成跳转链接。
    // 注意：Bing 展示网址时把路径分隔符渲染成 "›"，要还原成 "/"，否则打不开。
    let link = '';
    const citeM = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    if (citeM) {
      link = stripTags(citeM[1])
        .replace(/\s+/g, '')
        .replace(/[›»]/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/^(https?:\/)/, '$1/');
    }

    if (!/^https?:\/\//i.test(link)) {
      // 退回到 <a href>，但要排掉 bing 自己的跳转壳
      const hrefM = block.match(/<a[^>]+href="([^"]+)"/i);
      const href = hrefM?.[1] ?? '';
      if (/^https?:\/\//i.test(href) && !/bing\.com\/ck\//i.test(href)) link = href;
    }
    if (!/^https?:\/\//i.test(link)) continue;

    // Bing 会在显示网址里插 "..." 表示省略。那不是真路径，带着必然 404。
    // 见到省略号就只保留到它之前，宁可退回站点根页也不要一个打不开的地址。
    if (link.includes('...')) {
      const cut = link.split('...')[0].replace(/\/+$/, '');
      // 只有形如 https://host 或 https://host/path 才算可用
      if (/^https?:\/\/[^/]+\/[^/]*$/.test(cut)) link = cut;
      else continue; // 截断得太狠，这条丢掉
    }

    const snipM =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/(?:div|p)>/i);
    const snippet = snipM ? stripTags(snipM[1]).slice(0, 300) : '';

    results.push({ title, url: link, snippet });
  }

  if (!results.length) {
    return { query: q, results: [], error: '没搜到结果（可能有验证码，或页面结构变了）' };
  }
  return { query: q, results };
}

/**
 * 打开网页取正文。
 * @param {string} url
 * @param {{maxChars?:number}} [opts]
 * @returns {Promise<{url:string, title:string, text:string, error?:string}>}
 */
export async function fetchPage(url, { maxChars = 3000 } = {}) {
  let target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return { url: target, title: '', text: '', error: '不是合法的网址' };
  }

  let res;
  try {
    res = await httpGet(target, PAGE_TIMEOUT_MS);
  } catch (err) {
    return { url: target, title: '', text: '', error: `打不开：${err.message}` };
  }

  if (!res.ok) {
    return {
      url: target,
      title: '',
      text: '',
      error:
        res.status === 403
          ? '这个站点拒绝抓取（403）。换个来源，或者告诉对方打不开。'
          : `打不开：HTTP ${res.status}`,
    };
  }

  const ctype = res.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype)) {
    return { url: target, title: '', text: '', error: `不是网页内容（${ctype}）` };
  }

  let html;
  try {
    html = await res.text();
  } catch (err) {
    return { url: target, title: '', text: '', error: `读取失败：${err.message}` };
  }

  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]).slice(0, 120) : '';

  // 优先取 <article> 或 <main>，噪音少
  const mainM =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  const text = stripTags(mainM ? mainM[1] : html).slice(0, maxChars);

  if (text.length < 40) {
    return { url: target, title, text, error: '取到的正文太短（可能是 JS 渲染的页面）' };
  }
  return { url: target, title, text };
}

/** 给模型看的工具定义（OpenAI function calling 格式） */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '上网搜索。想知道最近发生了什么、某个东西现在是什么情况、你不确定的事实，就用这个。' +
        '闲聊、情感话题、你已经知道的事，不要用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，用中文或英文都可以' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: '打开一个网页读正文。搜索结果里看到想细看的，用它。不要滥用，一次对话最多读一两页。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网址，必须以 http 开头' },
        },
        required: ['url'],
      },
    },
  },
];

/**
 * 执行一个工具调用，返回给模型看的文本结果。
 * 任何失败都转成一句人话，不抛异常——她不应该因为网络问题发不出消息。
 */
export async function runTool(name, args) {
  try {
    if (name === 'web_search') {
      const r = await webSearch(args?.query);
      if (r.error) return `搜索失败：${r.error}。跟他说没搜到，别编。`;
      const lines = r.results
        .map((x, i) => `${i + 1}. ${x.title}\n   ${x.snippet}\n   链接：${x.url}`)
        .join('\n');
      return (
        `搜到 ${r.results.length} 条（今天是 ${new Date().toISOString().slice(0, 10)}）：\n${lines}\n\n` +
        `注意：结果里有旧文章。摘要开头的"X天前/X个月前"是发布时间，先看新旧再决定怎么说。`
      );
    }

    if (name === 'read_page') {
      const r = await fetchPage(args?.url);
      if (r.error && !r.text) return `没读到内容：${r.error}`;
      return `以下是刚刚打开的网页正文（实时内容）：\n\n标题：${r.title || '(无)'}\n\n${r.text}`;
    }

    return `没有叫 ${name} 的工具`;
  } catch (err) {
    return `工具执行出错：${err.message}`;
  }
}
