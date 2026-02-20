/**
 * Base auth interface. Per-channel auth (v1), centralized auth (v2 future).
 * @abstract
 */
export class AuthProvider {
  /**
   * @param {string} type — auth type identifier
   * @param {Object} config
   */
  constructor(type, config = {}) {
    this.type = type;
    this.config = config;
  }

  /**
   * Authenticate a request/connection
   * @param {Object} credentials
   * @returns {Promise<{valid: boolean, userId?: string, roles?: string[]}>}
   */
  async authenticate(credentials) {
    throw new Error('Not implemented: authenticate()');
  }

  /**
   * Check authorization for an action
   * @param {string} userId
   * @param {string} action
   * @returns {Promise<boolean>}
   */
  async authorize(userId, action) {
    return true; // permissive by default
  }
}
