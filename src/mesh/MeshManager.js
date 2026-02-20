/**
 * Mesh networking coordinator (placeholder for Phase 5).
 * Handles local (EventBus) and cross-host (WebSocket/WireGuard) communication.
 */
export class MeshManager {
  constructor({ eventBus, config = {} }) {
    this.eventBus = eventBus;
    this.config = config;
    this.type = config.type || 'local'; // 'local' | 'websocket' | 'wireguard'
  }

  async start() {
    console.log(`[MeshManager] Mode: ${this.type} (placeholder)`);
  }

  async stop() {
    console.log('[MeshManager] Stopped');
  }

  /**
   * Send message to another instance (local or remote)
   * @param {import('../core/types.js').MeshMessage} msg
   */
  async send(msg) {
    if (this.type === 'local') {
      this.eventBus.emit(`mesh.${msg.to}`, msg);
    } else {
      // TODO: WebSocket / WireGuard transport
      throw new Error(`Mesh type "${this.type}" not yet implemented`);
    }
  }
}
