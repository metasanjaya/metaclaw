import fs from 'node:fs';
import path from 'node:path';
import { Skill } from './Skill.js';

/**
 * Skill discovery, loading, and management.
 */
export class SkillRegistry {
  /**
   * @param {import('../core/EventBus.js').EventBus} eventBus
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    /** @type {Map<string, Skill>} */
    this.skills = new Map();
  }

  /**
   * Register a skill
   * @param {Skill} skill
   */
  register(skill) {
    this.skills.set(skill.id, skill);
    console.log(`[SkillRegistry] Registered: ${skill.id} (${skill.type})`);
  }

  /**
   * Get skill by ID
   * @param {string} id
   * @returns {Skill|undefined}
   */
  get(id) {
    return this.skills.get(id);
  }

  /**
   * Get all skills enabled for an instance
   * @param {string} instanceId
   * @returns {Skill[]}
   */
  getForInstance(instanceId) {
    return [...this.skills.values()].filter(s => s.isEnabledFor(instanceId));
  }

  /**
   * Get tool definitions for function calling (for an instance)
   * @param {string} instanceId
   * @returns {Object[]}
   */
  getToolDefs(instanceId) {
    return this.getForInstance(instanceId)
      .map(s => s.toToolDef())
      .filter(Boolean);
  }

  /**
   * Load prompt-based skills from a directory
   * @param {string} dir — skills directory path
   */
  loadFromDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const skillMd = path.join(skillDir, 'SKILL.md');
      const indexJs = path.join(skillDir, 'index.js');

      if (fs.existsSync(indexJs)) {
        // Plugin skill — loaded dynamically
        this._loadPlugin(entry.name, skillDir, indexJs);
      } else if (fs.existsSync(skillMd)) {
        // Prompt-based skill
        this._loadPromptSkill(entry.name, skillDir, skillMd);
      }
    }
  }

  /**
   * @param {string} id
   * @param {string} dir
   * @param {string} mdPath
   */
  _loadPromptSkill(id, dir, mdPath) {
    const content = fs.readFileSync(mdPath, 'utf8');
    // Extract description from first paragraph after title
    const descMatch = content.match(/^#\s+.+\n+(.+)/m);
    const description = descMatch?.[1]?.trim() || `Prompt skill: ${id}`;

    this.register(new Skill({
      id,
      name: id,
      description,
      type: 'prompt',
      promptFile: mdPath,
    }));
  }

  /**
   * @param {string} id
   * @param {string} dir
   * @param {string} jsPath
   */
  async _loadPlugin(id, dir, jsPath) {
    try {
      const mod = await import(jsPath);
      if (mod.default && mod.default instanceof Skill) {
        this.register(mod.default);
      } else if (mod.skill && mod.skill instanceof Skill) {
        this.register(mod.skill);
      } else {
        console.warn(`[SkillRegistry] Plugin ${id} doesn't export a Skill instance`);
      }
    } catch (e) {
      console.error(`[SkillRegistry] Failed to load plugin ${id}:`, e.message);
    }
  }
}
