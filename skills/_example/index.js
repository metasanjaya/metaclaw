export default class ExampleSkill {
  constructor(context) {
    this.log = context.log;
  }

  async init() {
    this.log('Example skill initialized');
  }

  async destroy() {
    this.log('Example skill destroyed');
  }

  async echo({ message }) {
    return { echo: message, timestamp: Date.now() };
  }

  async ping() {
    return { status: 'pong', timestamp: Date.now() };
  }
}
