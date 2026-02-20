/**
 * TopicManager - Per-instance auto topic classification
 * Ported from v2. Keyword-based (0 tokens), with selective context retrieval.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TOPIC_PATTERNS = [
  { topic: 'server-management', keywords: ['server', 'ssh', 'nginx', 'apache', 'systemctl', 'service', 'restart', 'uptime', 'disk', 'cpu', 'ram', 'memory', 'load', 'firewall', 'ufw', 'iptables', 'port', 'vps', 'vm'] },
  { topic: 'coding', keywords: ['code', 'function', 'class', 'bug', 'error', 'debug', 'refactor', 'implement', 'variable', 'loop', 'array', 'object', 'regex', 'algorithm', 'typescript', 'javascript', 'python', 'php', 'laravel', 'node', 'react', 'svelte', 'api', 'endpoint', 'route'] },
  { topic: 'deployment', keywords: ['deploy', 'build', 'ci', 'cd', 'pipeline', 'docker', 'container', 'kubernetes', 'forge', 'staging', 'production', 'release', 'rollback', 'webhook'] },
  { topic: 'database', keywords: ['database', 'db', 'mysql', 'mariadb', 'postgres', 'mongodb', 'redis', 'migration', 'schema', 'query', 'sql', 'table', 'backup'] },
  { topic: 'domain-dns', keywords: ['domain', 'dns', 'nameserver', 'ssl', 'certificate', 'https', 'letsencrypt', 'registrar', 'whois'] },
  { topic: 'networking', keywords: ['network', 'ip', 'subnet', 'vpn', 'proxy', 'reverse proxy', 'load balancer', 'cdn', 'cloudflare'] },
  { topic: 'git', keywords: ['git', 'github', 'gitlab', 'commit', 'push', 'pull', 'merge', 'branch', 'rebase', 'pr', 'pull request'] },
  { topic: 'security', keywords: ['security', 'vulnerability', 'hack', 'fail2ban', 'auth', 'password', 'encrypt', 'permission'] },
  { topic: 'general', keywords: [] },
];

const SWITCH_PATTERNS = [
  /lanjut(in|kan)?\s+(yang|soal|tentang|bahas)\s+(.+)/i,
  /balik\s+ke\s+(yang|soal|topik|bahas)\s+(.+)/i,
  /back\s+to\s+(the\s+)?(.+)/i,
  /continue\s+(with\s+)?(the\s+)?(.+)/i,
  /gimana\s+(yang|soal|tentang)\s+(.+)/i,
];

export class TopicManager {
  constructor(instanceDir) {
    this.persistPath = join(instanceDir, 'data', 'topics.json');
    this.chatTopics = new Map();
    this._saveTimer = null;
    this._load();
  }

  classify(chatId, text, role = 'user') {
    if (!text || text.length < 5) return this.getActiveTopic(chatId);
    const lower = text.toLowerCase();

    if (role === 'user') {
      const switchTo = this._detectSwitch(chatId, lower);
      if (switchTo) { this._setActive(chatId, switchTo); return switchTo; }
    }

    let best = null, bestScore = 0;
    for (const { topic, keywords } of TOPIC_PATTERNS) {
      if (topic === 'general') continue;
      let score = 0;
      for (const kw of keywords) { if (lower.includes(kw)) score += kw.includes(' ') ? 2 : 1; }
      if (score > bestScore) { bestScore = score; best = topic; }
    }

    if (bestScore < 1) {
      return text.split(/\s+/).length <= 10 ? this.getActiveTopic(chatId) : 'general';
    }
    this._setActive(chatId, best);
    return best;
  }

  _detectSwitch(chatId, text) {
    for (const p of SWITCH_PATTERNS) {
      const m = text.match(p);
      if (m) {
        const hint = m[m.length - 1].trim().toLowerCase();
        const data = this.chatTopics.get(chatId);
        if (data) {
          for (const name of Object.keys(data.topics)) {
            if (name.includes(hint) || hint.includes(name.split('-')[0])) return name;
          }
        }
        for (const { topic, keywords } of TOPIC_PATTERNS) {
          if (topic === 'general') continue;
          if (topic.includes(hint) || keywords.some(kw => hint.includes(kw))) return topic;
        }
      }
    }
    return null;
  }

  getActiveTopic(chatId) { return this.chatTopics.get(chatId)?.activeTopic || 'general'; }

  _setActive(chatId, topic) {
    if (!this.chatTopics.has(chatId)) this.chatTopics.set(chatId, { activeTopic: topic, topics: {} });
    const d = this.chatTopics.get(chatId);
    d.activeTopic = topic;
    if (!d.topics[topic]) d.topics[topic] = { lastActive: Date.now(), msgCount: 0 };
    d.topics[topic].lastActive = Date.now();
    d.topics[topic].msgCount++;
    this._scheduleSave();
  }

  /** Context hint for system prompt */
  getContextHint(chatId) {
    const d = this.chatTopics.get(chatId);
    if (!d || Object.keys(d.topics).length <= 1) return '';
    const topics = Object.entries(d.topics)
      .filter(([n]) => n !== 'general')
      .sort((a, b) => b[1].lastActive - a[1].lastActive).slice(0, 5);
    if (!topics.length) return '';
    const lines = topics.map(([n, data]) => `- ${n} (${data.msgCount} msgs)${n === d.activeTopic ? ' ← active' : ''}`);
    return `\n## Active Topics\n${lines.join('\n')}`;
  }

  _load() {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        for (const [k, v] of Object.entries(data)) this.chatTopics.set(k, v);
      }
    } catch {}
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, 5000);
  }

  _save() {
    try {
      const data = {}; for (const [k, v] of this.chatTopics) data[k] = v;
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {}
  }
}
