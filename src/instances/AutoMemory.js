/**
 * AutoMemory — Auto-summarize conversations to daily memory logs
 * 
 * Triggers:
 * - Idle timeout (10min no activity in a chat)
 * - Manual flush (e.g. conversation clear)
 * 
 * Saves summaries to <instanceDir>/memory/YYYY-MM-DD.md
 * Uses instance's Router for AI summarization (cheap/fast model).
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const IDLE_MS = 10 * 60 * 1000; // 10 min

export class AutoMemory {
  /**
   * @param {Object} opts
   * @param {string} opts.instanceDir
   * @param {import('../core/Router.js').Router} opts.router
   * @param {string} opts.instanceId
   * @param {string} [opts.summaryModel] — cheap model for summarization
   * @param {import('./ChatStore.js').ChatStore} [opts.chatStore]
   */
  constructor({ instanceDir, router, instanceId, summaryModel, chatStore }) {
    this.dir = instanceDir;
    this.memDir = join(instanceDir, 'memory');
    this.router = router;
    this.instanceId = instanceId;
    this.summaryModel = summaryModel || 'gemini-2.5-flash';
    this.chatStore = chatStore;

    /** @type {Map<string, NodeJS.Timeout>} */
    this._idleTimers = new Map();
    /** @type {Map<string, {ts: number, name: string}>} */
    this._lastActivity = new Map();
    /** @type {Set<string>} chatIds that have been summarized recently */
    this._summarized = new Set();
    this.todayCount = 0;

    if (!existsSync(this.memDir)) mkdirSync(this.memDir, { recursive: true });
  }

  /**
   * Track activity — resets idle timer for a chat
   * @param {string} chatId
   * @param {string} [chatName]
   */
  trackActivity(chatId, chatName) {
    this._lastActivity.set(chatId, { ts: Date.now(), name: chatName || chatId });

    if (this._idleTimers.has(chatId)) clearTimeout(this._idleTimers.get(chatId));
    this._idleTimers.set(chatId, setTimeout(() => {
      this._onIdle(chatId);
    }, IDLE_MS));
  }

  /**
   * Force summary (e.g. on conversation clear or shutdown)
   * @param {string} chatId
   * @param {string} [chatName]
   */
  async forceSummary(chatId, chatName) {
    if (this._idleTimers.has(chatId)) {
      clearTimeout(this._idleTimers.get(chatId));
      this._idleTimers.delete(chatId);
    }
    await this._summarizeChat(chatId, chatName || chatId);
  }

  async _onIdle(chatId) {
    this._idleTimers.delete(chatId);
    if (this._summarized.has(chatId)) return;

    const activity = this._lastActivity.get(chatId);
    if (!activity) return;

    await this._summarizeChat(chatId, activity.name);
  }

  async _summarizeChat(chatId, chatName) {
    if (!this.chatStore || !this.router) return;

    // Get recent messages
    const messages = this.chatStore.getConversation(chatId, 30);
    const userMsgs = messages.filter(m => m.role === 'user');
    if (userMsgs.length < 2) return;

    // Build conversation text (last 20 messages, trimmed)
    const recentText = messages.slice(-20)
      .map(m => `${m.role}: ${m.content.substring(0, 150)}`)
      .join('\n');

    try {
      const response = await this.router.chat({
        instanceId: this.instanceId,
        model: this.summaryModel,
        messages: [
          { role: 'system', content: 'You summarize conversations into 2-3 bullet points (max 200 chars total). Focus on: topics discussed, decisions made, tasks completed. Match the conversation language. Be concise.' },
          { role: 'user', content: `Summarize:\n${recentText}` },
        ],
        options: { maxTokens: 150, temperature: 0 },
      });

      const summary = (response.text || '').trim();
      if (!summary || summary.length < 10) return;

      this._saveSummary(chatName, summary);
      this._summarized.add(chatId);
      this.todayCount++;
      console.log(`[AutoMemory:${this.instanceId}] Saved summary for ${chatName} (${summary.length} chars)`);
    } catch (e) {
      console.error(`[AutoMemory:${this.instanceId}] Summarize failed: ${e.message}`);
    }
  }

  _saveSummary(chatName, summary) {
    const now = new Date(Date.now() + 7 * 3600000); // WIB
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const filePath = join(this.memDir, `${dateStr}.md`);

    const entry = `\n## ${timeStr} — ${chatName}\n${summary}\n`;
    appendFileSync(filePath, entry);
  }

  /** Clear idle timers on shutdown */
  destroy() {
    for (const timer of this._idleTimers.values()) clearTimeout(timer);
    this._idleTimers.clear();
  }

  getStats() {
    return { todayCount: this.todayCount, activeChats: this._idleTimers.size };
  }
}
