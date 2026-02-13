/**
 * ConversationManager - Smart conversation history with relevance filtering
 * 
 * Instead of sending all messages to the AI, optimizes by:
 * 1. Always including last 4 messages (immediate context)
 * 2. Using embeddings to find top 3 relevant older messages
 * 3. Prepending a local extractive summary of old messages
 * 
 * ~60% token savings vs sending full history.
 * 
 * Persistence: saves to data/conversations.json (debounced).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSIST_PATH = path.join(__dirname, '../../data/conversations.json');
const MAX_MESSAGES_PER_CHAT = 50;
const SAVE_DEBOUNCE_MS = 5000;

const GREETING_PATTERNS = /^(hi|hello|hey|halo|hai|yo|sup|gm|gn|good\s*(morning|night|evening|afternoon))[\s!.]*$/i;
const FILLER_PATTERNS = /^(ok|okay|yes|no|ya|yep|nope|sure|thanks|thx|ty|lol|haha|nice|cool|hmm|wow|oke|sip|gak|ga|iya|nah|udah|done|got it)[\s!.]*$/i;

export class ConversationManager {
  constructor(embeddingManager) {
    this.chats = new Map(); // chatId -> { messages: [], summary: '' }
    this.embedder = embeddingManager;
    this._embedderReady = false;
    this._saveTimer = null;
    this._checkEmbedder();
    this._loadFromDisk();
  }

  async _checkEmbedder() {
    if (this.embedder?.embedder) {
      this._embedderReady = true;
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(PERSIST_PATH)) {
        const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8'));
        for (const [chatId, chatData] of Object.entries(data)) {
          const messages = (chatData.messages || []).map(m => ({ ...m, embedding: null }));
          this.chats.set(chatId, { messages, summary: chatData.summary || '' });
        }
        console.log(`💾 Loaded ${this.chats.size} conversations from disk`);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to load conversations: ${err.message}`);
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  _saveToDisk() {
    try {
      const data = {};
      for (const [chatId, chat] of this.chats) {
        // Don't save system messages, prune to max
        const msgs = chat.messages
          .filter(m => m.role !== 'system')
          .slice(-MAX_MESSAGES_PER_CHAT)
          .map(m => ({ role: m.role, content: m.content }));
        data[chatId] = { messages: msgs, summary: chat.summary || '' };
      }
      const dir = path.dirname(PERSIST_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn(`⚠️ Failed to save conversations: ${err.message}`);
    }
  }

  addMessage(chatId, role, content) {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { messages: [], summary: '' });
    }
    const chat = this.chats.get(chatId);
    chat.messages.push({ role, content, embedding: null });

    // Generate summary every 10 messages
    if (chat.messages.length % 10 === 0 && chat.messages.length > 6) {
      this._generateSummary(chatId);
    }

    // Auto-compact when exceeding 30 messages
    if (chat.messages.length > 30) {
      this._compactHistory(chatId);
    }

    // Schedule debounced save
    this._scheduleSave();
  }

  async getOptimizedHistory(chatId, currentQuery) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.messages.length === 0) return [];

    const msgs = chat.messages;
    const total = msgs.length;

    // If 6 or fewer messages, return all
    if (total <= 6) return msgs.map(m => ({ role: m.role, content: m.content }));

    // Last 4 messages (immediate context)
    const recent = msgs.slice(-4);
    const older = msgs.slice(0, -4);

    // Try relevance filtering with embeddings
    let relevantOlder = [];
    if (this.embedder && this._embedderReady && older.length > 0) {
      try {
        await this._ensureEmbedderReady();
        const queryEmb = await this.embedder.embed(currentQuery);

        // Compute embeddings for older messages (cached)
        const scored = [];
        for (const msg of older) {
          if (!msg.embedding) {
            try {
              msg.embedding = await this.embedder.embed(msg.content);
            } catch { continue; }
          }
          const sim = this.embedder.cosineSimilarity(queryEmb, msg.embedding);
          scored.push({ msg, sim });
        }

        // Top 3 most relevant
        scored.sort((a, b) => b.sim - a.sim);
        relevantOlder = scored.slice(0, 3).map(s => ({ role: s.msg.role, content: s.msg.content }));
      } catch {
        // Fallback: just take last 6
        return msgs.slice(-6).map(m => ({ role: m.role, content: m.content }));
      }
    } else {
      // No embedder: take 2 oldest for context
      relevantOlder = older.slice(-2).map(m => ({ role: m.role, content: m.content }));
    }

    // Build optimized history
    const result = [];

    // 1. Summary
    if (chat.summary) {
      result.push({ role: 'system', content: `[Conversation summary: ${chat.summary}]` });
    }

    // 2. Relevant older messages
    result.push(...relevantOlder);

    // 3. Recent messages
    result.push(...recent.map(m => ({ role: m.role, content: m.content })));

    // Log savings
    const saved = total - result.length;
    const tokensSaved = saved * 100; // ~100 tokens per message estimate
    if (saved > 0) {
      console.log(`📊 History: ${total} msgs → ${result.length} optimized (saved ~${tokensSaved} tokens)`);
    }

    return result;
  }

  async _ensureEmbedderReady() {
    if (this._embedderReady) return;
    if (this.embedder?.embedder) {
      this._embedderReady = true;
      return;
    }
    // Try initializing
    try {
      await this.embedder.initialize();
      this._embedderReady = true;
    } catch {
      throw new Error('Embedder not ready');
    }
  }

  _generateSummary(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return;

    const msgs = chat.messages;
    if (msgs.length <= 6) return;

    const older = msgs.slice(0, -6);
    const kept = [];

    for (const msg of older) {
      const text = msg.content;
      // Skip short filler
      if (text.length < 10) continue;
      if (GREETING_PATTERNS.test(text)) continue;
      if (FILLER_PATTERNS.test(text)) continue;

      // Keep: questions, commands, tool results, informational content
      const hasInfo = /[?/]/.test(text) ||
        /\d{2,}/.test(text) ||
        /https?:\/\//.test(text) ||
        /\/[\w.]+/.test(text) ||
        /\[.*\]/.test(text) ||
        text.length > 50;

      if (hasInfo) {
        kept.push(text.substring(0, 100));
      }
    }

    chat.summary = kept.join(' | ').substring(0, 500);
  }

  _compactHistory(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.messages.length <= 30) return;

    // Take oldest 20, keep recent 10+
    const oldest = chat.messages.slice(0, 20);
    const recent = chat.messages.slice(20);

    // Build simple summary from oldest messages
    const parts = oldest
      .filter(m => m.content && m.content.length > 5)
      .map(m => `[${m.role}] ${m.content.substring(0, 60)}`)
      .join(' | ');

    const summary = parts.substring(0, 500) || 'Earlier conversation context';
    chat.summary = summary;

    // Replace oldest 20 with a single summary message
    const summaryMsg = { role: 'system', content: `[Context summary of ${oldest.length} earlier messages: ${summary}]`, embedding: null };
    chat.messages = [summaryMsg, ...recent];

    console.log(`📦 Compacted chat ${chatId}: ${oldest.length + recent.length} → ${chat.messages.length} msgs`);
    this._scheduleSave();
  }

  getRawHistory(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return chat.messages.map(m => ({ role: m.role, content: m.content }));
  }

  clear(chatId) {
    if (chatId) {
      this.chats.delete(chatId);
    } else {
      this.chats.clear();
    }
  }
}
