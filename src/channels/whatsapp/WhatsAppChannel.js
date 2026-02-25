/**
 * WhatsApp channel via Baileys (WebSocket-based, no Puppeteer).
 */
import { Channel } from '../Channel.js';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import qrcode from 'qrcode-terminal';

/**
 * WhatsApp channel implementation using Baileys library.
 */
export class WhatsAppChannel extends Channel {
  /**
   * @param {Object} opts
   * @param {string} [opts.id]
   * @param {Object} opts.config — { authDir, whitelist, groupMode }
   * @param {import('../../core/EventBus.js').EventBus} opts.eventBus
   */
  constructor({ id, config, eventBus }) {
    super(id || 'whatsapp', 'whatsapp', config);
    this.eventBus = eventBus;
    this.authDir = config.authDir || config.auth_dir || 'data/whatsapp-auth';
    this.whitelist = (config.whitelist || []).map(id => id.toString());
    this.groupMode = config.groupMode || config.group_mode || 'mention_only';
    /** @type {any|null} */
    this.sock = null;
    this.userId = null;
    this.userName = null;
    /** @type {Map<string, any>} message ID cache for replies */
    this._msgCache = new Map();
    /** @type {Map<string, number>} rate limit */
    this._lastSend = new Map();
    this._minDelay = 1500;
    /** @type {Map<string, Array>} message buffer per chat: chatId → messages[] */
    this._msgBuffer = new Map();
    /** @type {Map<string, NodeJS.Timeout>} debounce timers per chat */
    this._debounceTimers = new Map();
    /** @type {number} typing buffer delay for DM in ms (default 2s) */
    this._typingDelayDM = config.typingDelayDM || config.typing_delay_dm || 2000;
    /** @type {number} typing buffer delay for Group in ms (default 5s) */
    this._typingDelayGroup = config.typingDelayGroup || config.typing_delay_group || 5000;
  }

