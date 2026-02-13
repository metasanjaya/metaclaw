/**
 * EmbeddingManager - Local embeddings & similarity search
 * 
 * Uses Xenova Transformers for local embeddings (no API calls!)
 * Benefits:
 * - Fast semantic search
 * - Find relevant context automatically
 * - Privacy-friendly (all local)
 * - No API costs
 */

import { pipeline, env } from '@xenova/transformers';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Disable remote models (use local cache only after first download)
env.allowLocalModels = true;
env.allowRemoteModels = true; // Allow initial download

export class EmbeddingManager {
  constructor(options = {}) {
    this.model = options.model || 'Xenova/all-MiniLM-L6-v2'; // Fast & lightweight
    this.embedder = null;
    this.cache = new Map(); // Cache embeddings
    this.dimension = 384; // Embedding dimension for MiniLM
    this.similarityThreshold = options.similarityThreshold || 0.5;
    this.persistPath = options.persistPath || null; // Path to save/load cache
  }

  /**
   * Initialize the embedding model
   */
  async initialize() {
    if (this.embedder) return;
    
    console.log('🔧 Initializing embedding model...');
    this.embedder = await pipeline('feature-extraction', this.model);
    console.log('✅ Embedding model ready!');
  }

  /**
   * Generate embedding for text
   */
  async embed(text, useCache = true) {
    if (!this.embedder) {
      await this.initialize();
    }

    // Check cache
    const cacheKey = this.hashText(text);
    if (useCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Generate embedding
    const output = await this.embedder(text, {
      pooling: 'mean',
      normalize: true
    });

    // Convert to regular array
    const embedding = Array.from(output.data);

    // Cache it
    if (useCache) {
      this.cache.set(cacheKey, embedding);
      
      // Limit cache size
      if (this.cache.size > 1000) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
    }

    return embedding;
  }

  /**
   * Embed multiple texts in parallel batches
   * @param {string[]} texts - Texts to embed
   * @param {boolean} useCache - Whether to use cache
   * @param {number} batchSize - Parallel batch size
   * @returns {Promise<Array>} Array of embedding vectors
   */
  async embedBatch(texts, useCache = true, batchSize = 8) {
    const results = new Array(texts.length);
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await Promise.all(
        batch.map(text => this.embed(text, useCache))
      );
      for (let j = 0; j < embeddings.length; j++) {
        results[i + j] = embeddings[j];
      }
    }
    
    return results;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  cosineSimilarity(embeddingA, embeddingB) {
    if (embeddingA.length !== embeddingB.length) {
      throw new Error('Embeddings must have same dimension');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < embeddingA.length; i++) {
      dotProduct += embeddingA[i] * embeddingB[i];
      normA += embeddingA[i] * embeddingA[i];
      normB += embeddingB[i] * embeddingB[i];
    }

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return similarity;
  }

  /**
   * Find most similar items from a list
   */
  async findSimilar(query, items, topK = 5) {
    // Generate query embedding
    const queryEmbedding = await this.embed(query);

    // Calculate similarity scores
    const scored = [];
    for (const item of items) {
      // Item should have either 'embedding' or 'content' field
      let itemEmbedding;
      
      if (item.embedding) {
        itemEmbedding = item.embedding;
      } else if (item.content) {
        itemEmbedding = await this.embed(item.content);
        item.embedding = itemEmbedding; // Cache for future use
      } else {
        continue;
      }

      const similarity = this.cosineSimilarity(queryEmbedding, itemEmbedding);
      
      // Store similarity directly on item instead of spreading
      item.similarityScore = similarity;
      scored.push(item);
    }

    // Sort by similarity (highest first)
    scored.sort((a, b) => b.similarityScore - a.similarityScore);

    // Return top K results above threshold
    return scored
      .filter(item => item.similarityScore >= this.similarityThreshold)
      .slice(0, topK);
  }

  /**
   * Cluster items by semantic similarity
   */
  async cluster(items, threshold = 0.7) {
    const clusters = [];
    const processed = new Set();

    // Ensure all items have embeddings
    for (const item of items) {
      if (!item.embedding && item.content) {
        item.embedding = await this.embed(item.content);
      }
    }

    for (let i = 0; i < items.length; i++) {
      if (processed.has(i)) continue;

      const cluster = [items[i]];
      processed.add(i);

      // Find similar items
      for (let j = i + 1; j < items.length; j++) {
        if (processed.has(j)) continue;

        const similarity = this.cosineSimilarity(
          items[i].embedding,
          items[j].embedding
        );

        if (similarity >= threshold) {
          cluster.push(items[j]);
          processed.add(j);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  /**
   * Auto-detect relevant context blocks for a query
   */
  async selectRelevantContext(query, contextBlocks, options = {}) {
    const {
      maxBlocks = 5,
      maxTokens = 2000,
      minSimilarity = 0.3,
      diversityBonus = 0.1 // Prefer diverse blocks
    } = options;

    // Find similar blocks
    const similar = await this.findSimilar(query, contextBlocks, maxBlocks * 2);

    // Apply diversity bonus
    const selected = [];
    let totalTokens = 0;

    for (const block of similar) {
      if (selected.length >= maxBlocks) break;
      if (totalTokens + block.metadata.tokens > maxTokens) break;
      if (block.similarityScore < minSimilarity) break;

      // Check diversity - don't select too many similar blocks
      const isDiverse = selected.every(s => {
        const sim = this.cosineSimilarity(s.embedding, block.embedding);
        return sim < 0.9; // Not too similar to already selected
      });

      if (isDiverse) {
        // Update relevance score
        block.metadata.relevanceScore = block.similarityScore;
        selected.push(block);
        totalTokens += block.metadata.tokens;
      }
    }

    return {
      blocks: selected,
      totalTokens,
      averageRelevance: selected.reduce((sum, b) => sum + b.similarityScore, 0) / selected.length || 0
    };
  }

  /**
   * Hash text for caching using SHA-256 for collision resistance
   * @param {string} text - Text to hash
   * @returns {string} Hex hash string
   */
  hashText(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Save embedding cache to disk for persistence across restarts
   * @param {string} [filePath] - Override persist path
   */
  async saveCache(filePath = null) {
    const savePath = filePath || this.persistPath;
    if (!savePath) return false;
    
    try {
      const dir = path.dirname(savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      const data = Object.fromEntries(this.cache);
      fs.writeFileSync(savePath, JSON.stringify(data));
      return true;
    } catch (err) {
      console.error('Failed to save embedding cache:', err.message);
      return false;
    }
  }

  /**
   * Load embedding cache from disk
   * @param {string} [filePath] - Override persist path
   */
  loadCache(filePath = null) {
    const loadPath = filePath || this.persistPath;
    if (!loadPath || !fs.existsSync(loadPath)) return false;
    
    try {
      const data = JSON.parse(fs.readFileSync(loadPath, 'utf8'));
      for (const [key, value] of Object.entries(data)) {
        this.cache.set(key, value);
      }
      console.log(`📂 Loaded ${Object.keys(data).length} cached embeddings from disk`);
      return true;
    } catch (err) {
      console.error('Failed to load embedding cache:', err.message);
      return false;
    }
  }

  /**
   * Clear embedding cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: 1000,
      utilizationPercent: (this.cache.size / 1000 * 100).toFixed(2)
    };
  }
}
