/**
 * AsyncTaskManager - Lightweight async task execution
 * 
 * Pattern: Run tool/command → check result → only call AI if needed
 * Zero tokens when task completes successfully with expected output.
 * 
 * Flow:
 * 1. AI spawns task via [ASYNC: {...}] tag
 * 2. Task runs in background (shell command, HTTP check, etc.)
 * 3. On completion, evaluate condition (optional)
 * 4. If condition met OR no condition → send result to AI for analysis → reply user
 * 5. If condition NOT met → send raw result directly to user (0 AI tokens)
 * 
 * Check loop: every 5 seconds for pending tasks
 */

import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';
import { randomUUID } from 'crypto';

const DATA_FILE = path.join(process.cwd(), 'data', 'async-tasks.json');
const CHECK_INTERVAL = 5_000;

export class AsyncTaskManager {
  /**
   * @param {Function} sendFn - Direct message sender (peerId, message, replyTo?)
   * @param {Function} agentFn - AI analysis (peerId, chatId, prompt) → processes through AI
   */
  constructor(sendFn, agentFn = null) {
    this.sendFn = sendFn;
    this.agentFn = agentFn;
    this.tasks = new Map();
    this.timer = null;
    this._load();
  }

  setAgentFn(fn) {
    this.agentFn = fn;
  }

  /**
   * Create an async task
   * @param {object} opts
   * @param {string} opts.peerId - Telegram peer to reply to
   * @param {string} opts.chatId - Chat identifier
   * @param {string} opts.cmd - Shell command to run
   * @param {string} opts.msg - Description / AI prompt for analysis
   * @param {string|null} opts.if - Condition to evaluate (triggers AI only if met)
   * @param {boolean} opts.aiAnalysis - Whether to send result to AI (default: true if no condition)
   * @param {number|null} opts.replyTo - Message ID to reply to
   * @param {number} opts.timeout - Timeout in ms (default: 120000)
   * @returns {string} task id
   */
  add({ peerId, chatId, cmd, msg, if: condition = null, aiAnalysis = true, replyTo = null, timeout = 120000 }) {
    const id = randomUUID().slice(0, 8);
    const task = {
      id,
      peerId,
      chatId,
      cmd,
      msg,
      condition,
      aiAnalysis,
      replyTo,
      timeout,
      status: 'running', // running | completed | failed | timeout
      output: null,
      error: null,
      pid: null,
      startedAt: Date.now(),
    };

    this.tasks.set(id, task);
    this._save();

    // Start execution
    this._executeTask(task);

    console.log(`  ⚡ Async task [${id}]: "${cmd.substring(0, 60)}" (timeout: ${timeout / 1000}s)`);
    return id;
  }

  /**
   * Get task by id
   */
  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * List tasks for a chat
   */
  listForChat(chatId) {
    return [...this.tasks.values()].filter(t => t.chatId === chatId);
  }

  /**
   * List all pending tasks
   */
  listPending() {
    return [...this.tasks.values()].filter(t => t.status === 'running');
  }

