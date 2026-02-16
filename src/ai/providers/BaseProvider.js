/**
 * BaseProvider - Abstract base class for AI provider adapters
 */
export class BaseProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
  }

  async chat(messages, options = {}) {
    throw new Error(`${this.name}: chat() not implemented`);
  }

  /**
   * Chat with tools/function calling support
   * @param {Array} messages - Conversation messages
   * @param {Array} tools - Tool definitions
   * @param {object} options - Chat options (model, maxTokens, temperature, etc)
   * @returns {Promise<{ text: string, toolCalls?: Array<{id: string, name: string, input: object}>, tokensUsed: number, model: string, provider: string }>}
   */
  async chatWithTools(messages, tools, options = {}) {
    return await this.chat(messages, options);
  }

  /**
   * Normalize response to unified format
   * @returns {{ text: string, tokensUsed: number, inputTokens: number, outputTokens: number, model: string, provider: string }}
   */
  _normalize(text, tokensUsed, model, inputTokens = 0, outputTokens = 0) {
    return { text, tokensUsed, inputTokens, outputTokens, model: `${this.name}:${model}`, provider: this.name };
  }

  /**
   * Validate and sanitize provider response — ensures consistent shape
   * Call this at the end of every chat() / chatWithTools() before returning
   * @param {object} raw - Raw response object from provider-specific code
   * @returns {{ text: string, toolCalls?: Array, tokensUsed: number, inputTokens: number, outputTokens: number, model: string, provider: string }}
   */
  validateResponse(raw) {
    const validated = {
      text: typeof raw?.text === 'string' ? raw.text : '',
      tokensUsed: typeof raw?.tokensUsed === 'number' && raw.tokensUsed >= 0 ? raw.tokensUsed : 0,
      inputTokens: typeof raw?.inputTokens === 'number' && raw.inputTokens >= 0 ? raw.inputTokens : 0,
      outputTokens: typeof raw?.outputTokens === 'number' && raw.outputTokens >= 0 ? raw.outputTokens : 0,
      model: typeof raw?.model === 'string' ? raw.model : `${this.name}:unknown`,
      provider: this.name,
    };

    // Parse text-based tool calls (MiniMax sometimes outputs tools as text instead of native tool_use)
    // Patterns: [Tool: name]\n<parameter name="key">value</parameter>  OR  </invoke>\n</minimax:tool_call>
    if (validated.text && /\[Tool:\s*\w+\]|<parameter\s+name=|<\/minimax:tool_call>|<invoke\s+name=/i.test(validated.text)) {
      const textToolCalls = [];
      // Pattern 1: [Tool: name] with <parameter> tags
      const toolBlockRegex = /\[Tool:\s*(\w+)\]\s*((?:<parameter\s+name="([^"]+)">([^<]*)<\/parameter>\s*)*)/gi;
      let tbMatch;
      while ((tbMatch = toolBlockRegex.exec(validated.text)) !== null) {
        const toolName = tbMatch[1];
        const paramsBlock = tbMatch[2] || '';
        const input = {};
        const paramRegex = /<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/gi;
        let pMatch;
        while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
          input[pMatch[1]] = pMatch[2];
        }
        textToolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: toolName,
          input,
        });
      }
      // Pattern 2: <invoke name="toolName"><parameter name="key">value</parameter></invoke>
      const invokeRegex = /<invoke\s+name="(\w+)">((?:<parameter\s+name="([^"]+)">([^<]*)<\/parameter>\s*)*)<\/invoke>/gi;
      let ivMatch;
      while ((ivMatch = invokeRegex.exec(validated.text)) !== null) {
        const toolName = ivMatch[1];
        const paramsBlock = ivMatch[2] || '';
        const input = {};
        const paramRegex = /<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/gi;
        let pMatch;
        while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
          input[pMatch[1]] = pMatch[2];
        }
        textToolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: toolName,
          input,
        });
      }
      if (textToolCalls.length > 0) {
        console.log(`  🔧 Parsed ${textToolCalls.length} text-based tool call(s): ${textToolCalls.map(t => t.name).join(', ')}`);
        if (!raw.toolCalls) raw.toolCalls = [];
        raw.toolCalls.push(...textToolCalls);
      }
      // Strip raw tool XML/tags from text
      validated.text = validated.text
        .replace(/\[Tool:\s*\w+\]\s*(?:<parameter\s+name="[^"]*">[^<]*<\/parameter>\s*)*/gi, '')
        .replace(/<invoke\s+name="[^"]*">(?:<parameter\s+name="[^"]*">[^<]*<\/parameter>\s*)*<\/invoke>/gi, '')
        .replace(/<\/?minimax:tool_call>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // Validate toolCalls if present
    if (Array.isArray(raw?.toolCalls) && raw.toolCalls.length > 0) {
      validated.toolCalls = raw.toolCalls
        .filter(tc => tc && (typeof tc.name === 'string' || typeof tc.function?.name === 'string'))
        .map(tc => {
          // Support both native format {name, input} and OpenAI format {function: {name, arguments}}
          const name = tc.name || tc.function?.name;
          const input = tc.input || (tc.function?.arguments ? (typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments) : {});
          return {
            id: typeof tc.id === 'string' ? tc.id : `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            input: input && typeof input === 'object' ? input : {},
          };
        });
      if (validated.toolCalls.length === 0) delete validated.toolCalls;
    }

    // Derive tokensUsed from input+output if not set
    if (validated.tokensUsed === 0 && (validated.inputTokens > 0 || validated.outputTokens > 0)) {
      validated.tokensUsed = validated.inputTokens + validated.outputTokens;
    }

    return validated;
  }
}
