import { Channel } from '../Channel.js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

/**
 * Telegram channel via GramJS (MTProto userbot).
 */
export class TelegramChannel extends Channel {
  /**
   * @param {Object} opts
   * @param {string} [opts.id]
   * @param {Object} opts.config — { apiId, apiHash, sessionFile, whitelist, groupMode }
   * @param {import('../../core/EventBus.js').EventBus} opts.eventBus
   */
  constructor({ id, config, eventBus }) {
    super(id || 'telegram', 'telegram', config);
    this.eventBus = eventBus;
    this.apiId = parseInt(config.apiId || config.api_id);
    this.apiHash = config.apiHash || config.api_hash;
    this.sessionFile = config.sessionFile || config.session_file || 'data/session.txt';
    this.whitelist = (config.whitelist || []).map(id => BigInt(id));
    this.groupMode = config.groupMode || config.group_mode || 'mention_only';
    /** @type {TelegramClient|null} */
    this.client = null;
    this.botUsername = null;
    /** @type {Map<string, number>} rate limit: chatId → lastSendTime */
    this._lastSend = new Map();
    this._minDelay = 1500;
    /** @type {Map<string, any>} entity cache: chatId → input entity */
    this._entities = new Map();
    /** @type {Map<string, any>} last event per chat for respond() */
    this._lastEvents = new Map();
  }

