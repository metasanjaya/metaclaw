import { ChatStore } from './ChatStore.js';
import { MemoryManager } from './MemoryManager.js';
import { KnowledgeManager } from './KnowledgeManager.js';
import { ToolExecutor } from './ToolExecutor.js';
import { TopicManager } from './TopicManager.js';
import { RAGEngine } from './RAGEngine.js';
import { StatsTracker } from './StatsTracker.js';
import { AutoMemory } from './AutoMemory.js';
import { LessonLearner } from './LessonLearner.js';
import { Scheduler } from './Scheduler.js';
import { SessionSpawner } from './SessionSpawner.js';
import { BackgroundTracker } from './BackgroundTracker.js';
import { DebugLogger } from './DebugLogger.js';
import { EmbeddingManager } from '../ai/EmbeddingManager.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Represents a single MetaClaw instance (independent agent).
 */
export class Instance {
  /**
   * @param {Object} opts
   * @param {string} opts.id
   * @param {Object} opts.config — resolved config (from ConfigManager)
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   * @param {import('../core/Router.js').Router} [opts.router]
   */
  constructor({ id, config, eventBus, router }) {
    this.id = id;
    this.config = config;
    this.eventBus = eventBus;
    this.router = router || null;
    this.identity = config._identity || {};
    this.dataDir = config._dir;

    /** @type {'stopped'|'initializing'|'ready'|'running'|'stopping'|'crashed'} */
    this.status = 'stopped';

    /** @type {string[]} — assigned channel IDs */
    this.channelIds = config.channels || [];

    /** @type {string[]} — enabled skill IDs */
    this.skillIds = config.skills || [];

    /** @type {ChatStore|null} */
    this.chatStore = null;

    /** @type {MemoryManager|null} */
    this.memory = null;
    /** @type {KnowledgeManager|null} */
    this.knowledge = null;
    /** @type {ToolExecutor|null} */
    this.tools = null;
    /** @type {TopicManager|null} */
    this.topics = null;
    /** @type {RAGEngine|null} */
    this.rag = null;
    /** @type {StatsTracker|null} */
    this.statsTracker = null;
    /** @type {AutoMemory|null} */
    this.autoMemory = null;
    /** @type {LessonLearner|null} */
    this.lessonLearner = null;
    /** @type {Scheduler|null} */
    this.scheduler = null;
    /** @type {SessionSpawner|null} */
    this.spawner = null;
    /** @type {BackgroundTracker|null} */
    this.bgTracker = null;

    /** @type {{inputTokens:number, outputTokens:number, cost:number, requests:number}} */
    this.stats = { inputTokens: 0, outputTokens: 0, cost: 0, requests: 0, totalMessages: 0 };
  }

  get name() { return this.identity.name || this.id; }
  get personality() { return this.identity.personality || ''; }
  get emoji() { return this.identity.emoji || '🤖'; }
  get model() { return this.config.model?.primary || 'anthropic/claude-sonnet-4-6'; }

