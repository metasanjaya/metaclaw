/**
 * TaskRunner - Background task execution with RAG-optimized context
 * Handles long-running tasks (coding, research) without blocking chat.
 * Uses embeddings to load only relevant file chunks into context.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const TASKS_FILE = path.join(process.cwd(), 'data', 'tasks.json');

export class TaskRunner {
  /**
   * @param {object} opts
   * @param {object} opts.ai - UnifiedAIClient instance
   * @param {object} opts.rag - RAGEngine instance
   * @param {object} opts.tools - ToolExecutor instance
   * @param {Function} opts.sendFn - (peerId, message, replyTo?) => Promise
   * @param {string} opts.corePrompt - Core personality prompt
   */
  constructor({ ai, rag, tools, sendFn, corePrompt }) {
    this.ai = ai;
    this.rag = rag;
    this.tools = tools;
    this.sendFn = sendFn;
    this.corePrompt = corePrompt;
    this.activeTasks = new Map();
    this._loadState();
  }

  /**
   * Spawn a background task
   * @param {object} opts
   * @param {string} opts.peerId - Where to send results
   * @param {string} opts.chatId - Chat identifier
   * @param {string} opts.description - Task description
   * @param {string} opts.type - 'code' | 'research' | 'general'
   * @param {number} [opts.maxRounds=5] - Max tool rounds
   * @param {number} [opts.replyTo] - Message ID to reply to
   * @returns {string} task ID
   */
  spawn({ peerId, chatId, description, type = 'general', maxRounds = 5, replyTo = null }) {
    const taskId = randomUUID().slice(0, 8);
    const task = {
      id: taskId,
      peerId,
      chatId,
      description,
      type,
      maxRounds,
      replyTo,
      status: 'running',
      startedAt: Date.now(),
      log: [],
    };

    this.activeTasks.set(taskId, task);
    this._saveState();

    // Run in background (don't await)
    this._execute(task).catch(err => {
      task.status = 'error';
      task.error = err.message;
      this._saveState();
      console.error(`❌ Task ${taskId} failed: ${err.message}`);
    });

    console.log(`🚀 Task spawned: [${taskId}] ${type} — "${description.substring(0, 60)}"`);
    return taskId;
  }

  /**
   * Get task status
   */
  getStatus(taskId) {
    return this.activeTasks.get(taskId) || null;
  }

  /**
   * List active tasks for a chat
   */
  listForChat(chatId) {
    return [...this.activeTasks.values()].filter(t => t.chatId === chatId);
  }

  /**
   * List all tasks
   */
  listAll() {
    return [...this.activeTasks.values()];
  }

  async _execute(task) {
    const { description, type, maxRounds, peerId, replyTo } = task;

    // Build optimized context using RAG
    let context = this._buildTaskPrompt(type);

    // RAG search for relevant context
    if (this.rag) {
      try {
        const results = await this.rag.search(description, 5);
        if (results.length > 0) {
          context += '\n\n--- Relevant Context (from codebase/docs) ---\n';
          for (const r of results) {
            context += `[${r.source} (${(r.score * 100).toFixed(0)}% relevant)]\n${r.content}\n\n`;
          }
          task.log.push(`📎 RAG loaded ${results.length} relevant chunks`);
        }
      } catch (err) {
        task.log.push(`⚠️ RAG search failed: ${err.message}`);
      }
    }

    // Multi-round tool execution
    let messages = [
      { role: 'system', content: context },
      { role: 'user', content: `Task: ${description}\n\nUse tools as needed. Be thorough.` },
    ];

    let totalTokens = 0;

    for (let round = 0; round < maxRounds; round++) {
      task.log.push(`🔄 Round ${round + 1}/${maxRounds}`);

      const provider = this.ai._getProvider('anthropic');
      const result = await provider.chat(messages, {
        model: 'claude-opus-4-20250514',
        maxTokens: 3000,
        temperature: 0.5,
      });

      totalTokens += result.tokensUsed || 0;
      const responseText = result?.text || result?.content || String(result);

      // Parse tool calls
      const toolCalls = this._parseToolCalls(responseText);

      if (toolCalls.length === 0) {
        // Done — send result
        task.status = 'completed';
        task.tokensUsed = totalTokens;
        task.completedAt = Date.now();
        task.result = responseText;
        this._saveState();

        // Send result to chat
        const duration = ((task.completedAt - task.startedAt) / 1000).toFixed(1);
        const header = `✅ **Task [${task.id}] selesai** (${duration}s, ${totalTokens} tokens)\n\n`;
        const reply = header + responseText.substring(0, 3500);
        await this.sendFn(peerId, reply, replyTo);

        // Cleanup after 1 hour
        setTimeout(() => this.activeTasks.delete(task.id), 3600_000);
        return;
      }

      // Execute tools
      const toolResults = [];
      for (const call of toolCalls) {
        let result;
        try {
          switch (call.type) {
            case 'shell':
              result = await this.tools.execShell(call.content);
              result = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
              break;
            case 'search':
              const sr = await this.tools.webSearch(call.content);
              result = sr.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
              break;
            case 'fetch':
              const f = await this.tools.webFetch(call.content);
              result = `Title: ${f.title}\n\n${f.content}`;
              break;
            case 'read':
              result = await this.tools.readFile(call.content);
              break;
            case 'write':
              result = await this.tools.writeFile(call.pathArg || call.content, call.pathArg ? call.content : '');
              break;
            case 'ls':
              result = await this.tools.listDir(call.content);
              break;
            default:
              result = `Unknown tool: ${call.type}`;
          }
        } catch (err) {
          result = `Error: ${err.message}`;
        }
        toolResults.push({ type: call.type, result: (result || '(empty)').substring(0, 5000) });
        task.log.push(`🔧 [${call.type}]: ${(result || '').substring(0, 80)}`);
      }

      const toolOutput = toolResults.map(r => `[${r.type}]:\n${r.result}`).join('\n\n');
      messages.push({ role: 'assistant', content: responseText });
      messages.push({ role: 'user', content: `Tool results:\n${toolOutput}\n\nContinue with the task. Use more tools if needed, or give the final result.` });

      this._saveState();
    }

    // Max rounds reached — send what we have
    const provider = this.ai._getProvider('anthropic');
    const finalResult = await provider.chat([
      ...messages,
      { role: 'user', content: 'Max tool rounds reached. Give your final summary/result now.' },
    ], { model: 'claude-opus-4-20250514', maxTokens: 2000, temperature: 0.5 });

    totalTokens += finalResult.tokensUsed || 0;
    task.status = 'completed';
    task.tokensUsed = totalTokens;
    task.completedAt = Date.now();
    task.result = finalResult?.text || finalResult?.content || String(finalResult);
    this._saveState();

    const duration = ((task.completedAt - task.startedAt) / 1000).toFixed(1);
    const header = `✅ **Task [${task.id}] selesai** (${duration}s, ${totalTokens} tokens)\n\n`;
    await this.sendFn(peerId, header + task.result.substring(0, 3500), replyTo);

    setTimeout(() => this.activeTasks.delete(task.id), 3600_000);
  }

  _buildTaskPrompt(type) {
    let prompt = this.corePrompt + '\n\n';

    switch (type) {
      case 'code':
        prompt += `## Mode: Coding Task
Kamu sedang mengerjakan coding task di background. Gunakan tools untuk:
- [TOOL: read] baca file yang relevan
- [TOOL: write path=/path/to/file] tulis/edit file
- [TOOL: shell] jalankan command (test, lint, etc)
- [TOOL: ls] list directory structure

Prinsip:
- Baca dulu sebelum edit (pahami context)
- Test setelah perubahan
- Kasih summary perubahan yang dibuat
`;
        break;
      case 'research':
        prompt += `## Mode: Research Task
Kamu sedang melakukan research di background. Gunakan tools untuk:
- [TOOL: search] cari di web
- [TOOL: fetch] baca halaman web
- [TOOL: read] baca file lokal
- [TOOL: shell] jalankan command

Prinsip:
- Cari dari multiple sources
- Verifikasi informasi
- Kasih summary yang actionable
`;
        break;
      default:
        prompt += `## Mode: Background Task
Kerjakan task ini dengan tools yang tersedia. Kasih hasil yang clear dan actionable.
`;
    }

    return prompt;
  }

  _parseToolCalls(text) {
    const regex = /\[TOOL:\s*(shell|search|fetch|read|write|ls)(?:\s+path=([^\]]*))?\]\s*([\s\S]*?)\s*\[\/TOOL\]/gi;
    const calls = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      calls.push({ type: match[1].toLowerCase(), pathArg: match[2]?.trim(), content: match[3].trim() });
    }
    return calls;
  }

  _loadState() {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
        // Only load recent tasks (last 24h) for status display
        const cutoff = Date.now() - 86400_000;
        for (const task of (data.tasks || [])) {
          if (task.startedAt > cutoff) {
            this.activeTasks.set(task.id, task);
          }
        }
      }
    } catch (e) {
      console.error(`📋 Failed to load tasks: ${e.message}`);
    }
  }

  _saveState() {
    try {
      const dir = path.dirname(TASKS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TASKS_FILE, JSON.stringify({
        tasks: [...this.activeTasks.values()],
      }, null, 2));
    } catch (e) {
      console.error(`📋 Failed to save tasks: ${e.message}`);
    }
  }
}
