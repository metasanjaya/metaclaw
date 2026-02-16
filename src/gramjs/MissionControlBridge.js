/**
 * MissionControlBridge.js — Redis pub/sub for mission-control dashboard
 * 
 * Publishes events to:
 * - metaclaw:events — live feed of activity
 * - metaclaw:instance:{instanceId} — instance status (Redis hash)
 * - metaclaw:instances — instance status changes
 * 
 * Gracefully handles Redis unavailability (logs warning, continues without pub/sub)
 */

import Redis from 'ioredis';

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

export class MissionControlBridge {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - Full config from config.yaml
   */
  constructor(opts = {}) {
    this.config = opts.config || {};
    
    // Extract pub/sub config
    const redisCfg = this.config.redis || {};
    const pubsubCfg = redisCfg.pubsub || {};
    
    this.enabled = pubsubCfg.enabled !== false;
    this.instanceId = pubsubCfg.instanceId || this.config.instance?.id || 'unknown';
    this.instanceName = this.config.instance?.name || 'Unknown';
    this.instanceScope = this.config.instance?.scope || '';
    
    // Redis config
    this.redisUrl = redisCfg.url || 'redis://localhost:6379';
    
    // Redis connections
    this.client = null;
    this.publisher = null;
    this._initialized = false;
    this._destroyed = false;
    this._heartbeatTimer = null;
    
    // Track current state for heartbeat
    this._currentTask = null;
    this._activeChats = 0;
    this._tokensToday = 0;
    
    // Stats tracking (periodic)
    this._statsInterval = null;
  }

  // ─── Lifecycle ───

  async initialize() {
    if (!this.enabled) {
      console.log('📡 MissionControlBridge: disabled in config (redis.pubsub.enabled = false)');
      return;
    }

    if (this._initialized) return;

    console.log(`📡 MissionControlBridge: connecting to ${this.redisUrl}...`);

    const redisOpts = {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (this._destroyed) return null;
        if (times > 5) {
          console.warn('⚠️ MissionControlBridge: giving up on Redis connection');
          return null;
        }
        return Math.min(times * 2000, 30_000);
      },
      lazyConnect: false,
    };

    try {
      // Create publisher connection
      this.publisher = new Redis(this.redisUrl, redisOpts);
      
      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10_000);
        this.publisher.once('ready', () => {
          clearTimeout(timeout);
          resolve();
        });
        this.publisher.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Test with a ping
      await this.publisher.ping();
      
      console.log(`✅ MissionControlBridge: connected as "${this.instanceId}"`);
      
      this._initialized = true;
      
      // Start heartbeat
      await this._publishInstanceStatus('online');
      this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL);
      
      // Periodic stats (every 60 seconds)
      this._statsInterval = setInterval(() => this._publishStats(), 60_000);
      
    } catch (err) {
      console.warn(`⚠️ MissionControlBridge: Redis unavailable (${err.message}), running without pub/sub`);
      this.enabled = false;
      this._initialized = false;
    }
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._statsInterval) clearInterval(this._statsInterval);

    if (this._initialized && this.publisher) {
      try {
        // Publish offline status
        await this._publishInstanceStatus('offline');
        this.publisher.disconnect();
      } catch {}
    }

    console.log('📡 MissionControlBridge: offline');
  }

  // ─── Event Publishing ───

  /**
   * Publish a live event to metaclaw:events channel
   * @param {Object} event
   * @param {string} event.source - Source of event (message, response, tool, error)
   * @param {string} event.text - Event description/text
   * @param {string} [event.agent] - Agent/model handling
   */
  async publishEvent(source, text, agent = null) {
    if (!this._initialized || !this.enabled) return;

    try {
      const event = {
        agent: agent || this.instanceId,
        source,
        text: text.substring(0, 500), // Truncate for sanity
        time: Date.now(),
        instanceId: this.instanceId,
      };
      await this.publisher.publish('metaclaw:events', JSON.stringify(event));
    } catch (err) {
      console.warn(`⚠️ MissionControlBridge: failed to publish event: ${err.message}`);
    }
  }

  /**
   * Publish a message received event
   */
  async onMessageReceived(senderName, preview) {
    await this.publishEvent('message', `"${preview.substring(0, 100)}" from ${senderName}`);
  }

  /**
   * Publish routing decision
   */
  async onRoutingDecision(complexity, model, provider) {
    await this.publishEvent('routing', `routed to ${complexity} → ${provider}/${model}`, `${provider}/${model}`);
  }

  /**
   * Publish AI response generated
   */
  async onResponseGenerated(responseLength, tokensUsed, durationMs, model) {
    await this.publishEvent('response', 
      `${responseLength} chars, ${tokensUsed} tokens, ${(durationMs/1000).toFixed(1)}s`, 
      model
    );
  }

  /**
   * Publish tool call
   */
  async onToolCall(toolName, resultSummary) {
    await this.publishEvent('tool', `${toolName}: ${resultSummary.substring(0, 100)}`);
  }

  /**
   * Publish error
   */
  async onError(errorType, errorMessage) {
    await this.publishEvent('error', `${errorType}: ${errorMessage.substring(0, 200)}`);
  }

  // ─── Instance Status ───

  /**
   * Update current state for heartbeat
   */
  updateState(state = {}) {
    if (state.currentTask !== undefined) this._currentTask = state.currentTask;
    if (state.activeChats !== undefined) this._activeChats = state.activeChats;
    if (state.tokensToday !== undefined) this._tokensToday = state.tokensToday;
  }

  /**
   * Publish instance status to Redis hash
   */
  async _publishInstanceStatus(status) {
    if (!this._initialized || !this.enabled) return;

    try {
      const hashKey = `metaclaw:instance:${this.instanceId}`;
      const data = {
        id: this.instanceId,
        name: this.instanceName,
        scope: this.instanceScope,
        status,
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        current_task: this._currentTask || '',
        tokens: this._tokensToday || 0,
        updated_at: Date.now(),
      };

      // Use hset to store as hash
      await this.publisher.hset(hashKey, data);
      
      // Also publish status change to channel
      await this.publisher.publish('metaclaw:instances', JSON.stringify({
        type: 'instance_update',
        instanceId: this.instanceId,
        status,
        ...data,
      }));
    } catch (err) {
      console.warn(`⚠️ MissionControlBridge: failed to publish status: ${err.message}`);
    }
  }

  /**
   * Periodic heartbeat
   */
  async _heartbeat() {
    await this._publishInstanceStatus('online');
  }

  /**
   * Publish periodic stats
   */
  async _publishStats() {
    if (!this._initialized || !this.enabled) return;
    
    try {
      const stats = {
        instanceId: this.instanceId,
        timestamp: Date.now(),
        tokensToday: this._tokensToday || 0,
        activeChats: this._activeChats || 0,
        uptime: Math.floor(process.uptime()),
      };
      
      await this.publisher.publish('metaclaw:stats', JSON.stringify(stats));
    } catch (err) {
      // Silent fail for stats
    }
  }
}

export default MissionControlBridge;
