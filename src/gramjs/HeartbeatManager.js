import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';

const execAsync = promisify(exec);

export class HeartbeatManager {
  constructor({ heartbeatPath, asyncTaskManager, agentFn, sendFn, defaultPeerId, defaultChatId }) {
    this.heartbeatPath = heartbeatPath || 'workspace/HEARTBEAT.md';
    this.asyncTaskManager = asyncTaskManager;
    this.agentFn = agentFn;
    this.sendFn = sendFn;
    this.defaultPeerId = defaultPeerId;
    this.defaultChatId = defaultChatId;
    this.statePath = resolve(process.cwd(), 'data', 'heartbeat-state.json');
    this.timer = null;
    this.tickCount = 0;
    this.lastResults = null;
    this.stats = { lastTick: null, nextTick: null, checksRun: 0, alertsSent: 0, tasksRun: 0 };
    this.state = { lastTick: 0, taskLastRun: {}, stats: { totalTicks: 0, totalAlerts: 0, totalTaskRuns: 0 } };
  }

  async start() {
    await this._loadState();
    // Do first tick, then schedule
    await this.tick();
    this._schedule();
    console.log('❤️ HeartbeatManager started');
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('❤️ HeartbeatManager stopped');
  }

  _schedule(intervalMs) {
    if (this.timer) clearTimeout(this.timer);
    const ms = intervalMs || 300_000;
    this.stats.nextTick = Date.now() + ms;
    this.timer = setTimeout(async () => {
      await this.tick();
      this._schedule(intervalMs);
    }, ms);
    this.timer.unref?.();
  }

  async tick() {
    this.tickCount++;
    let parsed;
    try {
      const content = await readFile(this.heartbeatPath, 'utf-8');
      parsed = this._parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('❤️ HEARTBEAT.md not found, skipping tick');
      } else {
        console.warn('❤️ Error reading HEARTBEAT.md:', err.message);
      }
      return;
    }

    const { interval, notify, checks, tasks } = parsed;
    const peerId = notify || this.defaultPeerId;

    // Reschedule if interval changed
    if (this.timer && interval) {
      clearTimeout(this.timer);
      this._schedule(interval * 1000);
    }

    // === Checks phase ===
    const triggered = [];
    if (checks.length > 0) {
      const results = await Promise.all(checks.map(c => this._runCheck(c)));
      for (const r of results) {
        this.stats.checksRun++;
        if (r.triggered) triggered.push(r);
      }
    }

    const tasksDue = [];

    // === Alert phase ===
    if (triggered.length > 0) {
      this.stats.alertsSent++;
      this.state.stats.totalAlerts++;

      const lines = triggered.map(t => `🔴 ${t.name}: ${t.output} (threshold: ${t.condition})`);
      const msg = `⚠️ Heartbeat Alert (${triggered.length} issue${triggered.length > 1 ? 's' : ''}):\n\n${lines.join('\n')}\n\nCommand outputs attached for context.`;

      console.log(`❤️ Heartbeat alert: ${triggered.map(t => `${t.name}=${t.output} (${t.condition})`).join(', ')}`);

      if (this.agentFn && peerId) {
        const prompt = `Heartbeat checks triggered:\n${triggered.map(t => `- ${t.name}: output=${t.output}, condition=${t.condition}`).join('\n')}\nAnalyze these issues and suggest actions.`;
        try {
          await this.agentFn(peerId, this.defaultChatId || peerId, prompt);
        } catch (err) {
          console.warn('❤️ agentFn error:', err.message);
          if (this.sendFn) await this.sendFn(peerId, msg).catch(() => {});
        }
      } else if (this.sendFn && peerId) {
        try { await this.sendFn(peerId, msg); } catch (err) { console.warn('❤️ sendFn error:', err.message); }
      }
    }

    // === Tasks phase ===
    const now = Date.now();
    for (const task of tasks) {
      const lastRun = this.state.taskLastRun[task.name] || 0;
      const elapsed = now - lastRun;
      if (elapsed >= task.intervalMs) {
        tasksDue.push(task);
      }
    }

    for (const task of tasksDue) {
      const lastRun = this.state.taskLastRun[task.name] || 0;
      const ago = lastRun ? this._formatAgo(Date.now() - lastRun) : 'never';
      console.log(`❤️ Heartbeat task "${task.name}" running (last: ${ago})`);
      this.stats.tasksRun++;
      this.state.stats.totalTaskRuns++;
      this.state.taskLastRun[task.name] = now;

      if (this.agentFn && peerId) {
        try {
          await this.agentFn(peerId, this.defaultChatId || peerId, task.prompt);
        } catch (err) {
          console.warn(`❤️ Task "${task.name}" error:`, err.message);
        }
      }
    }

