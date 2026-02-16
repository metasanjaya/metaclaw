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
const PERSIST_DIR = path.join(__dirname, '../../data/conversations');
const LEGACY_PATH = path.join(__dirname, '../../data/conversations.json');
const MAX_MESSAGES_PER_CHAT = 80;
const SAVE_DEBOUNCE_MS = 5000;

// How many recent messages to ALWAYS include (immediate context)
const RECENT_WINDOW = 20;
// How many relevant older messages to include via embeddings
const RELEVANT_OLDER = 10;
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
    this._dirtyChats = new Set(); // track which chatIds need saving
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
      // Migrate legacy single-file format
      if (fs.existsSync(LEGACY_PATH)) {
        const data = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf-8'));
        if (Object.keys(data).length > 0) {
          if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true });
          for (const [chatId, chatData] of Object.entries(data)) {
            const filePath = path.join(PERSIST_DIR, `${chatId}.json`);
            if (!fs.existsSync(filePath)) {
              fs.writeFileSync(filePath, JSON.stringify(chatData, null, 2));
            }
          }
          console.log(`💾 Migrated ${Object.keys(data).length} conversations from legacy format`);
        }
        fs.renameSync(LEGACY_PATH, LEGACY_PATH + '.bak');
      }

      // Load per-chat files
      if (fs.existsSync(PERSIST_DIR)) {
        const files = fs.readdirSync(PERSIST_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const chatId = file.replace('.json', '');
            const chatData = JSON.parse(fs.readFileSync(path.join(PERSIST_DIR, file), 'utf-8'));
            const messages = (chatData.messages || []).map(m => ({ ...m, embedding: null, topic: m.topic || null }));
            this.chats.set(chatId, { messages, summary: chatData.summary || '' });
          } catch (e) {
            console.warn(`⚠️ Failed to load conversation ${file}: ${e.message}`);
          }
        }
        if (this.chats.size > 0) console.log(`💾 Loaded ${this.chats.size} conversations from disk`);
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
      if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true });
      
      // Only save dirty chats
      for (const chatId of this._dirtyChats) {
        const chat = this.chats.get(chatId);
        if (!chat) {
          // Chat was cleared — remove file
          const filePath = path.join(PERSIST_DIR, `${chatId}.json`);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          continue;
        }
        const msgs = chat.messages
          .filter(m => m.role !== 'system')
          .slice(-MAX_MESSAGES_PER_CHAT)
          .map(m => ({ role: m.role, content: m.content, ...(m.topic ? { topic: m.topic } : {}) }));
        const filePath = path.join(PERSIST_DIR, `${chatId}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ messages: msgs, summary: chat.summary || '' }, null, 2));
      }
      this._dirtyChats.clear();
    } catch (err) {
      console.warn(`⚠️ Failed to save conversations: ${err.message}`);
    }
  }

  /**
   * Add message to chat history.
   * Tool outputs are automatically compressed to save context space.
   */
  addMessage(chatId, role, content, topic = null) {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { messages: [], summary: '' });
    }
    const chat = this.chats.get(chatId);

    // Compress tool output before storing (keep essential info, trim bulk)
    const compressed = this._compressToolOutput(content);

    // Merge consecutive same-role messages into one (keeps clean user→assistant→user alternation)
    const lastMsg = chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null;
    if (lastMsg && lastMsg.role === role) {
      lastMsg.content = lastMsg.content + '\n' + compressed;
      if (topic) lastMsg.topic = topic; // update topic to latest
    } else {
      chat.messages.push({ role, content: compressed, embedding: null, topic: topic || null });
    }

    // Generate summary every 15 messages
    if (chat.messages.length % 15 === 0 && chat.messages.length > 10) {
      this._generateSummary(chatId);
    }

    // Auto-compact when exceeding threshold
    if (chat.messages.length > COMPACT_THRESHOLD) {
      this._compactHistory(chatId);
    }

    this._dirtyChats.add(chatId);
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

  async getOptimizedHistory(chatId, currentQuery, activeTopic = null) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.messages.length === 0) return [];

    const msgs = chat.messages;
    const total = msgs.length;

    // If within recent window, return all
    if (total <= RECENT_WINDOW + 2) return msgs.map(m => ({ role: m.role, content: m.content }));

    // Last N messages (immediate context) — always included
    const recent = msgs.slice(-RECENT_WINDOW);
    const older = msgs.slice(0, -RECENT_WINDOW);

    // Try relevance filtering with embeddings + topic awareness
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
          let sim = this.embedder.cosineSimilarity(queryEmb, msg.embedding);

          // Topic boost: same topic gets +0.3 similarity bonus
          if (activeTopic && msg.topic === activeTopic) {
            sim += 0.3;
          }

          scored.push({ msg, sim });
        }

        // Top N most relevant (topic-boosted)
        scored.sort((a, b) => b.sim - a.sim);
        relevantOlder = scored.slice(0, RELEVANT_OLDER).map(s => ({ role: s.msg.role, content: s.msg.content }));
      } catch {
        // Fallback: prefer same-topic messages from older
        relevantOlder = this._fallbackOlderByTopic(older, activeTopic);
      }
    } else {
      // No embedder: prefer same-topic messages
      relevantOlder = this._fallbackOlderByTopic(older, activeTopic);
    }

    // Build optimized history
    const result = [];

    // 1. Summary (if exists) — contains user goals and progress
    if (chat.summary) {
      result.push({ role: 'system', content: `[User's goals and context from earlier in this conversation — follow these instructions:\n${chat.summary}]` });
    }

    // 2. Relevant older messages (topic-weighted)
    result.push(...relevantOlder);

    // 3. Recent messages (immediate context — ALWAYS included)
    result.push(...recent.map(m => ({ role: m.role, content: m.content })));

    const saved = total - result.length;
    if (saved > 0) {
      console.log(`📊 History: ${total} msgs → ${result.length} optimized (${RECENT_WINDOW} recent + ${relevantOlder.length} relevant${activeTopic ? `, topic: ${activeTopic}` : ''})`);
    }

    return result;
  }

  /**
   * Fallback topic-aware selection when embedder is unavailable
   */
  _fallbackOlderByTopic(older, activeTopic) {
    if (!activeTopic) {
      return older.slice(-4).map(m => ({ role: m.role, content: m.content }));
    }

    // Pick from same topic first, then fill with recent
    const sameTopic = older.filter(m => m.topic === activeTopic);
    const topicMsgs = sameTopic.slice(-3).map(m => ({ role: m.role, content: m.content }));
    const recentAny = older.slice(-2).map(m => ({ role: m.role, content: m.content }));

    // Deduplicate (topic msgs might overlap with recent)
    const seen = new Set(topicMsgs.map(m => m.content));
    const extra = recentAny.filter(m => !seen.has(m.content));

    return [...topicMsgs, ...extra].slice(0, RELEVANT_OLDER);
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

    // Extract user goals from ALL messages
    const goals = [];
    for (const msg of msgs) {
      if (msg.role !== 'user' || !msg.content || msg.content.length < 20) continue;
      if (msg.content.startsWith('Tool results:') || msg.content.startsWith('[System:')) continue;
      if (/^(ok|iya|lanjut|betul|ya|oke|yes|go|mau)/i.test(msg.content.trim())) continue;
      goals.push(msg.content.substring(0, 250));
    }

    const uniqueGoals = [...new Set(goals)];
    chat.summary = uniqueGoals.map(g => `[GOAL] ${g}`).join('\n').substring(0, 2000);
  }

  _compactHistory(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.messages.length <= COMPACT_THRESHOLD) return;

    const keepCount = COMPACT_KEEP_RECENT;
    const oldest = chat.messages.slice(0, -keepCount);
    const recent = chat.messages.slice(-keepCount);

    // Build clean summary — prioritize USER GOALS over everything else
    // Step 1: Extract real user instructions (not tool results, not system messages)
    const userInstructions = [];
    const keyResults = [];
    
    // Also scan ALL messages (including recent) for the original task/goal
    const allMsgs = [...oldest, ...recent];
    for (const msg of allMsgs) {
      if (!msg.content || msg.content.length < 10) continue;
      const text = msg.content;
      
      if (msg.role === 'user') {
        // Skip tool results forwarded as user
        if (text.startsWith('Tool results:') || text.startsWith('[System:') || text.startsWith('[Async task')) continue;
        // Skip very short acks
        if (text.length < 20 && /^(ok|iya|lanjut|betul|ya|oke|yes|go|mau)/i.test(text)) continue;
        // This is a real user instruction
        userInstructions.push(text.substring(0, 250));
      } else if (msg.role === 'assistant' && !text.startsWith('[TOOL:')) {
        // Keep key conclusions only (first meaningful line)
        const firstLine = text.split('\n')[0].substring(0, 100);
        if (firstLine.length > 30 && !/^(Oke|Ok |Baik|Tunggu|Lagi )/.test(firstLine)) {
          keyResults.push(firstLine);
        }
      }
    }
    
    // Step 2: Build summary — user goals FIRST, then key results
    // Deduplicate user instructions (keep unique ones)
    const uniqueInstructions = [...new Set(userInstructions)];
    const goalSection = uniqueInstructions.map(i => `[GOAL] ${i}`).join('\n').substring(0, 2000);
    const resultSection = keyResults.slice(-10).join(' | ').substring(0, 800);
    
    // Step 3: REPLACE summary entirely (no chaining — prevents nested garbage)
    chat.summary = `${goalSection}\n[PROGRESS] ${resultSection}`.substring(0, 3000);

    chat.messages = recent;
    console.log(`📦 Compacted chat ${chatId}: ${oldest.length + recent.length} → ${recent.length} msgs (summary: ${chat.summary.length} chars)`);
    this._dirtyChats.add(chatId);
    this._scheduleSave();
  }

  getRawHistory(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return chat.messages.map(m => ({ role: m.role, content: m.content }));
  }

  clear(chatId) {
    if (chatId) {
      this._dirtyChats.add(chatId);
      this.chats.delete(chatId);
    } else {
      for (const id of this.chats.keys()) this._dirtyChats.add(id);
      this.chats.clear();
    }
    this._scheduleSave();
  }
}
