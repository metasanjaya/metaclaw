/**
 * MemoryManager - Per-instance daily logs + long-term memory
 * Ported from v2 gramjs/MemoryManager.js, adapted for per-instance dirs.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class MemoryManager {
  /**
   * @param {string} instanceDir — e.g. ~/.metaclaw/instances/nayla/
   */
  constructor(instanceDir) {
    this.dir = instanceDir;
    this.memoryDir = join(instanceDir, 'memory');
    this.longTermPath = join(instanceDir, 'MEMORY.md');
    this.dailyLogs = new Map();
    this.longTermMemory = '';
  }

  initialize() {
    mkdirSync(this.memoryDir, { recursive: true });
    if (existsSync(this.longTermPath)) {
      this.longTermMemory = readFileSync(this.longTermPath, 'utf-8');
    }
    this._loadRecentLogs(7);
  }

  _todayKey() { return new Date().toISOString().split('T')[0]; }
  _timeStamp() { const n = new Date(); return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`; }
  _dailyLogPath(dateKey) { return join(this.memoryDir, `${dateKey}.md`); }

  _loadRecentLogs(days) {
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const p = this._dailyLogPath(key);
      if (existsSync(p)) this.dailyLogs.set(key, readFileSync(p, 'utf-8'));
    }
  }

  addMemory(text, category = null) {
    const key = this._todayKey();
    const p = this._dailyLogPath(key);
    const entry = `## ${this._timeStamp()}${category ? ` [${category}]` : ''}\n- ${text}\n\n`;
    appendFileSync(p, entry);
    this.dailyLogs.set(key, (this.dailyLogs.get(key) || '') + entry);
    return entry;
  }

  getRecentMemories(days = 3) {
    const results = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      let content = this.dailyLogs.get(key);
      if (!content) {
        const p = this._dailyLogPath(key);
        if (existsSync(p)) { content = readFileSync(p, 'utf-8'); this.dailyLogs.set(key, content); }
      }
      if (content) results.push({ date: key, content });
    }
    return results;
  }

  updateLongTermMemory(text) {
    this.longTermMemory += `\n${text}\n`;
    writeFileSync(this.longTermPath, this.longTermMemory);
  }

  getLongTermMemory() { return this.longTermMemory; }

  /** Get truncated context for system prompt (token-efficient) */
  getContextForPrompt(maxChars = 4000) {
    let ctx = '';
    // Long-term memory (truncated)
    if (this.longTermMemory) {
      ctx += '## Long-Term Memory\n' + this.longTermMemory.slice(0, maxChars / 2) + '\n\n';
    }
    // Recent daily logs (last 2 days)
    const recent = this.getRecentMemories(2);
    for (const { date, content } of recent) {
      const remaining = maxChars - ctx.length;
      if (remaining < 200) break;
      ctx += `## ${date}\n${content.slice(0, remaining)}\n\n`;
    }
    return ctx;
  }

  /** List all memory files for API/UI */
  listFiles() {
    const files = [];
    if (existsSync(this.longTermPath)) files.push({ name: 'MEMORY.md', size: readFileSync(this.longTermPath).length });
    if (existsSync(this.memoryDir)) {
      for (const f of readdirSync(this.memoryDir).sort().reverse()) {
        if (f.endsWith('.md')) {
          files.push({ name: `memory/${f}`, size: readFileSync(join(this.memoryDir, f)).length });
        }
      }
    }
    return files;
  }
}
