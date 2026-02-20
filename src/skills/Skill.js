/**
 * Base Skill class — native tools, prompt skills, and plugins extend this.
 * @abstract
 */
export class Skill {
  /**
   * @param {Object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {string} opts.description
   * @param {'native'|'prompt'|'plugin'} opts.type
   * @param {string} [opts.version]
   * @param {Object} [opts.schema] — JSON Schema for native function calling
   * @param {string[]} [opts.permissions]
   * @param {string[]} [opts.enabledFor] — instance IDs (empty = all)
   */
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.description = opts.description;
    this.type = opts.type;
    this.version = opts.version || '1.0.0';
    this.schema = opts.schema || null;
    this.permissions = opts.permissions || [];
    this.enabledFor = opts.enabledFor || [];
  }

  /**
   * Check if skill is enabled for an instance
   * @param {string} instanceId
   * @returns {boolean}
   */
  isEnabledFor(instanceId) {
    return this.enabledFor.length === 0 || this.enabledFor.includes(instanceId);
  }

  /**
   * Execute the skill (native/plugin only)
   * @param {Object} params — tool call parameters
   * @param {import('../core/types.js').SkillContext} context
   * @returns {Promise<any>}
   */
  async execute(params, context) {
    throw new Error('Not implemented: execute()');
  }

  /**
   * Get tool definition for function calling APIs
   * @returns {Object|null}
   */
  toToolDef() {
    if (this.type !== 'native' || !this.schema) return null;
    return {
      name: this.id,
      description: this.description,
      input_schema: this.schema,
    };
  }
}
