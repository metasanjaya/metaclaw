/**
 * ToolExecutor - Executes tools for MetaClaw AI
 * Shell, web search, web fetch, file ops, image analysis
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const execAsync = promisify(execCb);

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\{\s*:\|:&\s*\};:/,
  />\s*\/dev\/sd/,
  /format\s+[cC]:/,
  /shutdown/,
  /reboot/,
  /init\s+0/,
];

const MAX_OUTPUT = 10240; // 10KB

function truncate(str, max = MAX_OUTPUT) {
  if (str.length <= max) return str;
  return str.substring(0, max) + '\n... (truncated)';
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  return map[ext] || 'image/jpeg';
}

export class ToolExecutor {
  constructor() {
    this.apiKey = process.env.GOOGLE_API_KEY;
    this.workspace = '/root';
  }

  setWorkspace(dir) {
    this.workspace = dir;
  }

  _resolvePath(filePath) {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(this.workspace, filePath);
  }

  async execShell(command, { timeout = 30000, cwd } = {}) {
    cwd = cwd || this.workspace;
    // Safety check
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return { stdout: '', stderr: `Blocked: dangerous command pattern detected`, exitCode: 1 };
      }
    }
    try {
      const { stdout, stderr } = await execAsync(command, { timeout, cwd, maxBuffer: 1024 * 1024 });
      return { stdout: truncate(stdout), stderr: truncate(stderr), exitCode: 0 };
    } catch (err) {
      return {
        stdout: truncate(err.stdout || ''),
        stderr: truncate(err.stderr || err.message),
        exitCode: err.code || 1,
      };
    }
  }

  async webSearch(query, { count = 5 } = {}) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36' },
        timeout: 15000,
      });
      const results = [];
      const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = regex.exec(data)) !== null && results.length < count) {
        const rawUrl = match[1];
        let finalUrl = rawUrl;
        const udParam = rawUrl.match(/uddg=([^&]+)/);
        if (udParam) finalUrl = decodeURIComponent(udParam[1]);
        results.push({
          title: stripHtml(match[2]).substring(0, 200),
          url: finalUrl,
          snippet: stripHtml(match[3]).substring(0, 300),
        });
      }
      return results;
    } catch (err) {
      return [{ title: 'Search error', url: '', snippet: err.message }];
    }
  }

  async webFetch(url, { maxChars = 5000 } = {}) {
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        maxContentLength: 5 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36' },
      });
      const text = stripHtml(typeof data === 'string' ? data : JSON.stringify(data));
      const titleMatch = (typeof data === 'string' ? data : '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return {
        content: text.substring(0, maxChars),
        title: titleMatch ? stripHtml(titleMatch[1]) : '',
        url,
      };
    } catch (err) {
      return { content: `Fetch error: ${err.message}`, title: '', url };
    }
  }

  async readFile(filePath, { offset, limit } = {}) {
    try {
      filePath = this._resolvePath(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = (offset || 1) - 1;
      const end = limit ? start + limit : lines.length;
      return truncate(lines.slice(start, end).join('\n'));
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  async writeFile(filePath, content) {
    try {
      filePath = this._resolvePath(filePath);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content);
      return `Written ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  async listDir(dirPath) {
    try {
      dirPath = this._resolvePath(dirPath);
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n');
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  async analyzeImage(imagePath, prompt = 'Describe this image') {
    if (!this.apiKey) return { description: 'Error: GOOGLE_API_KEY not set' };
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');
      const mimeType = getMimeType(imagePath);

      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`,
        {
          contents: [{
            parts: [
              { inlineData: { mimeType, data: base64 } },
              { text: prompt },
            ],
          }],
        },
        { headers: { 'content-type': 'application/json' }, timeout: 30000 }
      );

      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || 'No description';
      return { description: text };
    } catch (err) {
      return { description: `Image analysis error: ${err.message}` };
    }
  }
}
