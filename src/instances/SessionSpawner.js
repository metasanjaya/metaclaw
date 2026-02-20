/**
 * SessionSpawner — Spawn isolated AI sessions (sub-agents)
 * 
 * Inspired by OpenClaw's sessions_spawn approach:
 * - Isolated context (no parent conversation bleeding)
 * - Auto-announce results back to parent chat
 * - Optional different model per spawn
 * - Timeout + cleanup
 * 
 * Flow:
 *   Parent instance → spawner.spawn(task, opts) → isolated Router call
 *     → result auto-delivered to parent chatId via EventBus
 */
import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} SpawnedSession
 * @property {string} id
 * @property {string} task — the task/prompt
 * @property {string} parentChatId — chat to deliver result to
 * @property {string} parentChannelId — channel to deliver via
 * @property {string} model — model used
 * @property {'pending'|'running'|'done'|'failed'|'killed'} status
 * @property {string|null} result
 * @property {string|null} error
 * @property {number} startedAt
 * @property {number|null} completedAt
 * @property {number} timeoutMs
 */

export class SessionSpawner {
  /**
   * @param {Object} opts
   * @param {string} opts.instanceId
   * @param {import('../core/Router.js').Router} opts.router
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   * @param {string} opts.defaultModel
   * @param {import('./ToolExecutor.js').ToolExecutor} [opts.tools]
   */
  constructor({ instanceId, router, eventBus, defaultModel, tools }) {
    this.instanceId = instanceId;
    this.router = router;
    this.eventBus = eventBus;
    this.defaultModel = defaultModel;
    this.tools = tools;

    /** @type {Map<string, SpawnedSession>} */
    this.sessions = new Map();

    // Max concurrent
    this.maxConcurrent = 3;
  }

  /**
   * Spawn an isolated session
   * @param {Object} opts
   * @param {string} opts.task — the prompt/task
   * @param {string} opts.parentChatId — where to deliver result
   * @param {string} [opts.parentChannelId='mission-control']
   * @param {string} [opts.model] — override model
   * @param {string} [opts.systemPrompt] — custom system prompt
   * @param {number} [opts.timeoutMs=120000] — max runtime
   * @param {number} [opts.maxTokens=4096]
   * @param {boolean} [opts.announce=true] — auto-deliver result
   * @param {string} [opts.label] — human-readable label
   * @returns {string} session id
   */
  spawn(opts) {
    const running = [...this.sessions.values()].filter(s => s.status === 'running').length;
    if (running >= this.maxConcurrent) {
      throw new Error(`Max concurrent sessions (${this.maxConcurrent}) reached`);
    }

    const id = `sub_${randomUUID().slice(0, 8)}`;
    const session = {
      id,
      task: opts.task,
      label: opts.label || opts.task.slice(0, 60),
      parentChatId: opts.parentChatId,
      parentChannelId: opts.parentChannelId || 'mission-control',
      model: opts.model || this.defaultModel,
      systemPrompt: opts.systemPrompt || null,
      announce: opts.announce !== false,
      status: 'pending',
      result: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      timeoutMs: opts.timeoutMs || 120_000,
      maxTokens: opts.maxTokens || 4096,
    };

    this.sessions.set(id, session);
    console.log(`[Spawner:${this.instanceId}] Spawning: "${session.label}" (${session.model})`);

    // Run async (fire-and-forget)
    this._run(session).catch(e => {
      session.status = 'failed';
      session.error = e.message;
      session.completedAt = Date.now();
      console.error(`[Spawner:${this.instanceId}] Session ${id} failed: ${e.message}`);
    });

    return id;
  }

