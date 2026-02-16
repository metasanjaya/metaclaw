/**
 * SubAgent - Autonomous AI worker for MetaClaw
 * 
 * Spawns isolated AI agents that plan and execute tasks autonomously.
 * Each sub-agent gets its own context, tools, and reasoning loop.
 * 
 * Architecture: Human → GramJSBridge (main) → SubAgent(s)
 * Philosophy: Main task = "user", sub-agent = autonomous planner + executor
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data/subagents');

// Max output tokens per model
const MODEL_MAX_TOKENS = {
  'claude-opus-4-6': 16384,
  'claude-opus-4-20250514': 16384,
  'claude-sonnet-4-20250514': 16384,
  'claude-sonnet-4-5-20250514': 16384,
  'claude-haiku-3-5-20241022': 8192,
  'gemini-2.5-pro': 65536,
  'gemini-2.5-flash': 65536,
  'gemini-2.5': 65536,
  'gpt-5.2-codex': 32768,
  'gpt-5.1-codex': 32768,
  'gpt-5.1-codex-max': 32768,
  'gpt-4o': 16384,
  'gpt-4o-mini': 16384,
  'gpt-4': 8192,
  'o3-mini': 16384,
};
function getMaxTokens(model, fallback = 8192) {
  return MODEL_MAX_TOKENS[model] || fallback;
}

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ALL_TOOL_DEFINITIONS = [
  {
    name: "shell",
    description: "Execute a shell command on the server",
    params: { command: { type: "string", description: "Shell command to execute" } }
  },
  {
    name: "search",
    description: "Search the web",
    params: { query: { type: "string", description: "Search query" } }
  },
  {
    name: "fetch",
    description: "Fetch webpage content",
    params: { url: { type: "string", description: "URL to fetch" } }
  },
  {
    name: "read",
    description: "Read a file",
    params: { path: { type: "string", description: "File path to read" } }
  },
  {
    name: "write",
    description: "Write content to a file",
    params: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "File content" }
    }
  },
  {
    name: "ls",
    description: "List directory contents",
    params: { path: { type: "string", description: "Directory path" } }
  },
  {
    name: "image",
    description: "Analyze an image",
    params: { prompt: { type: "string", description: "What to analyze in the image" } }
  },
  {
    name: "ask_clarification",
    description: "Ask the user/main task a clarification question when you are stuck and cannot proceed without more information. Only use when absolutely necessary.",
    params: { question: { type: "string", description: "The clarification question" } }
  },
  {
    name: "background_task",
    description: "Run a long-running shell command in background (builds, installs, deploys). Use for commands that take >10 seconds. Returns a task ID to check later. Prefer this over 'shell' for npm install, builds, git clone, etc.",
    params: {
      command: { type: "string", description: "Shell command to run in background" },
      condition: { type: "string", description: "Optional condition to check output (e.g. 'contains:error', '>=90'). Leave empty for no condition." }
    }
  },
  {
    name: "check_task",
    description: "Check the status of a background task. Returns status and output if completed.",
    params: {
      task_id: { type: "string", description: "Task ID from background_task" }
    }
  }
];

export class SubAgent {
  /**
   * @param {Object} opts
   * @param {Object} opts.ai - UnifiedAIClient instance
   * @param {Object} opts.tools - ToolExecutor instance
   * @param {Object} [opts.knowledge] - KnowledgeManager instance
   * @param {Object} [opts.rag] - RAGEngine instance
   * @param {Function} [opts.sendFn] - (peerId, message, replyTo) => Promise
   */
  /**
   * @param {Object} opts
   * @param {Object} opts.ai - UnifiedAIClient instance
   * @param {Object} opts.tools - ToolExecutor instance
   * @param {Object} [opts.knowledge] - KnowledgeManager instance
   * @param {Object} [opts.rag] - RAGEngine instance
   * @param {Function} [opts.sendFn] - (peerId, message, replyTo) => Promise
   * @param {Object} [opts.asyncTaskManager] - AsyncTaskManager for background commands
   */
  constructor({ ai, tools, knowledge, rag, sendFn, asyncTaskManager, config }) {
    this.ai = ai;
    this.tools = tools;
    this.knowledge = knowledge;
    this.rag = rag;
    this.sendFn = sendFn || (() => {});
    this.asyncTaskManager = asyncTaskManager || null;
    this.config = config || {};

    /** @type {Map<string, Object>} */
    this.tasks = new Map();

    /** @type {Map<string, Map<string, Function[]>>} */
    this.listeners = new Map();

    // Restore tasks from disk on startup
    this._restoreFromDisk();

    // Cleanup completed tasks every 30 min
    this._cleanupInterval = setInterval(() => this._cleanup(), 30 * 60 * 1000);
  }

  // ─── Event System ───

  on(taskId, event, callback) {
    if (!this.listeners.has(taskId)) this.listeners.set(taskId, new Map());
    const taskListeners = this.listeners.get(taskId);
    if (!taskListeners.has(event)) taskListeners.set(event, []);
    taskListeners.get(event).push(callback);
    return this;
  }

  _emit(taskId, event, data) {
    const taskListeners = this.listeners.get(taskId);
    if (!taskListeners) return;
    const cbs = taskListeners.get(event) || [];
    for (const cb of cbs) {
      try { cb(data); } catch (e) { console.error(`🤖 Event handler error [${event}]:`, e.message); }
    }
  }

  // ─── Spawn ───

  /**
   * Spawn a new sub-agent task
   * @param {Object} opts
   * @param {string} opts.goal - What to accomplish
   * @param {string} [opts.context] - Additional context
   * @param {string} [opts.peerId] - Telegram peer for notifications
   * @param {string} [opts.chatId] - Chat identifier
   * @param {number} [opts.replyTo] - Message ID to reply to
   * @param {Object} [opts.knowledge] - Knowledge scoping config
   * @param {string} [opts.plannerModel] - Model for planning phase
   * @param {string} [opts.executorModel] - Model for execution turns
   * @param {number} [opts.maxTurns] - Max execution turns (default 10)
   * @param {number} [opts.timeout] - Timeout in ms (default 600000)
   * @param {string[]} [opts.tools] - Allowed tool names (null = all)
   * @param {number} [opts.reportEvery] - Report progress every N turns
   * @param {boolean} [opts.canAskClarification] - Allow asking questions
   * @param {boolean} [opts.requirePlanApproval] - Wait for plan approval
   * @param {string} [opts.dependsOn] - TaskId to wait for
   * @returns {Promise<string>} taskId
   */
  async spawn(opts) {
    const taskId = randomUUID().slice(0, 8);
    const task = {
      id: taskId,
      goal: opts.goal,
      context: opts.context || '',
      peerId: opts.peerId || null,
      chatId: opts.chatId || null,
      replyTo: opts.replyTo || null,

      // Knowledge config
      knowledgeCfg: opts.knowledge || null,

      // Models
      plannerModel: opts.plannerModel || 'openai/gpt-5.2',
      executorModel: opts.executorModel || 'minimax/MiniMax-M2.5',

      // Limits
      maxTurns: opts.maxTurns || Math.min(this.config?.tools?.max_rounds || 100, 100),
      timeout: opts.timeout || 3600000,
      allowedTools: opts.tools || null, // null = all

      // Communication
      reportEvery: opts.reportEvery || 5,
      canAskClarification: opts.canAskClarification !== false,
      requirePlanApproval: opts.requirePlanApproval || false,

      // Chaining
      dependsOn: opts.dependsOn || null,

      // State
      status: 'pending',
      messages: [],
      plan: null,
      turnCount: 0,
      tokensUsed: 0,
      result: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      clarificationQuestion: null,
      clarificationResolve: null,
      _aborted: false,
    };

    this.tasks.set(taskId, task);
    this._persist(task);

    console.log(`🤖 SubAgent [${taskId}] spawned: "${opts.goal}"`);

    // Run in background
    this._run(taskId).catch(err => {
      console.error(`🤖 SubAgent [${taskId}] fatal:`, err.message);
      task.status = 'failed';
      task.error = err.message;
      task.completedAt = Date.now();
      this._persist(task);
      this._emit(taskId, 'error', err);
    });

    return taskId;
  }

  // ─── Main Execution Loop ───

  async _run(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // Wait for dependency
    if (task.dependsOn) {
      task.status = 'waiting_dependency';
      this._persist(task);
      console.log(`🤖 SubAgent [${taskId}] waiting for dependency: ${task.dependsOn}`);
      const depResult = await this._waitForTask(task.dependsOn, task.timeout);
      if (!depResult) {
        task.status = 'failed';
        task.error = `Dependency ${task.dependsOn} failed or timed out`;
        task.completedAt = Date.now();
        this._persist(task);
        this._emit(taskId, 'error', new Error(task.error));
        return;
      }
      task.context += `\n\nOutput from previous task (${task.dependsOn}):\n${depResult}`;
    }

    if (task._aborted) return this._handleAbort(task);

    // Fetch knowledge
    let knowledgeContext = '';
    if (task.knowledgeCfg && (this.knowledge || this.rag)) {
      try {
        knowledgeContext = await this._fetchKnowledge(task.knowledgeCfg);
        if (knowledgeContext) {
          console.log(`🤖 SubAgent [${taskId}] loaded ${knowledgeContext.length} chars of knowledge`);
        }
      } catch (e) {
        console.warn(`🤖 SubAgent [${taskId}] knowledge fetch failed:`, e.message);
      }
    }

    // Planning phase
    task.status = 'planning';
    this._persist(task);
    const plan = await this._generatePlan(task, knowledgeContext);
    task.plan = plan;
    this._persist(task);

    console.log(`🤖 SubAgent [${taskId}] plan: ${plan.steps.length} steps`);
    this._emit(taskId, 'progress', { phase: 'planned', plan });
    this._notify(task, `📋 Plan (${plan.steps.length} steps):\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);

    // Plan approval gate
    if (task.requirePlanApproval) {
      task.status = 'waiting_approval';
      this._persist(task);
      this._notify(task, '⏳ Waiting for plan approval...');
      const answer = await this._waitForClarification(task);
      if (!answer || answer.toLowerCase().includes('reject') || answer.toLowerCase().includes('no')) {
        task.status = 'aborted';
        task.completedAt = Date.now();
        this._persist(task);
        this._emit(taskId, 'complete', { aborted: true, reason: 'Plan rejected' });
        this._notify(task, '🛑 Plan rejected, task aborted.');
        return;
      }
    }

    if (task._aborted) return this._handleAbort(task);

    // Execution phase
    task.status = 'running';
    this._persist(task);

    const systemPrompt = this._buildSystemPrompt(task, knowledgeContext);
    task.messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Execute this goal: ${task.goal}\n\nPlan:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` }
    ];

    const toolDefs = this._getFilteredTools(task.allowedTools, task.canAskClarification);
    const timeoutAt = Date.now() + task.timeout;

    // Reasoning loop: observe → think → act
    while (task.turnCount < task.maxTurns) {
      if (task._aborted) return this._handleAbort(task);

      if (Date.now() > timeoutAt) {
        task.status = 'failed';
        task.error = 'Timeout exceeded';
        task.completedAt = Date.now();
        this._persist(task);
        this._emit(taskId, 'error', new Error('Timeout'));
        this._notify(task, `⏰ Timed out after ${task.turnCount} turns.`);
        return;
      }

      task.turnCount++;
      console.log(`🤖 SubAgent [${taskId}] turn ${task.turnCount}/${task.maxTurns}`);

      const { provider, model } = this._parseModel(task.executorModel);

      let aiResponse;
      const maxRetries = 3;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          aiResponse = await this.ai.chatWithTools(task.messages, toolDefs, {
            provider,
            model,
            maxTokens: getMaxTokens(model, 16384),
            temperature: 0.3,
          });
          break; // success
        } catch (err) {
          const isRetryable = /529|overload|rate.limit|timeout|ECONNRESET|ETIMEDOUT|503|502/i.test(err.message);
          if (isRetryable && attempt < maxRetries) {
            const delay = (attempt + 1) * 10000; // 10s, 20s, 30s
            console.warn(`🤖 SubAgent [${taskId}] retryable error (attempt ${attempt + 1}/${maxRetries}): ${err.message}. Retrying in ${delay/1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          console.error(`🤖 SubAgent [${taskId}] AI error:`, err.message);
          task.status = 'failed';
          task.error = `AI call failed: ${err.message}`;
          task.completedAt = Date.now();
          this._persist(task);
          this._emit(taskId, 'error', err);
          return;
        }
      }

      task.tokensUsed += aiResponse.tokensUsed || 0;

      // No tool calls → task is done
      if (!aiResponse.toolCalls || aiResponse.toolCalls.length === 0) {
        task.result = aiResponse.text || '(no output)';
        task.status = 'completed';
        task.completedAt = Date.now();
        this._persist(task);
        console.log(`🤖 SubAgent [${taskId}] completed in ${task.turnCount} turns (${task.tokensUsed} tokens)`);
        this._emit(taskId, 'complete', { result: task.result, turns: task.turnCount, tokens: task.tokensUsed });
        this._notify(task, `✅ Done (${task.turnCount} turns, ${task.tokensUsed} tokens):\n${task.result.slice(0, 2000)}`);
        return;
      }

      // Execute tools
      const toolResults = [];
      for (const tc of aiResponse.toolCalls) {
        console.log(`🤖 SubAgent [${taskId}] tool: ${tc.name}(${JSON.stringify(tc.input).slice(0, 80)})`);

        // Handle clarification tool specially
        if (tc.name === 'ask_clarification' && task.canAskClarification) {
          const question = tc.input?.question || 'Need clarification';
          task.status = 'waiting_clarification';
          task.clarificationQuestion = question;
          this._persist(task);
          this._emit(taskId, 'clarification', question);
          this._notify(task, `❓ Asks: ${question}`);

          const answer = await this._waitForClarification(task);
          toolResults.push({ id: tc.id, result: answer || 'No answer provided. Continue with your best judgment.' });

          task.status = 'running';
          task.clarificationQuestion = null;
          this._persist(task);
          continue;
        }

        const result = await this._executeTool(tc.name, tc.input);
        toolResults.push({ id: tc.id, result });
      }

      // Push messages in the format Anthropic provider expects:
      // 1. Assistant message with tool_calls (OpenAI format — provider converts to Anthropic)
      // 2. Individual tool result messages (role: 'tool')
      task.messages.push({
        role: 'assistant',
        content: aiResponse.text || null,
        tool_calls: aiResponse.toolCalls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.name,
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
          },
        })),
      });

      for (const tr of toolResults) {
        task.messages.push({
          role: 'tool',
          tool_call_id: tr.id,
          content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
        });
      }

      // Progress reporting
      if (task.turnCount % task.reportEvery === 0) {
        const toolNames = aiResponse.toolCalls.map(t => t.name).join(', ');
        const summary = `Turn ${task.turnCount}/${task.maxTurns} | Tools: ${toolNames} | Tokens: ${task.tokensUsed}`;
        this._emit(taskId, 'progress', { turn: task.turnCount, summary });
        this._notify(task, `🔄 ${summary}`);
      }

      this._persist(task);
    }

    // Max turns exhausted — ask AI for a final summary
    console.log(`🤖 SubAgent [${taskId}] max turns reached, requesting summary...`);
    try {
      const { provider, model } = this._parseModel(task.executorModel);
      task.messages.push({
        role: 'user',
        content: 'Max execution turns reached. Give a final summary of what was accomplished and what remains.',
      });

      const summary = await this.ai.chatWithTools(task.messages, [], {
        provider, model, maxTokens: getMaxTokens(model, 8192), temperature: 0.3,
      });

      task.tokensUsed += summary.tokensUsed || 0;
      task.result = summary.text || '(max turns reached, no summary)';
    } catch (e) {
      task.result = task.messages[task.messages.length - 1]?.content || '(max turns reached)';
    }

    task.status = 'completed';
    task.completedAt = Date.now();
    this._persist(task);
    console.log(`🤖 SubAgent [${taskId}] completed (max turns) in ${task.turnCount} turns`);
    this._emit(taskId, 'complete', { result: task.result, turns: task.turnCount, tokens: task.tokensUsed, maxTurnsReached: true });
    this._notify(task, `⚠️ Max turns reached. Summary:\n${task.result.slice(0, 2000)}`);
  }

  // ─── Planning ───

  async _generatePlan(task, knowledgeContext) {
    const { provider, model } = this._parseModel(task.plannerModel);

    const planMessages = [
      {
        role: 'system',
        content: `You are a planning agent. Given a goal and context, generate a concise step-by-step plan.
Output ONLY a JSON array of step strings. No markdown, no explanation.
Example: ["Step 1: Check current state", "Step 2: Make changes", "Step 3: Verify"]`
      },
      {
        role: 'user',
        content: `Goal: ${task.goal}${task.context ? `\n\nContext: ${task.context}` : ''}${knowledgeContext ? `\n\nRelevant Knowledge:\n${knowledgeContext}` : ''}\n\nGenerate a plan.`
      }
    ];

    try {
      // Use regular chat for planning (no tools needed)
      const p = this.ai._getProvider(provider);
      const result = await p.chat(planMessages, { model, maxTokens: getMaxTokens(model, 4096), temperature: 0.3 });
      const text = (result?.text || result?.content || String(result)).trim();

      // Parse JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const steps = JSON.parse(jsonMatch[0]);
        if (Array.isArray(steps) && steps.length > 0) {
          return { steps: steps.map(s => String(s)), createdAt: Date.now() };
        }
      }

      // Fallback: split by newlines
      const steps = text.split('\n').filter(l => l.trim()).map(l => l.replace(/^\d+[\.\)]\s*/, '').trim());
      return { steps: steps.length > 0 ? steps : [task.goal], createdAt: Date.now() };
    } catch (err) {
      console.error(`🤖 SubAgent [${task.id}] planning failed:`, err.message);
      return { steps: [task.goal], createdAt: Date.now() };
    }
  }

  // ─── Knowledge ───

  async _fetchKnowledge(cfg) {
    const parts = [];
    const maxDocs = cfg.maxDocs || 5;

    if (this.rag && cfg.query) {
      try {
        const results = await this.rag.search(cfg.query, { limit: maxDocs });
        if (results?.length) {
          parts.push(results.map(r => `[${r.source || 'doc'}] ${r.content}`).join('\n\n'));
        }
      } catch (e) {
        console.warn('🤖 RAG search failed:', e.message);
      }
    }

    if (this.knowledge && cfg.collections) {
      for (const col of cfg.collections) {
        try {
          const docs = await this.knowledge.search(cfg.query || '', { collection: col, limit: maxDocs });
          if (docs?.length) {
            parts.push(docs.map(d => `[${col}] ${d.content || d.text || ''}`).join('\n\n'));
          }
        } catch (e) {
          console.warn(`🤖 Knowledge search [${col}] failed:`, e.message);
        }
      }
    }

    return parts.join('\n\n---\n\n');
  }

  // ─── Tool Execution ───

  _getFilteredTools(allowList, includeClarification = true) {
    // Special tools that are auto-included based on capabilities
    const autoInclude = new Set();
    if (includeClarification) autoInclude.add('ask_clarification');
    if (this.asyncTaskManager) {
      autoInclude.add('background_task');
      autoInclude.add('check_task');
    }

    let defs = ALL_TOOL_DEFINITIONS;

    // Remove background_task/check_task if no asyncTaskManager
    if (!this.asyncTaskManager) {
      defs = defs.filter(t => t.name !== 'background_task' && t.name !== 'check_task');
    }

    // Filter by allowlist if provided
    if (allowList) {
      const allowed = new Set([...allowList, ...autoInclude]);
      defs = defs.filter(t => allowed.has(t.name));
    }

    // Remove clarification tool if not allowed
    if (!includeClarification) {
      defs = defs.filter(t => t.name !== 'ask_clarification');
    }

    return defs;
  }

  async _executeTool(name, input) {
    try {
      switch (name) {
        case 'shell': {
          const r = await this.tools.execShell(input.command, { timeout: 60000 });
          const out = (r.stdout || '') + (r.stderr ? `\nSTDERR: ${r.stderr}` : '');
          return out.slice(0, 10240) || '(empty output)';
        }
        case 'search': {
          const results = await this.tools.webSearch(input.query);
          return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') || '(no results)';
        }
        case 'fetch': {
          const f = await this.tools.webFetch(input.url);
          return (`Title: ${f.title}\n\n${f.content}`).slice(0, 10240);
        }
        case 'read':
          return (await this.tools.readFile(input.path) || '(empty)').slice(0, 10240);
        case 'write':
          await this.tools.writeFile(input.path, input.content);
          return `Written ${input.content.length} chars to ${input.path}`;
        case 'ls':
          return await this.tools.listDir(input.path) || '(empty directory)';
        case 'image': {
          const a = await this.tools.analyzeImage(input.path || input.image, input.prompt || '');
          return a.description || JSON.stringify(a);
        }
        case 'background_task': {
          if (!this.asyncTaskManager) return 'Error: background tasks not available';
          const taskId = this.asyncTaskManager.add({
            peerId: null,  // SubAgent handles notifications, not AsyncTaskManager
            chatId: null,
            cmd: input.command,
            msg: input.command,
            if: input.condition || null,
            aiAnalysis: false,  // SubAgent will analyze results itself
            timeout: 120000,
          });
          return `Background task started: ${taskId}. Use check_task to monitor.`;
        }
        case 'check_task': {
          if (!this.asyncTaskManager) return 'Error: background tasks not available';
          const t = this.asyncTaskManager.get(input.task_id);
          if (!t) return `Task '${input.task_id}' not found`;
          if (t.status === 'running') {
            const elapsed = ((Date.now() - t.startedAt) / 1000).toFixed(0);
            return `Status: running (${elapsed}s elapsed)`;
          }
          const output = (t.output || t.error || '(empty)').slice(0, 5000);
          return `Status: ${t.status}\nOutput:\n${output}`;
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error [${name}]: ${err.message}`;
    }
  }

  // ─── System Prompt ───

  _buildSystemPrompt(task, knowledgeContext) {
    let prompt = `You are an autonomous sub-agent executing a specific task.

GOAL: ${task.goal}`;

    if (task.context) prompt += `\nCONTEXT: ${task.context}`;

    prompt += `

You have access to tools. Use them to accomplish the goal step by step.
When the goal is fully achieved, respond with a final summary WITHOUT calling any tools.

Rules:
- Be methodical: verify each step before moving to the next
- If a command fails, try to fix it or find alternatives
- Keep output concise and focused on results
- Only use ask_clarification when absolutely stuck and cannot proceed`;

    if (task.plan) {
      prompt += `\n\nPLAN:\n${task.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    }

    if (knowledgeContext) {
      prompt += `\n\nRELEVANT KNOWLEDGE:\n${knowledgeContext}`;
    }

    return prompt;
  }

  // ─── Model Parsing ───

  _parseModel(modelStr) {
    if (modelStr.includes('/')) {
      const [provider, ...rest] = modelStr.split('/');
      return { provider, model: rest.join('/') };
    }
    if (modelStr.startsWith('claude')) return { provider: 'anthropic', model: modelStr };
    if (modelStr.startsWith('gpt') || modelStr.startsWith('o1') || modelStr.startsWith('o3')) return { provider: 'openai', model: modelStr };
    if (modelStr.startsWith('gemini')) return { provider: 'google', model: modelStr };
    if (modelStr.startsWith('grok')) return { provider: 'grok', model: modelStr };
    if (modelStr.startsWith('deepseek')) return { provider: 'deepseek', model: modelStr };
    return { provider: 'anthropic', model: modelStr };
  }

  // ─── Communication ───

  _notify(task, message) {
    if (task.peerId && this.sendFn) {
      try {
        this.sendFn(task.peerId, `🤖 [${task.id}] ${message}`, task.replyTo);
      } catch (e) {
        console.warn(`🤖 SubAgent [${task.id}] notify failed:`, e.message);
      }
    }
  }

  async _waitForClarification(task) {
    return new Promise((resolve) => {
      task.clarificationResolve = resolve;
      // Timeout after 5 minutes
      const timer = setTimeout(() => {
        if (task.clarificationResolve === resolve) {
          task.clarificationResolve = null;
          resolve(null);
        }
      }, 5 * 60 * 1000);

      // Also resolve if task is aborted
      const checkAbort = setInterval(() => {
        if (task._aborted) {
          clearTimeout(timer);
          clearInterval(checkAbort);
          task.clarificationResolve = null;
          resolve(null);
        }
      }, 1000);

      // Cleanup interval when resolved
      const origResolve = resolve;
      task.clarificationResolve = (val) => {
        clearTimeout(timer);
        clearInterval(checkAbort);
        origResolve(val);
      };
    });
  }

  async _waitForTask(taskId, timeout) {
    const deadline = Date.now() + timeout;
    return new Promise((resolve) => {
      const check = () => {
        const dep = this.tasks.get(taskId);
        if (!dep) return resolve(null);
        if (dep.status === 'completed') return resolve(dep.result);
        if (dep.status === 'failed' || dep.status === 'aborted') return resolve(null);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(check, 2000);
      };
      check();
    });
  }

  _handleAbort(task) {
    task.status = 'aborted';
    task.completedAt = Date.now();
    this._persist(task);
    console.log(`🤖 SubAgent [${task.id}] aborted`);
    this._emit(task.id, 'complete', { aborted: true });
    this._notify(task, '🛑 Task aborted.');
  }

  // ─── Management ───

  answerClarification(taskId, answer) {
    const task = this.tasks.get(taskId);
    if (!task || !task.clarificationResolve) return false;
    task.clarificationResolve(answer);
    task.clarificationResolve = null;
    task.clarificationQuestion = null;
    return true;
  }

  getStatus(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      id: task.id,
      goal: task.goal,
      status: task.status,
      turnCount: task.turnCount,
      maxTurns: task.maxTurns,
      tokensUsed: task.tokensUsed,
      plan: task.plan,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      clarificationQuestion: task.clarificationQuestion,
    };
  }

  listAll() {
    return Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      goal: t.goal.slice(0, 80),
      status: t.status,
      turns: t.turnCount,
      tokens: t.tokensUsed,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }));
  }

  abort(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (['completed', 'failed', 'aborted'].includes(task.status)) return false;
    task._aborted = true;
    // Unblock clarification wait if active
    if (task.clarificationResolve) {
      task.clarificationResolve(null);
      task.clarificationResolve = null;
    }
    return true;
  }

  /**
   * Abort all running/pending sub-agents
   * @returns {number} Number of agents aborted
   */
  abortAll() {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (!['completed', 'failed', 'aborted'].includes(task.status)) {
        task._aborted = true;
        task.status = 'aborted';
        task.error = 'Stopped by abortAll command';
        task.completedAt = Date.now();
        if (task.clarificationResolve) {
          task.clarificationResolve(null);
          task.clarificationResolve = null;
        }
        this._persist(task);
        count++;
      }
    }
    if (count > 0) console.log(`🤖 Aborted ${count} sub-agents`);
    return count;
  }

  /**
   * Clear all sub-agents (abort running + delete from memory and disk)
   * @returns {number} Number of agents cleared
   */
  clearAll() {
    this.abortAll();
    const count = this.tasks.size;
    // Delete all persisted files
    for (const [id] of this.tasks) {
      try {
        const fp = path.join(DATA_DIR, `${id}.json`);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {}
    }
    this.tasks.clear();
    this.listeners.clear();
    console.log(`🤖 Cleared ${count} sub-agents`);
    return count;
  }

  // ─── Persistence ───

  _persist(task) {
    try {
      // Persist full state including messages (for resume after restart)
      // Messages can be large, so we cap at last 30 messages for persistence
      const messagesToPersist = task.messages.slice(-30).map(m => {
        // Strip embeddings or large binary data
        const msg = { role: m.role };
        if (m.content) msg.content = typeof m.content === 'string' ? m.content.slice(0, 5000) : m.content;
        if (m.toolCalls) msg.toolCalls = m.toolCalls;
        if (m.toolResults) msg.toolResults = m.toolResults.map(tr => ({
          id: tr.id,
          result: typeof tr.result === 'string' ? tr.result.slice(0, 2000) : tr.result,
        }));
        return msg;
      });

      const data = {
        id: task.id,
        goal: task.goal,
        context: task.context?.slice(0, 2000),
        peerId: task.peerId,
        chatId: task.chatId,
        replyTo: task.replyTo,
        knowledgeCfg: task.knowledgeCfg,
        plannerModel: task.plannerModel,
        executorModel: task.executorModel,
        maxTurns: task.maxTurns,
        timeout: task.timeout,
        allowedTools: task.allowedTools,
        reportEvery: task.reportEvery,
        canAskClarification: task.canAskClarification,
        dependsOn: task.dependsOn,
        status: task.status,
        plan: task.plan,
        turnCount: task.turnCount,
        tokensUsed: task.tokensUsed,
        result: task.result?.slice(0, 5000),
        error: task.error,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        messages: messagesToPersist,
      };
      fs.writeFileSync(
        path.join(DATA_DIR, `${task.id}.json`),
        JSON.stringify(data, null, 2)
      );
    } catch (e) {
      console.warn(`🤖 SubAgent [${task.id}] persist failed:`, e.message);
    }
  }

  _restoreFromDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) return;
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
      let restored = 0;

      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));

          // Only restore recent tasks (last 24h)
          if (Date.now() - data.createdAt > 24 * 60 * 60 * 1000) {
            // Clean up old files
            fs.unlinkSync(path.join(DATA_DIR, f));
            continue;
          }

          // Mark interrupted running tasks as failed
          if (['running', 'planning', 'pending', 'waiting_dependency', 'waiting_clarification', 'waiting_approval'].includes(data.status)) {
            data.status = 'failed';
            data.error = 'Process restarted while task was running';
            data.completedAt = Date.now();
            fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(data, null, 2));
          }

          // Restore into memory (without AbortController/resolve refs)
          this.tasks.set(data.id, {
            ...data,
            _aborted: false,
            clarificationResolve: null,
            clarificationQuestion: data.status === 'waiting_clarification' ? data.clarificationQuestion : null,
          });
          restored++;
        } catch (e) {
          console.warn(`🤖 SubAgent: failed to restore ${f}:`, e.message);
        }
      }

      if (restored > 0) console.log(`🤖 SubAgent: restored ${restored} tasks from disk`);
    } catch (e) {
      console.warn('🤖 SubAgent: restore failed:', e.message);
    }
  }

  _cleanup() {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, task] of this.tasks) {
      if (task.completedAt && task.completedAt < twoHoursAgo) {
        this.tasks.delete(id);
        this.listeners.delete(id);
        try {
          const fp = path.join(DATA_DIR, `${id}.json`);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (e) { /* ignore */ }
        console.log(`🤖 SubAgent [${id}] cleaned up`);
      }
    }
  }

  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}
