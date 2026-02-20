import fs from 'node:fs';
import path from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

const DEFAULT_BASE_DIR = path.join(process.env.HOME || '/root', '.metaclaw');

/**
 * Config manager with ~/.metaclaw/ support, per-instance configs, and hot-reload.
 */
export class ConfigManager {
  /**
   * @param {string} [baseDir] — personal directory (default: ~/.metaclaw)
   */
  constructor(baseDir) {
    this.baseDir = baseDir || process.env.METACLAW_HOME || DEFAULT_BASE_DIR;
    /** @type {Object} */
    this.global = {};
    /** @type {Map<string, Object>} */
    this.instances = new Map();
    /** @type {fs.FSWatcher|null} */
    this._watcher = null;
    /** @type {Function[]} */
    this._onReload = [];
  }

  /**
   * Initialize: load global + all instance configs
   */
  load() {
    this.global = this._loadYaml(path.join(this.baseDir, 'config.yaml'));
    const localOverrides = this._loadYaml(path.join(this.baseDir, 'config.local.yaml'));
    this.global = this._deepMerge(this.global, localOverrides);

    // Discover instances
    const instancesDir = path.join(this.baseDir, 'instances');
    if (existsSync(instancesDir)) {
      for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          this._loadInstance(entry.name);
        }
      }
    }
  }

  /**
   * Load a single instance config (inherits from global)
   * @param {string} id
   */
  _loadInstance(id) {
    const dir = path.join(this.baseDir, 'instances', id);
    const config = this._loadYaml(path.join(dir, 'config.yaml'));
    const local = this._loadYaml(path.join(dir, 'config.local.yaml'));
    const identity = this._loadYaml(path.join(dir, 'identity.yaml'));

    // Merge: global defaults → instance config → instance local
    const merged = this._deepMerge(
      this._deepMerge({ ...this.global }, config),
      local
    );
    merged._identity = identity;
    merged._id = id;
    merged._dir = dir;

    this.instances.set(id, merged);
    return merged;
  }

  /**
   * Get resolved config for an instance
   * @param {string} id
   * @returns {Object|null}
   */
  getInstance(id) {
    return this.instances.get(id) || null;
  }

  /**
   * Get all instance IDs
   * @returns {string[]}
   */
  getInstanceIds() {
    return [...this.instances.keys()];
  }

  /**
   * Create a new instance directory structure
   * @param {string} id
   * @param {Object} [opts]
   */
  createInstance(id, opts = {}) {
    const dir = path.join(this.baseDir, 'instances', id);
    if (existsSync(dir)) throw new Error(`Instance "${id}" already exists`);

    const dirs = ['skills', 'knowledge', 'memory', 'sessions', 'logs'];
    for (const d of dirs) {
      mkdirSync(path.join(dir, d), { recursive: true });
    }

    // Default config
    const config = {
      model: {
        primary: opts.model || this.global.model?.primary || 'anthropic/claude-sonnet-4-6',
      },
      channels: opts.channels || [],
      skills: opts.skills || ['shell', 'web_search'],
    };

    const identity = {
      name: opts.name || id,
      personality: opts.personality || '',
      emoji: opts.emoji || '🤖',
      avatar: opts.avatar || null,
    };

    writeFileSync(path.join(dir, 'config.yaml'), yaml.dump(config));
    writeFileSync(path.join(dir, 'config.local.yaml'), '# Instance secrets (API keys, tokens)\n');
    writeFileSync(path.join(dir, 'identity.yaml'), yaml.dump(identity));

    this._loadInstance(id);
    return dir;
  }

  /**
   * Ensure base directory structure exists
   */
  ensureBaseDir() {
    const dirs = ['instances', 'certs'];
    for (const d of dirs) {
      mkdirSync(path.join(this.baseDir, d), { recursive: true });
    }
    const globalConfig = path.join(this.baseDir, 'config.yaml');
    if (!existsSync(globalConfig)) {
      writeFileSync(globalConfig, yaml.dump({
        mesh: { type: 'local' },
        missionControl: { port: 3100 },
        model: { primary: 'anthropic/claude-sonnet-4-6' },
      }));
    }
  }

  /**
   * Enable hot-reload via fs.watch
   * @param {Function} [callback]
   */
  watch(callback) {
    if (callback) this._onReload.push(callback);
    if (this._watcher) return;

    this._watcher = fs.watch(this.baseDir, { recursive: true }, (event, filename) => {
      if (!filename?.endsWith('.yaml')) return;
      try {
        this.load();
        for (const cb of this._onReload) cb(filename);
      } catch (e) {
        console.error('[ConfigManager] Hot-reload error:', e.message);
      }
    });
  }

  /**
   * Stop watching
   */
  unwatch() {
    this._watcher?.close();
    this._watcher = null;
  }

  /**
   * Load YAML file, return {} if missing
   * @param {string} filePath
   * @returns {Object}
   */
  _loadYaml(filePath) {
    try {
      if (!existsSync(filePath)) return {};
      const content = readFileSync(filePath, 'utf8');
      return yaml.load(content) || {};
    } catch {
      return {};
    }
  }

  /**
   * Deep merge b into a (b wins)
   * @param {Object} a
   * @param {Object} b
   * @returns {Object}
   */
  _deepMerge(a, b) {
    const result = { ...a };
    for (const key of Object.keys(b)) {
      if (b[key] && typeof b[key] === 'object' && !Array.isArray(b[key]) &&
          a[key] && typeof a[key] === 'object' && !Array.isArray(a[key])) {
        result[key] = this._deepMerge(a[key], b[key]);
      } else {
        result[key] = b[key];
      }
    }
    return result;
  }
}