  /**
   * Start the instance
   */
  async start() {
    this.status = 'initializing';
    this.eventBus.emit('instance.spawn', { id: this.id, name: this.name });
    // Init persistent chat store
    if (this.dataDir) {
      try {
        this.chatStore = new ChatStore(this.dataDir);
        console.log(`[Instance:${this.id}] Chat store initialized`);
      } catch (e) {
        console.error(`[Instance:${this.id}] Chat store error:`, e.message);
      }
    }
    // Init memory + knowledge managers
    if (this.dataDir) {
      try {
        this.memory = new MemoryManager(this.dataDir);
        this.memory.initialize();
        console.log(`[Instance:${this.id}] Memory initialized (${this.memory.dailyLogs.size} daily logs)`);
      } catch (e) {
        console.error(`[Instance:${this.id}] Memory error:`, e.message);
      }
      try {
        this.knowledge = new KnowledgeManager(this.dataDir);
        console.log(`[Instance:${this.id}] Knowledge initialized (${this.knowledge.count()} facts)`);
      } catch (e) {
        console.error(`[Instance:${this.id}] Knowledge error:`, e.message);
      }
    }
    // Init tools, topics, RAG
    if (this.dataDir) {
      try {
        this.tools = new ToolExecutor({ instance: this, config: this.config });
        console.log(`[Instance:${this.id}] Tools initialized (${this.tools.getToolDefinitions().length} tools)`);
      } catch (e) { console.error(`[Instance:${this.id}] Tools error:`, e.message); }

      try {
        this.topics = new TopicManager(this.dataDir);
        console.log(`[Instance:${this.id}] Topics initialized`);
      } catch (e) { console.error(`[Instance:${this.id}] Topics error:`, e.message); }

      try {
        // Init embedding manager (config: embedding.provider, embedding.model, etc.)
        const embConfig = this.config.embedding || {};
        let embedder = null;
        if (embConfig.provider || embConfig.enabled !== false) {
          // Default to local if no explicit provider set
          embedder = new EmbeddingManager({
            provider: embConfig.provider || 'local',
            model: embConfig.model,
            api_url: embConfig.api_url,
            api_key: embConfig.api_key,
            api_model: embConfig.api_model,
            dimensions: embConfig.dimensions,
          });
        }
        this.rag = new RAGEngine(this.dataDir, { embedder });
        await this.rag.initialize();
        const stats = this.rag.getStats();
        console.log(`[Instance:${this.id}] RAG initialized (${stats.totalChunks} chunks, ${stats.provider}, ${stats.model || 'n/a'})`);
      } catch (e) { console.error(`[Instance:${this.id}] RAG error:`, e.message); }
    }

    // StatsTracker
    if (this.dataDir) {
      try {
        this.statsTracker = new StatsTracker(this.dataDir, { chatStore: this.chatStore });
        console.log(`[Instance:${this.id}] StatsTracker initialized ($${this.statsTracker.getCostToday().toFixed(4)} today)`);
      } catch (e) { console.error(`[Instance:${this.id}] StatsTracker error:`, e.message); }
    }

    // AutoMemory
    if (this.dataDir && this.router) {
      try {
        const summaryModel = this.config.models?.summary || this.config.models?.intent || 'gemini-2.5-flash';
        this.autoMemory = new AutoMemory({
          instanceDir: this.dataDir, router: this.router,
          instanceId: this.id, summaryModel, chatStore: this.chatStore,
        });
        console.log(`[Instance:${this.id}] AutoMemory initialized`);
      } catch (e) { console.error(`[Instance:${this.id}] AutoMemory error:`, e.message); }
    }

    // LessonLearner
    if (this.dataDir && this.router) {
      try {
        const extractModel = this.config.models?.intent || 'gemini-2.5-flash';
        this.lessonLearner = new LessonLearner({
          instanceDir: this.dataDir, router: this.router,
          instanceId: this.id, extractModel,
        });
        console.log(`[Instance:${this.id}] LessonLearner initialized (${this.lessonLearner.getStats().totalLessons} lessons)`);
      } catch (e) { console.error(`[Instance:${this.id}] LessonLearner error:`, e.message); }
    }

    // Scheduler
    if (this.dataDir) {
      try {
        this.scheduler = new Scheduler({
          instanceDir: this.dataDir, instanceId: this.id,
          eventBus: this.eventBus, router: this.router,
          timezone: this.config.timezone,
        });
        this.scheduler.start();
        console.log(`[Instance:${this.id}] Scheduler initialized (${this.scheduler.getStats().totalJobs} jobs)`);
      } catch (e) { console.error(`[Instance:${this.id}] Scheduler error:`, e.message); }
    }

    // SessionSpawner + BackgroundTracker
    if (this.router) {
      this.spawner = new SessionSpawner({
        instanceId: this.id, router: this.router,
        eventBus: this.eventBus, defaultModel: this.model,
        tools: this.tools,
      });
      this.bgTracker = new BackgroundTracker({
        instanceId: this.id, eventBus: this.eventBus,
      });
      console.log(`[Instance:${this.id}] SessionSpawner + BackgroundTracker initialized`);
    }

    // Load stats from DB
    if (this.chatStore) {
      try {
        const count = this.chatStore.db.prepare('SELECT COUNT(*) as c FROM messages WHERE role = ?').get('assistant');
        this.stats.requests = count?.c || 0;
        this.stats.totalMessages = this.chatStore.db.prepare('SELECT COUNT(*) as c FROM messages').get()?.c || 0;
      } catch {}
    }
    this.status = 'running';
    console.log(`[Instance:${this.id}] ${this.emoji} ${this.name} is running (model: ${this.model})`);
  }

