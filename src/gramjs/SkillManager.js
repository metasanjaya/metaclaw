import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

const log = (...args) => console.log('🔌', ...args);
const warn = (...args) => console.warn('🔌', ...args);

export default class SkillManager {
  constructor({ skillsDir, config = {}, tools = null }) {
    this.skillsDir = skillsDir;
    this.config = config;
    this.tools = tools;
    this.skills = new Map();       // name → { manifest, instance, status, toolMap }
    this.toolIndex = new Map();    // toolName → skillName
    this.globalConfig = {};
  }

  async init() {
    log('Initializing SkillManager...');
    await fs.mkdir(this.skillsDir, { recursive: true });

    // Load global config overrides
    try {
      const raw = await fs.readFile(path.join(this.skillsDir, '_config.json'), 'utf-8');
      this.globalConfig = JSON.parse(raw);
    } catch { /* no global config */ }

    // Discover skills
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const manifest = await this._readManifest(entry.name);
      if (!manifest) continue;
      this.skills.set(manifest.name, { manifest, instance: null, status: 'unloaded', toolMap: new Map() });
    }

    // Autoload
    for (const [name, skill] of this.skills) {
      if (skill.manifest.autoload) {
        await this.loadSkill(name);
      }
    }

    log(`Discovered ${this.skills.size} skill(s), ${[...this.skills.values()].filter(s => s.status === 'loaded').length} autoloaded`);
  }

  async _readManifest(dirName) {
    try {
      const raw = await fs.readFile(path.join(this.skillsDir, dirName, 'skill.json'), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _resolveConfig(manifest) {
    const resolved = {};
    const cfgSchema = manifest.config || {};
    const overrides = this.globalConfig[manifest.name] || {};

    for (const [key, def] of Object.entries(cfgSchema)) {
      // Priority: global config > env > default
      if (overrides[key] !== undefined) {
        resolved[key] = overrides[key];
      } else if (def.env && process.env[def.env] !== undefined) {
        resolved[key] = process.env[def.env];
      } else {
        resolved[key] = def.default ?? null;
      }
    }
    return resolved;
  }

  async loadSkill(name) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill '${name}' not found`);
    if (skill.status === 'loaded') return skill.manifest.tools;

    // Resolve dependencies first
    const requires = skill.manifest.requires || [];
    for (const dep of requires) {
      const depSkill = this.skills.get(dep);
      if (!depSkill) {
        warn(`Skill '${name}' requires '${dep}' which is not installed`);
        skill.status = 'error';
        return [];
      }
      if (depSkill.status !== 'loaded') {
        log(`Loading dependency '${dep}' for '${name}'`);
        await this.loadSkill(dep);
      }
    }

    try {
      const skillDir = path.join(this.skillsDir, name);
      const indexPath = path.join(skillDir, 'index.js');
      const fileUrl = pathToFileURL(indexPath).href + `?t=${Date.now()}`;
      const mod = await import(fileUrl);
      const Cls = mod.default;

      const context = {
        config: this._resolveConfig(skill.manifest),
        tools: this.tools,
        http: globalThis.fetch,
        skillDir,
        log: (...args) => log(`[${name}]`, ...args),
      };

      const instance = new Cls(context);
      if (typeof instance.init === 'function') await instance.init();

      // Build tool map
      const toolMap = new Map();
      for (const toolDef of skill.manifest.tools) {
        if (typeof instance[toolDef.name] !== 'function') {
          warn(`Skill '${name}' missing method '${toolDef.name}'`);
          continue;
        }
        toolMap.set(toolDef.name, toolDef);
        this.toolIndex.set(toolDef.name, name);
      }

      skill.instance = instance;
      skill.status = 'loaded';
      skill.toolMap = toolMap;
      log(`Loaded skill '${name}' with ${toolMap.size} tool(s)`);
      return skill.manifest.tools;
    } catch (err) {
      warn(`Failed to load skill '${name}':`, err.message);
      skill.status = 'error';
      skill.instance = null;
      return [];
    }
  }

  async unloadSkill(name) {
    const skill = this.skills.get(name);
    if (!skill || skill.status !== 'loaded') return;

    try {
      if (skill.instance && typeof skill.instance.destroy === 'function') {
        await skill.instance.destroy();
      }
    } catch (err) {
      warn(`Error destroying skill '${name}':`, err.message);
    }

    for (const toolName of skill.toolMap.keys()) {
      this.toolIndex.delete(toolName);
    }
    skill.instance = null;
    skill.status = 'unloaded';
    skill.toolMap = new Map();
    log(`Unloaded skill '${name}'`);
  }

  async reloadSkill(name) {
    await this.unloadSkill(name);
    return this.loadSkill(name);
  }

  async listSkills() {
    const list = [];
    for (const [name, skill] of this.skills) {
      list.push({
        name,
        version: skill.manifest.version,
        description: skill.manifest.description,
        status: skill.status,
        tools: skill.manifest.tools.map(t => t.name),
      });
    }
    return list;
  }

  getActiveTools() {
    const tools = [];
    for (const [, skill] of this.skills) {
      if (skill.status !== 'loaded') continue;
      for (const toolDef of skill.toolMap.values()) {
        tools.push({
          name: toolDef.name,
          description: toolDef.description,
          params: toolDef.params || {},
        });
      }
    }
    return tools;
  }

  isSkillTool(toolName) {
    return this.toolIndex.has(toolName);
  }

  async executeTool(toolName, input) {
    const skillName = this.toolIndex.get(toolName);
    if (!skillName) return `Error: Unknown skill tool '${toolName}'`;

    const skill = this.skills.get(skillName);
    if (!skill || skill.status !== 'loaded') return `Error: Skill '${skillName}' not loaded`;

    try {
      const result = await skill.instance[toolName](input);
      if (typeof result === 'string') return result;
      return JSON.stringify(result);
    } catch (err) {
      warn(`Tool '${toolName}' execution error:`, err.message);
      return `Error executing '${toolName}': ${err.message}`;
    }
  }

  async checkTriggers(query) {
    if (!query) return;
    const lower = query.toLowerCase();
    for (const [name, skill] of this.skills) {
      if (skill.status === 'loaded') continue;
      if (skill.status === 'disabled') continue;
      const triggers = skill.manifest.triggers || [];
      if (triggers.some(t => lower.includes(t.toLowerCase()))) {
        log(`Trigger matched for skill '${name}'`);
        await this.loadSkill(name);
      }
    }
  }

  getInstructions() {
    const parts = [];
    for (const [, skill] of this.skills) {
      if (skill.status === 'loaded' && skill.manifest.instructions) {
        parts.push(skill.manifest.instructions);
      }
    }
    return parts.join('\n\n');
  }

  async installSkill(source) {
    if (source.endsWith('.git') || source.startsWith('http')) {
      const name = path.basename(source, '.git');
      const dest = path.join(this.skillsDir, name);
      const { execSync } = await import('child_process');
      execSync(`git clone ${source} ${dest}`, { stdio: 'pipe' });
      const manifest = await this._readManifest(name);
      if (manifest) {
        this.skills.set(manifest.name, { manifest, instance: null, status: 'unloaded', toolMap: new Map() });
        log(`Installed skill '${manifest.name}' from git`);
        return manifest.name;
      }
      throw new Error('Cloned repo has no valid skill.json');
    } else {
      // Local path - copy
      const srcManifest = JSON.parse(await fs.readFile(path.join(source, 'skill.json'), 'utf-8'));
      const dest = path.join(this.skillsDir, srcManifest.name);
      await fs.cp(source, dest, { recursive: true });
      this.skills.set(srcManifest.name, { manifest: srcManifest, instance: null, status: 'unloaded', toolMap: new Map() });
      log(`Installed skill '${srcManifest.name}' from local path`);
      return srcManifest.name;
    }
  }

  async disableSkill(name) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill '${name}' not found`);
    if (skill.status === 'loaded') await this.unloadSkill(name);
    skill.status = 'disabled';
    log(`Disabled skill '${name}'`);
  }

  async enableSkill(name) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill '${name}' not found`);
    if (skill.status !== 'disabled') return;
    skill.status = 'unloaded';
    log(`Enabled skill '${name}'`);
  }

  async removeSkill(name) {
    await this.unloadSkill(name);
    const skillDir = path.join(this.skillsDir, name);
    await fs.rm(skillDir, { recursive: true, force: true });
    this.skills.delete(name);
    log(`Removed skill '${name}'`);
  }
}
