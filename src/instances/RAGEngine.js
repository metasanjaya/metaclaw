/**
 * RAGEngine - Per-instance Retrieval-Augmented Generation
 * 
 * Hybrid search: embedding similarity (if available) + keyword fallback.
 * Indexes personality, memory, and knowledge files.
 * Embedding vectors cached to SQLite for fast restarts.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class RAGEngine {
  /**
   * @param {string} instanceDir
   * @param {Object} [opts]
   * @param {import('../ai/EmbeddingManager.js').EmbeddingManager} [opts.embedder]
   */
  constructor(instanceDir, opts = {}) {
    this.dir = instanceDir;
    this.embedder = opts.embedder || null;
    /** @type {Array<{content: string, source: string, tokens: number, hash: string, embedding: Float32Array|null}>} */
    this.chunks = [];
    this.initialized = false;
    this.useEmbeddings = false;

    // Embedding cache path
    this._cachePath = join(instanceDir, '.rag-cache.json');
    /** @type {Map<string, number[]>} hash → embedding array */
    this._embeddingCache = new Map();
  }

  /**
   * Initialize: index files, compute embeddings if available
   */
  async initialize() {
    this._loadCache();
    this._indexFiles();

    // Try to initialize embeddings
    if (this.embedder) {
      try {
        await this.embedder.initialize();
        this.useEmbeddings = true;
        await this._computeEmbeddings();
        console.log(`[RAG] Embedding mode active (${this.embedder.dimensions}d, ${this.chunks.length} chunks)`);
      } catch (e) {
        console.warn(`[RAG] Embedding init failed, using keyword fallback: ${e.message}`);
        this.useEmbeddings = false;
      }
    }

    this.initialized = true;
  }

  /**
   * Sync initialize (keyword-only, no embeddings — backward compat)
   */
  initializeSync() {
    this._loadCache();
    this._indexFiles();
    this.initialized = true;
  }

  // --- Indexing ---

  _indexFiles() {
    this.chunks = [];

    // Personality files (MY_RULES is RAG-eligible, SOUL.md always in prompt)
    const ragFiles = ['MY_RULES.md', 'MEMORY.md'];
    for (const file of ragFiles) {
      const p = join(this.dir, file);
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf-8').trim();
        if (text) this._addChunks(file, text);
      }
    }

    // Memory daily logs (last 14 days)
    const memDir = join(this.dir, 'memory');
    if (existsSync(memDir)) {
      const files = readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 14);
      for (const f of files) {
        const text = readFileSync(join(memDir, f), 'utf-8').trim();
        if (text) this._addChunks(`memory/${f}`, text);
      }
    }

    // Knowledge facts
    const kPath = join(this.dir, 'knowledge', 'facts.json');
    if (existsSync(kPath)) {
      try {
        const facts = JSON.parse(readFileSync(kPath, 'utf-8'));
        for (const f of facts) {
          const content = `[${f.tags?.join(', ')}] ${f.fact}`;
          this.chunks.push({
            content,
            source: 'knowledge',
            tokens: Math.ceil(content.length / 4),
            hash: this._hash(content),
            embedding: null,
          });
        }
      } catch {}
    }
  }

  _addChunks(source, text) {
    const sections = text.split(/(?=^## )/m);
    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed || trimmed.length < 10) continue;

      if (trimmed.length > 600) {
        const lines = trimmed.split('\n');
        let buf = '';
        for (const line of lines) {
          buf += line + '\n';
          if (buf.length > 500) {
            this._pushChunk(source, buf.trim());
            buf = '';
          }
        }
        if (buf.trim()) this._pushChunk(source, buf.trim());
      } else {
        this._pushChunk(source, trimmed);
      }
    }
  }

  _pushChunk(source, content) {
    const hash = this._hash(content);
    const cachedEmb = this._embeddingCache.get(hash);
    this.chunks.push({
      content,
      source,
      tokens: Math.ceil(content.length / 4),
      hash,
      embedding: cachedEmb ? new Float32Array(cachedEmb) : null,
    });
  }

  // --- Embedding computation ---

  async _computeEmbeddings() {
    if (!this.embedder || !this.useEmbeddings) return;

    // Find chunks without embeddings
    const needEmbed = this.chunks.filter(c => !c.embedding);
    if (!needEmbed.length) return;

    console.log(`[RAG] Computing embeddings for ${needEmbed.length}/${this.chunks.length} chunks...`);

    const texts = needEmbed.map(c => c.content);
    const embeddings = await this.embedder.embedBatch(texts);

    for (let i = 0; i < needEmbed.length; i++) {
      needEmbed[i].embedding = embeddings[i];
      this._embeddingCache.set(needEmbed[i].hash, Array.from(embeddings[i]));
    }

    this._saveCache();
    console.log(`[RAG] Embeddings computed and cached`);
  }

  // --- Search ---

  /**
   * Search for relevant chunks
   * @param {string} query
   * @param {number} topK
   * @returns {Promise<Array<{content: string, source: string, score: number}>>}
   */
  async search(query, topK = 5) {
    if (!this.chunks.length) return [];

    // Hybrid search: embedding + keyword, merge results
    if (this.useEmbeddings && this.embedder) {
      return this._hybridSearch(query, topK);
    }

    return this._keywordSearch(query, topK);
  }

  /**
   * Sync keyword-only search (backward compat)
   */
  searchSync(query, topK = 5) {
    return this._keywordSearch(query, topK);
  }

  async _hybridSearch(query, topK) {
    const [embResults, kwResults] = await Promise.all([
      this._embeddingSearch(query, topK),
      Promise.resolve(this._keywordSearch(query, topK)),
    ]);

    // Merge with RRF (Reciprocal Rank Fusion)
    const scores = new Map();
    const k = 60; // RRF constant

    for (let i = 0; i < embResults.length; i++) {
      const key = embResults[i].content;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    }
    for (let i = 0; i < kwResults.length; i++) {
      const key = kwResults[i].content;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    }

    // Build result from merged scores
    const allResults = [...embResults, ...kwResults];
    const seen = new Set();
    const merged = [];
    for (const r of allResults) {
      if (seen.has(r.content)) continue;
      seen.add(r.content);
      merged.push({ content: r.content, source: r.source, score: scores.get(r.content) || 0 });
    }

    return merged.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async _embeddingSearch(query, topK) {
    const results = await this.embedder.findSimilar(query, this.chunks, topK);
    return results.filter(r => r.score > 0.2); // min similarity threshold
  }

  _keywordSearch(query, topK) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return [];

    const scored = this.chunks.map(chunk => {
      const lower = chunk.content.toLowerCase();
      const hits = words.filter(w => lower.includes(w)).length;
      return { content: chunk.content, source: chunk.source, score: hits / words.length };
    });

    return scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // --- Context for prompt ---

  /**
   * Get RAG context for system prompt injection
   * @param {string} query
   * @param {number} maxChars
   * @returns {string|Promise<string>}
   */
  getContextForPrompt(query, maxChars = 2000) {
    if (this.useEmbeddings) {
      return this._getContextAsync(query, maxChars);
    }
    return this._getContextSync(query, maxChars);
  }

  async _getContextAsync(query, maxChars) {
    const results = await this.search(query, 5);
    return this._formatContext(results, maxChars);
  }

  _getContextSync(query, maxChars) {
    const results = this._keywordSearch(query, 5);
    return this._formatContext(results, maxChars);
  }

  _formatContext(results, maxChars) {
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

  // --- Cache management ---

  _loadCache() {
    try {
      if (existsSync(this._cachePath)) {
        const data = JSON.parse(readFileSync(this._cachePath, 'utf-8'));
        for (const [hash, emb] of Object.entries(data)) {
          this._embeddingCache.set(hash, emb);
        }
        console.log(`[RAG] Loaded ${this._embeddingCache.size} cached embeddings`);
      }
    } catch {}
  }

  _saveCache() {
    try {
      const obj = Object.fromEntries(this._embeddingCache);
      writeFileSync(this._cachePath, JSON.stringify(obj));
    } catch (e) {
      console.warn(`[RAG] Cache save failed: ${e.message}`);
    }
  }

  /** Simple hash for content dedup */
  _hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  // --- Reindex ---

  async reindex() {
    this._indexFiles();
    if (this.useEmbeddings) {
      await this._computeEmbeddings();
    }
  }

  /** Sync reindex (keyword only) */
  reindexSync() {
    this._indexFiles();
  }

  // --- Stats ---

  getStats() {
    const withEmb = this.chunks.filter(c => c.embedding).length;
    return {
      totalChunks: this.chunks.length,
      embeddedChunks: withEmb,
      cachedEmbeddings: this._embeddingCache.size,
      useEmbeddings: this.useEmbeddings,
      dimensions: this.embedder?.dimensions || null,
      provider: this.embedder ? (this.useEmbeddings ? this.embedder.provider : 'fallback-keyword') : 'keyword-only',
    };
  }
}