    // === Update state ===
    this.state.lastTick = now;
    this.state.stats.totalTicks++;
    this.stats.lastTick = now;

    this.lastResults = { checks: checks.length, triggered: triggered.length, tasksDue: tasksDue.length, triggeredDetails: triggered };

    console.log(`❤️ Heartbeat tick #${this.tickCount}: ${checks.length} checks, ${triggered.length} triggered, ${tasksDue.length} task${tasksDue.length !== 1 ? 's' : ''} due`);

    await this._saveState();
  }

  getStatus() {
    return { ...this.stats };
  }

  getLastResults() {
    return this.lastResults;
  }

  // === Parsing ===

  _parse(content) {
    const lines = content.split('\n');
    let interval = 300;
    let notify = null;
    let section = null;
    const checks = [];
    const tasks = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || (line.startsWith('#') && !line.startsWith('##'))) continue;

      // Headers
      const intervalMatch = line.match(/^## interval:\s*(\d+)/i);
      if (intervalMatch) { interval = parseInt(intervalMatch[1], 10); continue; }

      const notifyMatch = line.match(/^## notify:\s*(\S+)/i);
      if (notifyMatch) { notify = notifyMatch[1]; continue; }

      if (/^## Checks/i.test(line)) { section = 'checks'; continue; }
      if (/^## Tasks/i.test(line)) { section = 'tasks'; continue; }
      if (line.startsWith('##')) { section = null; continue; }

      if (!line.startsWith('-')) continue;

      if (section === 'checks') {
        const m = line.match(/^-\s*(\w+):\s*`([^`]+)`\s*\|\s*if\s+([^\|]+)\|\s*(.+)/);
        if (m) checks.push({ name: m[1].trim(), command: m[2].trim(), condition: m[3].trim(), alertMsg: m[4].trim() });
      } else if (section === 'tasks') {
        const m = line.match(/^-\s*(\w+):\s*(.+?)\s*\|\s*every\s+(.+)/);
        if (m) tasks.push({ name: m[1].trim(), prompt: m[2].trim(), intervalMs: this._parseInterval(m[3].trim()) });
      }
    }

    return { interval, notify, checks, tasks };
  }

  _parseInterval(str) {
    let ms = 0;
    const d = str.match(/(\d+)\s*d/); if (d) ms += parseInt(d[1]) * 86400000;
    const h = str.match(/(\d+)\s*h/); if (h) ms += parseInt(h[1]) * 3600000;
    const m = str.match(/(\d+)\s*m(?!s)/); if (m) ms += parseInt(m[1]) * 60000;
    return ms || 300000; // fallback 5min
  }

  // === Check execution ===

  async _runCheck(check) {
    let output = '';
    try {
      const { stdout } = await execAsync(check.command, { timeout: 10000 });
      output = stdout.trim();
    } catch (err) {
      output = err.stdout?.trim?.() || 'ERROR';
    }

    const triggered = this._evalCondition(output, check.condition);
    return { name: check.name, output, condition: check.condition, alertMsg: check.alertMsg, triggered };
  }

  _evalCondition(output, condition) {
    try {
      // String conditions
      if (condition.startsWith('contains:')) return output.includes(condition.slice(9).trim());
      if (condition.startsWith('!contains:')) return !output.includes(condition.slice(10).trim());

      const val = parseFloat(output);
      const m = condition.match(/^([><!]=?|!=|==)\s*(.+)/);
      if (!m) return false;
      const [, op, rhs] = m;
      const target = parseFloat(rhs);

      if (isNaN(val) || isNaN(target)) {
        // String comparison for != and ==
        if (op === '!=') return output !== rhs.trim();
        if (op === '==') return output === rhs.trim();
        return false;
      }

      switch (op) {
        case '>': return val > target;
        case '>=': return val >= target;
        case '<': return val < target;
        case '<=': return val <= target;
        case '!=': return val !== target;
        case '==': return val === target;
        default: return false;
      }
    } catch { return false; }
  }

  // === State persistence ===

  async _loadState() {
    try {
      const data = await readFile(this.statePath, 'utf-8');
      this.state = JSON.parse(data);
    } catch { /* fresh state */ }
  }

  async _saveState() {
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn('❤️ Failed to save state:', err.message);
    }
  }

  _formatAgo(ms) {
    if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
    return `${Math.round(ms / 3600000)}h ago`;
  }
}
