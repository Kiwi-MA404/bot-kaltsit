/**
 * 图片处理 —— 让她能"看到"他发的图。
 *
 * 为什么要单独一个文件：涉及三件麻烦事
 *   1. QQ 给的图可能是远程 URL，也可能是本地路径（取决于 NapCat 配置）
 *   2. 模型要的是 base64 data URL，得先下载再编码
 *   3. 图片可能很大，直接塞进去会撑爆 token / 超时
 *
 * 设计取舍：
 *   - 只做"当前这张图"的识别，**不把图片存进记忆**。
 *     一张图 base64 动辄几 MB，存进 history 会让记忆文件爆炸。
 *   - 记忆里只留一行文字描述（"[他发了张图]"），图片本身用完就丢。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 单张图上限定为 6MB。超过就不下了——模型那边也吃不下。 */
const MAX_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** 按文件头猜 MIME。QQ 给的后缀名不太可靠。 */
function sniffMime(buf) {
  if (buf.length < 12) return 'image/jpeg';
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b.slice(0, 4).toString('ascii') === 'RIFF' &&
    b.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/**
 * 把一个 OneBot image 段变成模型能吃的 data URL。
 *
 * @param {{url?:string, file?:string}} data  OneBot 的 image 段 data 字段
 * @returns {Promise<{dataUrl:string, bytes:number, mime:string}|{error:string}>}
 */
export async function imageSegmentToDataUrl(data = {}) {
  const src = data.url || data.file;
  if (!src) return { error: '图片段里没有地址' };

  let buf;
  let mime;

  try {
    if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src, {
        headers: { 'User-Agent': UA, Accept: 'image/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { error: `下载图片失败 HTTP ${res.status}` };

      // 先看 Content-Length，太大就不读了
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_BYTES) return { error: `图片太大（${(len / 1048576).toFixed(1)}MB）` };

      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) return { error: `图片太大（${(buf.length / 1048576).toFixed(1)}MB）` };
      mime = (res.headers.get('content-type') || '').split(';')[0] || sniffMime(buf);
    } else {
      // 本地路径（NapCat 的 enableLocalFile2Url 关掉时会给本地文件）
      if (!existsSync(src)) return { error: '本地图片文件不存在' };
      buf = await readFile(src);
      if (buf.length > MAX_BYTES) return { error: `图片太大（${(buf.length / 1048576).toFixed(1)}MB）` };
      mime = sniffMime(buf);
    }
  } catch (err) {
    return { error: `取图失败：${err.message}` };
  }

  if (!/^image\//.test(mime)) mime = sniffMime(buf);

  return {
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    bytes: buf.length,
    mime,
  };
}

/**
 * 从 OneBot 消息段数组里挑出图片段。
 * @returns {Array<object>} image 段数组
 */
export function pickImages(message) {
  if (!Array.isArray(message)) return [];
  return message.filter((seg) => seg?.type === 'image');
}

/** 把 base64 大小粗略换算成 token 量级，用来提前告警 */
export function roughTokens(bytes) {
  // 视觉模型的 image token 大致随像素增长，不是随字节。
  // 这里只给一个粗略量级：每 100KB 约 100~200 token（经验值）。
  return Math.round(bytes / 1024) * 1.5;
}
