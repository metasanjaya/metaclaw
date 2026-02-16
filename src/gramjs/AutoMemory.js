/**
 * AutoMemory - Auto-summarize conversations to persistent memory
 * Triggers on idle (10min) or /clear. Saves to data/memory/YYYY-MM-DD.md
 * Injects relevant memories into system prompt via embedding similarity.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.join(__dirname, '../../data/memory');
const IDLE_MS = 10 * 60 * 1000; // 10 minutes

export class AutoMemory {
  constructor({ ai, embedder, config }) {
    this.ai = ai;
    this.embedder = embedder;
    this.config = config;
    this.idleTimers = new Map(); // chatId → timer
    this.lastActivity = new Map(); // chatId → timestamp
    this.todayCount = 0;
    this._memoryCache = []; // { text, embedding, date }

    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }

  /**
   * Track activity for a chat — resets idle timer
   */
  trackActivity(chatId, chatName) {
    this.lastActivity.set(chatId, { ts: Date.now(), name: chatName });

    // Reset idle timer
    if (this.idleTimers.has(chatId)) clearTimeout(this.idleTimers.get(chatId));
    this.idleTimers.set(chatId, setTimeout(() => {
      this._onIdle(chatId);
    }, IDLE_MS));
  }

  /**
   * Force summary (e.g. on /clear)
   */
  async forceSummary(chatId, chatName, messages) {
    if (this.idleTimers.has(chatId)) clearTimeout(this.idleTimers.get(chatId));
    await this._summarizeAndSave(chatId, chatName, messages);
  }

  /**
   * Search relevant memories for injection into system prompt
   */
  async getRelevantMemories(query, topK = 3) {
    if (!this.embedder || this._memoryCache.length === 0) {
      await this._loadMemoryCache();
    }
    if (this._memoryCache.length === 0) return [];

    try {
      const queryEmb = await this.embedder.embed(query);
      const scored = [];
      for (const mem of this._memoryCache) {
        if (!mem.embedding) continue;
        const sim = this.embedder.cosineSimilarity(queryEmb, mem.embedding);
        if (sim > 0.25) scored.push({ ...mem, score: sim });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    } catch {
      return [];
    }
  }

  /**
   * Build context string for system prompt injection
   */
  async buildContext(query) {
    const memories = await this.getRelevantMemories(query);
    if (memories.length === 0) return '';

    let ctx = '\n\n## Recent Memories\n';
    for (const m of memories) {
      ctx += `[${m.date}] ${m.text}\n`;
    }
    return ctx;
  }

  async _onIdle(chatId) {
    this.idleTimers.delete(chatId);
    const activity = this.lastActivity.get(chatId);
    if (!activity) return;

    // Get conversation from ConversationManager (injected later)
    if (!this._getMessages) return;
    const messages = this._getMessages(chatId);
    if (!messages || messages.length < 3) return;

    await this._summarizeAndSave(chatId, activity.name || chatId, messages);
  }

  async _summarizeAndSave(chatId, chatName, messages) {
    if (!messages || messages.length < 3) return;

    // Only summarize last batch of messages (since last summary)
    const userMsgs = messages.filter(m => m.role === 'user' && !m.content.startsWith('Tool results:') && !m.content.startsWith('[System:'));
    if (userMsgs.length < 2) return;

    const recentText = messages.slice(-20).map(m => `${m.role}: ${m.content.substring(0, 150)}`).join('\n');

    try {
      const intentCfg = this.config.models?.intent || { provider: 'google', model: 'gemini-2.5-flash' };
      const result = await this.ai.generate(
        `Summarize this conversation in 2-3 bullet points (max 200 chars total). Focus on: what was discussed, key decisions, tasks completed. Be concise. Language: match the conversation.\n\nConversation:\n${recentText}`,
        { provider: intentCfg.provider, model: intentCfg.model, maxTokens: 150, temperature: 0 }
      );

      const summary = (result?.text || result?.content || String(result)).trim();
      if (!summary || summary.length < 10) return;

      // Save to daily file
      const now = new Date(Date.now() + 7 * 3600000); // WIB
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
      const filePath = path.join(MEMORY_DIR, `${dateStr}.md`);

      const entry = `\n## ${timeStr} - [${chatName}]\n${summary}\n`;
      fs.appendFileSync(filePath, entry);

      this.todayCount++;
      this._memoryCache = []; // invalidate cache
      console.log(`📝 AutoMemory: saved summary for ${chatName} (${summary.length} chars)`);
    } catch (err) {
      console.error(`❌ AutoMemory summarize failed: ${err.message}`);
    }
  }

  async _loadMemoryCache() {
    this._memoryCache = [];
    if (!fs.existsSync(MEMORY_DIR)) return;

    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md')).sort().slice(-7); // last 7 days
    for (const file of files) {
      const date = file.replace('.md', '');
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf-8');
      // Split by ## headers
      const sections = content.split(/\n(?=## )/).filter(s => s.trim());
      for (const section of sections) {
        const text = section.trim().substring(0, 300);
        let embedding = null;
        if (this.embedder) {
          try { embedding = await this.embedder.embed(text); } catch {}
        }
        this._memoryCache.push({ text, embedding, date });
      }
    }
  }

  /**
   * Set message getter function (injected from GramJSBridge)
   */
  setMessageGetter(fn) {
    this._getMessages = fn;
  }

  getStats() {
    return { todayCount: this.todayCount, totalCached: this._memoryCache.length };
  }
}
