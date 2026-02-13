/**
 * StatsTracker — Lightweight daily stats tracking for MetaClaw
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function statsPath(date) {
  return path.join(DATA_DIR, `stats-${date}.json`);
}

function emptyDay(date) {
  return { date, totalMessages: 0, totalTokens: 0, users: {}, hourly: {}, models: {} };
}

export class StatsTracker {
  constructor() {
    this._saveTimer = null;
    this._dirty = false;
    this.data = this._load(todayStr());
    console.log(`📊 StatsTracker loaded (${this.data.totalMessages} msgs today)`);
  }

  _load(date) {
    const p = statsPath(date);
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
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
      // Day rolled over — save old, start fresh
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

  record(userId, userName, tokensUsed, model) {
    this._ensureToday();
    const d = this.data;
    const tokens = tokensUsed || 0;
    const hour = String(new Date().getHours());

    d.totalMessages++;
    d.totalTokens += tokens;

    // User
    const uid = String(userId);
    if (!d.users[uid]) d.users[uid] = { name: userName || 'Unknown', messages: 0, tokens: 0 };
    d.users[uid].name = userName || d.users[uid].name;
    d.users[uid].messages++;
    d.users[uid].tokens += tokens;

    // Hourly
    if (!d.hourly[hour]) d.hourly[hour] = { messages: 0, tokens: 0 };
    d.hourly[hour].messages++;
    d.hourly[hour].tokens += tokens;

    // Model
    const m = model || 'unknown';
    if (!d.models[m]) d.models[m] = { messages: 0, tokens: 0 };
    d.models[m].messages++;
    d.models[m].tokens += tokens;

    this._scheduleSave();
  }

  getTodayData() {
    this._ensureToday();
    return this.data;
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

    // Top model
    const topModel = Object.entries(d.models).sort((a, b) => b[1].messages - a[1].messages)[0]?.[0] || '?';

    // Users
    const userLines = Object.values(d.users)
      .sort((a, b) => b.messages - a.messages)
      .map(u => `  ${u.name}: ${u.messages} msgs (${fmt(u.tokens)} tokens)`)
      .join('\n');

    // Peak hour
    const peak = Object.entries(d.hourly).sort((a, b) => b[1].messages - a[1].messages)[0];
    const peakStr = peak ? `${peak[0].padStart(2, '0')}:00 (${peak[1].messages} msgs)` : 'N/A';

    return [
      `📊 MetaClaw Stats — ${d.date}`,
      '',
      `💬 Messages: ${fmt(d.totalMessages)}`,
      `🧮 Tokens: ${fmt(d.totalTokens)}`,
      `📈 Avg: ${fmt(avg)} tokens/msg`,
      `🤖 Model: ${topModel}`,
      '',
      `👤 Users:`,
      userLines,
      '',
      `⏰ Peak hour: ${peakStr}`,
    ].join('\n');
  }
}
