/**
 * StatsTracker — Per-instance token & cost tracking
 * 
 * Persists daily stats to SQLite (via ChatStore's db).
 * Tracks: messages, input/output tokens, cost per model, per user, hourly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Pricing per 1M tokens (USD) — updated 2026-02
const PRICING = {
  // Anthropic
  'claude-sonnet-4-6':       { input: 3,     output: 15 },
  'claude-sonnet-4-5':       { input: 3,     output: 15 },
  'claude-opus-4-6':         { input: 15,    output: 75 },
  'claude-opus-4':           { input: 15,    output: 75 },
  'claude-haiku-3-5':        { input: 0.80,  output: 4 },
  // Google
  'gemini-2.5-flash':        { input: 0.15,  output: 0.60 },
  'gemini-2.5-pro':          { input: 1.25,  output: 10 },
  'gemini-3':                { input: 0.15,  output: 0.60 },
  // OpenAI
  'gpt-4o':                  { input: 2.50,  output: 10 },
  'gpt-4o-mini':             { input: 0.15,  output: 0.60 },
  'o4-mini':                 { input: 1.10,  output: 4.40 },
  // Kimi
  'kimi-k2.5':               { input: 0.50,  output: 2.00 },
  // MiniMax
  'MiniMax-M2.5':            { input: 0.50,  output: 2.00 },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function calcCost(model, inputTokens, outputTokens) {
  const clean = (model || 'unknown').replace(/^[^/]+\//, '');
  let pricing = PRICING[clean];
  if (!pricing) {
    const key = Object.keys(PRICING).find(k => clean.includes(k));
    pricing = key ? PRICING[key] : DEFAULT_PRICING;
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function emptyDay(date) {
  return {
    date,
    totalMessages: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    users: {},
    hourly: {},
    models: {},
  };
}

export class StatsTracker {
  /**
   * @param {string} instanceDir — instance data directory
   * @param {Object} [opts]
   * @param {import('./ChatStore.js').ChatStore} [opts.chatStore] — for DB-backed persistence
   */
  constructor(instanceDir, opts = {}) {
    this.dir = instanceDir;
    this.statsDir = join(instanceDir, 'stats');
    this.chatStore = opts.chatStore || null;
    this._saveTimer = null;
    this._dirty = false;

    if (!existsSync(this.statsDir)) mkdirSync(this.statsDir, { recursive: true });

    this.data = this._load(todayStr());
  }

  // ========== Recording ==========

  /**
   * Record a message interaction
   * @param {Object} opts
   * @param {string} opts.model
   * @param {number} opts.inputTokens
   * @param {number} opts.outputTokens
   * @param {string} [opts.userId]
   * @param {string} [opts.userName]
   * @param {string} [opts.chatId]
   */
  record({ model, inputTokens = 0, outputTokens = 0, userId, userName, chatId }) {
    this._ensureToday();
    const d = this.data;
    const inTok = inputTokens || 0;
    const outTok = outputTokens || 0;
    const hour = String(new Date().getHours());
    const cost = calcCost(model, inTok, outTok);

    d.totalMessages++;
    d.totalInputTokens += inTok;
    d.totalOutputTokens += outTok;
    d.totalCost += cost;

    // Per model
    const m = model || 'unknown';
    if (!d.models[m]) d.models[m] = { messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    d.models[m].messages++;
    d.models[m].inputTokens += inTok;
    d.models[m].outputTokens += outTok;
    d.models[m].cost += cost;

    // Per user
    if (userId) {
      const uid = String(userId);
      if (!d.users[uid]) d.users[uid] = { name: userName || uid, messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      if (userName) d.users[uid].name = userName;
      d.users[uid].messages++;
      d.users[uid].inputTokens += inTok;
      d.users[uid].outputTokens += outTok;
      d.users[uid].cost += cost;
    }

    // Hourly
    if (!d.hourly[hour]) d.hourly[hour] = { messages: 0, tokens: 0 };
    d.hourly[hour].messages++;
    d.hourly[hour].tokens += inTok + outTok;

    this._scheduleSave();
  }

  // ========== Queries ==========

  getCostToday() {
    this._ensureToday();
    return this.data.totalCost || 0;
  }

  getCostByModel() {
    this._ensureToday();
    const result = {};
    for (const [model, data] of Object.entries(this.data.models || {})) {
      result[model] = { cost: data.cost, inputTokens: data.inputTokens, outputTokens: data.outputTokens, messages: data.messages };
    }
    return result;
  }

  getTodayData() {
    this._ensureToday();
    return { ...this.data };
  }

  /**
   * Get multi-day data for charts
   * @param {number} days
   * @returns {Array<{date: string, messages: number, inputTokens: number, outputTokens: number, cost: number}>}
   */
  getHistory(days = 7) {
    const result = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const data = dateStr === this.data.date ? this.data : this._load(dateStr);
      result.push({
        date: dateStr,
        messages: data.totalMessages,
        inputTokens: data.totalInputTokens,
        outputTokens: data.totalOutputTokens,
        cost: data.totalCost,
      });
    }
    return result;
  }

  /** Formatted stats string */
  getFormattedStats() {
    this._ensureToday();
    const d = this.data;
    if (!d.totalMessages) return `📊 No activity today (${d.date})`;

    const fmt = n => n.toLocaleString('en-US');
    const totalTok = d.totalInputTokens + d.totalOutputTokens;

    const modelLines = Object.entries(d.models)
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([m, v]) => `  ${m}: ${v.messages} msgs, ${fmt(v.inputTokens + v.outputTokens)} tok ($${v.cost.toFixed(4)})`)
      .join('\n');

    const peak = Object.entries(d.hourly).sort((a, b) => b[1].messages - a[1].messages)[0];

    return [
      `📊 Stats — ${d.date}`,
      `💬 ${fmt(d.totalMessages)} messages`,
      `🧮 ${fmt(totalTok)} tokens (in: ${fmt(d.totalInputTokens)}, out: ${fmt(d.totalOutputTokens)})`,
      `💰 $${d.totalCost.toFixed(4)}`,
      `🤖 Models:\n${modelLines}`,
      peak ? `⏰ Peak: ${peak[0].padStart(2, '0')}:00 (${peak[1].messages} msgs)` : '',
    ].filter(Boolean).join('\n');
  }

  // ========== Persistence ==========

  _load(date) {
    const p = join(this.statsDir, `${date}.json`);
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {}
    return emptyDay(date);
  }

  _ensureToday() {
    const today = todayStr();
    if (this.data.date !== today) {
      this._saveNow();
      this.data = this._load(today);
    }
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 5000);
  }

  _saveNow() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      writeFileSync(join(this.statsDir, `${this.data.date}.json`), JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn(`[StatsTracker] Save error: ${e.message}`);
    }
  }

  /** Flush on shutdown */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._saveNow();
  }

  /** Pricing table (for UI) */
  static getPricing() { return { ...PRICING }; }
}
