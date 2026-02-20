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

  /** Get native function calling tool definitions */
  getToolDefinitions() {
    return [
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
        description: 'Create a reminder or scheduled task. Supports one-shot and repeating schedules.',
        params: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Reminder text or task description' },
            delayMs: { type: 'number', description: 'Delay from now in milliseconds (e.g. 300000 for 5min)' },
            triggerAt: { type: 'number', description: 'Exact trigger time as Unix ms (alternative to delayMs)' },
            repeatMs: { type: 'number', description: 'Repeat interval in ms (null for one-shot)' },
            type: { type: 'string', enum: ['direct', 'agent', 'check'], description: 'direct=send message, agent=AI processes it, check=run command first' },
            command: { type: 'string', description: 'Shell command (for type check)' },
            condition: { type: 'string', description: 'Condition for check type (e.g. "contains:error", "!=200")' },
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

    const triggerAt = input.triggerAt || (Date.now() + (input.delayMs || 300_000));
    const id = sched.add({
      chatId: this._currentChatId || this.instance.id,
      message: input.message,
      triggerAt,
      repeatMs: input.repeatMs || null,
      type: input.type || 'direct',
      command: input.command || null,
      condition: input.condition || null,
    });

    const when = new Date(triggerAt);
    const repeat = input.repeatMs ? ` (repeats every ${sched._fmtMs(input.repeatMs)})` : '';
    return `✅ Scheduled: "${input.message}" at ${when.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}${repeat} [id: ${id.slice(0, 8)}]`;
  }

  _scheduleList() {
    const sched = this.instance?.scheduler;
    if (!sched) return 'No scheduler';
    const jobs = sched.listAll();
    if (!jobs.length) return 'No scheduled jobs.';

    return jobs.map(j => {
      const when = new Date(j.triggerAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const repeat = j.repeatMs ? ` (every ${sched._fmtMs(j.repeatMs)})` : '';
      const type = j.type !== 'direct' ? ` [${j.type}]` : '';
      return `• ${j.id.slice(0, 8)} — "${j.message}" at ${when}${repeat}${type}`;
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
}
