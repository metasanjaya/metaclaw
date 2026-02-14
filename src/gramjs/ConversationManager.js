/**
 * ConversationManager - Smart conversation history with relevance filtering
 * 
 * Improvements v2:
 * 1. Recent window: 10 messages (was 4) — prevents context loss
 * 2. Relevant older: 5 messages (was 3) — more context
 * 3. Compact threshold: 50 messages (was 30) — less aggressive
 * 4. AI-quality summary using extractive approach with key info preservation
 * 5. Tool output compression — stores summaries, not raw output
 * 6. Summary chaining — new summaries build on old ones
 * 
 * Persistence: saves to data/conversations.json (debounced).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSIST_PATH = path.join(__dirname, '../../data/conversations.json');
const MAX_MESSAGES_PER_CHAT = 80;
const SAVE_DEBOUNCE_MS = 5000;

// How many recent messages to ALWAYS include (immediate context)
const RECENT_WINDOW = 10;
// How many relevant older messages to include via embeddings
const RELEVANT_OLDER = 5;
// When to auto-compact
const COMPACT_THRESHOLD = 50;
// How many recent to keep after compaction
const COMPACT_KEEP_RECENT = 20;

const GREETING_PATTERNS = /^(hi|hello|hey|halo|hai|yo|sup|gm|gn|good\s*(morning|night|evening|afternoon))[\s!.]*$/i;
const FILLER_PATTERNS = /^(ok|okay|yes|no|ya|yep|nope|sure|thanks|thx|ty|lol|haha|nice|cool|hmm|wow|oke|sip|gak|ga|iya|nah|udah|done|got it)[\s!.]*$/i;

export class ConversationManager {
  constructor(embeddingManager) {
    this.chats = new Map();
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

  /**
   * Add message to chat history.
   * Tool outputs are automatically compressed to save context space.
   */
  addMessage(chatId, role, content) {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { messages: [], summary: '' });
    }
    const chat = this.chats.get(chatId);

    // Compress tool output before storing (keep essential info, trim bulk)
    const compressed = this._compressToolOutput(content);
    chat.messages.push({ role, content: compressed, embedding: null });

    // Generate summary every 15 messages
    if (chat.messages.length % 15 === 0 && chat.messages.length > 10) {
      this._generateSummary(chatId);
    }

    // Auto-compact when exceeding threshold
    if (chat.messages.length > COMPACT_THRESHOLD) {
      this._compactHistory(chatId);
    }

    this._scheduleSave();
  }

  /**
   * Compress tool output to save tokens.
   * Keeps first/last portions and key information.
   */
  _compressToolOutput(content) {
    if (!content) return content;

    // Detect tool result messages
    const toolMatch = content.match(/^Tool results:\n([\s\S]+?)(?:\n\nNow give your final response|$)/);
    if (!toolMatch) {
      // Also compress very long assistant messages with code blocks
      if (content.length > 3000) {
        return content.substring(0, 2500) + '\n...[truncated]...\n' + content.substring(content.length - 500);
      }
      return content;
    }

    const toolContent = toolMatch[1];
    if (toolContent.length <= 1500) return content; // Short enough, keep as-is

    // Compress each tool result section
    const sections = toolContent.split(/\n\n(?=\[)/);
    const compressed = sections.map(section => {
      if (section.length <= 500) return section;
      // Keep first 400 chars + last 200 chars
      return section.substring(0, 400) + '\n...[output truncated, ' + section.length + ' chars total]...\n' + section.substring(section.length - 200);
    }).join('\n\n');

    return `Tool results:\n${compressed}\n\nNow give your final response to the user.`;
  }

  async getOptimizedHistory(chatId, currentQuery) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.messages.length === 0) return [];

    const msgs = chat.messages;
    const total = msgs.length;

    // If within recent window, return all
    if (total <= RECENT_WINDOW + 2) return msgs.map(m => ({ role: m.role, content: m.content }));

    // Last N messages (immediate context) — this is the key fix
    const recent = msgs.slice(-RECENT_WINDOW);
    const older = msgs.slice(0, -RECENT_WINDOW);

    // Try relevance filtering with embeddings
    let relevantOlder = [];
    if (this.embedder && this._embedderReady && older.length > 0) {
      try {
        await this._ensureEmbedderReady();
        const queryEmb = await this.embedder.embed(currentQuery);

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

        // Top N most relevant
        scored.sort((a, b) => b.sim - a.sim);
        relevantOlder = scored.slice(0, RELEVANT_OLDER).map(s => ({ role: s.msg.role, content: s.msg.content }));
      } catch {
        // Fallback: take last few from older
        relevantOlder = older.slice(-4).map(m => ({ role: m.role, content: m.content }));
      }
    } else {
      // No embedder: take last 4 from older for continuity
      relevantOlder = older.slice(-4).map(m => ({ role: m.role, content: m.content }));
    }

    // Build optimized history
    const result = [];

    // 1. Summary (if exists)
    if (chat.summary) {
      result.push({ role: 'system', content: `[Conversation context: ${chat.summary}]` });
    }

    // 2. Relevant older messages
    result.push(...relevantOlder);

    // 3. Recent messages (immediate context — ALWAYS included)
    result.push(...recent.map(m => ({ role: m.role, content: m.content })));

    const saved = total - result.length;
    if (saved > 0) {
      console.log(`📊 History: ${total} msgs → ${result.length} optimized (${RECENT_WINDOW} recent + ${relevantOlder.length} relevant)`);
    }

    return result;
  }

  async _ensureEmbedderReady() {
    if (this._embedderReady) return;
    if (this.embedder?.embedder) {
      this._embedderReady = true;
      return;
    }
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
    if (msgs.length <= 10) return;

    const older = msgs.slice(0, -10);
    const kept = [];

    for (const msg of older) {
      const text = msg.content;
      if (text.length < 10) continue;
      if (GREETING_PATTERNS.test(text)) continue;
      if (FILLER_PATTERNS.test(text)) continue;

      // Extract key information
      const isUser = msg.role === 'user';
      const isImportant =
        /[?]/.test(text) ||                    // Questions
        /\b(file|path|env|key|url|ip)\b/i.test(text) ||  // File/config references
        /\/[\w./]+/.test(text) ||              // Paths
        /https?:\/\//.test(text) ||            // URLs
        /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text) || // IPs
        text.length > 80;                      // Substantial content

      if (isImportant) {
        // For user messages, keep more (they contain instructions)
        const maxLen = isUser ? 150 : 100;
        kept.push(`[${msg.role}] ${text.substring(0, maxLen)}`);
      }
    }

    // Chain with existing summary
    const newSummary = kept.join(' | ').substring(0, 600);
    if (chat.summary && chat.summary.length > 0) {
      // Merge: keep last part of old summary + new
      const oldPart = chat.summary.substring(0, 300);
      chat.summary = `${oldPart} ||| ${newSummary}`.substring(0, 800);
    } else {
      chat.summary = newSummary;
    }
  }

  _compactHistory(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.messages.length <= COMPACT_THRESHOLD) return;

    const keepCount = COMPACT_KEEP_RECENT;
    const oldest = chat.messages.slice(0, -keepCount);
    const recent = chat.messages.slice(-keepCount);

    // Build meaningful summary from compacted messages
    const keyParts = [];
    for (const msg of oldest) {
      if (!msg.content || msg.content.length < 15) continue;
      if (msg.role === 'system') continue;

      const text = msg.content;

      // Extract user instructions/requests (most important)
      if (msg.role === 'user') {
        // Skip pure tool results forwarded as user
        if (text.startsWith('Tool results:')) {
          // Extract just the key findings
          const shortResult = text.substring(0, 100).replace(/\n/g, ' ');
          keyParts.push(`[tool-output] ${shortResult}`);
          continue;
        }
        keyParts.push(`[user] ${text.substring(0, 200)}`);
      } else if (msg.role === 'assistant') {
        // Keep assistant conclusions (first line usually has the answer)
        const firstLine = text.split('\n')[0].substring(0, 150);
        if (firstLine.length > 20) {
          keyParts.push(`[assistant] ${firstLine}`);
        }
      }
    }

    const summary = keyParts.join(' | ').substring(0, 1000) || 'Earlier conversation context';

    // Chain with existing summary
    if (chat.summary) {
      chat.summary = `${chat.summary.substring(0, 400)} ||| Compacted: ${summary}`.substring(0, 1200);
    } else {
      chat.summary = summary;
    }

    chat.messages = recent;
    console.log(`📦 Compacted chat ${chatId}: ${oldest.length + recent.length} → ${recent.length} msgs (summary: ${chat.summary.length} chars)`);
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