  /**
   * Stop the instance
   */
  async stop() {
    this.status = 'stopping';
    if (this.statsTracker) this.statsTracker.flush();
    if (this.lessonLearner) this.lessonLearner.flush();
    if (this.autoMemory) this.autoMemory.destroy();
    if (this.scheduler) this.scheduler.stop();
    this.eventBus.emit('instance.stop', { id: this.id });
    this.status = 'stopped';
    console.log(`[Instance:${this.id}] Stopped`);
  }

  /**
   * Build system prompt from identity
   * @returns {string}
   */
  /**
   * Build system prompt with full personality stack:
   * 1. Identity (name, personality)
   * 2. SOUL.md (deep personality)
   * 3. WORKFLOW.md (system rules, read-only)
   * 4. MY_RULES.md (learned rules)
   * 5. Memory context (long-term + recent daily)
   * 6. Knowledge (relevant facts injected per query)
   * 7. RAG (retrieved chunks from memory/knowledge)
   * 8. Topic context hint
   */
  async _buildSystemPrompt(userMessage = '', chatId = '') {
    const parts = [];
    const dir = this.config._dir;

    // 1. Identity
    parts.push(`You are ${this.name}.`);
    if (this.personality) parts.push(this.personality);

    // 2. SOUL.md
    if (dir) {
      try {
        const soulPath = join(dir, 'SOUL.md');
        if (existsSync(soulPath)) parts.push('\n' + readFileSync(soulPath, 'utf8').trim());
      } catch {}
    }

    // 3. WORKFLOW.md (project-level, read-only — NOT in instance dir)
    try {
      const projectRoot = join(import.meta.dirname, '../..');
      const wfPath = join(projectRoot, 'defaults', 'WORKFLOW.md');
      if (existsSync(wfPath)) parts.push('\n' + readFileSync(wfPath, 'utf8').trim());
    } catch {}

    // 4. MY_RULES.md (learned rules)
    if (dir) {
      try {
        const rulesPath = join(dir, 'MY_RULES.md');
        if (existsSync(rulesPath)) {
          const rules = readFileSync(rulesPath, 'utf8').trim();
          if (rules) parts.push('\n## Learned Rules\n' + rules);
        }
      } catch {}
    }

    // 5. Memory context
    if (this.memory) {
      const memCtx = this.memory.getContextForPrompt(3000);
      if (memCtx) parts.push('\n' + memCtx);
    }

    // 6. Knowledge (query-relevant facts)
    if (this.knowledge && userMessage) {
      const kCtx = this.knowledge.getContextForQuery(userMessage, 6);
      if (kCtx) parts.push('\n' + kCtx);
    }

    // 7. RAG (retrieved context — may be async with embeddings)
    if (this.rag && userMessage) {
      const ragCtx = await Promise.resolve(this.rag.getContextForPrompt(userMessage, 2000));
      if (ragCtx) parts.push('\n' + ragCtx);
    }

    // 8. Topic context hint
    if (this.topics && chatId) {
      const topicHint = this.topics.getContextHint(chatId);
      if (topicHint) parts.push(topicHint);
    }

    // 9. Lessons learned (from corrections/errors)
    if (this.lessonLearner && userMessage) {
      const lessonCtx = this.lessonLearner.buildContext(userMessage);
      if (lessonCtx) parts.push(lessonCtx);
    }

    // Fallback instruction
    parts.push('\nBe helpful, concise, and friendly. Respond in the same language as the user.');

    return parts.join('\n');
  }

