import uWS from 'uWebSockets.js';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const UI_DIR = join(__dirname, 'ui');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

/**
 * Mission Control HTTP + WebSocket server.
 */
export class MCServer {
  constructor({ port, auth, eventBus, instanceManager, onMessage }) {
    this.port = port;
    this.auth = auth;
    this.eventBus = eventBus;
    this.instanceManager = instanceManager;
    this.onMessage = onMessage;
    /** @type {import('../../doctor/Doctor.js').Doctor|null} */
    this.doctor = null;
    this.app = null;
    this.listenSocket = null;

    /** @type {Map<string, Set<any>>} chatId → ws clients */
    this.chatClients = new Map();
    /** @type {Set<any>} all connected clients */
    this.allClients = new Set();
    /** @type {Map<string, Array>} chatId → message history */
    this.chatHistory = new Map();
  }

  async start() {
    this.app = uWS.App();

    // --- API Routes ---
    this.app.get('/api/instances', (res) => {
      res.onAborted(() => {});
      const instances = this.instanceManager.list();
      this._json(res, instances);
    });

    this.app.post('/api/instances', (res) => {
      res.onAborted(() => {});
      let body = '';
      res.onData((chunk, isLast) => {
        body += Buffer.from(chunk).toString();
        if (isLast) {
          try {
            const data = JSON.parse(body);
            const id = (data.id || data.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
            if (!id) { res.cork(() => { res.writeStatus('400'); this._json(res, { error: 'ID required' }); }); return; }
            this.instanceManager.create(id, {
              name: data.name || id,
              emoji: data.emoji || '🤖',
              model: data.model || undefined,
              personality: data.personality || '',
              channels: data.channels || ['mission-control'],
              skills: data.skills || ['shell', 'web_search'],
            }).then(() => {
              this._json(res, { ok: true, id, instances: this.instanceManager.list() });
            }).catch(e => {
              res.cork(() => { res.writeStatus('500'); this._json(res, { error: e.message }); });
            });
          } catch (e) {
            res.cork(() => { res.writeStatus('400'); this._json(res, { error: 'Invalid JSON' }); });
          }
        }
      });
    });

    this.app.post('/api/instances/:id/restart', async (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      try {
        await this.instanceManager.stop(id);
        await this.instanceManager.start(id);
        this._json(res, { ok: true, instances: this.instanceManager.list() });
      } catch (e) {
        res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
      }
    });

    this.app.del('/api/instances/:id', async (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      try {
        await this.instanceManager.delete(id);
        this._json(res, { ok: true, instances: this.instanceManager.list() });
      } catch (e) {
        res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
      }
    });

    this.app.get('/api/health', async (res) => {
      res.onAborted(() => {});
      const health = this.instanceManager.healthCheckAll();
      this._json(res, health);
    });

    this.app.get('/api/doctor', async (res) => {
      res.onAborted(() => {});
      if (this.doctor) {
        const report = await this.doctor.report();
        this._json(res, report);
      } else {
        this._json(res, { error: 'Doctor not initialized' });
      }
    });

    this.app.get('/api/incidents', (res, req) => {
      res.onAborted(() => {});
      if (!this.doctor) { this._json(res, []); return; }
      const url = req.getQuery();
      const params = new URLSearchParams(url);
      const opts = {};
      if (params.get('limit')) opts.limit = parseInt(params.get('limit'));
      if (params.get('type')) opts.type = params.get('type');
      if (params.get('active') === 'true') opts.resolved = false;
      this._json(res, this.doctor.getIncidents(opts));
    });

    this.app.post('/api/incidents/:id/resolve', (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      if (this.doctor?.resolveIncident(id)) {
        this._json(res, { ok: true });
      } else {
        res.writeStatus('404');
        this._json(res, { error: 'Incident not found' });
      }
    });

    this.app.get('/api/tasks', (res) => {
      res.onAborted(() => {});
      // TODO: wire to actual task system
      this._json(res, []);
    });

    this.app.get('/api/stats', (res) => {
      res.onAborted(() => {});
      const stats = {};
      for (const [id, inst] of this.instanceManager.instances) {
        stats[id] = inst.getStats();
      }
      this._json(res, stats);
    });

    this.app.get('/api/chat/:instanceId/history', (res, req) => {
      res.onAborted(() => {});
      const instanceId = req.getParameter(0);
      const instance = this.instanceManager.get(instanceId);
      if (instance?.chatStore) {
        const history = instance.chatStore.getHistory(instanceId, 100);
        this._json(res, history);
      } else {
        const history = this.chatHistory.get(instanceId) || [];
        this._json(res, history.slice(-100));
      }
    });

    // --- WebSocket ---
    this.app.ws('/ws', {
      compression: uWS.SHARED_COMPRESSOR,
      maxPayloadLength: 64 * 1024,
      idleTimeout: 120,

      open: (ws) => {
        this.allClients.add(ws);
        ws._data = { chatId: null, userId: crypto.randomUUID().slice(0, 8) };
        this._send(ws, { type: 'welcome', instances: this.instanceManager.list() });
      },

      message: (ws, message) => {
        try {
          const msg = JSON.parse(Buffer.from(message).toString());
          this._handleWsMessage(ws, msg);
        } catch {}
      },

      close: (ws) => {
        this.allClients.delete(ws);
        if (ws._data?.chatId) {
          this.chatClients.get(ws._data.chatId)?.delete(ws);
        }
      },
    });

    // --- Static files ---
    this.app.get('/*', (res, req) => this._serveStatic(res, req));

    // --- Listen ---
    return new Promise((resolve, reject) => {
      this.app.listen(this.port, (token) => {
        if (token) {
          this.listenSocket = token;
          console.log(`[MissionControl] 🌐 http://0.0.0.0:${this.port}`);

          // Forward EventBus events to WS clients
          this._wireEvents();
          resolve();
        } else {
          reject(new Error(`Failed to listen on port ${this.port}`));
        }
      });
    });
  }

  stop() {
    if (this.listenSocket) {
      uWS.us_listen_socket_close(this.listenSocket);
      this.listenSocket = null;
    }
  }

  /**
   * Handle incoming WebSocket message from browser
   */
  _handleWsMessage(ws, msg) {
    switch (msg.type) {
      case 'ping':
        this._send(ws, { type: 'pong' });
        break;

      case 'join_chat': {
        const { instanceId } = msg;
        if (!instanceId) return;
        ws._data.chatId = instanceId;
        if (!this.chatClients.has(instanceId)) this.chatClients.set(instanceId, new Set());
        this.chatClients.get(instanceId).add(ws);

        // Send history from SQLite or memory
        const instance = this.instanceManager.get(instanceId);
        let history;
        if (instance?.chatStore) {
          history = instance.chatStore.getHistory(instanceId, 100);
        } else {
          history = (this.chatHistory.get(instanceId) || []).slice(-100);
        }
        this._send(ws, { type: 'chat_history', instanceId, messages: history });
        break;
      }

      case 'chat_message': {
        // User sends a message to an instance
        const { instanceId, text } = msg;
        if (!instanceId || !text) return;

        const chatMsg = {
          id: crypto.randomUUID(),
          role: 'user',
          text,
          instanceId,
          userId: ws._data.userId,
          timestamp: Date.now(),
        };

        // Store in history
        this._addToHistory(instanceId, chatMsg);

        // Broadcast to other clients in same chat
        this._broadcastToChat(instanceId, { type: 'chat_message', message: chatMsg });

        // Dispatch as inbound message to channel handler
        this.onMessage({
          id: chatMsg.id,
          channelId: 'mission-control',
          chatId: instanceId,
          senderId: ws._data.userId,
          text,
          timestamp: chatMsg.timestamp,
          raw: msg,
        });
        break;
      }

      case 'leave_chat': {
        const old = ws._data.chatId;
        if (old) this.chatClients.get(old)?.delete(ws);
        ws._data.chatId = null;
        break;
      }
    }
  }

  /**
   * Send a message to all clients in a chat
   */
  sendToChat(chatId, data) {
    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: data.text || '',
      instanceId: chatId,
      timestamp: Date.now(),
      ...data,
    };
    this._addToHistory(chatId, assistantMsg);
    this._broadcastToChat(chatId, { type: 'chat_message', message: assistantMsg });
  }