  async _run(session) {
    session.status = 'running';

    // Setup timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Session timeout')), session.timeoutMs);
    });

    const workPromise = this._executeSession(session);

    try {
      const result = await Promise.race([workPromise, timeoutPromise]);
      session.result = result;
      session.status = 'done';
      session.completedAt = Date.now();

      const elapsed = ((session.completedAt - session.startedAt) / 1000).toFixed(1);
      console.log(`[Spawner:${this.instanceId}] ✅ "${session.label}" done (${elapsed}s)`);

      // Auto-announce
      if (session.announce && result) {
        this._announce(session, result);
      }
    } catch (e) {
      session.status = e.message === 'Session timeout' ? 'killed' : 'failed';
      session.error = e.message;
      session.completedAt = Date.now();

      if (session.announce) {
        this._announce(session, `⚠️ Sub-task failed: ${e.message}`);
      }
    }
  }

  async _executeSession(session) {
    const messages = [
      {
        role: 'system',
        content: session.systemPrompt || `You are a focused sub-agent. Complete the task concisely. Do not ask questions — just do it.\nParent instance: ${this.instanceId}`,
      },
      { role: 'user', content: session.task },
    ];

    const tools = this.tools?.getToolDefinitions() || [];
    const MAX_ROUNDS = 5;
    let finalText = '';

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (session.status === 'killed') throw new Error('Session killed');

      const response = tools.length > 0
        ? await this.router.chatWithTools({
            instanceId: `${this.instanceId}:${session.id}`,
            model: session.model,
            messages,
            tools,
            options: { maxTokens: session.maxTokens, temperature: 0.5 },
          })
        : await this.router.chat({
            instanceId: `${this.instanceId}:${session.id}`,
            model: session.model,
            messages,
            options: { maxTokens: session.maxTokens, temperature: 0.5 },
          });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        finalText = response.text || '';
        break;
      }

      // Execute tools
      const toolResults = [];
      for (const tc of response.toolCalls) {
        const output = await this.tools.execute(tc.name, tc.input);
        toolResults.push({
          id: tc.id,
          result: typeof output === 'string' ? output.slice(0, 3000) : JSON.stringify(output).slice(0, 3000),
        });
      }

      messages.push({
        role: 'assistant',
        content: response.text || null,
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          function: { name: tc.name, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) },
        })),
      });
      for (const tr of toolResults) {
        messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.result });
      }

      finalText = response.text || '';
    }

    return finalText;
  }

  _announce(session, text) {
    const prefix = `📋 [${session.label}]\n`;
    this.eventBus.emit('spawner.result', {
      instanceId: this.instanceId,
      sessionId: session.id,
      chatId: session.parentChatId,
      channelId: session.parentChannelId,
      text: prefix + text,
    });
  }

  /**
   * Kill a running session
   * @param {string} sessionId
   * @returns {boolean}
   */
  kill(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return false;
    session.status = 'killed';
    session.completedAt = Date.now();
    return true;
  }

  /**
   * Send a message to a running session (steer)
   * Not yet implemented — placeholder for future
   */
  steer(sessionId, message) {
    // TODO: inject message into running session
    return false;
  }

  /** List all sessions */
  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      label: s.label,
      status: s.status,
      model: s.model,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      elapsed: s.completedAt ? s.completedAt - s.startedAt : Date.now() - s.startedAt,
      error: s.error,
    }));
  }

  /** Cleanup old completed sessions (keep last 20) */
  cleanup() {
    const completed = [...this.sessions.entries()]
      .filter(([, s]) => s.status !== 'running' && s.status !== 'pending')
      .sort((a, b) => (b[1].completedAt || 0) - (a[1].completedAt || 0));

    if (completed.length > 20) {
      for (const [id] of completed.slice(20)) {
        this.sessions.delete(id);
      }
    }
  }

  getStats() {
    const sessions = [...this.sessions.values()];
    return {
      total: sessions.length,
      running: sessions.filter(s => s.status === 'running').length,
      done: sessions.filter(s => s.status === 'done').length,
      failed: sessions.filter(s => s.status === 'failed' || s.status === 'killed').length,
    };
  }
}
