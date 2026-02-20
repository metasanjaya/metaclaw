/**
 * Scheduler — Per-instance persistent scheduled tasks
 * 
 * Schedule kinds:
 * - "at":    One-shot at specific time (ISO 8601 or Unix ms)
 * - "every": Fixed interval (ms)
 * - "cron":  5/6-field cron expression with optional timezone
 * 
 * Job types:
 * - "direct": Send message to chat (0 tokens)
 * - "agent":  Route through AI pipeline (burns tokens)
 * - "check":  Run shell command, optionally feed to AI if condition matches
 * 
 * Session targets:
 * - "main":     Inject into main conversation
 * - "isolated": Run dedicated agent turn (separate context)
 * 
 * Storage: <instanceDir>/schedules.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Cron } from 'croner';

const CHECK_INTERVAL = 10_000;

export class Scheduler {
  /**
   * @param {Object} opts
   * @param {string} opts.instanceDir
   * @param {string} opts.instanceId
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   * @param {import('../core/Router.js').Router} [opts.router]
   * @param {Function} [opts.sendFn]
   */
  constructor({ instanceDir, instanceId, eventBus, router, sendFn }) {
    this.dir = instanceDir;
    this.instanceId = instanceId;
    this.eventBus = eventBus;
    this.router = router;
    this.sendFn = sendFn || null;
    this._filePath = join(instanceDir, 'schedules.json');

    /** @type {Array<Object>} */
    this.jobs = [];
    /** @type {Map<string, Cron>} cron instances for cron-type jobs */
    this._cronInstances = new Map();
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;

    this._load();
  }

  // ========== CRUD ==========

  /**
   * Add a scheduled job
   * @param {Object} opts
   * @param {string} opts.chatId
   * @param {string} opts.message
   * @param {Object} opts.schedule — { kind: 'at'|'every'|'cron', at?, everyMs?, cron?, tz? }
   *   OR legacy flat params: triggerAt, repeatMs
   * @param {string} [opts.type='direct']
   * @param {string} [opts.sessionTarget='main']
   * @param {string} [opts.command]
   * @param {string} [opts.condition]
   * @param {string} [opts.channelId]
   * @param {boolean} [opts.deleteAfterRun=true] — for one-shot jobs
   * @param {boolean} [opts.enabled=true]
   * @returns {string} job id
   */
  add(opts) {
    // Normalize schedule (support both new format and legacy flat params)
    const schedule = opts.schedule || this._normalizeSchedule(opts);

    // Compute next trigger
    const triggerAt = this._computeNextTrigger(schedule);

    // Dedup
    const dup = this.jobs.find(j =>
      j.chatId === opts.chatId && j.message === opts.message &&
      Math.abs((j.triggerAt || 0) - triggerAt) < 300_000
    );
    if (dup) return dup.id;

    const job = {
      id: randomUUID(),
      chatId: opts.chatId,
      message: opts.message,
      schedule,
      triggerAt,
      type: opts.type || 'direct',
      sessionTarget: opts.sessionTarget || 'main',
      command: opts.command || null,
      condition: opts.condition || null,
      channelId: opts.channelId || null,
      deleteAfterRun: opts.deleteAfterRun !== false,
      enabled: opts.enabled !== false,
      createdAt: Date.now(),
      lastRunAt: null,
      runCount: 0,
    };

    this.jobs.push(job);
    this._save();

    // Setup cron instance if needed
    if (schedule.kind === 'cron') this._setupCron(job);

    const label = job.type !== 'direct' ? ` [${job.type}]` : '';
    console.log(`[Scheduler:${this.instanceId}] Added${label}: "${opts.message}" (${this._describeSchedule(schedule)})`);

    return job.id;
  }

  /**
   * Edit a job
   * @param {string} jobId
   * @param {Object} updates
   * @returns {boolean}
   */
  edit(jobId, updates) {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job) return false;

    if (updates.message !== undefined) job.message = updates.message;
    if (updates.type !== undefined) job.type = updates.type;
    if (updates.enabled !== undefined) job.enabled = updates.enabled;
    if (updates.command !== undefined) job.command = updates.command;
    if (updates.condition !== undefined) job.condition = updates.condition;

    if (updates.schedule) {
      job.schedule = updates.schedule;
      job.triggerAt = this._computeNextTrigger(updates.schedule);
      // Re-setup cron
      this._teardownCron(job.id);
      if (updates.schedule.kind === 'cron') this._setupCron(job);
    }

    this._save();
    return true;
  }

  remove(jobId) {
    const before = this.jobs.length;
    this._teardownCron(jobId);
    this.jobs = this.jobs.filter(j => j.id !== jobId);
    if (this.jobs.length < before) { this._save(); return true; }
    return false;
  }

  clearChat(chatId) {
    const toRemove = this.jobs.filter(j => j.chatId === chatId);
    for (const j of toRemove) this._teardownCron(j.id);
    this.jobs = this.jobs.filter(j => j.chatId !== chatId);
    this._save();
  }

  listForChat(chatId) { return this.jobs.filter(j => j.chatId === chatId); }
  listAll() { return [...this.jobs]; }

  // ========== Lifecycle ==========

  start() {
    if (this._timer) return;

    // Setup cron instances for existing cron jobs
    for (const job of this.jobs) {
      if (job.schedule?.kind === 'cron' && job.enabled) {
        this._setupCron(job);
      }
    }

    this._timer = setInterval(() => this._tick(), CHECK_INTERVAL);
    this._tick();
    console.log(`[Scheduler:${this.instanceId}] Started (${this.jobs.length} jobs)`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const [id, cron] of this._cronInstances) {
      cron.stop();
    }
    this._cronInstances.clear();
  }

  // ========== Cron Management ==========

  _setupCron(job) {
    if (this._cronInstances.has(job.id)) return;
    try {
      const cronOpts = job.schedule.tz ? { timezone: job.schedule.tz } : {};
      const cron = new Cron(job.schedule.cron, cronOpts, () => {
        // Update triggerAt on each cron tick
        job.triggerAt = Date.now();
      });
      // Set next trigger
      const next = cron.nextRun();
      if (next) job.triggerAt = next.getTime();
      this._cronInstances.set(job.id, cron);
    } catch (e) {
      console.error(`[Scheduler:${this.instanceId}] Invalid cron "${job.schedule.cron}": ${e.message}`);
    }
  }

  _teardownCron(jobId) {
    const cron = this._cronInstances.get(jobId);
    if (cron) { cron.stop(); this._cronInstances.delete(jobId); }
  }

  // ========== Tick ==========

  async _tick() {
    const now = Date.now();
    const due = this.jobs.filter(j => j.enabled && j.triggerAt && j.triggerAt <= now);
    if (!due.length) return;

    for (const job of due) {
      try {
        await this._executeJob(job);
        job.lastRunAt = Date.now();
        job.runCount++;
      } catch (e) {
        console.error(`[Scheduler:${this.instanceId}] Job failed: ${e.message}`);
      }

      this._reschedule(job, now);
    }
    this._save();
  }

  _reschedule(job, now) {
    const kind = job.schedule?.kind;

    if (kind === 'cron') {
      const cron = this._cronInstances.get(job.id);
      if (cron) {
        const next = cron.nextRun();
        job.triggerAt = next ? next.getTime() : null;
        if (!job.triggerAt) { job.enabled = false; }
      }
    } else if (kind === 'every') {
      const interval = job.schedule.everyMs;
      while (job.triggerAt <= now) job.triggerAt += interval;
    } else {
      // One-shot ('at' or legacy)
      if (job.deleteAfterRun) {
        this._teardownCron(job.id);
        this.jobs = this.jobs.filter(j => j.id !== job.id);
      } else {
        job.enabled = false;
      }
    }
  }

  // ========== Execution ==========

  async _executeJob(job) {
    switch (job.type) {
      case 'check': return this._executeCheck(job);
      case 'agent': return this._executeAgent(job);
      default: return this._executeDirect(job);
    }
  }

  async _executeDirect(job) {
    this._send(job, `⏰ ${job.message}`);
    console.log(`[Scheduler:${this.instanceId}] ✅ Reminder: "${job.message}"`);
  }

  async _executeAgent(job) {
    if (!this.router) { this._send(job, `⏰ ${job.message} (agent unavailable)`); return; }
    console.log(`[Scheduler:${this.instanceId}] 🤖 Agent job: "${job.message}"`);

    this.eventBus.emit('message.in', {
      instanceId: this.instanceId,
      channelId: job.channelId || 'scheduler',
      id: `sched_${job.id}`,
      chatId: job.chatId,
      text: job.message,
      senderId: 'scheduler',
      senderName: 'Scheduler',
      timestamp: Date.now(),
    });
  }

  async _executeCheck(job) {
    if (!job.command) { this._send(job, `⏰ ${job.message} (no command)`); return; }
    console.log(`[Scheduler:${this.instanceId}] 🔍 Check: "${job.command}"`);

    let output;
    try {
      output = execSync(job.command, { timeout: 30_000, encoding: 'utf-8', maxBuffer: 10 * 1024 }).trim();
    } catch (e) {
      output = e.stderr || e.message || 'command failed';
    }

    if (job.condition && !this._evalCondition(output, job.condition)) return;

    if (this.router) {
      this.eventBus.emit('message.in', {
        instanceId: this.instanceId,
        channelId: job.channelId || 'scheduler',
        id: `sched_${job.id}`,
        chatId: job.chatId,
        text: `[Scheduled Check] Command: ${job.command}\nOutput: ${output}\n\nTask: ${job.message}`,
        senderId: 'scheduler',
        senderName: 'Scheduler',
        timestamp: Date.now(),
      });
    } else {
      this._send(job, `🔍 Check result:\n${output}`);
    }
  }

  _evalCondition(output, condition) {
    const t = output.trim();
    if (condition.startsWith('contains:')) return t.includes(condition.slice(9));
    if (condition.startsWith('!contains:')) return !t.includes(condition.slice(10));
    if (condition.startsWith('==')) return t === condition.slice(2);
    if (condition.startsWith('!=')) return t !== condition.slice(2);
    const num = parseFloat(t);
    if (isNaN(num)) return true;
    if (condition.startsWith('>=')) return num >= parseFloat(condition.slice(2));
    if (condition.startsWith('<=')) return num <= parseFloat(condition.slice(2));
    if (condition.startsWith('>')) return num > parseFloat(condition.slice(1));
    if (condition.startsWith('<')) return num < parseFloat(condition.slice(1));
    return true;
  }

  _send(job, text) {
    if (this.sendFn) this.sendFn(job.chatId, text).catch(() => {});
    this.eventBus.emit('scheduler.fired', {
      instanceId: this.instanceId, jobId: job.id,
      chatId: job.chatId, channelId: job.channelId, text,
    });
  }

  // ========== Schedule Helpers ==========

  /** Convert legacy flat params to schedule object */
  _normalizeSchedule(opts) {
    if (opts.cron) {
      return { kind: 'cron', cron: opts.cron, tz: opts.tz || opts.timezone || null };
    }
    if (opts.repeatMs || opts.everyMs) {
      return { kind: 'every', everyMs: opts.repeatMs || opts.everyMs };
    }
    // One-shot
    const at = opts.triggerAt || (opts.at ? this._parseAt(opts.at) : null) || (Date.now() + (opts.delayMs || 300_000));
    return { kind: 'at', at };
  }

  _computeNextTrigger(schedule) {
    if (schedule.kind === 'at') {
      return typeof schedule.at === 'string' ? new Date(schedule.at).getTime() : (schedule.at || Date.now());
    }
    if (schedule.kind === 'every') {
      return Date.now() + (schedule.everyMs || 60_000);
    }
    if (schedule.kind === 'cron') {
      try {
        const opts = schedule.tz ? { timezone: schedule.tz } : {};
        const cron = new Cron(schedule.cron, opts);
        const next = cron.nextRun();
        cron.stop();
        return next ? next.getTime() : Date.now() + 60_000;
      } catch {
        return Date.now() + 60_000;
      }
    }
    return Date.now();
  }

  _parseAt(input) {
    if (typeof input === 'number') return input;
    // Try ISO 8601
    const d = new Date(input);
    if (!isNaN(d.getTime())) return d.getTime();
    // Try relative: "5m", "1h", "30s"
    const match = String(input).match(/^(\d+)\s*(s|m|h|d)$/i);
    if (match) {
      const n = parseInt(match[1]);
      const unit = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[match[2].toLowerCase()];
      return Date.now() + n * unit;
    }
    return Date.now() + 300_000;
  }

  _describeSchedule(schedule) {
    if (schedule.kind === 'at') return `at ${new Date(schedule.at).toISOString()}`;
    if (schedule.kind === 'every') return `every ${this._fmtMs(schedule.everyMs)}`;
    if (schedule.kind === 'cron') return `cron "${schedule.cron}"${schedule.tz ? ` (${schedule.tz})` : ''}`;
    return 'unknown';
  }

  // ========== Persistence ==========

  _load() {
    try {
      if (existsSync(this._filePath)) {
        const data = JSON.parse(readFileSync(this._filePath, 'utf-8'));
        this.jobs = (data.jobs || []).map(j => ({
          ...j,
          type: j.type || 'direct',
          schedule: j.schedule || this._normalizeSchedule(j),
          deleteAfterRun: j.deleteAfterRun !== false,
          enabled: j.enabled !== false,
          runCount: j.runCount || 0,
        }));
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
    const now = Date.now();
    return {
      totalJobs: this.jobs.length,
      enabled: this.jobs.filter(j => j.enabled).length,
      pending: this.jobs.filter(j => j.enabled && j.triggerAt > now).length,
      overdue: this.jobs.filter(j => j.enabled && j.triggerAt <= now).length,
      cron: this.jobs.filter(j => j.schedule?.kind === 'cron').length,
      repeating: this.jobs.filter(j => j.schedule?.kind === 'every').length,
    };
  }
}
