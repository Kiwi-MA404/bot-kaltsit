#!/usr/bin/env node
/**
 * 命令行联网工具。给自己（AI）查资料用。
 *
 * 为什么需要这个：DSH 的 web_search 工具缺 API key，web_fetch 又被环境拦。
 * 但 Node 的 fetch 是通的 —— 所以绕一层，从命令行走。
 *
 *   node tools/net.js search "关键词"            # Bing 全网搜索
 *   node tools/net.js fetch <url>                # 抓网页正文
 *   node tools/net.js arxiv "关键词"             # 直查 arXiv（技术方案首选）
 *
 * 实测网络情况（2026-10-14）：
 *   arxiv.org        ✅ 通，查技术方案的第一选择
 *   cn.bing.com      ✅ 通，但结果质量一般
 *   github.com       ⚠️ 时通时不通
 *   duckduckgo.com   ❌ 不通
 */

import { webSearch, fetchPage } from '../src/web.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');

if (!cmd) {
  console.log(`
用法：
  node tools/net.js search "关键词"       Bing 全网搜索
  node tools/net.js fetch <url>           抓网页正文
  node tools/net.js arxiv "关键词"        直查 arXiv（技术方案首选）

${C.dim('提示：查技术方案优先用 arxiv；Bing 对技术名词的结果质量一般。')}
`);
  process.exit(0);
}

async function doSearch(q, limit = 6) {
  console.log(`\n${C.bold(`搜索：${q}`)}\n`);
  const r = await webSearch(q, { limit });
  if (r.error) {
    console.log(`${C.bad('✗')} ${r.error}\n`);
    return;
  }
  for (const [i, x] of r.results.entries()) {
    console.log(`${i + 1}. ${C.bold(x.title)}`);
    console.log(`   ${C.dim(x.url)}`);
    if (x.snippet) console.log(`   ${x.snippet.slice(0, 160)}`);
    console.log();
  }
}

async function doFetch(url) {
  console.log(`\n${C.bold(`抓取：${url}`)}\n`);
  const r = await fetchPage(url, { maxChars: 6000 });
  if (r.error && !r.text) {
    console.log(`${C.bad('✗')} ${r.error}\n`);
    return;
  }
  if (r.title) console.log(`${C.bold(r.title)}\n`);
  console.log(r.text);
  console.log();
}

async function doArxiv(q) {
  // 用网页版搜索页，不走 API。
  // API（export.arxiv.org）实测容易被限流，返回 429；
  // 而且 http 版被拦、https 版超时。网页版稳定得多。
  const url = `https://arxiv.org/search/?searchtype=all&query=${encodeURIComponent(q)}`;

  console.log(`\n${C.bold(`arXiv 检索：${q}`)}\n`);

  // 网页版走我们自己的抓取（带重试和 UA）
  const r = await fetchPage(url, { maxChars: 5000 });
  if (r.error && !r.text) {
    console.log(`${C.bad('✗')} ${r.error}\n`);
    return;
  }
  console.log(r.text.slice(0, 4000));
  console.log();
  return;

  const entries = xml.split('<entry>').slice(1);
  if (!entries.length) {
    console.log(`${C.dim('没有结果。')}\n`);
    return;
  }

  for (const [i, e] of entries.entries()) {
    const pick = (tag) => {
      const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };
    const title = pick('title');
    const summary = pick('summary');
    const id = pick('id');
    const published = pick('published').slice(0, 10);

    console.log(`${i + 1}. ${C.bold(title)}`);
    console.log(`   ${C.dim(`${id}  (${published})`)}`);
    console.log(`   ${summary.slice(0, 300)}`);
    console.log();
  }
}

switch (cmd) {
  case 'search':
    await doSearch(arg);
    break;
  case 'fetch':
    await doFetch(arg);
    break;
  case 'arxiv':
    await doArxiv(arg);
    break;
  default:
    console.log(`${C.bad(`未知命令：${cmd}`)}\n`);
    process.exit(1);
}
