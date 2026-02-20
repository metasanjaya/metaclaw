/**
 * RAGEngine — Per-instance Retrieval-Augmented Generation
 * 
 * Storage: LanceDB (embedded vector database, IVF-PQ indexed)
 * Search: Hybrid (vector similarity + keyword RRF fusion)
 * Fallback: Keyword-only if embeddings unavailable
 * 
 * Each instance gets its own LanceDB at <instanceDir>/lancedb/
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TABLE_NAME = 'rag_chunks';

export class RAGEngine {
  /**
   * @param {string} instanceDir
   * @param {Object} [opts]
   * @param {import('../ai/EmbeddingManager.js').EmbeddingManager} [opts.embedder]
   */
  constructor(instanceDir, opts = {}) {
    this.dir = instanceDir;
    this.embedder = opts.embedder || null;
    this.useEmbeddings = false;

    // LanceDB
    this._dbPath = join(instanceDir, 'lancedb');
    /** @type {any} */ this._db = null;
    /** @type {any} */ this._table = null;
    this._lanceReady = false;

    // In-memory chunks (always maintained for keyword fallback)
    /** @type {Array<{content: string, source: string, tokens: number, hash: string}>} */
    this.chunks = [];
    this.initialized = false;
  }

  /**
   * Initialize: index files, setup LanceDB, compute embeddings
   */
  async initialize() {
    this._indexFiles();

    // Try LanceDB + embeddings
    if (this.embedder) {
      try {
        await this.embedder.initialize();
        await this._initLanceDB();
        await this._syncToLance();
        this.useEmbeddings = true;
        console.log(`[RAG] LanceDB ready (${this.embedder.dimensions}d, ${this.chunks.length} chunks)`);
      } catch (e) {
        console.warn(`[RAG] LanceDB/embedding init failed, keyword fallback: ${e.message}`);
        this.useEmbeddings = false;
      }
    }

    this.initialized = true;
  }

  /** Sync-only init (keyword fallback, no embeddings) */
  initializeSync() {
    this._indexFiles();
    this.initialized = true;
  }

  // ========== LanceDB Setup ==========

  async _initLanceDB() {
    const lancedb = await import('@lancedb/lancedb');
    this._db = await lancedb.connect(this._dbPath);
    const tables = await this._db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this._table = await this._db.openTable(TABLE_NAME);
    }
    // Table created in _syncToLance if needed

    this._lanceReady = true;
  }

  /**
   * Sync in-memory chunks to LanceDB. 
   * Only embeds chunks that are new/changed (by hash).
   */
  async _syncToLance() {
    if (!this._db || !this.embedder) return;
    if (!this.chunks.length) return;

    // Get existing hashes from LanceDB
    const existingHashes = new Set();
    if (this._table) {
      try {
        const rows = await this._table.query().select(['hash']).toArray();
        for (const r of rows) existingHashes.add(r.hash);
      } catch {}
    }

    // Find new chunks
    const newChunks = this.chunks.filter(c => !existingHashes.has(c.hash));
    if (!newChunks.length && this._table) return;

    // Embed new chunks
    if (newChunks.length) {
      console.log(`[RAG] Embedding ${newChunks.length} new chunks...`);
      const texts = newChunks.map(c => c.content);
      const embeddings = await this.embedder.embedBatch(texts);

      const rows = newChunks.map((c, i) => ({
        hash: c.hash,
        content: c.content,
        source: c.source,
        tokens: c.tokens,
        vector: Array.from(embeddings[i]),
      }));

      if (!this._table) {
        // Create table with first batch
        this._table = await this._db.createTable(TABLE_NAME, rows);
      } else {
        await this._table.add(rows);
      }
      console.log(`[RAG] Synced ${newChunks.length} chunks to LanceDB`);
    }

    // Clean stale entries (hashes in Lance but not in current chunks)
    const currentHashes = new Set(this.chunks.map(c => c.hash));
    const staleHashes = [...existingHashes].filter(h => !currentHashes.has(h));
    if (staleHashes.length && this._table) {
      for (const h of staleHashes) {
        try { await this._table.delete(`hash = '${h}'`); } catch {}
      }
      console.log(`[RAG] Cleaned ${staleHashes.length} stale chunks`);
    }
  }

  // ========== File Indexing ==========

  _indexFiles() {
    this.chunks = [];

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
            content, source: 'knowledge',
            tokens: Math.ceil(content.length / 4),
            hash: this._hash(content),
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
    this.chunks.push({
      content, source,
      tokens: Math.ceil(content.length / 4),
      hash: this._hash(content),
    });
  }

  // ========== Search ==========

  /**
   * Hybrid search: vector (LanceDB) + keyword, merged via RRF
   * @param {string} query
   * @param {number} topK
   * @returns {Promise<Array<{content: string, source: string, score: number}>>}
   */
  async search(query, topK = 5) {
    if (!this.chunks.length) return [];

    if (this.useEmbeddings && this._table) {
      return this._hybridSearch(query, topK);
    }
    return this._keywordSearch(query, topK);
  }

  /** Sync keyword-only search */
  searchSync(query, topK = 5) {
    return this._keywordSearch(query, topK);
  }

  async _hybridSearch(query, topK) {
    const [vecResults, kwResults] = await Promise.all([
      this._vectorSearch(query, topK),
      Promise.resolve(this._keywordSearch(query, topK)),
    ]);

    // RRF (Reciprocal Rank Fusion)
    const scores = new Map();
    const k = 60;
    for (let i = 0; i < vecResults.length; i++) {
      const key = vecResults[i].content;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    }
    for (let i = 0; i < kwResults.length; i++) {
      const key = kwResults[i].content;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    }

    const seen = new Set();
    const merged = [];
    for (const r of [...vecResults, ...kwResults]) {
      if (seen.has(r.content)) continue;
      seen.add(r.content);
      merged.push({ content: r.content, source: r.source, score: scores.get(r.content) || 0 });
    }

    return merged.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async _vectorSearch(query, topK) {
    const qVec = await this.embedder.embed(query);
    const results = await this._table.vectorSearch(Array.from(qVec)).limit(topK).toArray();

    return results
      .map(r => ({
        content: r.content,
        source: r.source,
        score: 1 / (1 + (r._distance || 0)), // L2 distance → similarity
      }))
      .filter(r => r.score > 0.3); // min threshold
  }

  _keywordSearch(query, topK) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return [];

    return this.chunks
      .map(chunk => {
        const lower = chunk.content.toLowerCase();
        const hits = words.filter(w => lower.includes(w)).length;
        return { content: chunk.content, source: chunk.source, score: hits / words.length };
      })
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ========== Context for Prompt ==========

  /**
   * @param {string} query
   * @param {number} maxChars
   * @returns {string|Promise<string>}
   */
  getContextForPrompt(query, maxChars = 2000) {
    if (this.useEmbeddings) return this._getContextAsync(query, maxChars);
    return this._formatContext(this._keywordSearch(query, 5), maxChars);
  }

  async _getContextAsync(query, maxChars) {
    const results = await this.search(query, 5);
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

  // ========== Reindex ==========

  async reindex() {
    this._indexFiles();
    if (this.useEmbeddings && this._db) {
      await this._syncToLance();
    }
  }

  reindexSync() {
    this._indexFiles();
  }

  // ========== Utils ==========

  _hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  getStats() {
    return {
      totalChunks: this.chunks.length,
      useEmbeddings: this.useEmbeddings,
      lanceReady: this._lanceReady,
      dimensions: this.embedder?.dimensions || null,
      provider: this.embedder ? (this.useEmbeddings ? `${this.embedder.provider} + LanceDB` : 'fallback-keyword') : 'keyword-only',
      model: this.embedder?.localModel || this.embedder?.apiModel || null,
    };
  }
}
