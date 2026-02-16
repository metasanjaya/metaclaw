/**
 * StatsTracker — Token & cost tracking for MetaClaw
 * v2: Tracks input/output tokens separately + auto cost calculation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');

// Pricing per 1M tokens (USD)
const PRICING = {
  // Anthropic
  'claude-sonnet-4-5':       { input: 3,     output: 15 },
  'claude-sonnet-4-20250514':{ input: 3,     output: 15 },
  'claude-opus-4-6':         { input: 15,    output: 75 },
  'claude-opus-4':           { input: 15,    output: 75 },
  'claude-haiku-3-5':        { input: 0.80,  output: 4 },
  // Google
  'gemini-2.5-flash':        { input: 0.15,  output: 0.60 },
  'gemini-2.5-pro':          { input: 1.25,  output: 10 },
  'gemini-2.0-flash':        { input: 0.075, output: 0.30 },
  // OpenAI
  'gpt-4o':                  { input: 2.50,  output: 10 },
  'gpt-4o-mini':             { input: 0.15,  output: 0.60 },
  'gpt-4':                   { input: 30,    output: 60 },
  'o4-mini':                 { input: 1.10,  output: 4.40 },
};

// Default fallback pricing
const DEFAULT_PRICING = { input: 3, output: 15 };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function statsPath(date) {
  return path.join(DATA_DIR, `stats-${date}.json`);
}

function emptyDay(date) {
  return {
    date,
    version: 2,
    totalMessages: 0,
    totalTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    users: {},
    hourly: {},
    models: {}
  };
}

function calcCost(model, inputTokens, outputTokens) {
  // Try exact match, then partial match
  let pricing = PRICING[model];
  if (!pricing) {
    const key = Object.keys(PRICING).find(k => model.includes(k));
    pricing = key ? PRICING[key] : DEFAULT_PRICING;
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export class StatsTracker {
  constructor() {
    this._saveTimer = null;
    this._dirty = false;
    this.data = this._load(todayStr());
    console.log(`📊 StatsTracker v2 loaded (${this.data.totalMessages} msgs, $${this.data.totalCost?.toFixed(4) || '0'} today)`);
  }

  _load(date) {
    const p = statsPath(date);
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        // Migrate v1 data
        if (!data.version || data.version < 2) {
          data.version = 2;
          data.totalInputTokens = data.totalInputTokens || 0;
          data.totalOutputTokens = data.totalOutputTokens || 0;
          data.totalCost = data.totalCost || 0;
          for (const m of Object.values(data.models || {})) {
            m.inputTokens = m.inputTokens || 0;
            m.outputTokens = m.outputTokens || 0;
            m.cost = m.cost || 0;
          }
          for (const u of Object.values(data.users || {})) {
            u.inputTokens = u.inputTokens || 0;
            u.outputTokens = u.outputTokens || 0;
            u.cost = u.cost || 0;
          }
        }
        return data;
      }
    } catch (e) {
      console.error('⚠️ Stats load error:', e.message);
    }
    return emptyDay(date);
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._dirty = false;
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(statsPath(this.data.date), JSON.stringify(this.data, null, 2));
      } catch (e) {
        console.error('⚠️ Stats save error:', e.message);
      }
    }, 5000);
  }

  _ensureToday() {
    const today = todayStr();
    if (this.data.date !== today) {
      if (this._dirty) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
          if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(statsPath(this.data.date), JSON.stringify(this.data, null, 2));
        } catch {}
      }
      this.data = this._load(today);
    }
  }

  /**
   * Record a message with token breakdown
   * @param {string|number} userId
   * @param {string} userName
   * @param {number} tokensUsed - Total tokens (backward compat)
   * @param {string} model - Model name (e.g. 'claude-sonnet-4-5')
   * @param {number} inputTokens - Input/prompt tokens (optional, new in v2)
   * @param {number} outputTokens - Output/completion tokens (optional, new in v2)
   */
  record(userId, userName, tokensUsed, model, inputTokens = 0, outputTokens = 0) {
    this._ensureToday();
    const d = this.data;
    const tokens = tokensUsed || 0;
    const inTok = inputTokens || 0;
    const outTok = outputTokens || 0;
    const hour = String(new Date().getHours());

    // Strip provider prefix for pricing lookup (e.g. "anthropic:claude-sonnet-4-5" → "claude-sonnet-4-5")
    const modelClean = (model || 'unknown').replace(/^[^:]+:/, '');
    const cost = calcCost(modelClean, inTok, outTok);

    d.totalMessages++;
    d.totalTokens += tokens;
    d.totalInputTokens += inTok;
    d.totalOutputTokens += outTok;
    d.totalCost += cost;

    // User
    const uid = String(userId);
    if (!d.users[uid]) d.users[uid] = { name: userName || 'Unknown', messages: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    d.users[uid].name = userName || d.users[uid].name;
    d.users[uid].messages++;
    d.users[uid].tokens += tokens;
    d.users[uid].inputTokens += inTok;
    d.users[uid].outputTokens += outTok;
    d.users[uid].cost += cost;

    // Hourly
    if (!d.hourly[hour]) d.hourly[hour] = { messages: 0, tokens: 0 };
    d.hourly[hour].messages++;
    d.hourly[hour].tokens += tokens;

    // Model
    const m = model || 'unknown';
    if (!d.models[m]) d.models[m] = { messages: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    d.models[m].messages++;
    d.models[m].tokens += tokens;
    d.models[m].inputTokens += inTok;
    d.models[m].outputTokens += outTok;
    d.models[m].cost += cost;

    this._scheduleSave();
  }

  getTodayData() {
    this._ensureToday();
    return this.data;
  }

  getCostToday() {
    this._ensureToday();
    return this.data.totalCost || 0;
  }

  getCostByModel() {
    this._ensureToday();
    const result = {};
    for (const [model, data] of Object.entries(this.data.models || {})) {
      result[model] = { cost: data.cost || 0, inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0 };
    }
    return result;
  }

  reset() {
    this.data = emptyDay(todayStr());
    this._scheduleSave();
    return '🗑️ Stats reset for today.';
  }

  getStats() {
    this._ensureToday();
    const d = this.data;

    if (d.totalMessages === 0) return `📊 MetaClaw Stats — ${d.date}\n\nNo messages recorded yet today.`;

    const fmt = (n) => n.toLocaleString('en-US');
    const avg = Math.round(d.totalTokens / d.totalMessages);

    // Model breakdown with cost
    const modelLines = Object.entries(d.models)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([m, v]) => `  ${m}: ${v.messages} msgs, ${fmt(v.tokens)} tok ($${(v.cost || 0).toFixed(4)})`)
      .join('\n');

    // Users
    const userLines = Object.values(d.users)
      .sort((a, b) => b.messages - a.messages)
      .map(u => `  ${u.name}: ${u.messages} msgs (${fmt(u.tokens)} tok, $${(u.cost || 0).toFixed(4)})`)
      .join('\n');

    // Peak hour
    const peak = Object.entries(d.hourly).sort((a, b) => b[1].messages - a[1].messages)[0];
    const peakStr = peak ? `${peak[0].padStart(2, '0')}:00 (${peak[1].messages} msgs)` : 'N/A';

    return [
      `📊 MetaClaw Stats — ${d.date}`,
      '',
      `💬 Messages: ${fmt(d.totalMessages)}`,
      `🧮 Tokens: ${fmt(d.totalTokens)} (in: ${fmt(d.totalInputTokens || 0)}, out: ${fmt(d.totalOutputTokens || 0)})`,
      `💰 Cost: $${(d.totalCost || 0).toFixed(4)}`,
      `📈 Avg: ${fmt(avg)} tokens/msg`,
      '',
      `🤖 Models:`,
      modelLines,
      '',
      `👤 Users:`,
      userLines,
      '',
      `⏰ Peak hour: ${peakStr}`,
    ].join('\n');
  }

  /** Get pricing table (for Mission Control) */
  static getPricing() {
    return { ...PRICING };
  }
}
