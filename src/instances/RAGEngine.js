/**
 * RAGEngine - Per-instance Retrieval-Augmented Generation
 * Indexes personality + memory files, searches relevant chunks per query.
 * Uses keyword fallback by default (0 tokens). Embedding support optional.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class RAGEngine {
  /**
   * @param {string} instanceDir
   */
  constructor(instanceDir) {
    this.dir = instanceDir;
    this.chunks = [];
    this.initialized = false;
  }

  initialize() {
    this.chunks = [];
    this._indexFiles();
    this.initialized = true;
  }

  _indexFiles() {
    // Index personality files (RAG-eligible — NOT SOUL.md which is always in prompt)
    const ragFiles = ['MY_RULES.md', 'MEMORY.md'];
    for (const file of ragFiles) {
      const p = join(this.dir, file);
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf-8').trim();
        if (text) this._addChunks(file, text);
      }
    }

    // Index memory daily logs
    const memDir = join(this.dir, 'memory');
    if (existsSync(memDir)) {
      const files = readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 14); // Last 14 days
      for (const f of files) {
        const text = readFileSync(join(memDir, f), 'utf-8').trim();
        if (text) this._addChunks(`memory/${f}`, text);
      }
    }

    // Index knowledge facts
    const kPath = join(this.dir, 'knowledge', 'facts.json');
    if (existsSync(kPath)) {
      try {
        const facts = JSON.parse(readFileSync(kPath, 'utf-8'));
        for (const f of facts) {
          this.chunks.push({
            content: `[${f.tags?.join(', ')}] ${f.fact}`,
            source: 'knowledge',
            tokens: Math.ceil(f.fact.length / 4),
          });
        }
      } catch {}
    }
  }

  _addChunks(source, text) {
    // Split by ## headers or every ~500 chars
    const sections = text.split(/(?=^## )/m);
    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed || trimmed.length < 10) continue;
      // Further split large sections
      if (trimmed.length > 600) {
        const lines = trimmed.split('\n');
        let buf = '';
        for (const line of lines) {
          buf += line + '\n';
          if (buf.length > 500) {
            this.chunks.push({ content: buf.trim(), source, tokens: Math.ceil(buf.length / 4) });
            buf = '';
          }
        }
        if (buf.trim()) this.chunks.push({ content: buf.trim(), source, tokens: Math.ceil(buf.length / 4) });
      } else {
        this.chunks.push({ content: trimmed, source, tokens: Math.ceil(trimmed.length / 4) });
      }
    }
  }

  /**
   * Search for relevant chunks given a query
   * @param {string} query
   * @param {number} topK
   * @returns {Array<{content: string, source: string, score: number}>}
   */
  search(query, topK = 3) {
    if (!this.chunks.length) return [];
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return [];

    const scored = this.chunks.map(chunk => {
      const lower = chunk.content.toLowerCase();
      const hits = words.filter(w => lower.includes(w)).length;
      return { content: chunk.content, source: chunk.source, score: hits / words.length };
    });

    return scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Get RAG context for system prompt injection
   * @param {string} query — user message
   * @param {number} maxChars — max chars to inject
   * @returns {string}
   */
  getContextForPrompt(query, maxChars = 2000) {
    const results = this.search(query, 5);
    if (!results.length) return '';
    let ctx = '## Retrieved Context (RAG)\n';
    let chars = ctx.length;
    for (const r of results) {
      if (chars + r.content.length > maxChars) break;
      ctx += `[${r.source}] ${r.content}\n\n`;
      chars += r.content.length + r.source.length + 5;
    }
    return ctx;
  }

  /** Re-index all files (call after memory/knowledge changes) */
  reindex() {
    this.chunks = [];
    this._indexFiles();
  }
}
