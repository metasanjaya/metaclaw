/**
 * EmbeddingManager — Multi-provider embedding support
 * 
 * Providers:
 * 1. local    — @xenova/transformers (zero-cost, no API key)
 * 2. api      — OpenAI-compatible /v1/embeddings endpoint
 * 
 * Config in instance config.yaml:
 *   embedding:
 *     provider: local | api
 *     model: Xenova/bge-m3             # local model name (default)
 *     api_url: https://api.example.com  # for api provider
 *     api_key: sk-...                   # for api provider
 *     api_model: text-embedding-3-small # for api provider
 *     dimensions: 1024                  # auto-detected if omitted
 */

export class EmbeddingManager {
  /**
   * @param {Object} config
   * @param {string} [config.provider='local']
   * @param {string} [config.model='Xenova/bge-m3']
   * @param {string} [config.api_url]
   * @param {string} [config.api_key]
   * @param {string} [config.api_model]
   * @param {number} [config.dimensions]
   */
  constructor(config = {}) {
    this.provider = config.provider || 'local';
    this.localModel = config.model || 'Xenova/bge-m3';
    this.apiUrl = config.api_url;
    this.apiKey = config.api_key;
    this.apiModel = config.api_model || 'text-embedding-3-small';
    this.dimensions = config.dimensions || null;

    /** @type {any} local pipeline instance */
    this._pipeline = null;
    this._ready = false;
    this._initPromise = null;
  }

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
        this._pipeline = await pipeline('feature-extraction', this.localModel, { quantized: true });
        // Auto-detect dimensions
        const test = await this._localEmbed('dimension test');
        this.dimensions = test.length;
        console.log(`[Embedding] Local model ready (${this.dimensions}d)`);
      } catch (e) {
        throw new Error(`Local embedding init failed: ${e.message}`);
      }
    } else if (this.provider === 'api') {
      if (!this.apiUrl || !this.apiKey) {
        throw new Error('API embedding requires api_url and api_key');
      }
      const test = await this._apiEmbed('dimension test');
      this.dimensions = this.dimensions || test.length;
      console.log(`[Embedding] API provider ready (${this.apiModel}, ${this.dimensions}d)`);
    }
    this._ready = true;
  }

  /**
   * Embed a single text
   * @param {string} text
   * @returns {Promise<Float32Array>}
   */
  async embed(text) {
    if (!this._ready) await this.initialize();
    return this.provider === 'local' ? this._localEmbed(text) : this._apiEmbed(text);
  }

  /**
   * Embed multiple texts
   * @param {string[]} texts
   * @returns {Promise<Float32Array[]>}
   */
  async embedBatch(texts) {
    if (!this._ready) await this.initialize();
    if (this.provider === 'local') {
      const results = [];
      for (const t of texts) results.push(await this._localEmbed(t));
      return results;
    }
    return this._apiEmbedBatch(texts);
  }

  /**
   * Cosine similarity
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

  // --- Local ---

  async _localEmbed(text) {
    const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
    return output.data; // Float32Array
  }

  // --- API (OpenAI-compatible) ---

  async _apiEmbed(text) {
    const res = await fetch(`${this.apiUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.apiModel, input: text,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return new Float32Array(json.data[0].embedding);
  }

  async _apiEmbedBatch(texts) {
    const res = await fetch(`${this.apiUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.apiModel, input: texts,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json.data.sort((a, b) => a.index - b.index).map(d => new Float32Array(d.embedding));
  }

  get isReady() { return this._ready; }
}