  /**
   * Wire EventBus events to WebSocket broadcast
   */
  _wireEvents() {
    if (this._eventsWired) return;
    this._eventsWired = true;
    const events = ['instance.spawn', 'instance.stop', 'instance.crash', 'health.check', 'health.incident', 'doctor.incident', 'doctor.resolved', 'message.out', 'instance.response'];
    for (const event of events) {
      this.eventBus.on(event, (data) => {
        this._broadcastAll({ type: 'event', event, data });
      });
    }
  }

  _addToHistory(chatId, msg) {
    if (!this.chatHistory.has(chatId)) this.chatHistory.set(chatId, []);
    const history = this.chatHistory.get(chatId);
    history.push(msg);
    if (history.length > 500) history.splice(0, history.length - 500);
  }

  _broadcastToChat(chatId, data) {
    const clients = this.chatClients.get(chatId);
    if (!clients) return;
    const payload = JSON.stringify(data);
    for (const ws of clients) {
      try { ws.send(payload); } catch { clients.delete(ws); }
    }
  }

  _broadcastAll(data) {
    const payload = JSON.stringify(data);
    for (const ws of this.allClients) {
      try { ws.send(payload); } catch { this.allClients.delete(ws); }
    }
  }

  _send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  _json(res, data) {
    res.cork(() => {
      res.writeHeader('Content-Type', 'application/json').end(JSON.stringify(data));
    });
  }

  async _serveStatic(res, req) {
    res.onAborted(() => {});
    let url = req.getUrl();

    // SPA: all pages route to index.html
    const spaRoutes = ['/', '/chat', '/health', '/settings'];
    if (spaRoutes.includes(url) || url.match(/^\/chat\/[^/]+$/)) url = '/index.html';

    if (url.includes('..')) { res.writeStatus('403').end(); return; }

    try {
      const data = await readFile(join(UI_DIR, url));
      const ext = extname(url);
      res.cork(() => {
        res.writeHeader('Content-Type', MIME[ext] || 'application/octet-stream').end(data);
      });
    } catch {
      // Fallback to index
      try {
        const data = await readFile(join(UI_DIR, 'index.html'));
        res.cork(() => { res.writeHeader('Content-Type', 'text/html').end(data); });
      } catch {
        res.cork(() => { res.writeStatus('404').end('Not found'); });
      }
    }
  }
}
