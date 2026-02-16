/**
 * InstanceManager.js — Peer-to-peer multi-instance communication via Redis
 * 
 * Features:
 * - Auto-discovery via Redis heartbeat registry
 * - Broadcast + direct messaging channels
 * - Request/response with correlation IDs
 * - Knowledge sync between instances
 * - Configurable Redis (local default, remote supported)
 * - Auto-generated instance ID during onboarding
 */

import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

const HEARTBEAT_INTERVAL = 10_000;   // 10s heartbeat
const PEER_EXPIRE_SEC = 30;          // peer considered offline after 30s
const REQUEST_TIMEOUT = 30_000;      // 30s default request timeout
const RECONNECT_DELAY = 5_000;       // 5s reconnect delay

export class InstanceManager extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Object} opts.config       - instance config from config.yaml
   * @param {string} opts.configPath   - path to config.yaml (for onboarding write-back)
   * @param {Object} [opts.handlers]   - event handlers { onMessage, onRequest, onBroadcast }
   */
  constructor(opts = {}) {
    super();
    const instanceCfg = opts.config?.instance || {};
    
    this.instanceId = instanceCfg.id || null;
    this.instanceName = instanceCfg.name || null;
    this.instanceScope = instanceCfg.scope || '';
    this.configPath = opts.configPath || null;
    this.fullConfig = opts.config || {};
    
    // Redis config — default local
    const redisCfg = instanceCfg.redis || {};
    this.redisUrl = redisCfg.url || 'redis://localhost:6379';
    this.prefix = redisCfg.prefix || 'metaclaw';
    this.redisOptions = redisCfg.options || {};
    
    // Handlers
    this.handlers = opts.handlers || {};
    
    // State
    this.pub = null;       // Redis publisher
    this.sub = null;       // Redis subscriber
    this._heartbeatTimer = null;
    this._pendingRequests = new Map(); // correlationId → { resolve, reject, timer }
    this._initialized = false;
    this._destroyed = false;
  }

  // ─── Channel keys ───
  _key(suffix) { return `${this.prefix}:${suffix}`; }
  get _busChannel() { return this._key('bus'); }
  get _dmChannel() { return this._key(`dm:${this.instanceId}`); }
  get _peersHash() { return this._key('peers'); }

  // ─── Lifecycle ───

  async initialize() {
    if (this._initialized) return;

    // Onboarding: generate instance ID if not set
    if (!this.instanceId) {
      await this._onboard();
    }

    console.log(`🔗 InstanceManager: connecting as "${this.instanceId}" (${this.instanceName || 'unnamed'})...`);

    // Create two Redis connections (pub/sub requires dedicated connection)
    const redisOpts = this._buildRedisOpts();
    this.pub = new Redis(this.redisUrl, redisOpts);
    this.sub = new Redis(this.redisUrl, redisOpts);

    // Wait for connections
    await Promise.all([
      this._waitReady(this.pub, 'publisher'),
      this._waitReady(this.sub, 'subscriber'),
    ]);

    // Subscribe to channels
    await this.sub.subscribe(this._busChannel, this._dmChannel);
    this.sub.on('message', (channel, raw) => this._handleMessage(channel, raw));

    // Start heartbeat
    await this._heartbeat();
    this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL);

    // Error handling
    for (const conn of [this.pub, this.sub]) {
      conn.on('error', (err) => {
        console.error('🔴 InstanceManager Redis error:', err.message);
        this.emit('error', err);
      });
    }

    this._initialized = true;
    console.log(`✅ InstanceManager: online as "${this.instanceId}" on ${this.redisUrl}`);
    this.emit('ready', { instanceId: this.instanceId, name: this.instanceName });
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // Clear heartbeat
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);

    // Remove self from peers
    try {
      await this.pub?.hdel(this._peersHash, this.instanceId);
    } catch {}

    // Announce departure
    try {
      await this._publish(this._busChannel, {
        type: 'event',
        action: 'peer_offline',
        payload: { instanceId: this.instanceId },
      });
    } catch {}

    // Clear pending requests
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('InstanceManager destroyed'));
    }
    this._pendingRequests.clear();

    // Disconnect
    try { this.sub?.disconnect(); } catch {}
    try { this.pub?.disconnect(); } catch {}

    console.log('🔗 InstanceManager: offline');
  }

  // ─── Onboarding ───

  async _onboard() {
    // Auto-generate instance ID
    const shortId = randomUUID().split('-')[0]; // 8 chars
    this.instanceId = `instance-${shortId}`;
    this.instanceName = this.instanceName || this.instanceId;

    console.log(`🆕 InstanceManager: onboarding — generated ID "${this.instanceId}"`);

    // Write back to config.yaml if possible
    if (this.configPath && fs.existsSync(this.configPath)) {
      try {
        let configText = fs.readFileSync(this.configPath, 'utf8');
        
        // Append instance config if not present
        if (!configText.includes('instance:')) {
          const instanceBlock = [
            '',
            '# Multi-instance communication',
            'instance:',
            `  id: ${this.instanceId}`,
            `  name: "${this.instanceName}"`,
            '  redis:',
            '    url: redis://localhost:6379',
            `    prefix: ${this.prefix}`,
          ].join('\n');
          
          configText += '\n' + instanceBlock + '\n';
          fs.writeFileSync(this.configPath, configText, 'utf8');
          console.log(`📝 InstanceManager: wrote instance config to ${this.configPath}`);
        }
      } catch (err) {
        console.warn('⚠️ InstanceManager: could not write config:', err.message);
      }
    }
  }

  // ─── Messaging ───

  /**
   * Send a direct message to a specific instance
   */
  async send(to, message, opts = {}) {
    const envelope = {
      type: opts.type || 'message',
      action: opts.action || 'message',
      payload: typeof message === 'string' ? { text: message } : message,
    };
    await this._publish(this._key(`dm:${to}`), envelope);
    return envelope.id;
  }

  /**
   * Broadcast a message to all instances
   */
  async broadcast(message, opts = {}) {
    const envelope = {
      type: 'event',
      action: opts.action || 'broadcast',
      payload: typeof message === 'string' ? { text: message } : message,
    };
    await this._publish(this._busChannel, envelope);
    return envelope.id;
  }

  /**
   * Send a request and await response (with timeout)
   */
  async request(to, action, payload = {}, timeoutMs = REQUEST_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const correlationId = randomUUID();
      
      const timer = setTimeout(() => {
        this._pendingRequests.delete(correlationId);
        reject(new Error(`Request to "${to}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingRequests.set(correlationId, { resolve, reject, timer });

      this._publish(this._key(`dm:${to}`), {
        type: 'request',
        action,
        payload,
        correlationId,
      }).catch(reject);
    });
  }

  /**
   * Respond to a request
   */
  async respond(to, correlationId, payload) {
    await this._publish(this._key(`dm:${to}`), {
      type: 'response',
      action: 'response',
      payload,
      replyTo: correlationId,
    });
  }

  // ─── Knowledge Sync ───

  /**
   * Request knowledge from another instance
   */
  async queryKnowledge(to, query, opts = {}) {
    return this.request(to, 'knowledge_query', { query, ...opts });
  }

  /**
   * Share knowledge with another instance
   */
  async shareKnowledge(to, knowledge) {
    await this.send(to, { knowledge }, { action: 'knowledge_share' });
  }

  // ─── Peer Discovery ───

  /**
   * List all online peers
   */
  async listPeers() {
    const raw = await this.pub.hgetall(this._peersHash);
    const peers = [];
    const now = Date.now();
    
    for (const [id, json] of Object.entries(raw)) {
      try {
        const info = JSON.parse(json);
        const isOnline = (now - info.lastSeen) < (PEER_EXPIRE_SEC * 1000);
        if (isOnline) {
          peers.push({
            id,
            name: info.name,
            scope: info.scope || '',
            uptime: info.uptime,
            lastSeen: info.lastSeen,
            meta: info.meta || {},
          });
        } else {
          // Cleanup expired peer
          await this.pub.hdel(this._peersHash, id).catch(() => {});
        }
      } catch {}
    }
    
    return peers;
  }

  /**
   * Get info about a specific peer
   */
  async getPeer(peerId) {
    const raw = await this.pub.hget(this._peersHash, peerId);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ─── Tool Definitions (for AI native function calling) ───

  getToolDefinitions() {
    // Use `params` format to match MetaClaw's core tool definitions
    // (providers use Object.keys(t.params) to build schemas)
    return [
      {
        name: 'list_instances',
        description: 'List all online MetaClaw instances in the peer network',
        params: {},
      },
      {
        name: 'send_to_instance',
        description: 'Send a message to a specific MetaClaw instance',
        params: {
          to: { type: 'string', description: 'Target instance ID' },
          message: { type: 'string', description: 'Message to send' },
        },
      },
      {
        name: 'broadcast_instances',
        description: 'Broadcast a message to all online MetaClaw instances',
        params: {
          message: { type: 'string', description: 'Message to broadcast' },
        },
      },
      {
        name: 'request_instance',
        description: 'Send a request to another instance and wait for a response. Use for task delegation, knowledge queries, or status checks.',
        params: {
          to: { type: 'string', description: 'Target instance ID' },
          action: { type: 'string', description: 'Action to request (e.g. execute_task, query_knowledge, get_status)' },
          payload: { type: 'object', description: 'Request payload data' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
        },
      },
      {
        name: 'delegate_task',
        description: 'Delegate a task to another instance that has the right scope/expertise. The target instance will process the task using its AI and tools, then return the result. IMPORTANT: Always include replyTo with the chatId or username where the result should be sent.',
        params: {
          to: { type: 'string', description: 'Target instance ID (check list_instances to see available instances and their scopes)' },
          task: { type: 'string', description: 'Clear description of what needs to be done' },
          context: { type: 'string', description: 'Additional context (e.g. who requested, why, relevant details)' },
          replyToId: { type: 'string', description: 'Numeric chat/user ID where to send result (e.g. "5020823483"). REQUIRED.' },
          replyToUsername: { type: 'string', description: 'Telegram username without @ (e.g. "MetaSanjaya"). Optional but recommended as fallback.' },
          replyToTopicId: { type: 'number', description: 'Topic/thread ID for forum-style groups. Optional.' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000 for tasks)' },
        },
      },
    ];
  }

  /**
   * Execute a tool call (called from GramJSBridge._executeSingleTool)
   */
  async executeTool(toolName, input) {
    switch (toolName) {
      case 'list_instances': {
        const peers = await this.listPeers();
        if (peers.length === 0) return 'No other instances online.';
        return peers.map(p => 
          `• ${p.name || p.id} (${p.id}) — online, last seen ${Math.round((Date.now() - p.lastSeen) / 1000)}s ago`
        ).join('\n');
      }

      case 'send_to_instance': {
        const { to, message } = input;
        const peer = await this.getPeer(to);
        if (!peer) return `Instance "${to}" is not online.`;
        await this.send(to, message);
        return `Message sent to ${peer.name || to}.`;
      }

      case 'broadcast_instances': {
        const { message } = input;
        const peers = await this.listPeers();
        await this.broadcast(message);
        return `Broadcast sent to ${peers.length} peer(s).`;
      }

      case 'request_instance': {
        const { to, action, payload, timeout_ms } = input;
        const peer = await this.getPeer(to);
        if (!peer) return `Instance "${to}" is not online.`;
        try {
          const result = await this.request(to, action, payload || {}, timeout_ms);
          return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        } catch (err) {
          return `Request failed: ${err.message}`;
        }
      }

      case 'delegate_task': {
        const { to, task, context, replyToId, replyToUsername, replyToTopicId, timeout_ms } = input;
        const peer = await this.getPeer(to);
        if (!peer) return `Instance "${to}" is not online.`;
        try {
          const result = await this.request(to, 'execute_task', { task, context: context || '', replyToId: replyToId || '', replyToUsername: replyToUsername || '', replyToTopicId: replyToTopicId || null }, timeout_ms || 60000);
          if (result.error) return `Task failed: ${result.error}`;
          return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        } catch (err) {
          return `Task delegation failed: ${err.message}`;
        }
      }

      default:
        return `Unknown instance tool: ${toolName}`;
    }
  }

  // ─── Internals ───

  _buildRedisOpts() {
    return {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (this._destroyed) return null;
        return Math.min(times * RECONNECT_DELAY, 30_000);
      },
      lazyConnect: false,
      ...this.redisOptions,
    };
  }

  _waitReady(conn, label) {
    return new Promise((resolve, reject) => {
      if (conn.status === 'ready') return resolve();
      const timeout = setTimeout(() => reject(new Error(`${label} connection timeout`)), 10_000);
      conn.once('ready', () => { clearTimeout(timeout); resolve(); });
      conn.once('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  async _heartbeat() {
    if (this._destroyed) return;
    try {
      const info = JSON.stringify({
        name: this.instanceName,
        scope: this.instanceScope,
        lastSeen: Date.now(),
        uptime: process.uptime(),
        meta: {
          pid: process.pid,
          node: process.version,
        },
      });
      await this.pub.hset(this._peersHash, this.instanceId, info);
      // Set expiry on individual peer (cleanup if instance crashes without graceful shutdown)
      // Note: Redis doesn't support per-field expiry on hashes, so we clean up in listPeers()
    } catch (err) {
      console.warn('⚠️ InstanceManager heartbeat failed:', err.message);
    }
  }

  async _publish(channel, envelope) {
    envelope.id = envelope.id || randomUUID();
    envelope.from = this.instanceId;
    envelope.ts = Date.now();
    await this.pub.publish(channel, JSON.stringify(envelope));
    return envelope.id;
  }

  _handleMessage(channel, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Ignore own messages
    if (msg.from === this.instanceId) return;

    switch (msg.type) {
      case 'response': {
        // Handle response to pending request
        const pending = this._pendingRequests.get(msg.replyTo);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingRequests.delete(msg.replyTo);
          pending.resolve(msg.payload);
        }
        break;
      }

      case 'request': {
        // Handle incoming request — delegate to handler
        this._handleRequest(msg).catch(err => {
          console.error('InstanceManager request handler error:', err.message);
          // Send error response
          this.respond(msg.from, msg.correlationId, { error: err.message }).catch(() => {});
        });
        break;
      }

      case 'message': {
        this.emit('message', msg);
        this.handlers.onMessage?.(msg);
        break;
      }

      case 'event': {
        if (msg.action === 'broadcast') {
          this.emit('broadcast', msg);
          this.handlers.onBroadcast?.(msg);
        } else if (msg.action === 'peer_offline') {
          this.emit('peer_offline', msg.payload);
        } else if (msg.action === 'knowledge_share') {
          this.emit('knowledge_share', msg);
          this.handlers.onKnowledgeShare?.(msg);
        }
        break;
      }
    }
  }

  async _handleRequest(msg) {
    const { action, payload, correlationId, from } = msg;

    // Built-in handlers
    switch (action) {
      case 'get_status': {
        await this.respond(from, correlationId, {
          instanceId: this.instanceId,
          name: this.instanceName,
          uptime: process.uptime(),
          pid: process.pid,
        });
        return;
      }

      case 'ping': {
        await this.respond(from, correlationId, { pong: true, ts: Date.now() });
        return;
      }

      case 'execute_task': {
        // Another instance is delegating a task to us
        if (this.handlers.onTaskDelegated) {
          try {
            const result = await this.handlers.onTaskDelegated(payload, from);
            await this.respond(from, correlationId, result);
          } catch (err) {
            await this.respond(from, correlationId, { error: err.message });
          }
        } else {
          await this.respond(from, correlationId, { error: 'Task execution not supported' });
        }
        return;
      }

      case 'knowledge_query': {
        // Delegate to handler — the bridge will hook this up to RAG/KnowledgeManager
        if (this.handlers.onKnowledgeQuery) {
          const result = await this.handlers.onKnowledgeQuery(payload);
          await this.respond(from, correlationId, result);
        } else {
          await this.respond(from, correlationId, { error: 'Knowledge query not supported' });
        }
        return;
      }

      default: {
        // Delegate to generic request handler
        if (this.handlers.onRequest) {
          const result = await this.handlers.onRequest(msg);
          await this.respond(from, correlationId, result);
        } else {
          await this.respond(from, correlationId, { error: `Unknown action: ${action}` });
        }
      }
    }
  }
}

export default InstanceManager;
