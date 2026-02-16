/**
 * KnowledgeManager — Dynamic context injection
 * 
 * AI saves facts via [KNOW: {...}] tags. Before each prompt,
 * relevant facts are injected based on keyword matching.
 * 
 * Format: [KNOW: {"tags":["server","proxy"], "fact":"Server proxy di PROXY_SERVER_IP"}]
 * Delete: [KNOW: {"delete":"server-proxy-PROJECT_GAMING"}]
 * Update: [KNOW: {"id":"server-proxy-PROJECT_GAMING", "tags":[...], "fact":"..."}]
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const DATA_FILE = path.resolve('data/knowledge.json');
const DEFAULT_MAX = 8;

export class KnowledgeManager {
  constructor() {
    this.facts = this._load();
    this.maxInject = this._loadMaxFacts();
  }

  _loadMaxFacts() {
    try {
      const cfg = yaml.load(fs.readFileSync(path.resolve('config.yaml'), 'utf-8'));
      return cfg?.knowledge?.max_facts || DEFAULT_MAX;
    } catch { return DEFAULT_MAX; }
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      }
    } catch (e) {
      console.warn('⚠️ KnowledgeManager load error:', e.message);
    }
    return [];
  }

  _save() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.facts, null, 2));
  }

  /**
   * Add or update a fact
   * @param {Object} spec - {id?, tags:[], fact:"..."}
   */
  add(spec) {
    if (!spec.tags || !spec.fact) return null;
    
    // Auto-generate ID from tags if not provided
    const id = spec.id || spec.tags.slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
    
    // Update existing or add new
    const idx = this.facts.findIndex(f => f.id === id);
    const entry = {
      id,
      tags: spec.tags.map(t => t.toLowerCase()),
      fact: spec.fact,
      updated: new Date().toISOString(),
    };

    if (idx >= 0) {
      this.facts[idx] = entry;
      console.log(`  🧠 Knowledge updated: [${id}] ${spec.fact.substring(0, 60)}`);
    } else {
      this.facts.push(entry);
      console.log(`  🧠 Knowledge added: [${id}] ${spec.fact.substring(0, 60)}`);
    }

    this._save();
    return id;
  }

  /**
   * Delete a fact by ID
   */
  delete(id) {
    const before = this.facts.length;
    this.facts = this.facts.filter(f => f.id !== id);
    if (this.facts.length < before) {
      this._save();
      console.log(`  🧠 Knowledge deleted: [${id}]`);
      return true;
    }
    return false;
  }

  /**
   * Find relevant facts based on message text
   * Uses keyword matching against tags
   * @param {string} text - user message or recent context
   * @returns {Array} matching facts, scored and limited
   */
  findRelevant(text) {
    if (!text || this.facts.length === 0) return [];

    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s\/\.\-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const scored = this.facts.map(f => {
      let score = 0;
      for (const tag of f.tags) {
        // Exact word match
        if (words.includes(tag)) {
          score += 3;
        }
        // Partial match (tag contained in any word or vice versa)
        else if (words.some(w => w.includes(tag) || tag.includes(w))) {
          score += 1;
        }
      }
      return { ...f, score };
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, this.maxInject);

    return scored;
  }

  /**
   * Build context string for prompt injection
   */
  buildContext(text) {
    const relevant = this.findRelevant(text);
    if (relevant.length === 0) return '';

    let ctx = '\n\n## Knowledge Base (auto-loaded)\n';
    for (const f of relevant) {
      ctx += `- ${f.fact}\n`;
    }
    return ctx;
  }

  /**
   * Process [KNOW: {...}] tags from AI response
   * @returns {string} cleaned response text
   */
  processResponse(responseText) {
    const knowRegex = /\[KNOW:\s*(\{[\s\S]*?\})\s*\]/gi;
    let match;
    
    while ((match = knowRegex.exec(responseText)) !== null) {
      try {
        const spec = JSON.parse(match[1]);
        if (spec.delete) {
          this.delete(spec.delete);
        } else {
          this.add(spec);
        }
      } catch (e) {
        console.warn(`  ⚠️ Invalid KNOW JSON: ${e.message}`);
      }
    }

    return responseText.replace(/\s*\[KNOW:\s*\{[\s\S]*?\}\s*\]/gi, '').trim();
  }

  get count() {
    return this.facts.length;
  }
}
