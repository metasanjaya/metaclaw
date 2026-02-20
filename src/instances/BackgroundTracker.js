/**
 * BackgroundTracker — Track background shell processes
 * 
 * Inspired by OpenClaw's exec(background:true) + process management.
 * When a shell command is run in background mode, it's tracked here
 * and can be polled, killed, or auto-reported on completion.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} BackgroundProcess
 * @property {string} id
 * @property {string} command
 * @property {number} pid
 * @property {'running'|'done'|'failed'|'killed'} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} exitCode
 * @property {number} startedAt
 * @property {number|null} completedAt
 * @property {string|null} chatId — auto-report to this chat
 * @property {boolean} announce — auto-announce on completion
 */

const MAX_OUTPUT = 50_000; // max stdout/stderr buffer per process
const MAX_TRACKED = 30;

export class BackgroundTracker {
  /**
   * @param {Object} opts
   * @param {string} opts.instanceId
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   */
  constructor({ instanceId, eventBus }) {
    this.instanceId = instanceId;
    this.eventBus = eventBus;

    /** @type {Map<string, BackgroundProcess & {_proc: import('child_process').ChildProcess|null}>} */
    this.processes = new Map();
  }

  /**
   * Run a command in background
   * @param {Object} opts
   * @param {string} opts.command
   * @param {string} [opts.cwd]
   * @param {number} [opts.timeoutMs=300000] — 5min default
   * @param {string} [opts.chatId] — for auto-announce
   * @param {string} [opts.channelId]
   * @param {boolean} [opts.announce=true]
   * @returns {string} process id
   */
  run({ command, cwd, timeoutMs = 300_000, chatId, channelId, announce = true }) {
    const id = `bg_${randomUUID().slice(0, 8)}`;

    const proc = spawn('sh', ['-c', command], {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const entry = {
      id,
      command,
      pid: proc.pid || 0,
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
      startedAt: Date.now(),
      completedAt: null,
      chatId: chatId || null,
      channelId: channelId || null,
      announce,
      _proc: proc,
    };

    // Collect output
    proc.stdout.on('data', (d) => {
      entry.stdout += d.toString();
      if (entry.stdout.length > MAX_OUTPUT) entry.stdout = entry.stdout.slice(-MAX_OUTPUT);
    });
    proc.stderr.on('data', (d) => {
      entry.stderr += d.toString();
      if (entry.stderr.length > MAX_OUTPUT) entry.stderr = entry.stderr.slice(-MAX_OUTPUT);
    });

    // Completion
    proc.on('close', (code) => {
      entry.exitCode = code;
      entry.status = code === 0 ? 'done' : 'failed';
      entry.completedAt = Date.now();
      entry._proc = null;

      const elapsed = ((entry.completedAt - entry.startedAt) / 1000).toFixed(1);
      console.log(`[BgTracker:${this.instanceId}] Process ${id} ${entry.status} (${elapsed}s, exit ${code})`);

      if (entry.announce && entry.chatId) {
        this._announce(entry);
      }

      this.eventBus.emit('background.complete', {
        instanceId: this.instanceId,
        processId: id,
        status: entry.status,
        exitCode: code,
      });

      this._cleanup();
    });

    proc.on('error', (e) => {
      entry.status = 'failed';
      entry.stderr += `\nProcess error: ${e.message}`;
      entry.completedAt = Date.now();
      entry._proc = null;
    });

    // Timeout
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (entry.status === 'running') {
          this.kill(id);
          entry.stderr += `\nKilled: timeout (${timeoutMs / 1000}s)`;
        }
      }, timeoutMs);
    }

    this.processes.set(id, entry);
    console.log(`[BgTracker:${this.instanceId}] Started: "${command.slice(0, 60)}" (pid ${proc.pid}, id ${id})`);

    return id;
  }

  /**
   * Get process output/status
   * @param {string} id
   * @returns {Object|null}
   */
  poll(id) {
    const entry = this._find(id);
    if (!entry) return null;

    return {
      id: entry.id,
      command: entry.command,
      pid: entry.pid,
      status: entry.status,
      exitCode: entry.exitCode,
      stdout: entry.stdout.slice(-5000),
      stderr: entry.stderr.slice(-2000),
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      elapsed: entry.completedAt ? entry.completedAt - entry.startedAt : Date.now() - entry.startedAt,
    };
  }

  /**
   * Get full log for a process
   * @param {string} id
   * @param {number} [tailLines=50]
   * @returns {string}
   */
  log(id, tailLines = 50) {
    const entry = this._find(id);
    if (!entry) return 'Process not found';

    const lines = (entry.stdout + (entry.stderr ? `\n[stderr]\n${entry.stderr}` : '')).split('\n');
    return lines.slice(-tailLines).join('\n');
  }

  /**
   * Kill a running process
   * @param {string} id
   * @returns {boolean}
   */
  kill(id) {
    const entry = this._find(id);
    if (!entry || !entry._proc) return false;

    try {
      entry._proc.kill('SIGTERM');
      setTimeout(() => {
        if (entry._proc) entry._proc.kill('SIGKILL');
      }, 5000);
      entry.status = 'killed';
      entry.completedAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /** List all tracked processes */
  list() {
    return [...this.processes.values()].map(e => ({
      id: e.id,
      command: e.command.slice(0, 80),
      pid: e.pid,
      status: e.status,
      exitCode: e.exitCode,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      elapsed: e.completedAt ? e.completedAt - e.startedAt : Date.now() - e.startedAt,
    }));
  }

  /** Find by id or partial id */
  _find(id) {
    return this.processes.get(id) || [...this.processes.values()].find(p => p.id.startsWith(id));
  }

  _announce(entry) {
    const status = entry.status === 'done' ? '✅' : '❌';
    const elapsed = ((entry.completedAt - entry.startedAt) / 1000).toFixed(1);
    const output = entry.stdout.trim().slice(-500) || '(no output)';
    const text = `${status} Background task completed (${elapsed}s)\n\`${entry.command.slice(0, 60)}\`\nExit: ${entry.exitCode}\n\n${output}`;

    this.eventBus.emit('spawner.result', {
      instanceId: this.instanceId,
      chatId: entry.chatId,
      channelId: entry.channelId,
      text,
    });
  }

  _cleanup() {
    const completed = [...this.processes.entries()]
      .filter(([, p]) => p.status !== 'running')
      .sort((a, b) => (b[1].completedAt || 0) - (a[1].completedAt || 0));

    if (completed.length > MAX_TRACKED) {
      for (const [id] of completed.slice(MAX_TRACKED)) {
        this.processes.delete(id);
      }
    }
  }

  getStats() {
    const procs = [...this.processes.values()];
    return {
      total: procs.length,
      running: procs.filter(p => p.status === 'running').length,
      done: procs.filter(p => p.status === 'done').length,
      failed: procs.filter(p => p.status === 'failed' || p.status === 'killed').length,
    };
  }
}
