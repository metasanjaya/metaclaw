/**
 * GramJS Bridge
 * Connects GramJS client directly to UnifiedAIClient (in-process, no HTTP).
 * Now with Memory + RAG integration.
 */

import { UnifiedAIClient } from '../ai/UnifiedAIClient.js';
import { StatsTracker } from './StatsTracker.js';
import { MemoryManager } from './MemoryManager.js';
import { RAGEngine } from './RAGEngine.js';
import { EmbeddingManager } from '../core/EmbeddingManager.js';
import { SemanticChunker } from '../core/SemanticChunker.js';
import { ToolExecutor } from './ToolExecutor.js';
import { Scheduler } from './Scheduler.js';
import { ChatQueue } from './ChatQueue.js';
import { TaskRunner } from './TaskRunner.js';
import { AsyncTaskManager } from './AsyncTaskManager.js';
import { ConversationManager } from './ConversationManager.js';
import { TopicManager } from './TopicManager.js';
import { KnowledgeManager } from './KnowledgeManager.js';
import { TaskPlanner } from './TaskPlanner.js';
import { SubAgent } from './SubAgent.js';
import SessionManager from './SessionManager.js';
import SkillManager from './SkillManager.js';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import axios from 'axios';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Patterns that indicate sensitive content
const SENSITIVE_PATTERNS = [
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{33,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b[0-9a-f]{32,}\b/,
  /\bghp_[A-Za-z0-9]{36,}\b/,
  /\bpassword\s*[:=]\s*\S+/i,
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\btoken\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*\S+/i,
];

function isSensitive(text) {
  return SENSITIVE_PATTERNS.some(p => p.test(text));
}

function loadCorePersonality() {
  const pDir = path.join(__dirname, '../../personality');
  let prompt = '';
  // Only load SOUL.md and IDENTITY.md (always included, small core files)
  for (const file of ['SOUL.md', 'IDENTITY.md']) {
    const p = path.join(pDir, file);
    if (fs.existsSync(p)) {
      prompt += fs.readFileSync(p, 'utf-8').trim() + '\n\n';
    }
  }
  if (!prompt) {
    prompt = 'You are a helpful AI assistant. Be concise and friendly.';
  }
  prompt += '\nRespond in the same language as the user. Keep responses short unless asked for detail.';

  // Tool instructions
  prompt += `

## Tools Available
When you need to use a tool, output the tool call in this exact format:
[TOOL: shell] command here [/TOOL]
[TOOL: search] query here [/TOOL]
[TOOL: fetch] https://url.com [/TOOL]
[TOOL: read] /path/to/file [/TOOL]
[TOOL: write path=/path/to/file] content here [/TOOL]
[TOOL: ls] /path/to/dir [/TOOL]
[TOOL: image] prompt for image analysis [/TOOL]

You can use multiple tools in one response. After tool results are provided, give your final answer.
Only use tools when actually needed — for simple chat, just respond normally.`;

  return prompt;
}

export class GramJSBridge {
  constructor(config, gramClient) {
    this.config = config;
    this.gram = gramClient;
    this.conversationMgr = null; // initialized after embedder is ready
    this.topicMgr = new TopicManager();

    // Initialize AI client (default provider from complex model config)
    const defaultModel = config.models?.complex || { provider: 'google', model: 'gemini-2.5-pro' };
    this.ai = new UnifiedAIClient({
      provider: defaultModel.provider,
      model: defaultModel.model,
      remote: config.llm?.remote,
      local: config.llm?.local,
    });

    // Initialize stats tracker
    this.stats = new StatsTracker();

    // Core personality (SOUL.md + IDENTITY.md) - always in system prompt
    this.corePrompt = loadCorePersonality();

    // Workspace
    this.workspacePath = path.resolve(this.config.workspace?.path || './workspace');
    if (!fs.existsSync(this.workspacePath)) fs.mkdirSync(this.workspacePath, { recursive: true });

    // Tool executor
    this.tools = new ToolExecutor();
    this.tools.setWorkspace(this.workspacePath);

    // Persistent scheduler (survives restarts)
    this.scheduler = new Scheduler(
      // Direct send function
      async (peerId, message, replyTo) => {
        await this.gram.sendMessage(peerId, message, replyTo);
      },
      // Agent function — route through AI pipeline
      async (peerId, chatId, prompt) => {
        const systemPrompt = await this._buildSystemPrompt(prompt, chatId);
        await this.gram.setTyping(peerId);
        const typingInterval = setInterval(() => {
          this.gram.setTyping(peerId).catch(() => {});
        }, 6000);
        try {
          this.conversationMgr.addMessage(chatId, 'user', `[Scheduled task] ${prompt}`);
          const maxRounds = this.config.tools?.max_rounds || 20;
          const { responseText } = await this._processWithTools(chatId, systemPrompt, null, maxRounds, prompt);
          clearInterval(typingInterval);
          if (responseText) {
            this.conversationMgr.addMessage(chatId, 'assistant', responseText);
            await this.gram.sendMessage(peerId, responseText);
          }
        } catch (e) {
          clearInterval(typingInterval);
          throw e;
        }
      },
      // Check function — run command first, evaluate condition, feed to AI if triggered
      async (peerId, chatId, command, prompt, condition) => {
        const { execSync } = await import('child_process');
        let cmdOutput, cmdFailed = false;
        try {
          cmdOutput = execSync(command, { timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 512 }).trim();
        } catch (e) {
          cmdOutput = (e.stderr || e.stdout || e.message || '').trim();
          cmdFailed = true;
        }

        // Evaluate condition — if not met, stay silent (0 tokens)
        if (condition && !cmdFailed) {
          const triggered = this._evaluateCondition(cmdOutput, condition);
          if (!triggered) {
            console.log(`  ⏭️ Check condition not met: "${condition}" (output: "${cmdOutput.substring(0, 80)}")`);
            return; // Silent — don't call AI
          }
          console.log(`  ⚠️ Check condition triggered: "${condition}" (output: "${cmdOutput.substring(0, 80)}")`);
        }

        // Condition met (or no condition) → feed to AI
        const systemPrompt = await this._buildSystemPrompt(prompt, chatId);
        const combinedPrompt = `[Scheduled check — condition triggered]\nCommand: ${command}\nCondition: ${condition || 'none'}\nOutput:\n\`\`\`\n${cmdOutput}\n\`\`\`\n\nTask: ${prompt}`;
        await this.gram.setTyping(peerId);
        const typingInterval = setInterval(() => {
          this.gram.setTyping(peerId).catch(() => {});
        }, 6000);
        try {
          this.conversationMgr.addMessage(chatId, 'user', combinedPrompt);
          const maxRounds = this.config?.tools?.max_rounds || 20;
          const { responseText: rawSchedText } = await this._processWithTools(chatId, systemPrompt, null, maxRounds, prompt);
          let responseText = (rawSchedText || '').replace(/\[TOOL:\s*\w+[^\]]*\][\s\S]*?\[\/TOOL\]/gi, '').replace(/\[TOOL:\s*\w+\]\s*/gi, '').replace(/\[\/TOOL\]\s*/gi, '').trim();
          responseText = responseText.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[content saved to file]');
          responseText = responseText.replace(/(?:^[A-Za-z0-9+\/=]{40,}\n){5,}/gm, '[...truncated...]\n');
          if (responseText.length > 2000) responseText = responseText.substring(0, 1900) + '\n\n...(truncated)';
          clearInterval(typingInterval);
          if (responseText) {
            this.conversationMgr.addMessage(chatId, 'assistant', responseText);
            await this.gram.sendMessage(peerId, responseText);
          }
        } catch (e) {
          clearInterval(typingInterval);
          throw e;
        }
      }
    );

    // Concurrent chat queue
    // Async task manager (lightweight background tasks)
    this.asyncTasks = new AsyncTaskManager(
      async (peerId, message, replyTo) => {
        await this.gram.sendMessage(peerId, message, replyTo);
      },
      // Agent function for AI analysis — ISOLATED context (no conversation history)
      // Executes in fresh context, then injects compact summary back to main conversation
      async (peerId, chatId, prompt) => {
        console.log(`  🤖 Async agentFn (isolated): analyzing result for ${chatId} (${prompt.length} chars prompt)`);
        const systemPrompt = await this._buildSystemPrompt(prompt, chatId);
        await this.gram.setTyping(peerId);
        const typingInterval = setInterval(() => {
          this.gram.setTyping(peerId).catch(() => {});
        }, 6000);
        try {
          const maxRounds = this.config?.tools?.max_rounds || 20;
          const { responseText: rawText, tokensUsed } = await this._processIsolated(systemPrompt, prompt, maxRounds);
          let responseText = (rawText || '').replace(/\[TOOL:\s*\w+[^\]]*\][\s\S]*?\[\/TOOL\]/gi, '').replace(/\[TOOL:\s*\w+\]\s*/gi, '').replace(/\[\/TOOL\]\s*/gi, '').trim();
          // Same output sanitization as main flow
          responseText = responseText.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[content saved to file]');
          responseText = responseText.replace(/(?:^[A-Za-z0-9+\/=]{40,}\n){5,}/gm, '[...truncated...]\n');
          if (responseText.length > 2000) responseText = responseText.substring(0, 1900) + '\n\n...(truncated)';
          clearInterval(typingInterval);
          if (responseText) {
            console.log(`  📨 Async sending response (${responseText.length} chars)...`);
            await this.gram.sendMessage(peerId, responseText);
            // Inject compact summary into main conversation for continuity
            if (this.conversationMgr) {
              const summary = responseText.length > 300
                ? responseText.substring(0, 297) + '...'
                : responseText;
              this.conversationMgr.addMessage(chatId, 'user', `[Task completed] ${prompt.substring(0, 200)}`);
              this.conversationMgr.addMessage(chatId, 'assistant', `[Task result] ${summary}`);
              console.log(`  📝 Injected async summary to conversation (${summary.length} chars)`);
            }
          } else {
            console.warn(`  ⚠️ Async agentFn: AI returned empty, falling back to raw output`);
            const rawPrompt = prompt.substring(0, 2000);
            await this.gram.sendMessage(peerId, `⚡ Hasil task:\n${rawPrompt}`);
          }
        } catch (e) {
          clearInterval(typingInterval);
          console.error(`  ❌ Async agentFn error: ${e.message}`);
          throw e;
        }
      }
    );

    this.chatQueue = new ChatQueue();

    // Track last file per chat (for when file and text come as separate messages)
    this.lastFilePerChat = new Map();

    // Cost tracking per model (in-memory, resets on restart)
    this.costTracker = {};

    // Task runner (initialized after subsystems)
    this.taskRunner = null;

    // Memory & RAG (initialized async in start())
    this.memory = new MemoryManager();
    this.rag = null;
    this.knowledge = new KnowledgeManager();
    this.planner = new TaskPlanner();

    // Sub-agent system
    this.subAgent = null; // initialized in _initSubsystems after AI is ready

    // Session manager  
    this.sessionMgr = null; // initialized in _initSubsystems after embedder

    // Skill manager
    this.skillMgr = new SkillManager({
      skillsDir: path.resolve('skills'),
      config: this.config,
      tools: this.tools,
    });

    console.log(`🧬 Core personality loaded (${this.corePrompt.length} chars)`);
    console.log('🌉 GramJS Bridge initialized (Google Gemini 2.5 Pro)');
  }

  async _initSubsystems() {
    // Initialize memory
    await this.memory.initialize();

    // Initialize RAG
    let embedder = null;
    try {
      embedder = new EmbeddingManager({ similarityThreshold: 0.3 });
      const chunker = new SemanticChunker({ maxChunkSize: 200, minChunkSize: 50, overlapSize: 30 });
      this.rag = new RAGEngine(embedder, chunker);
      await this.rag.initialize();
      this.conversationMgr = new ConversationManager(embedder);
    } catch (err) {
      console.error('⚠️ RAG initialization failed, running without RAG:', err.message);
      this.rag = null;
    }

    // Initialize TaskRunner with RAG-optimized context
    this.taskRunner = new TaskRunner({
      ai: this.ai,
      rag: this.rag,
      tools: this.tools,
      sendFn: async (peerId, message, replyTo) => {
        await this.gram.sendMessage(peerId, message, replyTo);
      },
      corePrompt: this.corePrompt,
    });
    console.log('🚀 TaskRunner initialized');

    // Initialize SubAgent
    this.subAgent = new SubAgent({
      ai: this.ai,
      tools: this.tools,
      knowledge: this.knowledge,
      rag: this.rag,
      sendFn: async (peerId, message, replyTo) => {
        await this.gram.sendMessage(peerId, message, replyTo);
      },
      asyncTaskManager: this.asyncTasks,
    });
    console.log('🤖 SubAgent system initialized');

    // Initialize SessionManager
    this.sessionMgr = new SessionManager({
      persistPath: path.join(process.cwd(), 'data', 'sessions'),
      embedder: embedder,
      ai: this.ai,
    });
    await this.sessionMgr.ready();
    console.log('📑 SessionManager initialized');

    // Initialize SkillManager
    await this.skillMgr.init();
    console.log('🔌 SkillManager initialized');
  }

  async _transcribeVoice(voicePath) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return null;
    try {
      const audioBuffer = fs.readFileSync(voicePath);
      const base64 = audioBuffer.toString('base64');
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          contents: [{
            parts: [
              { inlineData: { mimeType: 'audio/ogg', data: base64 } },
              { text: 'Transcribe this audio message. Return ONLY the transcription text, nothing else.' },
            ],
          }],
        },
        { headers: { 'content-type': 'application/json' }, timeout: 30000 }
      );
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || null;
      if (text) console.log(`🎤 Voice transcribed: "${text.substring(0, 80)}"`);
      return text;
    } catch (err) {
      console.error(`❌ Voice transcription failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Evaluate a condition against command output
   * Supports: ==, !=, >, <, >=, <=, contains:, !contains:
   * For numeric comparisons, uses first number found in output
   */
  _evaluateCondition(output, condition) {
    const cond = condition.trim();
    const outputTrimmed = output.trim();

    // contains / !contains
    if (cond.startsWith('!contains:')) {
      return !outputTrimmed.includes(cond.substring(10).trim());
    }
    if (cond.startsWith('contains:')) {
      return outputTrimmed.includes(cond.substring(9).trim());
    }

    // Comparison operators: extract number from output for numeric comparisons
    const numMatch = outputTrimmed.match(/([\d.]+)/);
    const outputNum = numMatch ? parseFloat(numMatch[0]) : NaN;

    if (cond.startsWith('!=')) {
      const val = cond.substring(2).trim();
      const valNum = parseFloat(val);
      if (!isNaN(valNum) && !isNaN(outputNum)) return outputNum !== valNum;
      return outputTrimmed !== val;
    }
    if (cond.startsWith('==')) {
      const val = cond.substring(2).trim();
      const valNum = parseFloat(val);
      if (!isNaN(valNum) && !isNaN(outputNum)) return outputNum === valNum;
      return outputTrimmed === val;
    }
    if (cond.startsWith('>=')) {
      return !isNaN(outputNum) && outputNum >= parseFloat(cond.substring(2));
    }
    if (cond.startsWith('<=')) {
      return !isNaN(outputNum) && outputNum <= parseFloat(cond.substring(2));
    }
    if (cond.startsWith('>')) {
      return !isNaN(outputNum) && outputNum > parseFloat(cond.substring(1));
    }
    if (cond.startsWith('<')) {
      return !isNaN(outputNum) && outputNum < parseFloat(cond.substring(1));
    }

    // Default: treat as not-equal check (backward compat)
    return outputTrimmed !== cond;
  }

  async _buildSystemPrompt(userMessage, chatId = null) {
    // Inject current time awareness
    const now = new Date();
    const wib = new Date(now.getTime() + 7 * 3600000);
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const h = wib.getUTCHours();
    const timeOfDay = h < 6 ? 'dini hari' : h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
    const timeStr = `${days[wib.getUTCDay()]}, ${wib.getUTCDate()} ${months[wib.getUTCMonth()]} ${wib.getUTCFullYear()} ${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB (${timeOfDay})`;

    let prompt = this.corePrompt + `\n\n## Waktu Sekarang\n${timeStr}\n`;

    // Knowledge Base: inject relevant facts
    if (this.knowledge) {
      const kb = this.knowledge.buildContext(userMessage);
      if (kb) {
        prompt += kb;
        console.log(`  🧠 Knowledge: ${this.knowledge.findRelevant(userMessage).length} facts injected`);
      }
    }

    // RAG: find relevant context
    if (this.rag) {
      try {
        const results = await this.rag.search(userMessage, 3);
        if (results.length > 0) {
          prompt += '\n\n--- Relevant Context ---\n';
          for (const r of results) {
            prompt += `[${r.source} (${(r.score * 100).toFixed(0)}%)]\n${r.content}\n\n`;
          }
          const sources = results.map(r => `${r.source}(${(r.score * 100).toFixed(0)}%)`).join(', ');
          console.log(`  📎 RAG: ${sources}`);
        }
      } catch (err) {
        console.warn('  ⚠️ RAG search failed:', err.message);
      }
    }

    // Task Planner: inject active plan
    if (this.planner && chatId) {
      const planCtx = this.planner.buildContext(chatId);
      if (planCtx) prompt += planCtx;
    }

    // Topic context: tell AI what topics are active
    if (this.topicMgr && chatId) {
      const topicHint = this.topicMgr.getContextHint(chatId);
      if (topicHint) prompt += `\n\n## Conversation Topics\n${topicHint}\n`;
    }

    // Skill instructions
    if (this.skillMgr) {
      const instructions = this.skillMgr.getInstructions();
      if (instructions) {
        prompt += `\n\n## Skill Instructions\n${instructions}`;
      }
    }

    return prompt;
  }

  _loadSetupCodes() {
    try {
      const p = path.resolve('data/setup-codes.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
    return { codes: [] };
  }

  _saveSetupCodes(data) {
    const dir = path.resolve('data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.resolve('data/setup-codes.json'), JSON.stringify(data, null, 2));
  }

  _generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return `MC-${code}`;
  }

  _getWelcomeMessage(ownerName) {
    const pDir = path.join(__dirname, '../../personality');
    let assistantName = 'MetaClaw';
    try {
      const identity = fs.readFileSync(path.join(pDir, 'IDENTITY.md'), 'utf-8');
      const m = identity.match(/\*\*Nama:\*\*\s*(.+)/);
      if (m) assistantName = m[1].trim();
    } catch {}

    return `Hai ${ownerName}! 👋 Aku ${assistantName}, personal assistant kamu.

Beberapa hal yang bisa aku bantu:
• 💬 Chat biasa / tanya jawab
• 🔧 Jalankan command di server
• 📎 Baca & analisis file
• ⏰ Set reminder (persistent!)
• 🎤 Voice note → transcribe
• 🚀 Background tasks (coding/research)

Commands:
/stats • /dailyusage • /memory • /clear
/remember <text> • /tasks • /invite

Selamat menggunakan! ✨`;
  }

  _isOwner(senderId) {
    const whitelist = this.config.gramjs?.whitelist || this.config.access_control?.allowed_users || [];
    return whitelist.length > 0 && whitelist.includes(parseInt(senderId));
  }

  async _handleCommand(text, peerId, messageId, actualChatId = null) {
    const chatId = actualChatId || peerId;

    if (text === '/clear' || text === '/reset' || text === '/newsession') {
      // Clear internal memory
      if (this.conversationMgr) {
        this.conversationMgr.clear(String(chatId));
        this.conversationMgr._scheduleSave();
      }
      this.lastFilePerChat.delete(chatId);

      // Delete all messages from Telegram chat
      await this.gram.sendMessage(peerId, '🧹 Clearing chat...', messageId);
      const deleted = await this.gram.clearChat(peerId);
      return true;
    }

    if (text.startsWith('/remember ')) {
      const content = text.slice(10).trim();
      if (!content) {
        await this.gram.sendMessage(peerId, '❌ Usage: /remember <text>', messageId);
        return true;
      }
      this.memory.addMemory(content);
      // Re-index RAG
      if (this.rag) await this.rag.reindex();
      await this.gram.sendMessage(peerId, `✅ Remembered: "${content}"`, messageId);
      return true;
    }

    if (text === '/memory') {
      const recent = this.memory.getRecentMemories(3);
      if (!recent.length) {
        await this.gram.sendMessage(peerId, '📭 No recent memories.', messageId);
        return true;
      }
      let msg = '🧠 **Recent Memories**\n\n';
      for (const { date, content } of recent) {
        msg += `**${date}**\n${content.substring(0, 500)}\n\n`;
      }
      await this.gram.sendMessage(peerId, msg.trim(), messageId);
      return true;
    }

    if (text === '/forget') {
      this.memory.clearTodayLog();
      if (this.rag) await this.rag.reindex();
      await this.gram.sendMessage(peerId, '🗑️ Today\'s memory log cleared.', messageId);
      return true;
    }

    // /start CODE — setup code validation & owner registration
    if (text.startsWith('/start MC-')) {
      const code = text.split(' ')[1];
      const data = this._loadSetupCodes();
      const entry = data.codes.find(c => c.code === code && !c.usedBy);

      if (!entry) {
        await this.gram.sendMessage(peerId, '❌ Invalid or already used code.', messageId);
        return true;
      }

      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        await this.gram.sendMessage(peerId, '❌ Code expired.', messageId);
        return true;
      }

      // Get sender info from the message context (we need senderId from caller)
      // peerId in DM is the sender
      const senderId = String(peerId).replace(/^PeerUser\(/, '').replace(/\)$/, '');
      entry.usedBy = senderId;

      // Add to whitelist in config
      const configPath = path.resolve('config.yaml');
      try {
        const rawCfg = fs.readFileSync(configPath, 'utf-8');
        const cfg = yaml.load(rawCfg.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || ''));
        const numId = parseInt(senderId);

        if (!cfg.gramjs) cfg.gramjs = {};
        if (!cfg.gramjs.whitelist) cfg.gramjs.whitelist = [];
        if (!cfg.gramjs.whitelist.includes(numId)) {
          cfg.gramjs.whitelist.push(numId);
        }

        if (!cfg.access_control) cfg.access_control = {};
        if (!cfg.access_control.allowed_users) cfg.access_control.allowed_users = [];
        if (!cfg.access_control.allowed_users.includes(numId)) {
          cfg.access_control.allowed_users.push(numId);
        }

        // Save config (simple write-back)
        let outYaml = yaml.dump(cfg, { lineWidth: 120, noRefs: true });
        const envVars = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'ZAI_API_KEY', 'GOOGLE_API_KEY', 'BRIDGE_SECRET'];
        for (const v of envVars) outYaml = outYaml.replace(new RegExp(`'?\\$\\{${v}\\}'?`, 'g'), `\${${v}}`);
        fs.writeFileSync(configPath, outYaml);

        // Update runtime whitelist
        if (this.gram.whitelist) {
          const bigId = BigInt(numId);
          if (!this.gram.whitelist.includes(bigId)) this.gram.whitelist.push(bigId);
        }
      } catch (err) {
        console.error('❌ Failed to update config whitelist:', err.message);
      }

      this._saveSetupCodes(data);

      const roleLabel = entry.type === 'owner' ? '👑 Owner' : '👤 User';
      console.log(`✅ ${roleLabel} registered: ${senderId} via code ${code}`);

      // Send welcome message & update USER.md
      let entityName = 'there';
      let entityUsername = '';
      try {
        const entity = await this.gram.client.getEntity(peerId);
        entityName = entity?.firstName || 'there';
        entityUsername = entity?.username || '';
      } catch {}

      // Update USER.md with owner/user info
      try {
        const userMdPath = path.resolve('personality/USER.md');
        let userMd = fs.existsSync(userMdPath) ? fs.readFileSync(userMdPath, 'utf-8') : '# USER.md — About the Owner\n\n';
        // Replace or append Telegram ID
        if (userMd.includes('(auto-filled on /start)')) {
          userMd = userMd.replace('(auto-filled on /start)', senderId);
        }
        if (userMd.includes('(pending setup)') && entityName !== 'there') {
          userMd = userMd.replace('(pending setup)', entityName);
        }
        if (entityUsername && !userMd.includes(entityUsername)) {
          userMd += `- **Telegram:** @${entityUsername}\n`;
        }
        fs.writeFileSync(userMdPath, userMd);
        console.log(`📝 USER.md updated with ${entityName}'s info`);
      } catch (err) {
        console.error('⚠️ Failed to update USER.md:', err.message);
      }

      const welcome = this._getWelcomeMessage(entityName);
      await this.gram.sendMessage(peerId, welcome, messageId);
      return true;
    }

    // /invite — owner-only: generate new invite code
    if (text === '/invite') {
      const senderId = String(peerId).replace(/^PeerUser\(/, '').replace(/\)$/, '');
      if (!this._isOwner(senderId)) {
        await this.gram.sendMessage(peerId, '❌ Only the owner can generate invite codes.', messageId);
        return true;
      }

      const code = this._generateInviteCode();
      const now = Date.now();
      const data = this._loadSetupCodes();
      data.codes.push({ code, type: 'user', createdAt: now, expiresAt: now + 24 * 60 * 60 * 1000, usedBy: null });
      this._saveSetupCodes(data);

      await this.gram.sendMessage(peerId, `🎟️ Invite code: **${code}**\n\nShare this with someone — they send:\n/start ${code}\n\nExpires in 24h.`, messageId);
      return true;
    }

    // /subagent <goal> — spawn a sub-agent task
    if (text.startsWith('/subagent ')) {
      const goal = text.slice(10).trim();
      if (!goal) {
        await this.gram.sendMessage(peerId, '❌ Usage: /subagent <goal>', messageId);
        return true;
      }
      if (!this.subAgent) {
        await this.gram.sendMessage(peerId, '❌ SubAgent not initialized yet.', messageId);
        return true;
      }
      const taskId = await this.subAgent.spawn({
        goal,
        peerId: String(peerId),
        chatId,
        replyTo: messageId,
        executorModel: this.config.models?.simple?.model || 'claude-sonnet-4-5',
        plannerModel: this.config.models?.complex?.model || 'claude-opus-4-6',
      });
      await this.gram.sendMessage(peerId, `🤖 SubAgent [${taskId}] spawned: "${goal}"`, messageId);
      return true;
    }

    // /subagent:status [taskId] — check sub-agent status
    if (text.startsWith('/subagent:status')) {
      if (!this.subAgent) {
        await this.gram.sendMessage(peerId, '❌ SubAgent not initialized.', messageId);
        return true;
      }
      const taskId = text.split(' ')[1]?.trim();
      if (taskId) {
        const status = this.subAgent.getStatus(taskId);
        if (!status) {
          await this.gram.sendMessage(peerId, `❌ Task ${taskId} not found.`, messageId);
        } else {
          await this.gram.sendMessage(peerId, `🤖 **Task ${status.id}**\nGoal: ${status.goal}\nStatus: ${status.status}\nTurns: ${status.turnCount}/${status.maxTurns}\nTokens: ${status.tokensUsed}${status.error ? `\nError: ${status.error}` : ''}${status.result ? `\nResult: ${status.result.slice(0, 500)}` : ''}`, messageId);
        }
      } else {
        const all = this.subAgent.listAll();
        if (!all.length) {
          await this.gram.sendMessage(peerId, '📋 No sub-agent tasks.', messageId);
        } else {
          const list = all.map(t => `• [${t.id}] ${t.status} — ${t.goal}`).join('\n');
          await this.gram.sendMessage(peerId, `🤖 **Sub-agents:**\n${list}`, messageId);
        }
      }
      return true;
    }

    // /subagent:abort <taskId>
    if (text.startsWith('/subagent:abort ')) {
      const taskId = text.split(' ')[1]?.trim();
      if (this.subAgent?.abort(taskId)) {
        await this.gram.sendMessage(peerId, `🛑 Task ${taskId} abort requested.`, messageId);
      } else {
        await this.gram.sendMessage(peerId, `❌ Cannot abort ${taskId}.`, messageId);
      }
      return true;
    }

    // /subagent:answer <taskId> <answer> — answer clarification
    if (text.startsWith('/subagent:answer ')) {
      const parts = text.slice(17).trim().split(' ');
      const taskId = parts[0];
      const answer = parts.slice(1).join(' ');
      if (this.subAgent?.answerClarification(taskId, answer)) {
        await this.gram.sendMessage(peerId, `✅ Answer sent to task ${taskId}.`, messageId);
      } else {
        await this.gram.sendMessage(peerId, `❌ Task ${taskId} not waiting for clarification.`, messageId);
      }
      return true;
    }

    // /session list
    if (text === '/session list' || text === '/sessions') {
      if (!this.sessionMgr) {
        await this.gram.sendMessage(peerId, '❌ SessionManager not initialized.', messageId);
        return true;
      }
      const sessions = await this.sessionMgr.listSessions(chatId);
      if (!sessions.length) {
        await this.gram.sendMessage(peerId, '📑 No sessions.', messageId);
      } else {
        const activeId = (await this.sessionMgr.getActiveSession(chatId))?.id;
        const list = sessions.map(s => {
          const active = s.id === activeId ? ' ⬅️' : '';
          return `• [${s.id.slice(0, 12)}] ${s.type} "${s.label}" — ${s.status}${active}`;
        }).join('\n');
        await this.gram.sendMessage(peerId, `📑 **Sessions:**\n${list}`, messageId);
      }
      return true;
    }

    // /session switch <id>
    if (text.startsWith('/session switch ')) {
      const sessionId = text.slice(16).trim();
      try {
        const sessions = await this.sessionMgr.listSessions(chatId);
        const match = sessions.find(s => s.id === sessionId || s.id.startsWith(sessionId));
        if (!match) throw new Error('Session not found');
        const session = await this.sessionMgr.switchSession(chatId, match.id);
        await this.gram.sendMessage(peerId, `📑 Switched to session "${session.label}" (${session.type})`, messageId);
      } catch (e) {
        await this.gram.sendMessage(peerId, `❌ ${e.message}`, messageId);
      }
      return true;
    }

    // /session new <label>
    if (text.startsWith('/session new ')) {
      const label = text.slice(13).trim() || 'New Session';
      const session = await this.sessionMgr.createSession({ chatId, type: 'task', label });
      await this.sessionMgr.switchSession(chatId, session.id);
      await this.gram.sendMessage(peerId, `📑 Created & switched to session "${label}" (${session.id.slice(0, 12)})`, messageId);
      return true;
    }

    // /session close — complete active session, switch to main
    if (text === '/session close') {
      const active = await this.sessionMgr.getActiveSession(chatId);
      if (active.type === 'main') {
        await this.gram.sendMessage(peerId, '❌ Cannot close main session.', messageId);
      } else {
        await this.sessionMgr.completeSession(active.id);
        await this.gram.sendMessage(peerId, `📑 Closed session "${active.label}". Back to main.`, messageId);
      }
      return true;
    }

    // /skill list
    if (text === '/skill list' || text === '/skills') {
      const skills = await this.skillMgr.listSkills();
      if (!skills.length) {
        await this.gram.sendMessage(peerId, '🔌 No skills installed.', messageId);
      } else {
        const list = skills.map(s => `• **${s.name}** v${s.version} [${s.status}] — ${s.description}\n  Tools: ${s.tools.join(', ') || 'none'}`).join('\n');
        await this.gram.sendMessage(peerId, `🔌 **Skills:**\n${list}`, messageId);
      }
      return true;
    }

    // /skill load <name>
    if (text.startsWith('/skill load ')) {
      const name = text.slice(12).trim();
      try {
        const tools = await this.skillMgr.loadSkill(name);
        await this.gram.sendMessage(peerId, `🔌 Loaded skill "${name}" with ${tools.length} tool(s).`, messageId);
      } catch (e) {
        await this.gram.sendMessage(peerId, `❌ ${e.message}`, messageId);
      }
      return true;
    }

    // /skill unload <name>
    if (text.startsWith('/skill unload ')) {
      const name = text.slice(14).trim();
      await this.skillMgr.unloadSkill(name);
      await this.gram.sendMessage(peerId, `🔌 Unloaded skill "${name}".`, messageId);
      return true;
    }

    // /skill reload <name>
    if (text.startsWith('/skill reload ')) {
      const name = text.slice(14).trim();
      try {
        await this.skillMgr.reloadSkill(name);
        await this.gram.sendMessage(peerId, `🔌 Reloaded skill "${name}".`, messageId);
      } catch (e) {
        await this.gram.sendMessage(peerId, `❌ ${e.message}`, messageId);
      }
      return true;
    }

    return false;
  }

  _loadAckConfig() {
    try {
      const data = JSON.parse(fs.readFileSync(path.resolve('data/ack-patterns.json'), 'utf-8'));
      this._ackConfig = data;
      this._ackWords = new Set(data.words || []);
      this._ackEmojis = new Set(data.emojis || []);
      this._ackPhrases = (data.phrases || []).map(p => p.toLowerCase());
      this._ackReactions = data.reactions || ['👍'];
      this._ackMaxWords = data.maxWords || 8;
    } catch {
      this._ackConfig = null;
      this._ackWords = new Set();
      this._ackEmojis = new Set();
      this._ackPhrases = [];
      this._ackReactions = ['👍'];
      this._ackMaxWords = 8;
    }
  }

  _isAcknowledgment(text) {
    // Reload config each time (hot-reloadable)
    this._loadAckConfig();

    const normalized = text.toLowerCase().replace(/[!.,?]+/g, '').trim();
    const words = normalized.split(/\s+/);
    if (words.length > this._ackMaxWords) return false;

    // Check if entire message is just emojis from the list
    if (this._ackEmojis.has(normalized)) return true;

    // Check phrase match (substring)
    for (const phrase of this._ackPhrases) {
      if (normalized.includes(phrase)) return true;
    }

    // All words must be ack words
    return words.length > 0 && words.every(w => this._ackWords.has(w) || this._ackEmojis.has(w));
  }

  _getRandomReaction() {
    return this._ackReactions[Math.floor(Math.random() * this._ackReactions.length)];
  }

  async _detectIntent(text, senderName) {
    // Quick intent check: is this message directed at MetaClaw / needs AI response?
    // Use cheap model with minimal tokens
    try {
      const prompt = `You are an intent classifier. A message was sent in a group chat where you (Nayla) are a participant.
Determine if this message needs YOUR response. Reply ONLY "yes" or "no".

Answer "yes" if:
- Asking a question that you can answer (tech, info, help)
- Talking to you (even without @mention)
- Asking for something you can do (remind, search, code)

Answer "no" if:
- Casual chat between humans
- Message clearly for someone else
- Just reactions, stickers, or "ok/nice/thanks" type messages
- Gossip/banter that doesn't need AI input

Sender: ${senderName}
Message: "${text.substring(0, 200)}"`;

      const intentCfg = this.config.models?.intent || { provider: 'google', model: 'gemini-2.5-flash' };
      const result = await this.ai.generate(prompt, {
        provider: intentCfg.provider,
        model: intentCfg.model,
        maxTokens: 5,
        temperature: 0,
      });

      const answer = (result?.text || result?.content || String(result)).toLowerCase().trim();
      return answer.startsWith('yes');
    } catch (err) {
      console.warn(`  ⚠️ Intent detection failed: ${err.message}`);
      return false; // Default: don't process if unsure
    }
  }

  _getToolDefinitions() {
    const coreDefs = [
      {
        name: "shell",
        description: "Execute a shell command on the server",
        params: {
          command: { type: "string", description: "Shell command to execute" }
        }
      },
      {
        name: "search",
        description: "Search the web",
        params: {
          query: { type: "string", description: "Search query" }
        }
      },
      {
        name: "fetch",
        description: "Fetch webpage content",
        params: {
          url: { type: "string", description: "URL to fetch" }
        }
      },
      {
        name: "read",
        description: "Read a file",
        params: {
          path: { type: "string", description: "File path to read" }
        }
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
        params: {
          path: { type: "string", description: "Directory path" }
        }
      },
      {
        name: "image",
        description: "Analyze an attached image",
        params: {
          prompt: { type: "string", description: "What to analyze in the image" }
        }
      }
    ];

    // Add skill tools
    const skillTools = this.skillMgr ? this.skillMgr.getActiveTools() : [];
    return [...coreDefs, ...skillTools];
  }

  // _parseToolCalls method removed - now using native function calling

  // Patterns that indicate long-running commands (>10s expected)
  _isLongRunningCmd(cmd) {
    const patterns = [
      /\bsleep\s+\d{2,}/i,          // sleep 30+
      /\bapt\s+(install|update|upgrade)/i,
      /\bnpm\s+(install|run\s+build|ci)/i,
      /\byarn\s+(install|build)/i,
      /\bpip\s+install/i,
      /\bgit\s+(clone|pull)/i,
      /\bdocker\s+(build|pull|push)/i,
      /\bcurl\s+.*&&\s*sleep/i,      // curl + sleep combo
      /\bwget\s+/i,
      /\bmake\b/i,
      /\bcargo\s+build/i,
      /\brsync\b/i,
      /\bscp\b/i,
      /\bdd\s+/i,
      /\btar\s+.*[xc]z?f/i,          // tar extract/create
    ];
    return patterns.some(p => p.test(cmd));
  }

  async _callAIWithTools(chatId, systemPrompt, tools, currentQuery) {
    // Build optimized conversation history for the AI (topic-aware)
    const activeTopic = this.topicMgr ? this.topicMgr.getActiveTopic(chatId) : null;
    let history;
    if (this.conversationMgr && currentQuery) {
      history = await this.conversationMgr.getOptimizedHistory(chatId, currentQuery, activeTopic);
    } else if (this.conversationMgr) {
      history = this.conversationMgr.getRawHistory(chatId);
    } else {
      history = [];
    }

    // Ensure first non-system message is 'user' role
    const firstNonSystemIdx = history.findIndex(m => m.role !== 'system');
    if (firstNonSystemIdx !== -1 && history[firstNonSystemIdx].role === 'assistant') {
      // Skip assistant messages at the start until we find a user message
      let skipUntil = firstNonSystemIdx;
      while (skipUntil < history.length && history[skipUntil].role !== 'user') {
        skipUntil++;
      }
      if (skipUntil < history.length) {
        history = [...history.slice(0, firstNonSystemIdx), ...history.slice(skipUntil)];
      } else {
        // No user messages at all — prepend synthetic one
        history = [{ role: 'user', content: '(continued conversation)' }, ...history];
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];

    // Smart model routing based on complexity
    const complexity = this._classifyComplexity(currentQuery || messages[messages.length - 1]?.content, chatId);
    let providerName, modelName;
    const modelCfg = complexity === 'simple'
      ? this.config.models?.simple || { provider: 'google', model: 'gemini-2.5-flash' }
      : this.config.models?.complex || { provider: 'google', model: 'gemini-2.5-pro' };
    providerName = modelCfg.provider;
    modelName = modelCfg.model;

    // Dynamic maxTokens based on complexity
    const maxTokens = complexity === 'complex' ? 8192 : 2048;
    console.log(`  🧠 Routing: ${complexity} → ${providerName}/${modelName} (maxTokens: ${maxTokens})`);

    // Call AI with tools
    try {
      const result = await this.ai.chatWithTools(messages, tools, {
        provider: providerName,
        model: modelName,
        maxTokens,
        temperature: 0.7
      });

      // Track token usage
      const tokensUsed = result.tokensUsed || 0;
      // Stats tracking handled in main message handler via this.stats.record()
      
      // Track daily usage by model
      const dayKey = new Date().toISOString().split('T')[0];
      if (!this.costTracker[modelName]) {
        this.costTracker[modelName] = { total: 0, daily: {} };
      }
      this.costTracker[modelName].total += tokensUsed;
      this.costTracker[modelName].daily[dayKey] = (this.costTracker[modelName].daily[dayKey] || 0) + tokensUsed;

      return result;
    } catch (error) {
      console.error(`❌ AI call failed: ${error.message}`);
      throw error;
    }
  }

  async _executeSingleTool(toolName, toolInput, imagePath) {
    try {
      switch (toolName) {
        case 'shell':
          const cmd = toolInput.command;
          // Auto-detect long-running commands → run async
          if (this._isLongRunningCmd(cmd) && this.asyncTasks) {
            const taskId = this.asyncTasks.add({
              peerId: this._currentPeerId,
              chatId: this._currentChatId,
              cmd: cmd,
              msg: 'Analisis dan rangkum hasil command ini',
              timeout: 300000, // 5 min for long tasks
            });
            const safeLog = cmd.replace(/sshpass\s+-p\s+'[^']*'/g, "sshpass -p '***'")
                              .replace(/sshpass\s+-p\s+\S+/g, "sshpass -p ***")
                              .substring(0, 60);
            console.log(`  ⚡ Auto-async: "${safeLog}" → task ${taskId}`);
            return `⚡ Command berjalan di background (task ${taskId}). Hasil akan dikirim otomatis setelah selesai.`;
          } else {
            const result = await this.tools.execShell(cmd);
            return result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
          }
        
        case 'search':
          const searchResults = await this.tools.webSearch(toolInput.query);
          return searchResults.map((r, i) => 
            `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
          ).join('\n\n');
        
        case 'fetch':
          const fetched = await this.tools.webFetch(toolInput.url);
          return `Title: ${fetched.title}\n\n${fetched.content}`;
        
        case 'read':
          return await this.tools.readFile(toolInput.path);
        
        case 'write':
          return await this.tools.writeFile(toolInput.path, toolInput.content);
        
        case 'ls':
          return await this.tools.listDir(toolInput.path);
        
        case 'image':
          if (imagePath) {
            const analysis = await this.tools.analyzeImage(imagePath, toolInput.prompt || '');
            return analysis.description;
          } else {
            return 'No image available to analyze';
          }
        
        default:
          // Check if it's a skill tool
          if (this.skillMgr && this.skillMgr.isSkillTool(toolName)) {
            return await this.skillMgr.executeTool(toolName, toolInput);
          }
          return `Unknown tool: ${toolName}`;
      }
    } catch (error) {
      const msg = error.message || String(error);
      // Mask sensitive data in error messages
      const maskedPatterns = [
        [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[MASKED_CREDENTIAL]'],
        [/\bAIza[A-Za-z0-9_-]{33,}\b/g, '[API_KEY]'],
        [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[TOKEN]'],
        [/\bpassword\s*[:=]\s*\S+/ig, 'password=[MASKED]'],
        [/\bapi[_-]?key\s*[:=]\s*\S+/ig, 'api_key=[MASKED]']
      ];
      
      let masked = msg;
      for (const [pattern, replacement] of maskedPatterns) {
        masked = masked.replace(pattern, replacement);
      }
      return masked;
    }
  }

  _addToolRoundToHistory(chatId, aiResponse, toolResults) {
    if (!this.conversationMgr) return;

    // Add assistant message with text (if any) - tool calls are internal
    const activeTopic = this.topicMgr ? this.topicMgr.getActiveTopic(chatId) : null;
    if (aiResponse.text && aiResponse.text.trim()) {
      this.conversationMgr.addMessage(chatId, 'assistant', aiResponse.text, activeTopic);
    }

    // Format tool results as readable text for history
    const toolOutputs = [];
    for (const tr of toolResults) {
      const tc = aiResponse.toolCalls.find(t => t.id === tr.id);
      if (tc) {
        toolOutputs.push(`[${tc.name}]:\n${tr.result}`);
      }
    }
    
    if (toolOutputs.length > 0) {
      const resultsText = `Tool results:\n${toolOutputs.join('\n\n')}`;
      this.conversationMgr.addMessage(chatId, 'user', resultsText, activeTopic);
    }
  }

  // _executeToolCalls method removed - now using _executeSingleTool with native function calling

  /**
   * Detect if AI response promises to do something without actually doing it.
   * Returns true if the text contains "will do" patterns (aku cari, tunggu, aku cek, etc.)
   */
  _detectUnfulfilledPromise(text) {
    if (!text || text.length > 500) return false; // long responses are likely complete answers
    const lower = text.toLowerCase();
    const promisePatterns = [
      /aku (cari|cek|lihat|search|check|look|fetch|ambil|cobain|test|coba)/,
      /aku akan (cari|cek|lihat|search|check|look|fetch|ambil)/,
      /let me (search|check|look|find|try|fetch|get)/,
      /i('ll| will) (search|check|look|find|try|fetch|get)/,
      /tunggu.*ya/,
      /wait.*moment/,
      /sebentar/,
      /cari (lagi|dulu|info|data)/,
      /cek (lagi|dulu|ulang)/,
    ];
    return promisePatterns.some(p => p.test(lower));
  }

  _classifyComplexity(text, chatId = null) {
    if (!text) return 'simple';
    const words = text.trim().split(/\s+/);
    const lower = text.toLowerCase();

    // Continuation keywords — if user says "lanjut"/"gas"/"oke"/"test", they're continuing a complex task
    const continueKeywords = ['lanjut', 'lanjutin', 'gas', 'terus', 'next', 'continue', 'oke lanjut', 'go', 'yuk'];
    const isContinuation = words.length <= 5 && continueKeywords.some(kw => lower.includes(kw));

    // If there's an active plan for this chat → always complex (task in progress)
    if (chatId && this.taskPlanner) {
      const activePlan = this.taskPlanner.getActive(chatId);
      if (activePlan) return 'complex';
    }

    // If continuation AND recent history has complex work → complex
    if (isContinuation && chatId && this.conversationMgr) {
      const recent = this.conversationMgr.getRawHistory(chatId).slice(-5);
      const recentText = recent.map(m => m.content).join(' ').toLowerCase();
      const hasComplexContext = ['ssh', 'nginx', 'ssl', 'cert', 'server', 'deploy', 'install', 'config', 'error', 'failed'].some(kw => recentText.includes(kw));
      if (hasComplexContext) return 'complex';
    }

    const codeKeywords = ['function', 'error', 'bug', 'deploy', 'server', 'database', 'api', 'regex', 'config', 'docker', 'git', 'npm', 'build', 'compile', 'debug', 'code', 'script', 'install', 'package', 'module', 'import', 'export', 'class', 'async', 'await', 'promise', 'callback', 'middleware', 'endpoint', 'query', 'schema', 'migration', 'terraform', 'kubernetes', 'nginx', 'systemctl', 'ssh', 'curl', 'wget'];
    const hasCodeKeyword = codeKeywords.some(kw => lower.includes(kw));
    if (words.length < 10 && !hasCodeKeyword) return 'simple';
    if (hasCodeKeyword) return 'complex';
    if (words.length > 50) return 'complex';
    return 'simple';
  }

  async _callAIWithHistory(chatId, systemPrompt, extraUserMsg = null, currentQuery = null) {
    // Build optimized conversation history for the AI (topic-aware)
    const activeTopic = this.topicMgr ? this.topicMgr.getActiveTopic(chatId) : null;
    let history;
    if (this.conversationMgr && currentQuery) {
      history = await this.conversationMgr.getOptimizedHistory(chatId, currentQuery, activeTopic);
    } else if (this.conversationMgr) {
      history = this.conversationMgr.getRawHistory(chatId);
    } else {
      history = [];
    }

    // Ensure first non-system message is 'user' role
    const firstNonSystemIdx = history.findIndex(m => m.role !== 'system');
    if (firstNonSystemIdx !== -1 && history[firstNonSystemIdx].role === 'assistant') {
      // Skip assistant messages at the start until we find a user message
      let skipUntil = firstNonSystemIdx;
      while (skipUntil < history.length && history[skipUntil].role !== 'user') {
        skipUntil++;
      }
      if (skipUntil < history.length) {
        history = [...history.slice(0, firstNonSystemIdx), ...history.slice(skipUntil)];
      } else {
        // No user messages at all — prepend synthetic one
        history = [{ role: 'user', content: '(continued conversation)' }, ...history];
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];
    if (extraUserMsg) {
      messages.push({ role: 'user', content: extraUserMsg });
    }

    // Smart model routing based on complexity
    const complexity = this._classifyComplexity(currentQuery || extraUserMsg, chatId);
    let providerName, modelName;
    const modelCfg = complexity === 'simple'
      ? this.config.models?.simple || { provider: 'google', model: 'gemini-2.5-flash' }
      : this.config.models?.complex || { provider: 'google', model: 'gemini-2.5-pro' };
    providerName = modelCfg.provider;
    modelName = modelCfg.model;

    // Dynamic maxTokens based on complexity
    const maxTokens = complexity === 'complex' ? 8192 : 2048;
    console.log(`  🧠 Routing: ${complexity} → ${providerName}/${modelName} (maxTokens: ${maxTokens})`);

    // Try primary with retry, then fallback
    const callProvider = async (pName, mName) => {
      const provider = this.ai._getProvider(pName);
      const result = await provider.chat(messages, {
        model: mName,
        maxTokens,
        temperature: 0.7,
      });
      return result;
    };

    try {
      const result = await callProvider(providerName, modelName);
      // Track cost
      if (!this.costTracker[modelName]) this.costTracker[modelName] = { input: 0, output: 0, total: 0 };
      this.costTracker[modelName].total += result.tokensUsed || 0;
      return result;
    } catch (primaryErr) {
      console.warn(`  ⚠️ Primary ${providerName}/${modelName} failed: ${primaryErr.message}, retrying in 2s...`);

      // Retry once after 2s
      await new Promise(r => setTimeout(r, 2000));
      try {
        const result = await callProvider(providerName, modelName);
        if (!this.costTracker[modelName]) this.costTracker[modelName] = { input: 0, output: 0, total: 0 };
        this.costTracker[modelName].total += result.tokensUsed || 0;
        return result;
      } catch (retryErr) {
        console.warn(`  ⚠️ Retry failed: ${retryErr.message}`);

        // Fallback to configured fallback model
        const fb = this.config.models?.fallback;
        if (fb && (fb.provider !== providerName || fb.model !== modelName)) {
          console.log(`  ⚠️ Primary failed, falling back to ${fb.provider}/${fb.model}`);
          try {
            const result = await callProvider(fb.provider, fb.model);
            if (!this.costTracker[fb.model]) this.costTracker[fb.model] = { input: 0, output: 0, total: 0 };
            this.costTracker[fb.model].total += result.tokensUsed || 0;
            return result;
          } catch (fbErr) {
            throw new Error(`All models failed. Primary: ${primaryErr.message}, Fallback: ${fbErr.message}`);
          }
        }
        throw retryErr;
      }
    }
  }

  /**
   * Process a task in isolated context — no conversation history, just system prompt + task.
   * Used by AsyncTaskManager for token-efficient background tasks.
   */
  async _processIsolated(systemPrompt, taskPrompt, maxRounds = 10) {
    const tools = this._getToolDefinitions();
    let totalTokens = 0;

    // Isolated message history — starts fresh with just the task
    const isolatedHistory = [
      { role: 'user', content: taskPrompt },
    ];

    // Smart complexity detection — same as main flow
    const complexity = this._classifyComplexity(taskPrompt);
    const modelCfg = complexity === 'simple'
      ? this.config.models?.simple || { provider: 'google', model: 'gemini-2.5-flash' }
      : this.config.models?.complex || { provider: 'google', model: 'gemini-2.5-pro' };
    const maxTokens = complexity === 'complex' ? 8192 : 4096;
    console.log(`  🔒 Isolated processing [${complexity}]: ${modelCfg.provider}/${modelCfg.model}`);

    for (let round = 0; round < maxRounds; round++) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...isolatedHistory,
      ];

      const result = await this.ai.chatWithTools(messages, tools, {
        provider: modelCfg.provider,
        model: modelCfg.model,
        maxTokens,
        temperature: 0.7,
      });
      totalTokens += result.tokensUsed || 0;

      if (!result.toolCalls || result.toolCalls.length === 0) {
        return { responseText: result.text, tokensUsed: totalTokens };
      }

      // Execute tool calls
      const toolResults = [];
      for (const tc of result.toolCalls) {
        const output = await this._executeSingleTool(tc.name, tc.input, null);
        toolResults.push({ id: tc.id, result: output });
      }

      // Add tool round to isolated history (NOT to conversationMgr)
      if (result.text) {
        isolatedHistory.push({ role: 'assistant', content: result.text });
      }
      // Add tool calls as assistant message
      const toolCallSummary = result.toolCalls.map(tc =>
        `[Tool: ${tc.name}] ${JSON.stringify(tc.input).substring(0, 200)}`
      ).join('\n');
      if (!result.text) {
        isolatedHistory.push({ role: 'assistant', content: toolCallSummary });
      }
      // Add tool results as user message
      const toolResultText = toolResults.map(tr => {
        const tc = result.toolCalls.find(t => t.id === tr.id);
        return `[${tc?.name} result]: ${(tr.result || '').substring(0, 2000)}`;
      }).join('\n\n');
      isolatedHistory.push({ role: 'user', content: toolResultText });
    }

    return { responseText: '(max rounds reached)', tokensUsed: totalTokens };
  }

  async _processWithTools(chatId, systemPrompt, imagePath, maxRounds = 3, currentQuery = null) {
    // If image, analyze and add to last user message in history
    if (imagePath) {
      const analysis = await this.tools.analyzeImage(imagePath);
      const chat = this.conversationMgr ? this.conversationMgr.chats.get(chatId) : null;
      const history = chat ? chat.messages : [];
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        lastMsg.content = `[User sent an image: ${analysis.description}]\n\n${lastMsg.content || 'What do you see in this image?'}`;
      }
    }

    const tools = this._getToolDefinitions();
    let totalTokens = 0;

    let promiseRetries = 0; // track "promise to act" retries

    // Check skill triggers
    if (this.skillMgr && currentQuery) {
      await this.skillMgr.checkTriggers(currentQuery);
    }

    for (let round = 0; round < maxRounds; round++) {
      const result = await this._callAIWithTools(chatId, systemPrompt, tools, currentQuery);
      totalTokens += result.tokensUsed || 0;

      if (!result.toolCalls || result.toolCalls.length === 0) {
        // Check if AI promised to do something but didn't use tools
        if (result.text && promiseRetries < 2 && this._detectUnfulfilledPromise(result.text)) {
          promiseRetries++;
          console.log(`  ⚠️ AI promised action but no tool call — forcing follow-up (retry ${promiseRetries})`);
          // Add the broken promise as context and force execution
          this._addToolRoundToHistory(chatId, result, []);
          if (this.conversationMgr) {
            this.conversationMgr.addMessage(chatId, 'user',
              `[System: Kamu bilang "${result.text.substring(0, 100)}..." tapi tidak ada tindakan. JANGAN hanya bilang akan melakukan sesuatu — LANGSUNG gunakan tool yang sesuai SEKARANG. Jika tidak bisa, jelaskan kenapa ke user.]`
            );
          }
          continue; // retry the round
        }
        // No tool calls = AI is done, return text response
        return { responseText: result.text, tokensUsed: totalTokens };
      }

      promiseRetries = 0; // reset on successful tool use

      // Execute each tool call
      const toolResults = [];
      for (const tc of result.toolCalls) {
        const output = await this._executeSingleTool(tc.name, tc.input, imagePath);
        toolResults.push({ id: tc.id, result: output });
      }

      // Format tool output for logging
      const toolOutput = toolResults.map(tr => {
        const tc = result.toolCalls.find(t => t.id === tr.id);
        return `[${tc?.name}]:\n${tr.result}`;
      }).join('\n\n');

      // Detect repeated errors — if same error appears 2+ times, force stop
      const hasPermDenied = toolOutput.includes('Permission denied');
      const hasConnRefused = toolOutput.includes('Connection refused') || toolOutput.includes('Connection timed out');
      const hasApiError = toolOutput.includes('"success":false') || toolOutput.includes('"success": false') || toolOutput.includes('invalid_access');
      const hasRepeatedError = hasPermDenied || hasConnRefused || hasApiError;
      if (hasRepeatedError) {
        this._lastErrorType = (this._lastErrorType === 'access') ? 'access_repeat' : 'access';
      } else {
        this._lastErrorType = null;
      }

      // Add tool interaction to conversation history
      if (this._lastErrorType === 'access_repeat') {
        // Force AI to stop retrying and ask user
        const errorMsg = `[System: STOP. Error yang sama sudah terjadi 2x berturut-turut. JANGAN coba lagi. Langsung kasih tau user masalahnya dan tanya solusi/akses alternatif.]`;
        this._addToolRoundToHistory(chatId, result, toolResults);
        
        if (this.conversationMgr) {
          this.conversationMgr.messages[this.conversationMgr.messages.length - 1].content += `\n\n${errorMsg}`;
        }
        this._lastErrorType = null;
      } else {
        // Add normal tool round to history
        this._addToolRoundToHistory(chatId, result, toolResults);
      }

      console.log(`  🔄 Tool round ${round + 1}/${maxRounds}`);
    }

    // Max rounds exhausted — ask AI to summarize progress and ask user for next steps
    console.log(`  ⚠️ Max tool rounds (${maxRounds}) exhausted — requesting summary`);
    if (this.conversationMgr) {
      this.conversationMgr.addMessage(chatId, 'user', `[System: Max tool rounds (${maxRounds}) reached. Berikan ringkasan progress sejauh ini ke user, apa yang sudah selesai, apa yang belum, dan tanya user mau lanjut yang mana atau ada instruksi lain.]`);
    }
    const final = await this._callAIWithTools(chatId, systemPrompt, [], currentQuery);
    return { responseText: final.text, tokensUsed: totalTokens + (final.tokensUsed || 0) };
  }

  start() {
    // Initialize subsystems in background
    this._initSubsystems().catch(err => {
      console.error('❌ Subsystem init error:', err.message);
    });

    // Start persistent scheduler
    this.scheduler.start();
    this.asyncTasks.start();

    this.gram.onMessage(async (msg) => {
      let text = (msg.text || '').trim();
      const peerId = msg.message.chatId || msg.message.peerId;
      const chatId = msg.chatId;
      const isDM = msg.isDM;
      const isGroup = msg.isGroup;
      const isMentioned = msg.isMentioned;

      // Mark as read
      this.gram.markAsRead(peerId, msg.message.id).catch(() => {});

      // Transcribe voice messages
      if (msg.voicePath) {
        const transcribed = await this._transcribeVoice(msg.voicePath);
        if (transcribed) {
          text = transcribed;
        } else {
          await this.gram.sendMessage(peerId, '⚠️ Could not transcribe voice message.', msg.message.id);
          return;
        }
      }

      // Quick commands bypass queue
      if (text === '/stats' || text === '/stats reset' || text === '/dailyusage') {
        let reply = text === '/stats reset' ? this.stats.reset() : this.stats.getStats();

        // Add cost breakdown from costTracker
        if (text === '/dailyusage' && Object.keys(this.costTracker).length > 0) {
          const COST_PER_MTOK = {
            'claude-sonnet-4-5': { input: 3, output: 15 },
            'claude-opus-4-6': { input: 15, output: 75 },
            'gemini-2.5-flash': { input: 0.075, output: 0.30 },
            'gemini-2.5-pro': { input: 1.25, output: 10 },
          };
          let costLines = '\n\n💰 **Est. Cost Breakdown:**\n';
          let totalCost = 0;
          for (const [model, data] of Object.entries(this.costTracker)) {
            const rates = COST_PER_MTOK[model] || { input: 1, output: 5 };
            // Estimate 70% input, 30% output
            const cost = (data.total / 1_000_000) * (rates.input * 0.7 + rates.output * 0.3);
            totalCost += cost;
            costLines += `• ${model}: ${data.total.toLocaleString()} tok ≈ $${cost.toFixed(4)}\n`;
          }
          costLines += `**Total: ~$${totalCost.toFixed(4)}**`;
          reply += costLines;
        }

        await this.gram.sendMessage(peerId, reply, msg.message.id);
        return;
      }
      if (text === '/tasks') {
        const tasks = this.taskRunner ? this.taskRunner.listForChat(chatId) : [];
        if (!tasks.length) {
          await this.gram.sendMessage(peerId, '📋 No active tasks.', msg.message.id);
        } else {
          const list = tasks.map(t => `• [${t.id}] ${t.status} — ${t.description.substring(0, 50)}`).join('\n');
          await this.gram.sendMessage(peerId, `📋 **Tasks:**\n${list}`, msg.message.id);
        }
        return;
      }
      if (text && await this._handleCommand(text, peerId, msg.message.id, chatId)) return;

      // Skip if no content at all
      const imagePath = msg.imagePath || null;
      const filePath = msg.filePath || null;
      if (!text && !imagePath && !filePath) return;

      // File-only message (no text): track file and acknowledge, don't send to AI
      // Skip stickers/animated stickers — they're not real file attachments
      const isSticker = msg.fileName && /\.(tgs|webp)$/i.test(msg.fileName) && /sticker/i.test(msg.fileName);
      if (!text && filePath && msg.fileName && isSticker) {
        console.log(`  🎨 Sticker ignored: ${msg.fileName}`);
        const delay = 500 + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
        await this.gram.sendReaction(peerId, msg.message.id, '😊');
        return;
      }
      if (!text && filePath && msg.fileName) {
        this.lastFilePerChat.set(chatId, { path: filePath, name: msg.fileName, at: Date.now() });
        console.log(`  📎 File received & tracked: ${msg.fileName} → ${filePath}`);
        const delay = 1000 + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
        await this.gram.sendReaction(peerId, msg.message.id, '👍');
        return;
      }

      // Acknowledgment messages → react with emoji, skip AI
      if (text && this._isAcknowledgment(text)) {
        const delay = 1000 + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
        const emoji = this._getRandomReaction();
        try {
          await this.gram.sendReaction(peerId, msg.message.id, emoji);
          console.log(`  ${emoji} Reacted to acknowledgment: "${text.substring(0, 30)}" (${Math.round(delay)}ms)`);
        } catch (err) {
          console.warn(`  ⚠️ Reaction failed: ${err.message}`);
        }
        return;
      }

      // Group intent detection: if not mentioned, check if message is for us
      if (isGroup && !isMentioned && text) {
        const shouldProcess = await this._detectIntent(text, msg.senderName);
        if (!shouldProcess) {
          console.log(`  💤 Skipped (not for me): "${text.substring(0, 50)}"`);
          return;
        }
        console.log(`  🎯 Intent detected — processing group message`);
      }

      // Enqueue per-chat (parallel across chats, sequential within same chat)
      this.chatQueue.enqueue(chatId, async () => {
        let typingInterval = null;
        try {
          if (!this.conversationMgr) {
            this.conversationMgr = new ConversationManager(null);
          }
          let userContent = text || '[image]';

          // Forward message prefix
          if (msg.isForward && msg.forwardFrom) {
            userContent = `[Forwarded from: ${msg.forwardFrom}]\n${userContent}`;
          }
          // Edited message prefix
          if (msg.isEdit) {
            userContent = `[User edited message to:]\n${userContent}`;
          }

          // Track files per chat
          if (msg.filePath && msg.fileName) {
            this.lastFilePerChat.set(chatId, { path: msg.filePath, name: msg.fileName, at: Date.now() });
            userContent = `[User sent file: ${msg.fileName} → saved at ${msg.filePath}. Use [TOOL: shell] with python3/openpyxl to read it if needed.]\n${userContent}`;
            console.log(`  📎 File tracked: ${msg.fileName} → ${msg.filePath}`);
          } else if (text && this.lastFilePerChat.has(chatId)) {
            // If text message comes after a file (within 120s), attach file context
            const lastFile = this.lastFilePerChat.get(chatId);
            if (Date.now() - lastFile.at < 120000) {
              userContent = `[Referring to previously sent file: ${lastFile.name} → saved at ${lastFile.path}. Use [TOOL: shell] with python3/openpyxl to read it.]\n${userContent}`;
              console.log(`  📎 File context attached: ${lastFile.name}`);
            }
          }
          // Classify topic for this message
          const msgTopic = this.topicMgr.classify(chatId, text || userContent, 'user');
          this.conversationMgr.addMessage(chatId, 'user', userContent, msgTopic);

          // Track current context for auto-async tool calls
          this._currentPeerId = String(peerId);
          this._currentChatId = chatId;

          const systemPrompt = await this._buildSystemPrompt(text || 'image analysis', chatId);
          console.log(`🧠 Processing: "${(text || '[image]').substring(0, 60)}" from ${msg.senderName}`);

          if (text && isSensitive(text)) {
            await this.gram.deleteMessage(peerId, msg.message.id);
          }

          // Start typing indicator with interval (Telegram expires after 5s)
          await this.gram.setTyping(peerId);
          typingInterval = setInterval(() => {
            this.gram.setTyping(peerId).catch(() => {});
          }, 6000);

          // Streaming: send placeholder, edit later
          const useStreaming = this.config.features?.streaming === true;
          let placeholderMsgId = null;
          if (useStreaming) {
            try {
              const sent = await this.gram.client.sendMessage(peerId, { message: '💭' });
              placeholderMsgId = sent?.id;
            } catch {}
          }

          // Process with timeout protection (90 seconds max)
          const maxRounds = this.config.tools?.max_rounds || 20;
          const processPromise = this._processWithTools(
            chatId, systemPrompt, imagePath, maxRounds, text || 'image analysis'
          );
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Processing timeout (180s)')), 180000)
          );
          const { responseText: rawResponse, tokensUsed } = await Promise.race([processPromise, timeoutPromise])
            .catch(err => {
              console.error(`⚠️ Process error: ${err.message}`);
              return { responseText: `⚠️ Proses timeout atau gagal: ${err.message}. Coba lagi ya!`, tokensUsed: 0 };
            });

          let responseText = rawResponse;
          if (!responseText) {
            console.warn('⚠️ Empty response from AI — sending fallback');
            responseText = 'Hmm, kayaknya proses tadi gagal atau hasilnya kosong. Coba ulangi atau kasih detail lebih ya 🤔';
          }

          // Extract [REMEMBER:] tags
          const rememberRegex = /\[REMEMBER:\s*(.+?)\]/gi;
          let match;
          let hasMemory = false;
          while ((match = rememberRegex.exec(responseText)) !== null) {
            this.memory.addMemory(match[1].trim());
            hasMemory = true;
            console.log(`  💾 Auto-remembered: "${match[1].trim()}"`);
          }
          responseText = responseText.replace(/\s*\[REMEMBER:\s*.+?\]/gi, '').trim();
          if (hasMemory && this.rag) this.rag.reindex().catch(() => {});

          // Extract [SCHEDULE: ...] tags — supports JSON format and legacy format
          const scheduleJsonRegex = /\[SCHEDULE:\s*(\{[\s\S]*?\})\s*\]/gi;
          const scheduleLegacyRegex = /\[SCHEDULE:\s*([^\{][^\]]*?)\]/i;
          let schedJsonMatch;
          while ((schedJsonMatch = scheduleJsonRegex.exec(responseText)) !== null) {
            try {
              const spec = JSON.parse(schedJsonMatch[1]);
              // Parse "at": seconds (relative) or ISO string (absolute)
              let triggerAt;
              if (typeof spec.at === 'number') {
                triggerAt = Date.now() + spec.at * 1000;
              } else if (typeof spec.at === 'string') {
                triggerAt = new Date(spec.at).getTime();
              }
              if (!triggerAt || isNaN(triggerAt)) {
                console.warn(`  ⚠️ Invalid schedule time: ${spec.at}`);
                continue;
              }
              this.scheduler.add({
                peerId: String(peerId), chatId,
                message: spec.msg || 'Scheduled task',
                triggerAt,
                repeatMs: spec.repeat ? spec.repeat * 1000 : null,
                type: spec.type || 'direct',
                command: spec.cmd || null,
                condition: spec.if || null,
              });
            } catch (e) {
              console.warn(`  ⚠️ Invalid SCHEDULE JSON: ${e.message}`);
            }
          }
          // Legacy format fallback: [SCHEDULE: <seconds> | <message>]
          if (!scheduleJsonRegex.test(responseText)) {
            const legacyMatch = scheduleLegacyRegex.exec(responseText);
            if (legacyMatch) {
              const parts = legacyMatch[1].split('|').map(s => s.trim());
              const timeSpec = parts[0];
              let triggerAt;
              if (/^\d+$/.test(timeSpec)) {
                triggerAt = Date.now() + parseInt(timeSpec) * 1000;
              } else {
                triggerAt = new Date(timeSpec).getTime();
              }
              if (triggerAt && !isNaN(triggerAt)) {
                const repeatSec = parts.length >= 3 && /^repeat:(\d+)$/i.test(parts[1])
                  ? parseInt(parts[1].match(/\d+/)[0]) : null;
                const msgIdx = repeatSec ? 2 : 1;
                this.scheduler.add({
                  peerId: String(peerId), chatId,
                  message: parts.slice(msgIdx).join('|').trim() || 'Reminder',
                  triggerAt,
                  repeatMs: repeatSec ? repeatSec * 1000 : null,
                });
              }
            }
          }
          responseText = responseText.replace(/\s*\[SCHEDULE:\s*(?:\{[\s\S]*?\}|[^\]]*?)\]/gi, '').trim();

          // Extract [ASYNC: {...}] tags — lightweight background tasks
          const asyncJsonRegex = /\[ASYNC:\s*(\{[\s\S]*?\})\s*\]/gi;
          let asyncMatch;
          while ((asyncMatch = asyncJsonRegex.exec(responseText)) !== null) {
            try {
              const spec = JSON.parse(asyncMatch[1]);
              if (spec.cmd) {
                const taskId = this.asyncTasks.add({
                  peerId: String(peerId), chatId,
                  cmd: spec.cmd,
                  msg: spec.msg || 'Analisis hasil task ini',
                  if: spec.if || null,
                  aiAnalysis: spec.ai !== false, // default true
                  replyTo: msg.message.id,
                  timeout: (spec.timeout || 120) * 1000,
                });
                console.log(`  ⚡ Async task created: [${taskId}] ${spec.cmd.substring(0, 60)}`);
              }
            } catch (e) {
              console.warn(`  ⚠️ Invalid ASYNC JSON: ${e.message}`);
            }
          }
          responseText = responseText.replace(/\s*\[ASYNC:\s*\{[\s\S]*?\}\s*\]/gi, '').trim();

          // Extract [KNOW: {...}] tags — dynamic knowledge base
          if (this.knowledge) {
            responseText = this.knowledge.processResponse(responseText);
          }

          // Extract [PLAN: {...}] and [STEP: {...}] tags — task planner
          if (this.planner) {
            responseText = this.planner.processResponse(chatId, responseText);
          }

          // Extract [SPAWN: type | description] tag — background task
          const spawnRegex = /\[SPAWN:\s*(code|research|general)\s*\|\s*(.+?)\]/i;
          const spawnMatch = spawnRegex.exec(responseText);
          if (spawnMatch && this.taskRunner) {
            const taskType = spawnMatch[1].toLowerCase();
            const taskDesc = spawnMatch[2].trim();
            const taskId = this.taskRunner.spawn({
              peerId: String(peerId), chatId,
              description: taskDesc, type: taskType,
              maxRounds: 5, replyTo: msg.message.id,
            });
            responseText = responseText.replace(/\s*\[SPAWN:\s*.+?\]/gi, '').trim();
            if (!responseText) responseText = `🚀 Task [${taskId}] started: ${taskDesc}`;
          }

          // Extract [FILE: /path] or [FILE: /path | caption] tags
          const fileRegex = /\[FILE:\s*([^\|\]]+?)(?:\s*\|\s*([^\]]+?))?\]/gi;
          let fileMatch;
          const filesToSend = [];
          while ((fileMatch = fileRegex.exec(responseText)) !== null) {
            filesToSend.push({ path: fileMatch[1].trim(), caption: (fileMatch[2] || '').trim() });
          }
          responseText = responseText.replace(/\s*\[FILE:\s*[^\]]+\]/gi, '').trim();

          // Extract [STICKER: emoji] tags — send as large single-emoji message
          const stickerRegex = /\[STICKER:\s*(.+?)\]/gi;
          let stickerMatch;
          const stickersToSend = [];
          while ((stickerMatch = stickerRegex.exec(responseText)) !== null) {
            stickersToSend.push(stickerMatch[1].trim());
          }
          responseText = responseText.replace(/\s*\[STICKER:\s*.+?\]/gi, '').trim();

          // Extract [VOICE: text to speak] tags
          const voiceRegex = /\[VOICE:\s*(.+?)\]/gi;
          let voiceMatch;
          const voicesToSend = [];
          while ((voiceMatch = voiceRegex.exec(responseText)) !== null) {
            voicesToSend.push(voiceMatch[1].trim());
          }
          responseText = responseText.replace(/\s*\[VOICE:\s*.+?\]/gi, '').trim();

          // Strip any leaked tool tags from response
          responseText = responseText.replace(/\[TOOL:\s*\w+\][\s\S]*?\[\/TOOL\]/gi, '').trim();
          responseText = responseText.replace(/\[TOOL:\s*\w+\]\s*/gi, '').trim();
          responseText = responseText.replace(/\[\/TOOL\]\s*/gi, '').trim();

          // Strip "mau lanjut?" spam — auto-continue enforcement
          // Remove sentences asking permission to continue (AI should just do it)
          responseText = responseText.replace(/\n*(?:^|\n).*(?:mau (?:gue |gw |aku )?(?:lanjut|lanjutin|gas|terus)|(?:lanjut|lanjutin|gas) (?:gak|ga|nggak|tidak|ngga)?[?\s]*(?:✨|🚀|💪|🔥)?|tinggal bilang[^.\n]*|mau (?:gue |gw )?(?:selesaiin|kerjain|handle)[^.\n]*\?)\s*$/gmi, '').trim();

          // Mask sshpass passwords in responses
          responseText = responseText.replace(/sshpass\s+-p\s+'[^']*'/g, "sshpass -p '***'");
          responseText = responseText.replace(/sshpass\s+-p\s+\S+/g, "sshpass -p ***");

          // Mask any accidentally leaked credentials in response
          responseText = responseText.replace(/\b(sk-[A-Za-z0-9_-]{10,})\b/g, (m) => m.substring(0, 7) + '...[masked]');
          responseText = responseText.replace(/\b(AIza[A-Za-z0-9_-]{10,})\b/g, (m) => m.substring(0, 7) + '...[masked]');
          responseText = responseText.replace(/((?:API_KEY|SECRET|TOKEN|PASSWORD|CONSUMER_KEY|APP_SECRET)\s*[=:]\s*)(\S{8,})/gi, (m, prefix, val) => prefix + val.substring(0, 4) + '...[masked]');

          // Hard limit: strip long encoded/cert/key blocks from response
          // Catches base64 blobs, PEM certificates, CSRs, etc.
          responseText = responseText.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[content saved to file — not shown in chat]');
          // Strip any remaining base64-like blocks (40+ chars of base64 per line, 5+ lines)
          responseText = responseText.replace(/(?:^[A-Za-z0-9+\/=]{40,}\n){5,}/gm, '[...long encoded content truncated...]\n');
          // Hard cap: if response > 2000 chars, truncate with notice
          if (responseText.length > 2000) {
            responseText = responseText.substring(0, 1900) + '\n\n...(output terlalu panjang, sisanya di-truncate)';
            console.log(`  ✂️ Response truncated from ${responseText.length} to 2000 chars`);
          }

          // Stop typing indicator before sending response
          clearInterval(typingInterval);

          const finalTopic = this.topicMgr ? this.topicMgr.getActiveTopic(chatId) : null;
          this.conversationMgr.addMessage(chatId, 'assistant', responseText, finalTopic);

          // Reply logic:
          // - DM: no reply (plain message) UNLESS there are queued messages for this chat
          // - Group: always reply to the original message
          let replyTo = null;
          if (isGroup) {
            replyTo = msg.message.id; // Group: always reply
          } else {
            // DM: reply only if there are more messages waiting in queue
            const chatState = this.chatQueue.chats.get(chatId);
            if (chatState && chatState.queue.length > 0) {
              replyTo = msg.message.id; // Queue has more → reply so user knows which msg this answers
            }
          }

          if (responseText) {
            console.log(`  📨 Sending response (${responseText.length} chars)...`);
            try {
              if (placeholderMsgId) {
                await this.gram.editMessage(peerId, placeholderMsgId, responseText);
              } else {
                await this.gram.sendMessage(peerId, responseText, replyTo);
              }
            } catch (sendErr) {
              console.error(`  ❌ Send failed: ${sendErr.message}`);
              // Emergency fallback: try sending truncated
              try {
                await this.gram.sendMessage(peerId, responseText.substring(0, 2000) + '\n\n...(truncated)', replyTo);
              } catch (e2) {
                console.error(`  ❌ Emergency send also failed: ${e2.message}`);
              }
            }
          } else if (placeholderMsgId) {
            // No text response, delete placeholder
            try { await this.gram.deleteMessage(peerId, placeholderMsgId); } catch {}
          }

          // Send sticker emojis
          for (const emoji of stickersToSend) {
            try {
              await this.gram.sendMessage(peerId, emoji, replyTo);
            } catch {}
          }

          // Send files
          for (const f of filesToSend) {
            if (fs.existsSync(f.path)) {
              await this.gram.sendFile(peerId, f.path, f.caption, replyTo);
              console.log(`  📎 Sent file: ${f.path}`);
            } else {
              console.warn(`  ⚠️ File not found: ${f.path}`);
            }
          }

          // Send voice notes via TTS
          for (const voiceText of voicesToSend) {
            try {
              const tmpFile = `/tmp/tts_${Date.now()}.mp3`;
              execSync(`gtts-cli "${voiceText.replace(/"/g, '\\"')}" --lang id --output ${tmpFile}`, { timeout: 15000 });
              await this.gram.sendVoice(peerId, tmpFile, replyTo);
              fs.unlinkSync(tmpFile);
              console.log(`  🎤 Sent voice: "${voiceText.substring(0, 40)}"`);
            } catch (err) {
              console.error(`  ❌ TTS failed: ${err.message}`);
              await this.gram.sendMessage(peerId, voiceText, replyTo);
            }
          }

          const usedCfg = this._classifyComplexity(text) === 'simple'
            ? (this.config.models?.simple || { model: 'gemini-2.5-flash' })
            : (this.config.models?.complex || { model: 'gemini-2.5-pro' });
          this.stats.record(msg.senderId || msg.message.senderId, msg.senderName, tokensUsed || 0, usedCfg.model);
          console.log(`✅ Responded to ${msg.senderName} (${tokensUsed || '?'} tokens)${replyTo ? ' [reply]' : ''}`);
        } catch (err) {
          if (typingInterval) clearInterval(typingInterval);
          console.error('❌ Bridge error:', err.message);
          try {
            await this.gram.sendMessage(peerId, '⚠️ Sorry, ada error. Coba lagi ya.', msg.message.id);
          } catch {}
        }
      });
    });

    console.log('🚀 GramJS Bridge listening for messages');
  }
}
