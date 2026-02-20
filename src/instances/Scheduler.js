/**
 * Scheduler — Per-instance persistent scheduled tasks
 * 
 * Job types:
 * - "direct": Send message to chat (0 tokens)
 * - "agent": Route through AI pipeline (burns tokens, smart)
 * - "check": Run shell command, optionally feed to AI if condition matches
 * 
 * Storage: <instanceDir>/schedules.json
 * Check interval: 10s
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const CHECK_INTERVAL = 10_000;

export class Scheduler {
  /**
   * @param {Object} opts
   * @param {string} opts.instanceDir
   * @param {string} opts.instanceId
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   * @param {import('../core/Router.js').Router} [opts.router]
   * @param {Function} [opts.sendFn] — (chatId, message) => Promise<void>
   */
  constructor({ instanceDir, instanceId, eventBus, router, sendFn }) {
    this.dir = instanceDir;
    this.instanceId = instanceId;
    this.eventBus = eventBus;
    this.router = router;
    this.sendFn = sendFn || null;
    this._filePath = join(instanceDir, 'schedules.json');

    /** @type {Array<ScheduleJob>} */
    this.jobs = [];
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;

    this._load();
  }

  // ========== CRUD ==========

  /**
   * Add a scheduled job
   * @param {Object} opts
   * @param {string} opts.chatId
   * @param {string} opts.message — reminder text or AI prompt
   * @param {number} opts.triggerAt — Unix ms
   * @param {number} [opts.repeatMs] — repeat interval (null = one-shot)
   * @param {string} [opts.type='direct'] — 'direct' | 'agent' | 'check'
   * @param {string} [opts.command] — shell command (for type 'check')
   * @param {string} [opts.condition] — condition for check (e.g. '!=200', 'contains:error')
   * @param {string} [opts.channelId] — which channel to send response to
   * @returns {string} job id
   */
  add({ chatId, message, triggerAt, repeatMs = null, type = 'direct', command = null, condition = null, channelId = null }) {
    // Dedup: skip if same chat+message within 5min
    const dup = this.jobs.find(j =>
      j.chatId === chatId && j.message === message && Math.abs(j.triggerAt - triggerAt) < 300_000
    );
    if (dup) return dup.id;

    const job = {
      id: randomUUID(),
      chatId,
      message,
      triggerAt,
      repeatMs,
      type,
      command,
      condition,
      channelId,
      createdAt: Date.now(),
    };

    this.jobs.push(job);
    this._save();

    const label = type !== 'direct' ? ` [${type}]` : '';
    const repeat = repeatMs ? ` (every ${this._fmtMs(repeatMs)})` : '';
    console.log(`[Scheduler:${this.instanceId}] Added${label}: "${message}" at ${new Date(triggerAt).toISOString()}${repeat}`);

    return job.id;
  }

  /**
   * Remove a job
   * @param {string} jobId
   * @returns {boolean}
   */
  remove(jobId) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter(j => j.id !== jobId);
    if (this.jobs.length < before) {
      this._save();
      return true;
    }
    return false;
  }

  /** Remove all jobs for a chat */
  clearChat(chatId) {
    this.jobs = this.jobs.filter(j => j.chatId !== chatId);
    this._save();
  }

  /** List jobs for a specific chat */
  listForChat(chatId) {
    return this.jobs.filter(j => j.chatId === chatId);
  }

  /** List all jobs */
  listAll() {
    return [...this.jobs];
  }

  // ========== Lifecycle ==========

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), CHECK_INTERVAL);
    this._tick(); // catch overdue jobs on restart
    console.log(`[Scheduler:${this.instanceId}] Started (${this.jobs.length} jobs)`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ========== Tick ==========

  async _tick() {
    const now = Date.now();
    const due = this.jobs.filter(j => j.triggerAt <= now);
    if (!due.length) return;

    for (const job of due) {
      try {
        await this._executeJob(job);
      } catch (e) {
        console.error(`[Scheduler:${this.instanceId}] Job failed: ${e.message}`);
      }

      if (job.repeatMs) {
        // Skip missed intervals
        while (job.triggerAt <= now) job.triggerAt += job.repeatMs;
      } else {
        this.jobs = this.jobs.filter(j => j.id !== job.id);
      }
    }
    this._save();
  }

  async _executeJob(job) {
    switch (job.type) {
      case 'check':
        await this._executeCheck(job);
        break;
      case 'agent':
        await this._executeAgent(job);
        break;
      default:
        await this._executeDirect(job);
    }
  }

  async _executeDirect(job) {
    const text = `⏰ ${job.message}`;
    this._send(job, text);
    console.log(`[Scheduler:${this.instanceId}] ✅ Reminder: "${job.message}"`);
  }

  async _executeAgent(job) {
    if (!this.router) {
      this._send(job, `⏰ ${job.message} (agent unavailable)`);
      return;
    }

    console.log(`[Scheduler:${this.instanceId}] 🤖 Agent job: "${job.message}"`);

    // Emit as inbound message for the instance to process
    this.eventBus.emit('channel.message', {
      instanceId: this.instanceId,
      channelId: job.channelId || 'scheduler',
      message: {
        id: `sched_${job.id}`,
        chatId: job.chatId,
        text: job.message,
        senderId: 'scheduler',
        senderName: 'Scheduler',
        timestamp: Date.now(),
      },
    });
  }

  async _executeCheck(job) {
    if (!job.command) {
      this._send(job, `⏰ ${job.message} (no command)`);
      return;
    }

    console.log(`[Scheduler:${this.instanceId}] 🔍 Check: "${job.command}"`);

    let output;
    try {
      output = execSync(job.command, { timeout: 30_000, encoding: 'utf-8', maxBuffer: 10 * 1024 }).trim();
    } catch (e) {
      output = e.stderr || e.message || 'command failed';
    }

    // Evaluate condition
    if (job.condition && !this._evalCondition(output, job.condition)) {
      return; // condition not met, stay silent
    }

    // If router available, feed to AI; otherwise direct send
    if (this.router) {
      this.eventBus.emit('channel.message', {
        instanceId: this.instanceId,
        channelId: job.channelId || 'scheduler',
        message: {
          id: `sched_${job.id}`,
          chatId: job.chatId,
          text: `[Scheduled Check] Command: ${job.command}\nOutput: ${output}\n\nTask: ${job.message}`,
          senderId: 'scheduler',
          senderName: 'Scheduler',
          timestamp: Date.now(),
        },
      });
    } else {
      this._send(job, `🔍 Check result:\n${output}`);
    }
  }

  _evalCondition(output, condition) {
    const trimmed = output.trim();
    if (condition.startsWith('contains:')) return trimmed.includes(condition.slice(9));
    if (condition.startsWith('!contains:')) return !trimmed.includes(condition.slice(10));
    if (condition.startsWith('==')) return trimmed === condition.slice(2);
    if (condition.startsWith('!=')) return trimmed !== condition.slice(2);

    const num = parseFloat(trimmed);
    if (isNaN(num)) return true; // can't evaluate numerically, pass through
    if (condition.startsWith('>=')) return num >= parseFloat(condition.slice(2));
    if (condition.startsWith('<=')) return num <= parseFloat(condition.slice(2));
    if (condition.startsWith('>')) return num > parseFloat(condition.slice(1));
    if (condition.startsWith('<')) return num < parseFloat(condition.slice(1));

    return true;
  }

  _send(job, text) {
    if (this.sendFn) {
      this.sendFn(job.chatId, text).catch(() => {});
    }
    this.eventBus.emit('scheduler.fired', {
      instanceId: this.instanceId,
      jobId: job.id,
      chatId: job.chatId,
      text,
    });
  }

  // ========== Persistence ==========

  _load() {
    try {
      if (existsSync(this._filePath)) {
        const data = JSON.parse(readFileSync(this._filePath, 'utf-8'));
        this.jobs = (data.jobs || []).map(j => ({ ...j, type: j.type || 'direct' }));
      }
    } catch { this.jobs = []; }
  }

  _save() {
    try {
      const dir = dirname(this._filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this._filePath, JSON.stringify({ jobs: this.jobs }, null, 2));
    } catch {}
  }

  _fmtMs(ms) {
    if (ms < 60_000) return `${ms / 1000}s`;
    if (ms < 3600_000) return `${ms / 60_000}min`;
    if (ms < 86400_000) return `${ms / 3600_000}h`;
    return `${ms / 86400_000}d`;
  }

  getStats() {
    return {
      totalJobs: this.jobs.length,
      pending: this.jobs.filter(j => j.triggerAt > Date.now()).length,
      overdue: this.jobs.filter(j => j.triggerAt <= Date.now()).length,
      repeating: this.jobs.filter(j => j.repeatMs).length,
    };
  }
}
