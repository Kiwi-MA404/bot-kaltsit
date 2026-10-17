/**
 * NapCat / OneBot 11 客户端。
 *
 * 支持两种接法（NapCat 网络配置里二选一）：
 *
 *   ws          我们当客户端，连到 NapCat 的 WebSocket 服务器（NapCat 侧配 websocketServers）
 *   ws-reverse  我们当服务器，等 NapCat 连进来（NapCat 侧配 websocketClients）
 *
 * 两者事件格式和 API 调用完全一样，只是谁先发起连接。默认用反向
 * （NapCat 主动连过来），因为不需要在 NapCat 里填我们的地址。
 *
 * API 调用是「发一个带 echo 的 JSON，等同样 echo 的响应」。
 * 没有 echo 的帧一律当成事件推给 onEvent。
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

export class NapCat extends EventEmitter {
  /**
   * @param {object} opts
   * @param {'ws-reverse'|'ws'} [opts.mode]
   * @param {string} [opts.url]       mode=ws-reverse 时 NapCat 的地址
   * @param {number} [opts.port]      mode=ws 时我们监听的端口
   * @param {string} [opts.host]
   * @param {string} [opts.accessToken]
   * @param {number} [opts.callTimeoutMs]
   */
  constructor({
    mode = 'ws-reverse',
    url = 'ws://127.0.0.1:3001',
    port = 3002,
    host = '127.0.0.1',
    accessToken = '',
    callTimeoutMs = 30_000,
  } = {}) {
    super();
    this.mode = mode;
    this.url = url;
    this.port = port;
    this.host = host;
    this.accessToken = accessToken;
    this.callTimeoutMs = callTimeoutMs;

    this.ws = null;
    this.wss = null;
    this.selfId = null;
    this._echo = 0;
    this._pending = new Map();
    this._closed = false;
    this._retryDelay = 1000;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async start() {
    // 命名以「我们」为主语，避免混淆：
    //   ws         → 我们当客户端，连到 NapCat 的 WebSocket 服务器（用 url）
    //   ws-reverse → 我们当服务器，等 NapCat 连进来（用 port）
    // 对应 NapCat 侧：websocketServers 配我们为 ws；websocketClients 配我们为 ws-reverse
    if (this.mode === 'ws-reverse') return this._startServer();
    return this._startClient();
  }

  // ── ws-reverse：我们开服务器，等 NapCat 连进来 ────────
  _startServer() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port, host: this.host });

      this.wss.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.wss.on('listening', () => {
        this.emit('listening', `${this.host}:${this.port}`);
        resolve();
      });

      this.wss.on('connection', (ws, req) => {
        // 带 token 时校验，防止别的程序乱连
        if (!this._authorized(req)) {
          this.emit('warn', '鉴权失败，拒绝连接');
          ws.close(1008, 'unauthorized');
          return;
        }
        this._attach(ws);
      });
    });
  }

  // ── ws：我们当客户端，连到 NapCat 的服务器 ────────────
  _startClient() {
    return new Promise((resolve) => {
      const connect = () => {
        if (this._closed) return;
        const ws = new WebSocket(this.url, {
          headers: this.accessToken
            ? { Authorization: `Bearer ${this.accessToken}` }
            : {},
        });

        ws.on('open', () => {
          this._retryDelay = 1000;
          this._attach(ws);
          resolve();
        });

        ws.on('error', (err) => {
          this.emit('warn', `连接 ${this.url} 失败: ${err.message}`);
        });

        ws.on('close', () => {
          if (this._closed) return;
          // 断线重连，指数退避到最多 30s
          this.emit('warn', `${Math.round(this._retryDelay / 1000)}s 后重连`);
          setTimeout(connect, this._retryDelay);
          this._retryDelay = Math.min(this._retryDelay * 2, 30_000);
        });
      };
      connect();
    });
  }

  _authorized(req) {
    if (!this.accessToken) return true;
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    const url = new URL(req.url || '/', 'http://x');
    const qs = url.searchParams.get('access_token') || '';
    return bearer === this.accessToken || qs === this.accessToken;
  }

  _attach(ws) {
    // 只保留最新一条连接，旧的主动断开，避免重复回复
    if (this.ws && this.ws !== ws) {
      try {
        this.ws.close(1000, 'replaced');
      } catch {}
    }
    this.ws = ws;
    this.emit('connected');

    ws.on('message', (buf) => {
      let ev;
      try {
        ev = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // 有 echo 的是 API 回执
      if (ev.echo && this._pending.has(ev.echo)) {
        const { resolve, timer } = this._pending.get(ev.echo);
        clearTimeout(timer);
        this._pending.delete(ev.echo);
        resolve(ev);
        return;
      }

      // 元事件里拿自己的 QQ 号
      if (ev.post_type === 'meta_event' && ev.self_id) {
        this.selfId = ev.self_id;
      }

      this.emit('event', ev);
    });

    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.emit('disconnected');
    });

    ws.on('error', (err) => this.emit('warn', `socket 错误: ${err.message}`));
  }

  /**
   * 调 OneBot API。
   * @param {string} action
   * @param {object} params
   */
  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error(`未连接，无法调用 ${action}`));
        return;
      }

      const echo = `e${++this._echo}`;
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error(`${action} 超时（${this.callTimeoutMs}ms）`));
      }, this.callTimeoutMs);

      this._pending.set(echo, { resolve, timer });

      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(echo);
        reject(err);
      }
    });
  }

  /** 发私聊消息，返回 message_id */
  async sendPrivate(userId, message) {
    const res = await this.call('send_private_msg', {
      user_id: Number(userId),
      message,
    });
    if (res.status === 'failed') throw new Error(res.message || '发送失败');
    return res.data?.message_id;
  }

  /** 发群消息 */
  async sendGroup(groupId, message) {
    const res = await this.call('send_group_msg', {
      group_id: Number(groupId),
      message,
    });
    if (res.status === 'failed') throw new Error(res.message || '发送失败');
    return res.data?.message_id;
  }

  async getLoginInfo() {
    const res = await this.call('get_login_info');
    if (res.data?.user_id) this.selfId = res.data.user_id;
    return res.data;
  }

  /**
   * 拉取与某人的私聊历史消息。
   * 用于机器人离线期间的漏消息补偿。
   * @param {number|string} userId
   * @param {number} count 最多拉多少条
   * @returns {Promise<Array<object>>} OneBot 消息对象数组（旧的在前）
   */
  async getFriendMsgHistory(userId, count = 20) {
    const res = await this.call('get_friend_msg_history', {
      user_id: Number(userId),
      count,
    });
    if (res.status === 'failed') throw new Error(res.message || '拉取历史失败');
    return res.data?.messages ?? [];
  }

  async stop() {
    this._closed = true;
    for (const { timer } of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    this.ws?.close();
    await new Promise((r) => (this.wss ? this.wss.close(r) : r()));
  }
}
