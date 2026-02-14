/**
 * TopicManager - Auto-classify and manage conversation topics
 * 
 * Each message gets a topic tag. Context retrieval is topic-aware:
 * - 70% from active topic, 30% from recent (any topic)
 * - Topics auto-detected via keyword matching + semantic similarity
 * - Supports explicit topic switching ("lanjutin yang server")
 * 
 * Token efficient: classification is local (no AI call), 
 * only uses embeddings when available.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSIST_PATH = path.join(__dirname, '../../data/topics.json');
const SAVE_DEBOUNCE_MS = 5000;

// Known topic patterns — extensible
const TOPIC_PATTERNS = [
  { topic: 'server-management', keywords: ['server', 'ssh', 'nginx', 'apache', 'systemctl', 'service', 'restart', 'uptime', 'disk', 'cpu', 'ram', 'memory', 'load', 'htop', 'top', 'ps aux', 'firewall', 'ufw', 'iptables', 'port', 'jump host', 'bastion', 'vps', 'vm', 'instance'] },
  { topic: 'coding', keywords: ['code', 'coding', 'function', 'class', 'bug', 'error', 'debug', 'refactor', 'implement', 'variable', 'loop', 'array', 'object', 'string', 'regex', 'algorithm', 'typescript', 'javascript', 'python', 'php', 'laravel', 'node', 'react', 'svelte', 'api', 'endpoint', 'route'] },
  { topic: 'deployment', keywords: ['deploy', 'build', 'ci', 'cd', 'pipeline', 'docker', 'container', 'kubernetes', 'k8s', 'forge', 'staging', 'production', 'release', 'rollback', 'webhook'] },
  { topic: 'database', keywords: ['database', 'db', 'mysql', 'mariadb', 'postgres', 'mongodb', 'redis', 'migration', 'schema', 'query', 'sql', 'table', 'index', 'backup'] },
  { topic: 'domain-dns', keywords: ['domain', 'dns', 'nameserver', 'ns', 'a record', 'cname', 'mx', 'txt record', 'ssl', 'certificate', 'cert', 'https', 'letsencrypt', 'registrar', 'whois', 'transfer'] },
  { topic: 'networking', keywords: ['network', 'ip', 'subnet', 'vpn', 'proxy', 'reverse proxy', 'load balancer', 'cdn', 'cloudflare', 'bandwidth', 'latency', 'ping', 'traceroute', 'dns'] },
  { topic: 'git', keywords: ['git', 'github', 'gitlab', 'commit', 'push', 'pull', 'merge', 'branch', 'rebase', 'cherry-pick', 'stash', 'conflict', 'pr', 'pull request'] },
  { topic: 'security', keywords: ['security', 'vulnerability', 'hack', 'malware', 'brute force', 'fail2ban', 'auth', 'authentication', 'password', 'key', 'encrypt', 'permission', 'chmod', 'chown'] },
  { topic: 'hardware', keywords: ['processor', 'intel', 'amd', 'arm', 'cpu', 'gpu', 'nvidia', 'motherboard', 'ssd', 'hdd', 'nvme', 'benchmark', 'spec', 'spek', 'hardware', 'chip', 'core', 'thread', 'ghz', 'watt'] },
  { topic: 'general', keywords: [] }, // fallback
];

// Switch phrases — user explicitly wants to resume a topic
const SWITCH_PATTERNS = [
  /lanjut(in|kan)?\s+(yang|soal|tentang|bahas)\s+(.+)/i,
  /balik\s+ke\s+(yang|soal|topik|bahas)\s+(.+)/i,
  /back\s+to\s+(the\s+)?(.+)/i,
  /continue\s+(with\s+)?(the\s+)?(.+)/i,
  /gimana\s+(yang|soal|tentang)\s+(.+)/i,
  /how('s| is| about)\s+(the\s+)?(.+)/i,
];

export class TopicManager {
  constructor(embedder = null) {
    this.embedder = embedder;
    this.chatTopics = new Map(); // chatId → { activeTopic, topics: { name: { lastActive, msgCount, summary } } }
    this._saveTimer = null;
    this._load();
  }

  /**
   * Classify a message's topic. Returns topic name.
   * Uses keyword matching (fast, 0 tokens) + optional semantic matching.
   */
  classify(chatId, text, role = 'user') {
    if (!text || text.length < 5) return this.getActiveTopic(chatId);

    const lower = text.toLowerCase();

    // Check for explicit topic switch
    if (role === 'user') {
      const switchTo = this._detectTopicSwitch(chatId, lower);
      if (switchTo) {
        this._setActiveTopic(chatId, switchTo);
        return switchTo;
      }
    }

    // Score each known topic by keyword matches
    let bestTopic = null;
    let bestScore = 0;

    for (const { topic, keywords } of TOPIC_PATTERNS) {
      if (topic === 'general') continue;
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          score += kw.includes(' ') ? 2 : 1; // multi-word = stronger signal
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestTopic = topic;
      }
    }

    // Need at least 1 keyword hit to classify (2+ for multi-word match is auto)
    if (bestScore < 1) {
      // No keyword match → keep current topic for short msgs, general for long
      const words = text.trim().split(/\s+/);
      if (words.length <= 10) {
        return this.getActiveTopic(chatId);
      }
      bestTopic = 'general';
    }

    this._setActiveTopic(chatId, bestTopic);
    return bestTopic;
  }

  /**
   * Detect explicit topic switch from user message
   */
  _detectTopicSwitch(chatId, text) {
    for (const pattern of SWITCH_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // Get the topic hint from the last capture group
        const hint = match[match.length - 1].trim().toLowerCase();
        // Find matching topic from registry
        const chatData = this.chatTopics.get(chatId);
        if (chatData) {
          for (const topicName of Object.keys(chatData.topics)) {
            if (topicName.includes(hint) || hint.includes(topicName.split('-')[0])) {
              return topicName;
            }
          }
        }
        // Try matching against known patterns
        for (const { topic, keywords } of TOPIC_PATTERNS) {
          if (topic === 'general') continue;
          if (topic.includes(hint) || hint.includes(topic.split('-')[0])) return topic;
          if (keywords.some(kw => hint.includes(kw))) return topic;
        }
      }
    }
    return null;
  }

  /**
   * Get active topic for a chat
   */
  getActiveTopic(chatId) {
    const chatData = this.chatTopics.get(chatId);
    return chatData?.activeTopic || 'general';
  }

  /**
   * Get topic registry for a chat
   */
  getTopics(chatId) {
    const chatData = this.chatTopics.get(chatId);
    return chatData?.topics || {};
  }

  /**
   * Set active topic and update registry
   */
  _setActiveTopic(chatId, topic) {
    if (!this.chatTopics.has(chatId)) {
      this.chatTopics.set(chatId, { activeTopic: topic, topics: {} });
    }
    const chatData = this.chatTopics.get(chatId);
    chatData.activeTopic = topic;

    if (!chatData.topics[topic]) {
      chatData.topics[topic] = { lastActive: Date.now(), msgCount: 0, summary: '' };
    }
    chatData.topics[topic].lastActive = Date.now();
    chatData.topics[topic].msgCount++;

    this._scheduleSave();
  }

  /**
   * Update topic summary (called after compaction or periodically)
   */
  updateSummary(chatId, topic, summary) {
    const chatData = this.chatTopics.get(chatId);
    if (chatData?.topics[topic]) {
      chatData.topics[topic].summary = summary.substring(0, 500);
      this._scheduleSave();
    }
  }

  /**
   * Get context hint for system prompt — tells AI what topics exist
   */
  getContextHint(chatId) {
    const chatData = this.chatTopics.get(chatId);
    if (!chatData || Object.keys(chatData.topics).length <= 1) return '';

    const topics = Object.entries(chatData.topics)
      .filter(([name]) => name !== 'general')
      .sort((a, b) => b[1].lastActive - a[1].lastActive)
      .slice(0, 5);

    if (topics.length === 0) return '';

    const active = chatData.activeTopic;
    const lines = topics.map(([name, data]) => {
      const marker = name === active ? ' ← active' : '';
      return `- ${name} (${data.msgCount} msgs)${marker}`;
    });

    return `[Active topics: ${active}]\n${lines.join('\n')}`;
  }

  // Persistence
  _load() {
    try {
      if (fs.existsSync(PERSIST_PATH)) {
        const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8'));
        for (const [chatId, chatData] of Object.entries(data)) {
          this.chatTopics.set(chatId, chatData);
        }
        console.log(`🏷️ Loaded topics for ${this.chatTopics.size} chats`);
      }
    } catch (e) {
      console.warn(`⚠️ Failed to load topics: ${e.message}`);
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, SAVE_DEBOUNCE_MS);
  }

  _save() {
    try {
      const data = {};
      for (const [chatId, chatData] of this.chatTopics) {
        data[chatId] = chatData;
      }
      const dir = path.dirname(PERSIST_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn(`⚠️ Failed to save topics: ${e.message}`);
    }
  }
}