  async connect() {
    this.status = 'connecting';

    let sessionStr = '';
    if (existsSync(this.sessionFile)) {
      sessionStr = readFileSync(this.sessionFile, 'utf-8').trim();
      console.log(`[Telegram:${this.id}] Loaded session`);
    }

    const session = new StringSession(sessionStr);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
    });

    // Check if session exists (non-interactive) or needs login
    if (sessionStr) {
      await this.client.connect();
      console.log(`[Telegram:${this.id}] Connected (existing session)`);
    } else {
      // Interactive login
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise(r => rl.question(q, r));

      await this.client.start({
        phoneNumber: () => ask('📱 Phone number: '),
        password: () => ask('🔐 2FA Password: '),
        phoneCode: () => ask('💬 Login code: '),
        onError: (err) => console.error('❌ Login error:', err.message),
      });
      rl.close();

      // Save session
      const dir = dirname(this.sessionFile);
      if (dir) mkdirSync(dir, { recursive: true });
      writeFileSync(this.sessionFile, this.client.session.save());
      console.log(`[Telegram:${this.id}] Session saved`);
    }

    // Get bot/user info
    const me = await this.client.getMe();
    this.botUsername = me.username || me.firstName || 'unknown';
    console.log(`[Telegram:${this.id}] Logged in as @${this.botUsername}`);

    // Pre-load dialogs so GramJS can resolve entities
    console.log(`[Telegram:${this.id}] Loading dialogs...`);
    const dialogs = await this.client.getDialogs({ limit: 100 });
    console.log(`[Telegram:${this.id}] Loaded ${dialogs.length} dialogs`);

    // Listen for messages
    this.client.addEventHandler(async (event) => {
      await this._handleMessage(event);
    }, new NewMessage({}));

    this.status = 'connected';
    this.eventBus.emit('channel.connect', { channelId: this.id, type: 'telegram', username: this.botUsername });
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
    }
    this.status = 'disconnected';
  }

  /**
   * Handle incoming Telegram message (text, photo, voice)
   */
  async _handleMessage(event) {
    const msg = event.message;
    if (!msg) return;

    const chatId = msg.chatId?.toString() || msg.peerId?.userId?.toString() || msg.peerId?.channelId?.toString() || '';
    const senderId = msg.senderId?.toString() || '';
    const msgText = msg.text || msg.caption || '';
    
    console.log(`[Telegram:${this.id}] Received message from ${senderId} in ${chatId}: "${msgText.slice(0, 50)}..."`);

    const myId = (await this.client.getMe()).id?.toString() || '';

    // Ignore own messages
    if (senderId === myId) return;

    // Check for media (image/voice)
    let imagePath = null;
    let voicePath = null;

    // Photo
    if (msg.media && msg.media.className === 'MessageMediaPhoto') {
      try {
        const buffer = await this.client.downloadMedia(msg.media, { workers: 1 });
        if (buffer) {
          imagePath = `/tmp/tg_img_${Date.now()}.jpg`;
          writeFileSync(imagePath, buffer);
        }
      } catch (e) {
        console.warn(`[Telegram:${this.id}] Failed to download image:`, e.message);
      }
    }

    // Voice message
    if (msg.voice) {
      try {
        const buffer = await this.client.downloadMedia(msg.media, { workers: 1 });
        if (buffer) {
          voicePath = `/tmp/tg_voice_${Date.now()}.ogg`;
          writeFileSync(voicePath, buffer);
        }
      } catch (e) {
        console.warn(`[Telegram:${this.id}] Failed to download voice:`, e.message);
      }
    }

    if (!msgText && !imagePath && !voicePath) return;

    console.log(`[Telegram:${this.id}] MSG from=${senderId} chat=${chatId} myId=${myId} text="${msgText?.slice(0,50)}" image=${!!imagePath} voice=${!!voicePath}`);

    // Whitelist check
    if (this.whitelist.length > 0) {
      const senderBigInt = BigInt(senderId || '0');
      const chatBigInt = BigInt(chatId || '0');
      if (!this.whitelist.includes(senderBigInt) && !this.whitelist.includes(chatBigInt)) {
        console.log(`[Telegram:${this.id}] Not whitelisted: sender=${senderId} chat=${chatId}`);
        return;
      }
    }

    // Group mode: only respond to mentions
    if (msg.isGroup && this.groupMode === 'mention_only') {
      if (!msgText.includes(`@${this.botUsername}`)) return;
    }

    console.log(`[Telegram:${this.id}] Dispatching message: "${msgText.slice(0, 50)}..."`);

    // Dispatch to channel handlers
    this._dispatch({
      id: msg.id?.toString() || crypto.randomUUID(),
      channelId: this.id,
      chatId,
      senderId,
      text: msgText,
      imagePath,
      voicePath,
      timestamp: new Date().toISOString(),
    });
  }
      chatId,
      senderId,
      text: msgText,
      replyTo: msg.replyToMsgId?.toString() || null,
      timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
      imagePath,
      voicePath,
      raw: msg,
    });
  }

  async sendText(chatId, text, opts = {}) {
    if (!this.client) throw new Error('Telegram not connected');

    // Rate limiting
    const now = Date.now();
    const last = this._lastSend.get(chatId) || 0;
    const wait = this._minDelay - (now - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastSend.set(chatId, Date.now());

    // Try respond via cached event first (most reliable)
    const lastEvent = this._lastEvents.get(chatId);
    if (lastEvent?.message?.respond) {
      try {
        await lastEvent.message.respond({ message: text });
        this.eventBus.emit('message.out', { channelId: this.id, chatId, text });
        return;
      } catch (e) {
        console.warn(`[Telegram:${this.id}] respond() failed, trying sendMessage:`, e.message);
      }
    }

    // Fallback: resolve entity
    let peer;
    if (this._entities.has(chatId)) {
      peer = this._entities.get(chatId);
    } else {
      try {
        peer = await this.client.getInputEntity(BigInt(chatId));
        this._entities.set(chatId, peer);
      } catch {
        try {
          peer = await this.client.getInputEntity(chatId);
          this._entities.set(chatId, peer);
        } catch (e) {
          console.error(`[Telegram:${this.id}] Cannot resolve entity for ${chatId}:`, e.message);
          return;
        }
      }
    }

    const params = { message: text };
    if (opts.replyTo) params.replyTo = parseInt(opts.replyTo);

    await this.client.sendMessage(peer, params);
    this.eventBus.emit('message.out', { channelId: this.id, chatId, text });
  }

  async sendMedia(chatId, media, opts = {}) {
    if (!this.client) throw new Error('Telegram not connected');
    const peer = BigInt(chatId);

    if (media.url || media.buffer) {
      await this.client.sendFile(peer, {
        file: media.buffer || media.url,
        caption: media.caption || '',
        replyTo: opts.replyTo ? parseInt(opts.replyTo) : undefined,
      });
    }
  }

  async sendReaction(chatId, messageId, emoji) {
    if (!this.client) return;
    try {
      await this.client.invoke(new Api.messages.SendReaction({
        peer: BigInt(chatId),
        msgId: parseInt(messageId),
        reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
      }));
    } catch (e) {
      console.warn(`[Telegram:${this.id}] Reaction failed:`, e.message);
    }
  }

  capabilities() {
    return {
      reactions: true,
      inlineButtons: true,
      voice: true,
      media: ['image', 'video', 'audio', 'document'],
      maxMessageLength: 4096,
      markdown: 'limited',
      threads: false,
      edit: true,
      delete: true,
    };
  }

  async healthCheck() {
    const connected = this.client?.connected || false;
    return {
      status: connected ? 'healthy' : 'unhealthy',
      message: `Telegram @${this.botUsername || 'unknown'} ${connected ? 'connected' : 'disconnected'}`,
      timestamp: Date.now(),
    };
  }
}
