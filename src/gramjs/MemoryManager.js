/**
 * MemoryManager - Manages daily logs and long-term memory
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONALITY_DIR = path.join(__dirname, '../../personality');
const MEMORY_DIR = path.join(PERSONALITY_DIR, 'memory');
const LONG_TERM_PATH = path.join(PERSONALITY_DIR, 'MEMORY.md');

export class MemoryManager {
  constructor() {
    this.dailyLogs = new Map(); // date -> content
    this.longTermMemory = '';
  }

  async initialize() {
    // Ensure memory directory exists
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }

    // Load long-term memory
    if (fs.existsSync(LONG_TERM_PATH)) {
      this.longTermMemory = fs.readFileSync(LONG_TERM_PATH, 'utf-8');
    }

    // Load recent daily logs
    this._loadRecentLogs(7);
    console.log(`🧠 MemoryManager initialized (${this.dailyLogs.size} daily logs loaded)`);
  }

  _todayKey() {
    const now = new Date();
    return now.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  _timeStamp() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  _dailyLogPath(dateKey) {
    return path.join(MEMORY_DIR, `${dateKey}.md`);
  }

  _loadRecentLogs(days) {
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const p = this._dailyLogPath(key);
      if (fs.existsSync(p)) {
        this.dailyLogs.set(key, fs.readFileSync(p, 'utf-8'));
      }
    }
  }

  addMemory(text, category = null) {
    const key = this._todayKey();
    const p = this._dailyLogPath(key);
    const entry = `## ${this._timeStamp()}${category ? ` [${category}]` : ''}\n- ${text}\n\n`;

    fs.appendFileSync(p, entry);
    // Update cache
    this.dailyLogs.set(key, (this.dailyLogs.get(key) || '') + entry);
    return entry;
  }

  getRecentMemories(days = 3) {
    const results = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const content = this.dailyLogs.get(key);
      if (content) {
        results.push({ date: key, content });
      } else {
        const p = this._dailyLogPath(key);
        if (fs.existsSync(p)) {
          const c = fs.readFileSync(p, 'utf-8');
          this.dailyLogs.set(key, c);
          results.push({ date: key, content: c });
        }
      }
    }
    return results;
  }

  updateLongTermMemory(text) {
    this.longTermMemory += `\n${text}\n`;
    fs.writeFileSync(LONG_TERM_PATH, this.longTermMemory);
  }

  clearTodayLog() {
    const key = this._todayKey();
    const p = this._dailyLogPath(key);
    if (fs.existsSync(p)) {
      fs.writeFileSync(p, '');
    }
    this.dailyLogs.set(key, '');
  }

  getAllMemoryText() {
    let text = this.longTermMemory + '\n\n';
    for (const [date, content] of this.dailyLogs) {
      text += `# ${date}\n${content}\n\n`;
    }
    return text;
  }

  /** Get all memory file paths for RAG indexing */
  getAllMemoryFiles() {
    const files = [];
    if (fs.existsSync(LONG_TERM_PATH)) {
      files.push({ name: 'MEMORY.md', path: LONG_TERM_PATH });
    }
    if (fs.existsSync(MEMORY_DIR)) {
      for (const f of fs.readdirSync(MEMORY_DIR)) {
        if (f.endsWith('.md')) {
          files.push({ name: `memory/${f}`, path: path.join(MEMORY_DIR, f) });
        }
      }
    }
    return files;
  }
}
