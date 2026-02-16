/**
 * SessionManager - Structured, isolated, resumable conversation contexts
 * 
 * Replaces direct ConversationManager usage with session-based routing.
 * Each chat has a main session by default; task/branch sessions provide isolation.
 * 
 * Integration Points (do NOT modify these files, wire up manually):
 *   GramJSBridge: Replace ConversationManager calls → sessionMgr.addMessage / getHistory
 *                 Commands: /session list, /session switch <id>, /session new <label>
 *   SubAgent:     On spawn → sessionMgr.createSession({ type: 'task', chatId, label })
 *                 Use addMessageToSession(sessionId, ...) for isolated context
 */

import { randomBytes } from 'crypto';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const LOG = '📑 SessionManager';
const AUTO_COMPACT_THRESHOLD = 50;
const KEEP_RECENT = 20;
const PERSIST_DEBOUNCE_MS = 5000;
const MAX_PERSIST_MESSAGES = 50;
const RELEVANT_OLDER = 10;
const RECENT_WINDOW = 5;

function genId() {
  return 'sess_' + randomBytes(8).toString('hex');
}

function now() {
  return Date.now();
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export default class SessionManager {
  /**
   * @param {object} opts
   * @param {string} [opts.persistPath] - directory for session JSON files
   * @param {object} [opts.embedder] - optional { embed(text) → Promise<number[]> }
   * @param {object} [opts.ai] - optional UnifiedAIClient for AI-powered compaction
   */
  constructor({ persistPath = 'data/sessions', embedder = null, ai = null } = {}) {
    this.persistPath = persistPath;
    this.embedder = embedder;
    this.ai = ai;

    /** @type {Map<string, object>} sessionId → full session object */
    this.sessions = new Map();
    /** @type {Map<string, object>} sessionId → lightweight index entry */
    this.index = new Map();
    /** @type {Map<string, string>} chatId → active sessionId */
    this.activeSessionMap = new Map();

    // Debounce state
    this._dirtySessions = new Set();
    this._dirtyIndex = false;
    this._saveTimer = null;

    this._loaded = false;
    this._loadPromise = this._init();
  }

  async _init() {
    try {
      await mkdir(this.persistPath, { recursive: true });
      await this._loadIndex();
      this._loaded = true;
      console.log(`${LOG} Initialized — ${this.index.size} sessions indexed`);
    } catch (err) {
      console.error(`${LOG} Init error:`, err.message);
      this._loaded = true;
    }
  }

  async ready() {
    await this._loadPromise;
  }

  // ── Persistence ──

  get _indexPath() {
    return join(this.persistPath, '_index.json');
  }

  async _loadIndex() {
    try {
      const raw = await readFile(this._indexPath, 'utf-8');
      const entries = JSON.parse(raw);
      for (const e of entries) {
        this.index.set(e.id, e);
      }

      // Restore active session map: prefer main, then most recently active
      const byChatId = new Map();
      for (const e of this.index.values()) {
        if (e.status !== 'active') continue;
        const arr = byChatId.get(e.chatId) || [];
        arr.push(e);
        byChatId.set(e.chatId, arr);
      }
      for (const [chatId, sessions] of byChatId) {
        const main = sessions.find(e => e.type === 'main');
        if (main) {
          this.activeSessionMap.set(chatId, main.id);
        } else {
          sessions.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
          if (sessions[0]) this.activeSessionMap.set(chatId, sessions[0].id);
        }
      }
    } catch {
      // No index yet — fresh start
    }
  }

  async _saveIndex() {
    const entries = [...this.index.values()];
    await writeFile(this._indexPath, JSON.stringify(entries, null, 2));
  }

  _sessionPath(id) {
    return join(this.persistPath, `${id}.json`);
  }

  async _loadSession(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    try {
      const raw = await readFile(this._sessionPath(id), 'utf-8');
      const session = JSON.parse(raw);
      // Ensure embeddings cache exists
      if (!session._embeddingCache) session._embeddingCache = new Map();
      else if (!(session._embeddingCache instanceof Map)) {
        // Restore from serialized
        session._embeddingCache = new Map(Object.entries(session._embeddingCache));
      }
      this.sessions.set(id, session);
      return session;
    } catch {
      return null;
    }
  }

  async _persistSession(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    const toSave = { ...s };
    // Truncate messages for persistence
    if (toSave.messages.length > MAX_PERSIST_MESSAGES) {
      toSave.messages = toSave.messages.slice(-MAX_PERSIST_MESSAGES);
    }
    // Don't persist embedding cache (large, regenerated on load)
    delete toSave._embeddingCache;
    await writeFile(this._sessionPath(id), JSON.stringify(toSave, null, 2));
  }

  _markDirty(sessionId) {
    this._dirtySessions.add(sessionId);
    this._dirtyIndex = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this._flushSaves(), PERSIST_DEBOUNCE_MS);
    }
  }

  async _flushSaves() {
    this._saveTimer = null;
    const ids = [...this._dirtySessions];
    this._dirtySessions.clear();
    const indexDirty = this._dirtyIndex;
    this._dirtyIndex = false;

    const promises = ids.map(id =>
      this._persistSession(id).catch(e => console.error(`${LOG} Save error ${id}:`, e.message))
    );
    if (indexDirty) {
      promises.push(this._saveIndex().catch(e => console.error(`${LOG} Index save error:`, e.message)));
    }
    await Promise.all(promises);
  }

  // ── Index helpers ──

  _updateIndex(session) {
    const { id, chatId, type, status, label, createdAt, lastActiveAt } = session;
    this.index.set(id, { id, chatId, type, status, label, createdAt, lastActiveAt });
  }

  // ── Embedding helpers ──

  async _embedMessage(session, msg, idx) {
    if (!this.embedder) return null;
    const cache = session._embeddingCache || (session._embeddingCache = new Map());
    const key = `${idx}:${msg.ts || idx}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (!text || text.length < 5) return null;
      const emb = await this.embedder.embed(text);
      cache.set(key, emb);
      return emb;
    } catch {
      return null;
    }
  }

  // ── Session creation ──

  _createSessionObj({ chatId, type = 'main', label = '', parentId = null, model = null, tools = null, knowledgeScope = null, messages = [], summary = '' }) {
    const id = genId();
    const t = now();
    return {
      id, chatId: String(chatId), type, parentId, label,
      messages, summary,
      model, tools, knowledgeScope,
      status: 'active',
      createdAt: t, lastActiveAt: t,
      turnCount: 0, tokensUsed: 0,
      _embeddingCache: new Map(),
    };
  }

  // ── Core API ──

  /**
   * Get or create the main session for a chat
   */
  async getMainSession(chatId) {
    await this.ready();
    chatId = String(chatId);

    // Find existing main session
    for (const entry of this.index.values()) {
      if (entry.chatId === chatId && entry.type === 'main') {
        const session = await this._loadSession(entry.id);
        if (session) return session;
      }
    }

    // Create new main session
    const session = this._createSessionObj({ chatId, type: 'main', label: 'Main' });
    this.sessions.set(session.id, session);
    this._updateIndex(session);
    if (!this.activeSessionMap.has(chatId)) {
      this.activeSessionMap.set(chatId, session.id);
    }
    this._markDirty(session.id);
    console.log(`${LOG} Created main session ${session.id} for chat ${chatId}`);
    return session;
  }

  /**
   * Create an isolated session (task or branch)
   */
  async createSession({ chatId, type = 'task', label = '', parentId = null, model = null, tools = null, knowledgeScope = null }) {
    await this.ready();
    chatId = String(chatId);
    if (type === 'main') return this.getMainSession(chatId);

    const session = this._createSessionObj({ chatId, type, label, parentId, model, tools, knowledgeScope });
    this.sessions.set(session.id, session);
    this._updateIndex(session);
    this._markDirty(session.id);
    console.log(`${LOG} Created ${type} session ${session.id} "${label}" for chat ${chatId}`);
    return session;
  }

  /**
   * Get the currently active session for a chat (auto-creates main if needed)
   */
  async getActiveSession(chatId) {
    await this.ready();
    chatId = String(chatId);
    const activeId = this.activeSessionMap.get(chatId);
    if (activeId) {
      const session = await this._loadSession(activeId);
      if (session && session.status === 'active') return session;
    }
    return this.getMainSession(chatId);
  }

  /**
   * Switch active session for a chat
   */
  async switchSession(chatId, sessionId) {
    await this.ready();
    chatId = String(chatId);
    const session = await this._loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.chatId !== chatId) throw new Error(`Session ${sessionId} belongs to chat ${session.chatId}, not ${chatId}`);
    if (!['active', 'paused'].includes(session.status)) {
      throw new Error(`Cannot switch to ${session.status} session`);
    }
    if (session.status === 'paused') {
      session.status = 'active';
    }
    this.activeSessionMap.set(chatId, sessionId);
    session.lastActiveAt = now();
    this._updateIndex(session);
    this._markDirty(sessionId);
    console.log(`${LOG} Switched chat ${chatId} → session ${sessionId} "${session.label}"`);
    return session;
  }

  /**
   * Add message to the active session for a chat
   */
  async addMessage(chatId, role, content, opts = {}) {
    const session = await this.getActiveSession(chatId);
    return this._addMessageToSession(session, role, content, opts);
  }

  /**
   * Add message to a specific session (for SubAgent / direct targeting)
   */
  async addMessageToSession(sessionId, role, content, opts = {}) {
    const session = await this._loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this._addMessageToSession(session, role, content, opts);
  }

  _addMessageToSession(session, role, content, opts = {}) {
    const msg = { role, content, ts: now(), ...opts };
    session.messages.push(msg);
    session.turnCount++;
    session.lastActiveAt = now();
    this._updateIndex(session);
    this._markDirty(session.id);

    // Auto-compact
    if (session.messages.length >= AUTO_COMPACT_THRESHOLD) {
      this._compactSession(session).catch(e =>
        console.error(`${LOG} Auto-compact error:`, e.message)
      );
    }
  }

  /**
   * Get optimized history for the active session
   * If query + embedder available, uses relevance filtering
   */
  async getHistory(chatId, query) {
    const session = await this.getActiveSession(chatId);
    return this.getSessionHistory(session.id, query);
  }

  /**
   * Get optimized history for a specific session
   */
  async getSessionHistory(sessionId, query) {
    const session = await this._loadSession(sessionId);
    if (!session) return [];

    const messages = session.messages;
    const result = [];

    // Always prepend summary if exists
    if (session.summary) {
      result.push({ role: 'system', content: `[Session context summary]\n${session.summary}` });
    }

    // No query or no embedder → return summary + all messages
    if (!query || !this.embedder || messages.length <= RECENT_WINDOW + RELEVANT_OLDER) {
      return [...result, ...messages];
    }

    // Embedding-based relevance: recent window + top-K relevant older
    try {
      const queryEmbed = await this.embedder.embed(query);
      const recentStart = Math.max(0, messages.length - RECENT_WINDOW);

      // Score older messages
      const olderScored = [];
      for (let i = 0; i < recentStart; i++) {
        const emb = await this._embedMessage(session, messages[i], i);
        if (emb) {
          olderScored.push({ idx: i, score: cosineSimilarity(queryEmbed, emb) });
        } else {
          olderScored.push({ idx: i, score: 0 });
        }
      }

      // Top relevant older messages
      olderScored.sort((a, b) => b.score - a.score);
      const topOlder = olderScored.slice(0, RELEVANT_OLDER).map(s => s.idx);

      // Combine: relevant older (in order) + recent window
      const includeIdx = new Set([...topOlder]);
      for (let i = recentStart; i < messages.length; i++) includeIdx.add(i);

      const sorted = [...includeIdx].sort((a, b) => a - b);
      for (const idx of sorted) {
        result.push(messages[idx]);
      }
      return result;
    } catch (err) {
      console.error(`${LOG} Embedding error, returning full history:`, err.message);
      return [...result, ...messages];
    }
  }

  /**
   * Compact the active session
   */
  async compact(chatId) {
    const session = await this.getActiveSession(chatId);
    await this._compactSession(session);
  }

  /**
   * Compact a session — AI-powered summary if available, else extractive
   */
  async _compactSession(session) {
    if (session.messages.length <= KEEP_RECENT) return;

    const old = session.messages.slice(0, -KEEP_RECENT);
    const recent = session.messages.slice(-KEEP_RECENT);
    const prevSummary = session.summary || '';

    // Build text from old messages
    const oldText = old
      .filter(m => m.role !== 'system')
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${content.slice(0, 300)}`;
      })
      .join('\n');

    let newSummary;

    // Try AI-powered summarization
    if (this.ai) {
      try {
        const provider = this.ai._getProvider('google'); // cheap model for summaries
        const result = await provider.chat([
          { role: 'system', content: 'Summarize this conversation concisely. Preserve key decisions, facts, and action items. Output only the summary, no preamble.' },
          { role: 'user', content: `${prevSummary ? `Previous summary:\n${prevSummary}\n\n` : ''}New messages to summarize:\n${oldText.slice(0, 4000)}` },
        ], { model: 'gemini-2.5-flash', maxTokens: 1024, temperature: 0.2 });

        newSummary = result?.text || result?.content || String(result);
        console.log(`${LOG} AI-compacted session ${session.id}: ${old.length} msgs → ${newSummary.length} char summary`);
      } catch (err) {
        console.warn(`${LOG} AI summary failed, using extractive:`, err.message);
        newSummary = null;
      }
    }

    // Fallback: extractive summary (chain with previous)
    if (!newSummary) {
      newSummary = prevSummary
        ? `${prevSummary}\n\n---\n\n${oldText.slice(0, 2000)}`
        : oldText.slice(0, 2000);
    }

    session.summary = newSummary;
    session.messages = recent;

    // Clear embedding cache for removed messages
    session._embeddingCache = new Map();

    this._updateIndex(session);
    this._markDirty(session.id);
    console.log(`${LOG} Compacted session ${session.id}: ${old.length} msgs removed, kept ${recent.length} recent`);
  }

  // ── Lifecycle ──

  async pauseSession(sessionId) {
    const session = await this._loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = 'paused';
    this._updateIndex(session);
    // Switch to main if this was active
    if (this.activeSessionMap.get(session.chatId) === sessionId) {
      const main = await this.getMainSession(session.chatId);
      this.activeSessionMap.set(session.chatId, main.id);
    }
    this._markDirty(sessionId);
    console.log(`${LOG} Paused session ${sessionId}`);
  }

  async resumeSession(chatId, sessionId) {
    chatId = String(chatId);
    const session = await this._loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = 'active';
    session.lastActiveAt = now();
    this.activeSessionMap.set(chatId, sessionId);
    this._updateIndex(session);
    this._markDirty(sessionId);
    console.log(`${LOG} Resumed session ${sessionId} for chat ${chatId}`);
    return session;
  }

  async completeSession(sessionId) {
    const session = await this._loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = 'completed';
    this._updateIndex(session);
    if (this.activeSessionMap.get(session.chatId) === sessionId) {
      const main = await this.getMainSession(session.chatId);
      this.activeSessionMap.set(session.chatId, main.id);
    }
    this._markDirty(sessionId);
    console.log(`${LOG} Completed session ${sessionId}`);
  }

  async archiveSession(sessionId) {
    const session = await this._loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.status = 'archived';
    this._updateIndex(session);
    if (this.activeSessionMap.get(session.chatId) === sessionId) {
      const main = await this.getMainSession(session.chatId);
      this.activeSessionMap.set(session.chatId, main.id);
    }
    this._markDirty(sessionId);
    console.log(`${LOG} Archived session ${sessionId}`);
  }

  async deleteSession(sessionId) {
    const session = await this._loadSession(sessionId);
    if (!session) return;
    if (session.type === 'main') throw new Error('Cannot delete main session');

    // Switch away if active
    if (this.activeSessionMap.get(session.chatId) === sessionId) {
      const main = await this.getMainSession(session.chatId);
      this.activeSessionMap.set(session.chatId, main.id);
    }

    this.sessions.delete(sessionId);
    this.index.delete(sessionId);
    this._dirtyIndex = true;

    // Remove file
    try {
      await unlink(this._sessionPath(sessionId));
    } catch { /* ignore */ }

    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this._flushSaves(), PERSIST_DEBOUNCE_MS);
    }
    console.log(`${LOG} Deleted session ${sessionId}`);
  }

  // ── Query ──

  async listSessions(chatId, { status, type } = {}) {
    await this.ready();
    chatId = String(chatId);
    let results = [...this.index.values()].filter(e => e.chatId === chatId);
    if (status) results = results.filter(e => e.status === status);
    if (type) results = results.filter(e => e.type === type);
    results.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    return results;
  }

  async getSession(sessionId) {
    await this.ready();
    return this._loadSession(sessionId);
  }

  async updateSession(sessionId, patch) {
    const session = await this._loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const allowed = ['label', 'model', 'tools', 'knowledgeScope', 'tokensUsed'];
    for (const key of allowed) {
      if (key in patch) session[key] = patch[key];
    }
    this._updateIndex(session);
    this._markDirty(sessionId);
    return session;
  }

  // ── Branching ──

  /**
   * Fork a new session from an existing one, carrying relevant context
   */
  async branchSession(chatId, fromSessionId, { label = 'Branch', query = null } = {}) {
    await this.ready();
    chatId = String(chatId);
    const parent = await this._loadSession(fromSessionId);
    if (!parent) throw new Error(`Parent session ${fromSessionId} not found`);

    let branchMessages = [];

    if (query && this.embedder && parent.messages.length > 0) {
      // Use cached embeddings from parent for relevance scoring
      try {
        const queryEmbed = await this.embedder.embed(query);
        const scored = [];
        for (let i = 0; i < parent.messages.length; i++) {
          const emb = await this._embedMessage(parent, parent.messages[i], i);
          scored.push({ idx: i, score: emb ? cosineSimilarity(queryEmbed, emb) : 0 });
        }
        scored.sort((a, b) => b.score - a.score);
        const topIdx = scored.slice(0, 10).map(s => s.idx).sort((a, b) => a - b);
        branchMessages = topIdx.map(i => ({ ...parent.messages[i] }));
      } catch (err) {
        console.error(`${LOG} Branch embedding error, taking last 10:`, err.message);
        branchMessages = parent.messages.slice(-10).map(m => ({ ...m }));
      }
    } else {
      branchMessages = parent.messages.slice(-10).map(m => ({ ...m }));
    }

    const session = this._createSessionObj({
      chatId, type: 'branch', label, parentId: fromSessionId,
      model: parent.model, tools: parent.tools, knowledgeScope: parent.knowledgeScope,
      messages: branchMessages, summary: parent.summary || '',
    });

    this.sessions.set(session.id, session);
    this._updateIndex(session);
    this._markDirty(session.id);
    console.log(`${LOG} Branched session ${session.id} from ${fromSessionId} with ${branchMessages.length} messages`);
    return session;
  }

  // ── Graceful shutdown ──

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this._flushSaves();
    console.log(`${LOG} Flushed all pending saves`);
  }
}
