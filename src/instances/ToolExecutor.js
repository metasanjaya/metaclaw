/**
 * ToolExecutor - Per-instance tool execution
 * Ported from v2, adapted for v3 per-instance architecture.
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, extname } from 'node:path';

const execAsync = promisify(execCb);
const MAX_OUTPUT = 10240;

const BLOCKED = [
  /rm\s+-rf\s+\//,  /mkfs/, /dd\s+if=/, /:\(\)\{\s*:\|:&\s*\};:/,
  />\s*\/dev\/sd/, /format\s+[cC]:/, /shutdown/, /reboot/, /init\s+0/,
];

function truncate(str, max = MAX_OUTPUT) {
  return str.length <= max ? str : str.substring(0, max) + '\n... (truncated)';
}

function stripHtml(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export class ToolExecutor {
  /**
   * @param {Object} opts
   * @param {import('./Instance.js').Instance} opts.instance — parent instance
   * @param {Object} opts.config — provider keys etc
   */
  constructor({ instance, config = {} }) {
    this.instance = instance;
    this.workspace = instance?.dataDir || '/root';
    this.braveApiKey = config.search?.brave_api_key || process.env.BRAVE_API_KEY || '';
    this.googleApiKey = process.env.GOOGLE_API_KEY || '';
  }

  _resolve(p) { return isAbsolute(p) ? p : resolve(this.workspace, p); }

  _time() {
    const now = new Date();
    const tz = this.instance?.config?.timezone || process.env.TZ || 'UTC';
    const utc = now.toISOString();
    const local = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const unix = now.getTime();
    return `UTC: ${utc}\n${tz}: ${local}\nUnix: ${unix}`;
  }

  /** Get native function calling tool definitions */
  getToolDefinitions() {
    return [
      {
        name: 'time',
        description: 'Get current date and time in UTC and instance timezone. Use before creating schedules or answering time-related questions.',
        params: { type: 'object', properties: {} },
      },
      {
        name: 'shell',
        description: 'Run a shell command. Returns stdout, stderr, exitCode.',
        params: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
          },
          required: ['command'],
        },
      },
      {
        name: 'search',
        description: 'Search the web. Returns array of {title, url, snippet}.',
        params: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            count: { type: 'number', description: 'Number of results (default 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'fetch',
        description: 'Fetch webpage content as text.',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
            maxChars: { type: 'number', description: 'Max chars to return (default 5000)' },
          },
          required: ['url'],
        },
      },
      {
        name: 'read',
        description: 'Read a file. Returns content.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            offset: { type: 'number', description: 'Start line (1-indexed)' },
            limit: { type: 'number', description: 'Max lines to read' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write',
        description: 'Write content to a file.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'ls',
        description: 'List directory contents.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (default: workspace)' },
          },
        },
      },
      {
        name: 'knowledge',
        description: 'Save, update, or delete a fact in knowledge base. Facts are auto-injected when relevant.',
        params: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove', 'list'], description: 'Action' },
            id: { type: 'string', description: 'Fact ID (for remove/update)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the fact' },
            fact: { type: 'string', description: 'The fact text' },
          },
          required: ['action'],
        },
      },
      {
        name: 'remember',
        description: 'Save something to daily memory log or long-term memory.',
        params: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to remember' },
            category: { type: 'string', description: 'Category tag (optional)' },
            longTerm: { type: 'boolean', description: 'If true, append to MEMORY.md instead of daily log' },
          },
          required: ['text'],
        },
      },
      {
        name: 'schedule',
        description: 'Create a reminder or scheduled task. Supports: one-shot (at/delayMs), recurring (everyMs), cron expressions.',
        params: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Reminder text or task description' },
            at: { type: 'string', description: 'Trigger time: ISO 8601 ("2026-02-20T17:00:00+07:00"), or relative ("5m", "1h", "30s")' },
            delayMs: { type: 'number', description: 'Delay from now in ms (alternative to at)' },
            everyMs: { type: 'number', description: 'Repeat interval in ms (e.g. 3600000 for 1h)' },
            cron: { type: 'string', description: 'Cron expression (e.g. "0 7 * * *" for daily 7am, "*/5 * * * *" for every 5min)' },
            tz: { type: 'string', description: 'Timezone for cron (e.g. "Asia/Jakarta"). Default: server timezone' },
            type: { type: 'string', enum: ['direct', 'agent', 'check'], description: 'direct=send message, agent=AI processes it, check=run command first' },
            command: { type: 'string', description: 'Shell command (for type check)' },
            condition: { type: 'string', description: 'Condition for check type (e.g. "contains:error", "!=200")' },
            deleteAfterRun: { type: 'boolean', description: 'Delete one-shot jobs after execution (default true)' },
          },
          required: ['message'],
        },
      },
      {
        name: 'schedule_list',
        description: 'List all scheduled reminders and tasks.',
        params: { type: 'object', properties: {} },
      },
      {
        name: 'schedule_remove',
        description: 'Remove a scheduled job by ID.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Job ID to remove' } },
          required: ['id'],
        },
      },
      {
        name: 'spawn',
        description: 'Spawn an isolated sub-agent session to handle a complex task in background. Result auto-delivered when done.',
        params: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task/prompt for the sub-agent' },
            model: { type: 'string', description: 'Override model (e.g. anthropic/claude-opus-4-6)' },
            label: { type: 'string', description: 'Short label for this task' },
            timeoutMs: { type: 'number', description: 'Timeout in ms (default 120000)' },
          },
          required: ['task'],
        },
      },
      {
        name: 'spawn_list',
        description: 'List all spawned sub-agent sessions and their status.',
        params: { type: 'object', properties: {} },
      },
      {
        name: 'spawn_kill',
        description: 'Kill a running sub-agent session.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session ID to kill' } },
          required: ['id'],
        },
      },
      {
        name: 'bg_run',
        description: 'Run a shell command in background. Returns immediately, auto-reports when done.',
        params: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command' },
            timeoutMs: { type: 'number', description: 'Timeout in ms (default 300000)' },
          },
          required: ['command'],
        },
      },
      {
        name: 'bg_poll',
        description: 'Check status and output of a background process.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Process ID' } },
          required: ['id'],
        },
      },
      {
        name: 'bg_list',
        description: 'List all background processes.',
        params: { type: 'object', properties: {} },
      },
      {
        name: 'bg_kill',
        description: 'Kill a running background process.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Process ID to kill' } },
          required: ['id'],
        },
      },
    ];
  }

  /**
   * Execute a tool call from AI
   * @param {string} name — tool name
   * @param {Object} input — tool parameters
   * @returns {string} — result text
   */
  async execute(name, input = {}) {
    try {
      switch (name) {
        case 'time': return this._time();
        case 'shell': return await this._shell(input.command, input.timeout);
        case 'search': return JSON.stringify(await this._search(input.query, input.count));
        case 'fetch': return JSON.stringify(await this._fetch(input.url, input.maxChars));
        case 'read': return await this._read(input.path, input.offset, input.limit);
        case 'write': return await this._write(input.path, input.content);
        case 'ls': return await this._ls(input.path);
        case 'knowledge': return this._knowledge(input);
        case 'remember': return this._remember(input);
        case 'schedule': return this._schedule(input);
        case 'schedule_list': return this._scheduleList();
        case 'schedule_remove': return this._scheduleRemove(input.id);
        case 'spawn': return this._spawn(input);
        case 'spawn_list': return this._spawnList();
        case 'spawn_kill': return this._spawnKill(input.id);
        case 'bg_run': return this._bgRun(input);
        case 'bg_poll': return this._bgPoll(input.id);
        case 'bg_list': return this._bgList();
        case 'bg_kill': return this._bgKill(input.id);
        default: return `Unknown tool: ${name}`;
      }
    } catch (e) {
      return `Tool error (${name}): ${e.message}`;
    }
  }

  async _shell(command, timeout = 30000) {
    for (const p of BLOCKED) { if (p.test(command)) return 'Blocked: dangerous command'; }
    try {
      const { stdout, stderr } = await execAsync(command, { timeout, cwd: this.workspace, maxBuffer: 1024 * 1024 });
      let out = '';
      if (stdout.trim()) out += truncate(stdout);
      if (stderr.trim()) out += (out ? '\n' : '') + 'STDERR: ' + truncate(stderr);
      return out || '(no output)';
    } catch (e) {
      return `Exit ${e.code || 1}: ${truncate(e.stderr || e.message)}`;
    }
  }

  async _search(query, count = 5) {
    if (this.braveApiKey) {
      try {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
          headers: { 'X-Subscription-Token': this.braveApiKey, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return (data.web?.results || []).slice(0, count).map(r => ({ title: r.title, url: r.url, snippet: r.description }));
      } catch {}
    }
    // Fallback DuckDuckGo
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
      });
      const html = await res.text();
      const results = [];
      const rx = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = rx.exec(html)) && results.length < count) {
        let url = m[1]; const ud = url.match(/uddg=([^&]+)/);
        if (ud) url = decodeURIComponent(ud[1]);
        results.push({ title: stripHtml(m[2]).slice(0, 200), url, snippet: stripHtml(m[3]).slice(0, 300) });
      }
      return results;
    } catch (e) { return [{ title: 'Error', url: '', snippet: e.message }]; }
  }

  async _fetch(url, maxChars = 5000) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return { content: stripHtml(html).slice(0, maxChars), title: titleMatch ? stripHtml(titleMatch[1]) : '', url };
    } catch (e) { return { content: `Fetch error: ${e.message}`, title: '', url }; }
  }

  async _read(filePath, offset, limit) {
    filePath = this._resolve(filePath);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = (offset || 1) - 1;
    const end = limit ? start + limit : lines.length;
    return truncate(lines.slice(start, end).join('\n'));
  }

  async _write(filePath, content) {
    filePath = this._resolve(filePath);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
    return `Written ${content.length} bytes to ${filePath}`;
  }

  async _ls(dirPath) {
    dirPath = this._resolve(dirPath || '.');
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n');
  }

  _knowledge(input) {
    const km = this.instance?.knowledge;
    if (!km) return 'No knowledge manager';
    if (input.action === 'add') {
      const result = km.add({ id: input.id, tags: input.tags || ['general'], fact: input.fact });
      return result ? `Saved: [${result.tags.join(', ')}] ${result.fact}` : 'Failed to save';
    }
    if (input.action === 'remove') { return km.remove(input.id) ? `Removed: ${input.id}` : 'Not found'; }
    if (input.action === 'list') { return JSON.stringify(km.list().slice(0, 20)); }
    return 'Unknown action';
  }

  _remember(input) {
    const mm = this.instance?.memory;
    if (!mm) return 'No memory manager';
    if (input.longTerm) {
      mm.updateLongTermMemory(input.text);
      return 'Saved to long-term memory (MEMORY.md)';
    }
    mm.addMemory(input.text, input.category);
    return `Saved to daily log${input.category ? ` [${input.category}]` : ''}`;
  }

  _schedule(input) {
    const sched = this.instance?.scheduler;
    if (!sched) return 'No scheduler available';

    const id = sched.add({
      chatId: this._currentChatId || this.instance.id,
      message: input.message,
      at: input.at,
      delayMs: input.delayMs,
      everyMs: input.everyMs,
      cron: input.cron,
      tz: input.tz,
      type: input.type || 'direct',
      command: input.command || null,
      condition: input.condition || null,
      deleteAfterRun: input.deleteAfterRun,
    });

    const job = sched.jobs.find(j => j.id === id);
    const desc = job ? sched._describeSchedule(job.schedule) : 'scheduled';
    return `✅ Scheduled: "${input.message}" — ${desc} [id: ${id.slice(0, 8)}]`;
  }

  _scheduleList() {
    const sched = this.instance?.scheduler;
    if (!sched) return 'No scheduler';
    const jobs = sched.listAll();
    if (!jobs.length) return 'No scheduled jobs.';

    return jobs.map(j => {
      const desc = sched._describeSchedule(j.schedule);
      const enabled = j.enabled ? '' : ' [disabled]';
      const type = j.type !== 'direct' ? ` [${j.type}]` : '';
      const runs = j.runCount ? ` (${j.runCount} runs)` : '';
      return `• ${j.id.slice(0, 8)} — "${j.message}" ${desc}${type}${enabled}${runs}`;
    }).join('\n');
  }

  _scheduleRemove(id) {
    const sched = this.instance?.scheduler;
    if (!sched) return 'No scheduler';
    // Support partial ID match
    const full = sched.jobs.find(j => j.id.startsWith(id));
    if (!full) return `Job not found: ${id}`;
    sched.remove(full.id);
    return `✅ Removed: "${full.message}"`;
  }

  /** Set current chat context (called before execute) */
  setChatContext(chatId) {
    this._currentChatId = chatId;
  }

  // ===== Spawn (sub-agents) =====

  _spawn(input) {
    const spawner = this.instance?.spawner;
    if (!spawner) return 'No spawner available';
    const id = spawner.spawn({
      task: input.task,
      model: input.model,
      label: input.label,
      timeoutMs: input.timeoutMs,
      parentChatId: this._currentChatId || this.instance.id,
      parentChannelId: 'mission-control',
    });
    return `✅ Spawned sub-agent: ${id} — "${(input.label || input.task).slice(0, 60)}"`;
  }

  _spawnList() {
    const spawner = this.instance?.spawner;
    if (!spawner) return 'No spawner';
    const sessions = spawner.list();
    if (!sessions.length) return 'No spawned sessions.';
    return sessions.map(s => {
      const elapsed = (s.elapsed / 1000).toFixed(1);
      return `• ${s.id} [${s.status}] "${s.label}" (${elapsed}s, ${s.model})${s.error ? ` — ${s.error}` : ''}`;
    }).join('\n');
  }

  _spawnKill(id) {
    const spawner = this.instance?.spawner;
    if (!spawner) return 'No spawner';
    return spawner.kill(id) ? `✅ Killed: ${id}` : `Not found or not running: ${id}`;
  }

  // ===== Background processes =====

  _bgRun(input) {
    const tracker = this.instance?.bgTracker;
    if (!tracker) return 'No background tracker';

    // Safety check
    const blocked = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /shutdown/, /reboot/];
    if (blocked.some(p => p.test(input.command))) return '❌ Blocked: dangerous command';

    const id = tracker.run({
      command: input.command,
      timeoutMs: input.timeoutMs,
      chatId: this._currentChatId || this.instance.id,
      channelId: 'mission-control',
    });
    return `✅ Background process started: ${id}\nCommand: ${input.command.slice(0, 80)}\nUse bg_poll("${id}") to check status.`;
  }

  _bgPoll(id) {
    const tracker = this.instance?.bgTracker;
    if (!tracker) return 'No tracker';
    const info = tracker.poll(id);
    if (!info) return `Process not found: ${id}`;

    const elapsed = (info.elapsed / 1000).toFixed(1);
    let result = `[${info.status}] ${info.command.slice(0, 60)} (${elapsed}s)`;
    if (info.exitCode !== null) result += `\nExit: ${info.exitCode}`;
    if (info.stdout) result += `\n\n${info.stdout.slice(-3000)}`;
    if (info.stderr) result += `\n[stderr] ${info.stderr.slice(-1000)}`;
    return result;
  }

  _bgList() {
    const tracker = this.instance?.bgTracker;
    if (!tracker) return 'No tracker';
    const procs = tracker.list();
    if (!procs.length) return 'No background processes.';
    return procs.map(p => {
      const elapsed = (p.elapsed / 1000).toFixed(1);
      return `• ${p.id} [${p.status}] "${p.command}" (${elapsed}s${p.exitCode !== null ? `, exit ${p.exitCode}` : ''})`;
    }).join('\n');
  }

  _bgKill(id) {
    const tracker = this.instance?.bgTracker;
    if (!tracker) return 'No tracker';
    return tracker.kill(id) ? `✅ Killed: ${id}` : `Not found or not running: ${id}`;
  }
}
