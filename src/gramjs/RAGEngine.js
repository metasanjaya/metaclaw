/**
 * RAGEngine - Retrieval-Augmented Generation using EmbeddingManager
 * Indexes personality + memory files, searches relevant chunks per query.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONALITY_DIR = path.join(__dirname, '../../personality');

export class RAGEngine {
  constructor(embeddingManager, chunker) {
    this.embedder = embeddingManager;
    this.chunker = chunker;
    this.chunks = []; // { content, embedding, source, tokens }
    this.initialized = false;
    this.useFallback = false; // true if embeddings fail
  }

  async initialize() {
    try {
      await this.embedder.initialize();
    } catch (err) {
      console.warn('⚠️ Embedding model failed, using keyword fallback:', err.message);
      this.useFallback = true;
    }

    await this._indexAllDocuments();
    this.initialized = true;
    console.log(`🔍 RAGEngine initialized (${this.chunks.length} chunks indexed, fallback=${this.useFallback})`);
  }

  async _indexAllDocuments() {
    this.chunks = [];

    // Index personality files (except SOUL.md and IDENTITY.md which are always included)
    const ragFiles = ['USER.md', 'TOOLS.md', 'HOWTO.md', 'MEMORY.md'];
    for (const file of ragFiles) {
      const p = path.join(PERSONALITY_DIR, file);
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf-8');
        if (text.trim()) await this.addDocument(file, text);
      }
    }

    // Index memory daily logs
    const memDir = path.join(PERSONALITY_DIR, 'memory');
    if (fs.existsSync(memDir)) {
      for (const f of fs.readdirSync(memDir)) {
        if (f.endsWith('.md')) {
          const text = fs.readFileSync(path.join(memDir, f), 'utf-8');
          if (text.trim()) await this.addDocument(`memory/${f}`, text);
        }
      }
    }
  }

  async addDocument(name, text) {
    const docChunks = this.chunker.chunk(text, { source: name });
    
    for (const chunk of docChunks) {
      if (!chunk.content.trim()) continue;
      
      const entry = {
        content: chunk.content,
        source: name,
        tokens: chunk.tokens || Math.ceil(chunk.content.length / 4),
        embedding: null,
      };

      if (!this.useFallback) {
        try {
          entry.embedding = await this.embedder.embed(chunk.content);
        } catch {
          this.useFallback = true;
        }
      }

      this.chunks.push(entry);
    }
  }

  async search(query, topK = 3) {
    if (!this.chunks.length) return [];

    if (this.useFallback) {
      return this._keywordSearch(query, topK);
    }

    try {
      const results = await this.embedder.findSimilar(query, this.chunks, topK);
      return results.map(r => ({
        content: r.content,
        source: r.source,
        score: r.similarityScore,
      }));
    } catch (err) {
      console.warn('⚠️ Embedding search failed, falling back to keywords:', err.message);
      this.useFallback = true;
      return this._keywordSearch(query, topK);
    }
  }

  _keywordSearch(query, topK) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return [];

    const scored = this.chunks.map(chunk => {
      const lower = chunk.content.toLowerCase();
      const hits = words.filter(w => lower.includes(w)).length;
      return { ...chunk, score: hits / words.length };
    });

    return scored
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(r => ({ content: r.content, source: r.source, score: r.score }));
  }

  async reindex() {
    await this._indexAllDocuments();
    console.log(`🔄 RAG re-indexed (${this.chunks.length} chunks)`);
  }
}
