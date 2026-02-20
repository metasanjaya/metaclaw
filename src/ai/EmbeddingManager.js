/**
 * EmbeddingManager — Multi-provider embedding support
 * 
 * Providers (priority order):
 * 1. local    — @xenova/transformers (zero-cost, no API key)
 * 2. api      — OpenAI-compatible /v1/embeddings endpoint
 * 
 * Config in instance config.yaml:
 *   embedding:
 *     provider: local | api
 *     model: all-MiniLM-L6-v2          # local model name
 *     api_url: https://api.example.com  # for api provider
 *     api_key: sk-...                   # for api provider
 *     api_model: text-embedding-3-small # for api provider
 *     dimensions: 384                   # optional, override dims
 */

export class EmbeddingManager {
  /**
   * @param {Object} config
   * @param {string} [config.provider='local'] — 'local' | 'api'
   * @param {string} [config.model='Xenova/all-MiniLM-L6-v2']
   * @param {string} [config.api_url]
   * @param {string} [config.api_key]
   * @param {string} [config.api_model]
   * @param {number} [config.dimensions]
   */
  constructor(config = {}) {
    this.provider = config.provider || 'local';
    this.localModel = config.model || 'Xenova/all-MiniLM-L6-v2';
    this.apiUrl = config.api_url;
    this.apiKey = config.api_key;
    this.apiModel = config.api_model || 'text-embedding-3-small';
    this.dimensions = config.dimensions || null;

    /** @type {any} local pipeline instance */
    this._pipeline = null;
    this._ready = false;
    this._initPromise = null;
  }

  /**
   * Initialize the embedding provider (lazy, call once)
   */
  async initialize() {
    if (this._ready) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    await this._initPromise;
  }

  async _doInit() {
    if (this.provider === 'local') {
      try {
        const { pipeline } = await import('@xenova/transformers');
        console.log(`[Embedding] Loading local model: ${this.localModel}...`);
        this._pipeline = await pipeline('feature-extraction', this.localModel, {
          quantized: true,
        });
        this.dimensions = this.dimensions || 384; // MiniLM default
        console.log(`[Embedding] Local model ready (${this.dimensions}d)`);
      } catch (e) {
        throw new Error(`Local embedding init failed: ${e.message}`);
      }
    } else if (this.provider === 'api') {
      if (!this.apiUrl || !this.apiKey) {
        throw new Error('API embedding requires api_url and api_key');
      }
      // Test with a dummy embed
      const test = await this._apiEmbed('test');
      this.dimensions = this.dimensions || test.length;
      console.log(`[Embedding] API provider ready (${this.apiModel}, ${this.dimensions}d)`);
    }

    this._ready = true;
  }

  /**
   * Embed a single text string
   * @param {string} text
   * @returns {Promise<Float32Array>}
   */
  async embed(text) {
    if (!this._ready) await this.initialize();

    if (this.provider === 'local') {
      return this._localEmbed(text);
    } else {
      return this._apiEmbed(text);
    }
  }

  /**
   * Embed multiple texts (batched)
   * @param {string[]} texts
   * @returns {Promise<Float32Array[]>}
   */
  async embedBatch(texts) {
    if (!this._ready) await this.initialize();

    if (this.provider === 'local') {
      // transformers.js supports batching natively
      return this._localEmbedBatch(texts);
    } else {
      // API batch (most providers support array input)
      return this._apiEmbedBatch(texts);
    }
  }

  /**
   * Compute cosine similarity between two vectors
   * @param {Float32Array|number[]} a
   * @param {Float32Array|number[]} b
   * @returns {number}
   */
  static cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Find top-K most similar chunks to a query
   * @param {string} query
   * @param {Array<{content: string, embedding: Float32Array|number[], [key: string]: any}>} chunks
   * @param {number} topK
   * @returns {Promise<Array<{content: string, source: string, score: number}>>}
   */
  async findSimilar(query, chunks, topK = 3) {
    const qEmb = await this.embed(query);
    const scored = chunks
      .filter(c => c.embedding)
      .map(c => ({
        content: c.content,
        source: c.source,
        score: EmbeddingManager.cosineSimilarity(qEmb, c.embedding),
      }));

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // --- Local provider ---

  async _localEmbed(text) {
    const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
    return output.data; // Float32Array
  }

  async _localEmbedBatch(texts) {
    const results = [];
    // Process in small batches to avoid memory issues
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      for (const t of batch) {
        results.push(await this._localEmbed(t));
      }
    }
    return results;
  }

  // --- API provider (OpenAI-compatible) ---

  async _apiEmbed(text) {
    const res = await fetch(`${this.apiUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.apiModel,
        input: text,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Embedding API error ${res.status}: ${err}`);
    }

    const json = await res.json();
    return new Float32Array(json.data[0].embedding);
  }

  async _apiEmbedBatch(texts) {
    const res = await fetch(`${this.apiUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.apiModel,
        input: texts,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Embedding API error ${res.status}: ${err}`);
    }

    const json = await res.json();
    return json.data
      .sort((a, b) => a.index - b.index)
      .map(d => new Float32Array(d.embedding));
  }

  get isReady() { return this._ready; }
}