  async connect() {
    this.status = 'connecting';
    console.log(`[WhatsApp:${this.id}] Connecting...`);

    // Lazy mode: clear existing session on first user-initiated connect
    // to prevent auto-reconnect with stale session
    if (this._lazy && !this._userConnecting) {
      console.log(`[WhatsApp:${this.id}] Skipping connect (lazy mode, waiting for user)`);
      this.status = 'disconnected';
      return;
    }
    
    // Lazy mode cleanup: clear auth dir on first explicit connect
    if (this._lazy && this._userConnecting && !this._cleanupDone) {
      try {
        const files = await readdir(this.authDir);
        for (const file of files) {
          await unlink(join(this.authDir, file));
        }
        console.log(`[WhatsApp:${this.id}] Cleared previous session for fresh connect`);
      } catch (e) {
        // Ignore errors (dir might be empty)
      }
      this._cleanupDone = true;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    // Handle connection events
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[WhatsApp:${this.id}] Scan QR code below to login:`);
        qrcode.generate(qr, { small: true });
        // Emit QR code to EventBus for Mission Control
        console.log(`[WhatsApp:${this.id}] Emitting QR event to EventBus`);
        this.eventBus.emit('channel.whatsapp.qr', {
          channelId: this.id,
          qr: qr,
          timestamp: Date.now(),
        });
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

        // Don't auto-reconnect if lazy mode, EXCEPT when user initiated connect is in progress
        if (this._lazy && !this._userConnecting) {
          console.log(`[WhatsApp:${this.id}] Connection closed (lazy mode, not reconnecting)`);
          this.status = 'disconnected';
          return;
        }

        if (shouldReconnect) {
          console.log(`[WhatsApp:${this.id}] Connection closed, reconnecting...`);
          this.status = 'reconnecting';
          await this.connect();
        } else {
          console.log(`[WhatsApp:${this.id}] Logged out`);
          this.status = 'disconnected';
          this._userConnecting = false; // Reset flag on logout
        }
      } else if (connection === 'open') {
        this.status = 'connected';
        this.userId = this.sock.user.id;
        this.userName = this.sock.user.name;
        this._userConnecting = false; // Reset flag on successful connection
        console.log(`[WhatsApp:${this.id}] Connected as ${this.userName} (${this.userId})`);
        this.eventBus.emit('channel.connect', {
          channelId: this.id,
          type: 'whatsapp',
          username: this.userName,
        });
      }
    });

    // Handle credentials update
    this.sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          await this._handleMessage(msg);
        }
      }
    });
  }

  async disconnect() {
    // Clear all debounce timers
    for (const [chatId, timer] of this._debounceTimers) {
      clearTimeout(timer);
      // Flush any pending messages before disconnect
      this._flushBuffer(chatId);
    }
    this._debounceTimers.clear();
    this._msgBuffer.clear();
    
    if (this.sock) {
      await this.sock.logout();
      this.sock = null;
    }
    this.status = 'disconnected';
  }

  /**
   * Handle incoming WhatsApp message
   */
  async _handleMessage(msg) {
    // Ignore own messages
    if (msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const senderId = msg.key.participant || chatId;
    const messageId = msg.key.id;

    // Check whitelist
    if (this.whitelist.length > 0 && !this.whitelist.includes(senderId)) {
      return;
    }

    // Extract message content
    const messageContent = msg.message;
    if (!messageContent) return;

    // Get text content
    let text = '';
    let messageType = 'text';

    if (messageContent.conversation) {
      text = messageContent.conversation;
    } else if (messageContent.extendedTextMessage) {
      text = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage) {
      messageType = 'image';
      text = messageContent.imageMessage.caption || '';
    } else if (messageContent.audioMessage) {
      messageType = 'audio';
      text = '(voice message)';
    } else if (messageContent.videoMessage) {
      messageType = 'video';
      text = messageContent.videoMessage.caption || '';
    } else if (messageContent.documentMessage) {
      messageType = 'document';
      text = messageContent.documentMessage.caption || '';
    }

    // Group mode handling
    const isGroup = chatId.endsWith('@g.us');
    if (isGroup && this.groupMode === 'mention_only') {
      const wasMentioned = text.includes('@' + this.userId.split(':')[0]) ||
                           text.toLowerCase().includes(this.userName?.toLowerCase() || '');
      if (!wasMentioned) return;
    }

    // Download media if present
    let mediaPath = null;
    if (['image', 'audio', 'video', 'document'].includes(messageType)) {
      try {
        const buffer = await this._downloadMedia(msg);
        if (buffer) {
          const ext = this._getExtension(messageType, messageContent);
          const mediaDir = join(process.cwd(), 'data', 'media', this.id, messageType);
          if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
          mediaPath = join(mediaDir, `${Date.now()}_${messageId}.${ext}`);
          writeFileSync(mediaPath, buffer);
          console.log(`📎 [WhatsApp:${this.id}] Downloaded ${messageType}: ${mediaPath}`);
        }
      } catch (err) {
        console.error(`❌ [WhatsApp:${this.id}] Media download failed:`, err.message);
      }
    }

    // Cache message for reply context
    this._msgCache.set(chatId, msg);

    // Build inbound message
    const inbound = {
      channelId: this.id,
      chatId,
      senderId,
      messageId,
      text: text || '(no text)',
      timestamp: msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(),
      type: messageType,
      isGroup,
      mentions: this._extractMentions(messageContent),
      replyTo: msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
      media: mediaPath ? { type: messageType, path: mediaPath } : null,
      raw: msg,
    };

    // Buffer messages for typing aggregation
    this._bufferMessage(inbound);
  }

  /**
   * Buffer messages with debounce for typing aggregation
   * @param {Object} msg
   */
  _bufferMessage(msg) {
    const chatId = msg.chatId;
    const isGroup = msg.isGroup || chatId.endsWith('@g.us');
    
    // Initialize buffer for this chat
    if (!this._msgBuffer.has(chatId)) {
      this._msgBuffer.set(chatId, []);
    }
    
    // Add message to buffer
    this._msgBuffer.get(chatId).push(msg);
    
    // Clear existing timer
    if (this._debounceTimers.has(chatId)) {
      clearTimeout(this._debounceTimers.get(chatId));
    }
    
    // Choose delay based on DM vs Group
    const delay = isGroup ? this._typingDelayGroup : this._typingDelayDM;
    
    // Set new timer
    const timer = setTimeout(() => {
      this._flushBuffer(chatId);
    }, delay);
    
    this._debounceTimers.set(chatId, timer);
    
    console.log(`[WhatsApp:${this.id}] Buffered message from ${msg.senderId} in ${chatId} (${this._msgBuffer.get(chatId).length} pending, ${isGroup ? 'group' : 'DM'}, ${delay}ms)`);
  }

  /**
   * Flush buffered messages and dispatch aggregated message
   * @param {string} chatId
   */
  _flushBuffer(chatId) {
    const buffer = this._msgBuffer.get(chatId);
    if (!buffer || buffer.length === 0) return;
    
    // Clear timer reference
    this._debounceTimers.delete(chatId);
    this._msgBuffer.delete(chatId);
    
    // Aggregate messages
    if (buffer.length === 1) {
      // Single message, dispatch as-is
      this._dispatch(buffer[0]);
    } else {
      // Multiple messages, aggregate text
      const aggregatedText = buffer.map(m => m.text).filter(Boolean).join('\n');
      const firstMsg = buffer[0];
      const lastMsg = buffer[buffer.length - 1];
      
      // Use first message as base, but aggregate text
      const aggregated = {
        ...firstMsg,
        id: firstMsg.messageId,
        text: aggregatedText,
        timestamp: lastMsg.timestamp,
        aggregated: true,
        aggregatedCount: buffer.length,
      };
      
      console.log(`[WhatsApp:${this.id}] Aggregated ${buffer.length} messages from ${chatId}`);
      this._dispatch(aggregated);
    }
  }

  async _downloadMedia(msg) {
    const buffer = await this.sock.downloadMediaMessage(msg);
    return buffer;
  }

  _getExtension(type, content) {
    switch (type) {
      case 'image': return 'jpg';
      case 'audio': return 'ogg';
      case 'video': return 'mp4';
      case 'document':
        const doc = content.documentMessage;
        return doc?.mimetype?.split('/')[1] || 'bin';
      default: return 'bin';
    }
  }

  _extractMentions(content) {
    const mentions = [];
    if (content?.extendedTextMessage?.contextInfo?.mentionedJid) {
      mentions.push(...content.extendedTextMessage.contextInfo.mentionedJid);
    }
    return mentions;
  }

  /**
   * Send text message with rate limiting
   */
  async sendText(chatId, text, opts = {}) {
    if (this.status !== 'connected') {
      throw new Error('WhatsApp not connected');
    }

    // Rate limiting
    const now = Date.now();
    const last = this._lastSend.get(chatId) || 0;
    const wait = this._minDelay - (now - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    // Split long messages
    const maxLength = 4096;
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }

    const sent = [];
    for (const chunk of chunks) {
      const result = await this.sock.sendMessage(chatId, { text: chunk });
      sent.push(result);
      this._lastSend.set(chatId, Date.now());
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
    }

    return sent;
  }

  /**
   * Send media (image, video, audio, document)
   */
  async sendMedia(chatId, media, opts = {}) {
    if (this.status !== 'connected') {
      throw new Error('WhatsApp not connected');
    }

    const { type, path, buffer, caption, filename } = media;

    let mediaBuffer;
    if (buffer) {
      mediaBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    } else if (path && existsSync(path)) {
      mediaBuffer = readFileSync(path);
    } else {
      throw new Error('Media requires path or buffer');
    }

    const options = { caption: caption || opts.caption || '' };

    let result;
    switch (type) {
      case 'image':
        result = await this.sock.sendMessage(chatId, { image: mediaBuffer, ...options });
        break;
      case 'video':
        result = await this.sock.sendMessage(chatId, { video: mediaBuffer, ...options });
        break;
      case 'audio':
      case 'voice':
        result = await this.sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: 'audio/ogg; codecs=opus' });
        break;
      case 'document':
        result = await this.sock.sendMessage(chatId, {
          document: mediaBuffer,
          fileName: filename || 'file',
          ...options,
        });
        break;
      default:
        throw new Error(`Unsupported media type: ${type}`);
    }

    this._lastSend.set(chatId, Date.now());
    return result;
  }

  /**
   * Send reply to a specific message
   */
  async sendReply(chatId, text, replyToMessageId) {
    return this.sock.sendMessage(chatId, {
      text,
      quoted: { key: { remoteJid: chatId, id: replyToMessageId } },
    });
  }

  /**
   * Send reaction (emoji)
   */
  async sendReaction(chatId, messageId, emoji) {
    await this.sock.sendMessage(chatId, {
      react: {
        text: emoji,
        key: { remoteJid: chatId, id: messageId },
      },
    });
  }

  capabilities() {
    return {
      reactions: true,
      inlineButtons: false, // Buttons supported but complex
      voice: true,
      media: ['image', 'video', 'audio', 'document'],
      maxMessageLength: 4096,
      markdown: false,
      threads: false,
      edit: false,
      delete: false,
    };
  }

  async healthCheck() {
    return {
      status: this.status === 'connected' ? 'healthy' : 'unhealthy',
      timestamp: Date.now(),
      details: {
        userId: this.userId,
        userName: this.userName,
        socketState: this.sock?.ws?.readyState,
      },
    };
  }
}
