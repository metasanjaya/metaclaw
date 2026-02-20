/**
 * KnowledgeManager — Per-instance dynamic fact storage
 * Ported from v2 gramjs/KnowledgeManager.js
 * 
 * AI saves facts via tool calls. Relevant facts injected per query via keyword matching.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class KnowledgeManager {
  /**
   * @param {string} instanceDir
   */
  constructor(instanceDir) {
    this.dataPath = join(instanceDir, 'knowledge', 'facts.json');
    this.maxInject = 8;
    this.facts = this._load();
  }

  _load() {
    try {
      if (existsSync(this.dataPath)) return JSON.parse(readFileSync(this.dataPath, 'utf-8'));
    } catch {}
    return [];
  }

  _save() {
    const dir = join(this.dataPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.dataPath, JSON.stringify(this.facts, null, 2));
  }

  add(spec) {
    if (!spec.tags || !spec.fact) return null;
    const id = spec.id || spec.tags.slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const idx = this.facts.findIndex(f => f.id === id);
    const entry = { id, tags: spec.tags, fact: spec.fact, updated: new Date().toISOString() };
    if (idx >= 0) this.facts[idx] = entry;
    else this.facts.push(entry);
    this._save();
    return entry;
  }

  remove(id) {
    const before = this.facts.length;
    this.facts = this.facts.filter(f => f.id !== id);
    if (this.facts.length !== before) { this._save(); return true; }
    return false;
  }

  /** Find relevant facts by keywords in the message */
  search(query, limit) {
    limit = limit || this.maxInject;
    const words = query.toLowerCase().split(/\s+/);
    const scored = this.facts.map(f => {
      const tagStr = f.tags.join(' ').toLowerCase();
      const factStr = f.fact.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (w.length < 2) continue;
        if (tagStr.includes(w)) score += 3;
        if (factStr.includes(w)) score += 1;
      }
      return { ...f, score };
    }).filter(f => f.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Format facts for system prompt injection */
  getContextForQuery(query, maxFacts) {
    const relevant = this.search(query, maxFacts);
    if (relevant.length === 0) return '';
    return '## Relevant Knowledge\n' + relevant.map(f => `- [${f.tags.join(', ')}] ${f.fact}`).join('\n') + '\n';
  }

  /** List all facts for API */
  list() { return this.facts; }
  count() { return this.facts.length; }
}