  /**
   * Start the check loop
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._checkCompleted(), CHECK_INTERVAL);
    // Check immediately for any tasks that completed while we were down
    this._checkCompleted();
    const pending = this.listPending().length;
    if (pending > 0) console.log(`⚡ AsyncTaskManager started (${pending} pending tasks)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Execute a task in background
   */
  _executeTask(task) {
    const child = exec(task.cmd, {
      timeout: task.timeout,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024, // 1MB
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          task.status = 'timeout';
          task.error = `Command timed out after ${task.timeout / 1000}s`;
        } else {
          task.status = 'failed';
          task.error = error.message;
        }
        task.output = (stdout || '') + (stderr ? `\nSTDERR: ${stderr}` : '');
      } else {
        task.status = 'completed';
        task.output = (stdout || '').trim();
        if (stderr) task.output += `\nSTDERR: ${stderr.trim()}`;
      }
      task.completedAt = Date.now();
      this._save();
    });

    task.pid = child.pid;
  }

  /**
   * Check for completed tasks and process results
   */
  async _checkCompleted() {
    const completed = [...this.tasks.values()].filter(
      t => t.status !== 'running' && !t.processed
    );

    for (const task of completed) {
      task.processed = true;
      this._save();

      try {
        await this._processResult(task);
      } catch (e) {
        console.error(`  ❌ Async task [${task.id}] result processing failed: ${e.message}`);
        // Still notify user of raw result
        try {
          const duration = ((task.completedAt - task.startedAt) / 1000).toFixed(1);
          await this.sendFn(task.peerId,
            `⚡ Task [${task.id}] selesai (${duration}s):\n\`\`\`\n${(task.output || task.error || '(empty)').substring(0, 2000)}\n\`\`\``,
            task.replyTo
          );
        } catch {}
      }

      // Cleanup after 1 hour
      setTimeout(() => this.tasks.delete(task.id), 3600_000);
    }
  }

  /**
   * Process task result — evaluate condition, decide AI or direct
   */
  async _processResult(task) {
    const duration = ((task.completedAt - task.startedAt) / 1000).toFixed(1);
    const output = task.output || task.error || '(empty)';

    // Task failed or timed out → always notify
    if (task.status === 'failed' || task.status === 'timeout') {
      if (this.agentFn && task.aiAnalysis) {
        // Let AI explain the error
        const prompt = `[Async task failed]\nCommand: ${task.cmd}\nStatus: ${task.status}\nError: ${task.error}\nOutput: ${output.substring(0, 1000)}\n\nJelaskan error ini ke user dan suggest fix.`;
        await this.agentFn(task.peerId, task.chatId, prompt);
      } else {
        await this.sendFn(task.peerId,
          `⚠️ Task [${task.id}] ${task.status} (${duration}s):\n${output.substring(0, 2000)}`,
          task.replyTo
        );
      }
      return;
    }

    // Evaluate condition (if set)
    if (task.condition) {
      const triggered = this._evaluateCondition(output, task.condition);
      if (!triggered) {
        // Condition NOT met → send simple direct result (0 AI tokens)
        await this.sendFn(task.peerId,
          `✅ Task [${task.id}] selesai (${duration}s) — semua normal.\n\`\`\`\n${output.substring(0, 1000)}\n\`\`\``,
          task.replyTo
        );
        console.log(`  ⏭️ Async task [${task.id}] condition not met, direct reply (0 tokens)`);
        return;
      }
      console.log(`  ⚠️ Async task [${task.id}] condition triggered!`);
    }

    // Send to AI for analysis (or direct if no agentFn)
    if (this.agentFn && task.aiAnalysis) {
      const prompt = `[Async task completed]\nCommand: ${task.cmd}\nDuration: ${duration}s\nOutput:\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\`\n\nTask: ${task.msg}`;
      await this.agentFn(task.peerId, task.chatId, prompt);
    } else {
      await this.sendFn(task.peerId,
        `✅ Task [${task.id}] selesai (${duration}s):\n\`\`\`\n${output.substring(0, 2000)}\n\`\`\``,
        task.replyTo
      );
    }
  }

  /**
   * Evaluate condition against output (same as Scheduler)
   */
  _evaluateCondition(output, condition) {
    const cond = condition.trim();
    const outputTrimmed = output.trim();

    if (cond.startsWith('!contains:')) return !outputTrimmed.includes(cond.substring(10).trim());
    if (cond.startsWith('contains:')) return outputTrimmed.includes(cond.substring(9).trim());

    const numMatch = outputTrimmed.match(/([\d.]+)/);
    const outputNum = numMatch ? parseFloat(numMatch[0]) : NaN;

    if (cond.startsWith('!=')) { const v = cond.substring(2).trim(); const n = parseFloat(v); if (!isNaN(n) && !isNaN(outputNum)) return outputNum !== n; return outputTrimmed !== v; }
    if (cond.startsWith('==')) { const v = cond.substring(2).trim(); const n = parseFloat(v); if (!isNaN(n) && !isNaN(outputNum)) return outputNum === n; return outputTrimmed === v; }
    if (cond.startsWith('>=')) return !isNaN(outputNum) && outputNum >= parseFloat(cond.substring(2));
    if (cond.startsWith('<=')) return !isNaN(outputNum) && outputNum <= parseFloat(cond.substring(2));
    if (cond.startsWith('>')) return !isNaN(outputNum) && outputNum > parseFloat(cond.substring(1));
    if (cond.startsWith('<')) return !isNaN(outputNum) && outputNum < parseFloat(cond.substring(1));

    return outputTrimmed !== cond;
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        for (const task of (data.tasks || [])) {
          // Only load recent (last 2 hours) and mark running tasks as timeout
          if (Date.now() - task.startedAt < 7200_000) {
            if (task.status === 'running') {
              task.status = 'timeout';
              task.error = 'Task was running when process restarted';
              task.completedAt = Date.now();
            }
            this.tasks.set(task.id, task);
          }
        }
      }
    } catch (e) {
      console.error(`⚡ Failed to load async tasks: ${e.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        tasks: [...this.tasks.values()],
      }, null, 2));
    } catch (e) {
      console.error(`⚡ Failed to save async tasks: ${e.message}`);
    }
  }
}
