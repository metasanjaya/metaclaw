import uWS from 'uWebSockets.js';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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

    // --- Settings APIs ---
    this.app.get('/api/config', (res) => {
      res.onAborted(() => {});
      this._json(res, {
        global: {
          model: this.instanceManager.configManager.global.model || {},
          missionControl: this.instanceManager.configManager.global.missionControl || {},
          mesh: this.instanceManager.configManager.global.mesh || {},
        },
      });
    });

    this.app.post('/api/config', (res) => {
      res.onAborted(() => {});
      this._readBody(res, async (body) => {
        try {
          const data = JSON.parse(body);
          const yaml = (await import('js-yaml')).default;
          const { writeFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const cfgPath = join(this.instanceManager.configManager.baseDir, 'config.yaml');
          const current = this.instanceManager.configManager.global;
          if (data.model?.primary) current.model = { ...current.model, primary: data.model.primary };
          if (data.missionControl?.port) current.missionControl = { ...current.missionControl, port: data.missionControl.port };
          writeFileSync(cfgPath, yaml.dump(current));
          this._json(res, { ok: true });
        } catch (e) {
          res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
        }
      });
    });

    this.app.get('/api/instances/:id/config', (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      const config = this.instanceManager.configManager.getInstance(id);
      if (!config) { res.cork(() => { res.writeStatus('404'); this._json(res, { error: 'Not found' }); }); return; }
      this._json(res, {
        id,
        model: config.model || {},
        identity: config._identity || {},
        channels: config.channels || [],
        skills: config.skills || [],
        telegram: config.telegram ? { enabled: config.telegram.enabled !== false, whitelist: config.telegram.whitelist || [] } : null,
      });
    });

    this.app.post('/api/instances/:id/config', (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      this._readBody(res, async (body) => {
        try {
          const data = JSON.parse(body);
          const yaml = (await import('js-yaml')).default;
          const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const dir = join(this.instanceManager.configManager.baseDir, 'instances', id);
          if (!existsSync(dir)) throw new Error('Instance not found');

          // Update config.yaml
          const cfgPath = join(dir, 'config.yaml');
          const cfg = yaml.load(readFileSync(cfgPath, 'utf8')) || {};
          if (data.model?.primary) cfg.model = { ...cfg.model, primary: data.model.primary };
          if (data.skills) cfg.skills = data.skills;
          writeFileSync(cfgPath, yaml.dump(cfg));

          // Update identity.yaml
          const idPath = join(dir, 'identity.yaml');
          const ident = yaml.load(readFileSync(idPath, 'utf8')) || {};
          if (data.identity?.name !== undefined) ident.name = data.identity.name;
          if (data.identity?.personality !== undefined) ident.personality = data.identity.personality;
          if (data.identity?.emoji !== undefined) ident.emoji = data.identity.emoji;
          writeFileSync(idPath, yaml.dump(ident));

          // Reload config
          this.instanceManager.configManager.load();

          // Update running instance
          const inst = this.instanceManager.get(id);
          if (inst) {
            if (data.model?.primary) inst.model = data.model.primary;
            if (data.identity?.name) inst.name = data.identity.name;
            if (data.identity?.emoji) inst.emoji = data.identity.emoji;
            if (data.identity?.personality) inst.personality = data.identity.personality;
          }

          this._json(res, { ok: true, instances: this.instanceManager.list() });
        } catch (e) {
          res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
        }
      });
    });

    // --- Instance files (SOUL.md, MY_RULES.md) ---
    this.app.get('/api/instances/:id/files', async (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      const { readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dir = join(this.instanceManager.configManager.baseDir, 'instances', id);
      if (!existsSync(dir)) { res.cork(() => { res.writeStatus('404'); this._json(res, { error: 'Not found' }); }); return; }
      const soul = existsSync(join(dir, 'SOUL.md')) ? readFileSync(join(dir, 'SOUL.md'), 'utf8') : '';
      const rules = existsSync(join(dir, 'MY_RULES.md')) ? readFileSync(join(dir, 'MY_RULES.md'), 'utf8') : '';
      this._json(res, { soul, rules });
    });

    this.app.post('/api/instances/:id/files', (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      this._readBody(res, async (body) => {
        try {
          const data = JSON.parse(body);
          const { writeFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const dir = join(this.instanceManager.configManager.baseDir, 'instances', id);
          if (!existsSync(dir)) throw new Error('Instance not found');
          if (data.soul !== undefined) writeFileSync(join(dir, 'SOUL.md'), data.soul);
          if (data.rules !== undefined) writeFileSync(join(dir, 'MY_RULES.md'), data.rules);
          this._json(res, { ok: true });
        } catch (e) {
          res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
        }
      });
    });

    // --- Instance channels management ---
    this.app.post('/api/instances/:id/channels', (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      this._readBody(res, async (body) => {
        try {
          const data = JSON.parse(body);
          const yaml = (await import('js-yaml')).default;
          const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const dir = join(this.instanceManager.configManager.baseDir, 'instances', id);
          if (!existsSync(dir)) throw new Error('Instance not found');
          const cfgPath = join(dir, 'config.yaml');
          const cfg = yaml.load(readFileSync(cfgPath, 'utf8')) || {};
          if (data.channels) cfg.channels = data.channels;
          if (data.telegram !== undefined) {
            if (data.telegram === false) {
              delete cfg.telegram;
            } else if (typeof data.telegram === 'object') {
              cfg.telegram = { ...cfg.telegram, ...data.telegram, enabled: true };
            }
          }
          writeFileSync(cfgPath, yaml.dump(cfg));
          this.instanceManager.configManager.load();
          this._json(res, { ok: true, message: 'Restart instance to apply channel changes' });
        } catch (e) {
          res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
        }
      });
    });

    // --- Memory API ---
    this.app.get('/api/instances/:id/memory', (res, req) => {
      res.onAborted(() => {});
      const inst = this.instanceManager.get(req.getParameter(0));
      if (!inst?.memory) { this._json(res, { error: 'No memory' }); return; }
      this._json(res, {
        longTerm: inst.memory.getLongTermMemory(),
        recent: inst.memory.getRecentMemories(7),
        files: inst.memory.listFiles(),
      });
    });

    this.app.post('/api/instances/:id/memory', (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      this._readBody(res, (body) => {
        try {
          const data = JSON.parse(body);
          const inst = this.instanceManager.get(id);
          if (!inst?.memory) throw new Error('No memory manager');
          if (data.longTerm !== undefined) {
            writeFileSync(inst.memory.longTermPath, data.longTerm);
            inst.memory.longTermMemory = data.longTerm;
          }
          if (data.addEntry) inst.memory.addMemory(data.addEntry, data.category);
          this._json(res, { ok: true });
        } catch (e) {
          res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
        }
      });
    });

    // --- Knowledge API ---
    this.app.get('/api/instances/:id/knowledge', (res, req) => {
      res.onAborted(() => {});
      const inst = this.instanceManager.get(req.getParameter(0));
      if (!inst?.knowledge) { this._json(res, { facts: [] }); return; }
      this._json(res, { facts: inst.knowledge.list(), count: inst.knowledge.count() });
    });

    this.app.post('/api/instances/:id/knowledge', (res, req) => {
      res.onAborted(() => {});
      const id = req.getParameter(0);
      this._readBody(res, (body) => {
        try {
          const data = JSON.parse(body);
          const inst = this.instanceManager.get(id);
          if (!inst?.knowledge) throw new Error('No knowledge manager');
          if (data.action === 'add') {
            const result = inst.knowledge.add({ tags: data.tags, fact: data.fact, id: data.id });
            this._json(res, { ok: true, fact: result });
          } else if (data.action === 'remove') {
            inst.knowledge.remove(data.id);
            this._json(res, { ok: true });
          } else {
            this._json(res, { error: 'Unknown action' });
          }
        } catch (e) {
          res.cork(() => { res.writeStatus('400'); this._json(res, { error: e.message }); });
        }
      });
    });

    // WORKFLOW.md (read-only, project-level)
    this.app.get('/api/workflow', async (res) => {
      res.onAborted(() => {});
      try {
        const wfPath = join(import.meta.dirname, '../../..', 'defaults', 'WORKFLOW.md');
        const { readFileSync, existsSync } = await import('node:fs');
        const content = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
        this._json(res, { content, readOnly: true });
      } catch { this._json(res, { content: '', readOnly: true }); }
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

  _readBody(res, cb) {
    let body = '';
    res.onData((chunk, isLast) => {
      body += Buffer.from(chunk).toString();
      if (isLast) cb(body);
    });
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