  /**
   * Get conversation history from persistent store
   * @param {string} chatId
   * @returns {Array<{role:string, content:string, reasoning_content?:string}>}
   */
  _getConversation(chatId) {
    if (!this.chatStore) return [];
    const messages = this.chatStore.getConversation(chatId, 50);
    // Kimi requires reasoning_content on all assistant messages when tools are used
    if (this.model?.includes('kimi')) {
      let assistantCount = 0;
      for (const msg of messages) {
        if (msg.role === 'assistant' && msg.reasoning_content === undefined) {
          msg.reasoning_content = '';
          assistantCount++;
        }
      }
      console.log(`[Instance:${this.id}] Loaded ${messages.length} msgs, ${assistantCount} assistant (added reasoning_content)`);
    }
    return messages;
  }

  /** Get last assistant message for a chat (for correction detection) */
  _getLastAssistantMessage(chatId) {
    if (!this.chatStore) return '';
    try {
      const row = this.chatStore.db.prepare(
        'SELECT text FROM messages WHERE chat_id = ? AND role = ? ORDER BY timestamp DESC LIMIT 1'
      ).get(chatId, 'assistant');
      return row?.text || '';
    } catch { return ''; }
  }

  /**
   * Handle inbound message (from assigned channel)
   * @param {import('../core/types.js').InboundMessage} msg
   * @returns {Promise<string|null>} response text
   */
  async handleMessage(msg) {
    if (this.status !== 'running') return null;
    if (!this.router) return null;

    const chatId = msg.chatId;
    const MAX_TOOL_ROUNDS = 8;

    // Handle /clear command
    if (msg.text?.trim() === '/clear') {
      if (this.chatStore) {
        this.chatStore.clearChat(chatId);
        console.log(`[Instance:${this.id}] Cleared conversation for chat ${chatId}`);
      }
      // Send response through eventBus
      this.eventBus.emit('instance.response', {
        instanceId: this.id,
        chatId,
        text: '✅ Conversation cleared.',
        model: this.model,
        channelId: msg.channelId,
      });
      return '✅ Conversation cleared.';
    }

    // Classify topic
    if (this.topics) this.topics.classify(chatId, msg.text, 'user');

    // Track activity for auto-memory
    if (this.autoMemory) this.autoMemory.trackActivity(chatId, msg.senderName || msg.senderId);

    // Check for corrections (lesson learning)
    if (this.lessonLearner) {
      const prevAssistant = this._getLastAssistantMessage(chatId);
      this.lessonLearner.checkCorrection(msg.text, prevAssistant, chatId).catch(() => {});
    }

    // Persist user message
    if (this.chatStore) {
      this.chatStore.save({ id: msg.id, chatId, role: 'user', text: msg.text, senderId: msg.senderId, timestamp: msg.timestamp });
    }

    const conversation = this._getConversation(chatId);
    const systemPrompt = await this._buildSystemPrompt(msg.text, chatId);
    const tools = this.tools?.getToolDefinitions() || [];

    // Set chat context for tools (scheduler/spawner need chatId + channelId)
    if (this.tools) this.tools.setChatContext(chatId, msg.channelId);

    console.log(`[Instance:${this.id}] Processing message from ${msg.senderId} (${conversation.length} msgs, ${tools.length} tools)`);

    try {
      let totalIn = 0, totalOut = 0;
      // Build working messages (separate from persisted conversation)
      const workingMessages = [...conversation];

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const messages = [{ role: 'system', content: systemPrompt }, ...workingMessages];

        // Use chatWithTools if tools available, otherwise plain chat
        const response = tools.length > 0
          ? await this.router.chatWithTools({ instanceId: this.id, model: this.model, messages, tools, options: { maxTokens: 4096, temperature: 0.7 } })
          : await this.router.chat({ instanceId: this.id, model: this.model, messages, options: { maxTokens: 4096, temperature: 0.7 } });

        totalIn += response.inputTokens || 0;
        totalOut += response.outputTokens || 0;

        // No tool calls → final response
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const text = response.text || '';
          this._trackStats(totalIn, totalOut, msg);
          const metadata = response.reasoningContent ? { reasoningContent: response.reasoningContent } : null;
          this._persistResponse(chatId, text, metadata, msg.channelId);
          this._reindexIfNeeded();
          return text;
        }

        // Execute tool calls
        console.log(`[Instance:${this.id}] Tool round ${round + 1}: ${response.toolCalls.map(t => t.name).join(', ')}`);
        const toolResults = [];
        for (const tc of response.toolCalls) {
          const output = await this.tools.execute(tc.name, tc.input);
          toolResults.push({ id: tc.id, result: typeof output === 'string' ? output.slice(0, 3000) : JSON.stringify(output).slice(0, 3000) });
        }

        // Add tool round to working messages (native format)
        const assistantMsg = {
          role: 'assistant',
          content: response.text || null,
          tool_calls: response.toolCalls.map(tc => ({
            id: tc.id,
            function: { name: tc.name, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) },
          })),
        };
        // Kimi requires reasoning_content on all assistant messages
        if (this.model?.includes('kimi')) {
          assistantMsg.reasoning_content = response.reasoningContent ?? '';
        }
        workingMessages.push(assistantMsg);
        // Persist tool round assistant message to ChatStore
        if (this.chatStore) {
          this.chatStore.save({
            id: crypto.randomUUID(),
            chatId,
            role: 'assistant',
            text: response.text || '',
            metadata: { toolCalls: response.toolCalls, reasoningContent: response.reasoningContent },
            timestamp: Date.now(),
          });
        }
        for (const tr of toolResults) {
          workingMessages.push({ role: 'tool', tool_call_id: tr.id, content: tr.result });
          // Persist tool message to ChatStore
          if (this.chatStore) {
            this.chatStore.save({
              id: crypto.randomUUID(),
              chatId,
              role: 'tool',
              text: tr.result,
              metadata: { toolCallId: tr.id },
              timestamp: Date.now(),
            });
          }
        }
      }

      // Max rounds reached
      this._trackStats(totalIn, totalOut, msg);
      const fallback = '(max tool rounds reached)';
      this._persistResponse(chatId, fallback);
      return fallback;
    } catch (e) {
      console.error(`[Instance:${this.id}] AI error:`, e.message);
      this.eventBus.emit('instance.error', { instanceId: this.id, error: e.message });
      return `⚠️ Error: ${e.message}`;
    }
  }

  _trackStats(inTok, outTok, msg) {
    this.stats.inputTokens += inTok;
    this.stats.outputTokens += outTok;
    this.stats.requests++;
    this.stats.totalMessages += 2;

    // StatsTracker (persistent, with cost)
    if (this.statsTracker) {
      this.statsTracker.record({
        model: this.model,
        inputTokens: inTok,
        outputTokens: outTok,
        userId: msg?.senderId,
        userName: msg?.senderName,
        chatId: msg?.chatId,
      });
    }
  }

  _persistResponse(chatId, text, metadata = null, channelId = null) {
    if (this.chatStore) {
      this.chatStore.save({ id: crypto.randomUUID(), chatId, role: 'assistant', text, timestamp: Date.now(), metadata });
    }
    this.eventBus.emit('instance.response', { instanceId: this.id, chatId, text, model: this.model, channelId });
  }

  _reindexIfNeeded() {
    // Re-index RAG after knowledge/memory may have changed (async, fire-and-forget)
    if (this.rag) { this.rag.reindex().catch(() => {}); }
  }

  /**
   * Health check
   * @returns {import('../core/types.js').HealthStatus}
   */
  healthCheck() {
    return {
      status: this.status === 'running' ? 'healthy' : 'unhealthy',
      message: `${this.name}: ${this.status}`,
      timestamp: Date.now(),
    };
  }

  /**
   * Get stats summary
   */
  getStats() {
    return {
      ...this.stats,
      id: this.id,
      name: this.name,
      model: this.model,
      rag: this.rag?.getStats() || null,
      costToday: this.statsTracker?.getCostToday() || 0,
      statsToday: this.statsTracker?.getTodayData() || null,
      autoMemory: this.autoMemory?.getStats() || null,
      lessons: this.lessonLearner?.getStats() || null,
      scheduler: this.scheduler?.getStats() || null,
      spawner: this.spawner?.getStats() || null,
      background: this.bgTracker?.getStats() || null,
    };
  }
}
