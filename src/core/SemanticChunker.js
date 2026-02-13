/**
 * SemanticChunker - Split text into meaningful semantic chunks
 * 
 * Unlike simple character/token splitting, this maintains semantic boundaries:
 * - Respects sentence boundaries
 * - Keeps related content together
 * - Handles code blocks specially
 * - Considers paragraph structure
 */

export class SemanticChunker {
  constructor(options = {}) {
    this.maxChunkSize = options.maxChunkSize || 500; // tokens
    this.minChunkSize = options.minChunkSize || 100;
    this.overlapSize = options.overlapSize || 50; // overlap between chunks
    this.preserveCodeBlocks = options.preserveCodeBlocks !== false;
  }

  /**
   * Main chunking method
   */
  chunk(text, metadata = {}) {
    // Detect content type
    const type = this.detectContentType(text);
    
    if (type === 'code') {
      return this.chunkCode(text, metadata);
    }
    
    if (type === 'structured') {
      return this.chunkStructured(text, metadata);
    }
    
    return this.chunkNatural(text, metadata);
  }

  /**
   * Detect content type
   */
  detectContentType(text) {
    // Check for code indicators
    const codeIndicators = [
      /```/g,
      /function\s+\w+\s*\(/,
      /const\s+\w+\s*=/,
      /class\s+\w+/,
      /import\s+.*from/,
      /\{[\s\S]*\}/
    ];
    
    const codeScore = codeIndicators.reduce((score, pattern) => {
      return score + (pattern.test(text) ? 1 : 0);
    }, 0);
    
    if (codeScore >= 3) return 'code';
    
    // Check for structured data (JSON, lists, etc.)
    if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
      try {
        JSON.parse(text);
        return 'structured';
      } catch {
        // Not JSON
      }
    }
    
    // Check for lists
    const lines = text.split('\n');
    const listLines = lines.filter(line => /^\s*[-*•]\s/.test(line) || /^\s*\d+\.\s/.test(line));
    if (listLines.length > lines.length * 0.4) {
      return 'structured';
    }
    
    return 'natural';
  }

  /**
   * Chunk natural language text
   */
  chunkNatural(text, metadata = {}) {
    const chunks = [];
    
    // Split into sentences
    const sentences = this.splitSentences(text);
    
    let currentChunk = '';
    let currentTokens = 0;
    
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const sentenceTokens = this.estimateTokens(sentence);
      
      // Check if adding this sentence exceeds limit
      if (currentTokens + sentenceTokens > this.maxChunkSize && currentChunk) {
        // Save current chunk
        chunks.push({
          content: currentChunk.trim(),
          tokens: currentTokens,
          type: 'natural',
          ...metadata
        });
        
        // Start new chunk with overlap
        const overlap = this.getOverlap(currentChunk);
        currentChunk = overlap + sentence;
        currentTokens = this.estimateTokens(currentChunk);
      } else {
        // Add to current chunk
        currentChunk += (currentChunk ? ' ' : '') + sentence;
        currentTokens += sentenceTokens;
      }
    }
    
    // Add final chunk
    if (currentChunk) {
      chunks.push({
        content: currentChunk.trim(),
        tokens: currentTokens,
        type: 'natural',
        ...metadata
      });
    }
    
    return chunks;
  }

  /**
   * Chunk code text
   */
  chunkCode(text, metadata = {}) {
    const chunks = [];
    
    // Preserve code blocks
    const blocks = this.extractCodeBlocks(text);
    
    for (const block of blocks) {
      const tokens = this.estimateTokens(block.content);
      
      if (tokens <= this.maxChunkSize) {
        // Block fits in one chunk
        chunks.push({
          content: block.content,
          tokens,
          type: 'code',
          language: block.language,
          ...metadata
        });
      } else {
        // Split by logical boundaries (functions, classes, etc.)
        const subChunks = this.splitCodeByLogic(block.content, block.language);
        chunks.push(...subChunks.map(c => ({
          ...c,
          type: 'code',
          language: block.language,
          ...metadata
        })));
      }
    }
    
    return chunks;
  }

  /**
   * Chunk structured text (lists, JSON, etc.)
   */
  chunkStructured(text, metadata = {}) {
    const chunks = [];
    const lines = text.split('\n');
    
    let currentChunk = '';
    let currentTokens = 0;
    let indentLevel = 0;
    
    for (const line of lines) {
      const lineTokens = this.estimateTokens(line);
      const lineIndent = this.getIndentLevel(line);
      
      // Keep same indent level together
      if (currentTokens + lineTokens > this.maxChunkSize && lineIndent <= indentLevel) {
        if (currentChunk) {
          chunks.push({
            content: currentChunk.trim(),
            tokens: currentTokens,
            type: 'structured',
            ...metadata
          });
        }
        
        currentChunk = line;
        currentTokens = lineTokens;
        indentLevel = lineIndent;
      } else {
        currentChunk += '\n' + line;
        currentTokens += lineTokens;
        indentLevel = Math.max(indentLevel, lineIndent);
      }
    }
    
    if (currentChunk) {
      chunks.push({
        content: currentChunk.trim(),
        tokens: currentTokens,
        type: 'structured',
        ...metadata
      });
    }
    
    return chunks;
  }

  /**
   * Helper: Split text into sentences
   */
  splitSentences(text) {
    // Simple sentence boundary detection
    return text
      .split(/([.!?]+[\s\n]+)/)
      .filter(s => s.trim())
      .reduce((sentences, part, i, arr) => {
        if (i % 2 === 0) {
          sentences.push(part + (arr[i + 1] || ''));
        }
        return sentences;
      }, []);
  }

  /**
   * Helper: Extract code blocks
   */
  extractCodeBlocks(text) {
    const blocks = [];
    const regex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    let lastIndex = 0;
    
    while ((match = regex.exec(text)) !== null) {
      // Add text before code block
      const beforeText = text.substring(lastIndex, match.index).trim();
      if (beforeText) {
        blocks.push({
          content: beforeText,
          language: null,
          isCode: false
        });
      }
      
      // Add code block
      blocks.push({
        content: match[2].trim(),
        language: match[1] || 'unknown',
        isCode: true
      });
      
      lastIndex = regex.lastIndex;
    }
    
    // Add remaining text
    const remaining = text.substring(lastIndex).trim();
    if (remaining) {
      blocks.push({
        content: remaining,
        language: null,
        isCode: false
      });
    }
    
    return blocks.length > 0 ? blocks : [{ content: text, language: null, isCode: true }];
  }

  /**
   * Helper: Split code by logical boundaries
   */
  splitCodeByLogic(code, language) {
    // Split by function/class definitions
    const patterns = {
      javascript: /(?:^|\n)((?:async\s+)?(?:function|class|const|let|var)\s+\w+[^{]*\{)/g,
      python: /(?:^|\n)(def\s+\w+|class\s+\w+)/g,
      java: /(?:^|\n)((?:public|private|protected)?\s*(?:static)?\s*(?:class|interface|void|int|String)\s+\w+)/g
    };
    
    const pattern = patterns[language] || patterns.javascript;
    const splits = code.split(pattern).filter(s => s.trim());
    
    return splits.map(content => ({
      content: content.trim(),
      tokens: this.estimateTokens(content)
    }));
  }

  /**
   * Helper: Get overlap text
   */
  getOverlap(text) {
    const tokens = this.estimateTokens(text);
    if (tokens < this.overlapSize) return text;
    
    const sentences = this.splitSentences(text);
    let overlap = '';
    let overlapTokens = 0;
    
    for (let i = sentences.length - 1; i >= 0; i--) {
      const sentence = sentences[i];
      const sentenceTokens = this.estimateTokens(sentence);
      
      if (overlapTokens + sentenceTokens <= this.overlapSize) {
        overlap = sentence + ' ' + overlap;
        overlapTokens += sentenceTokens;
      } else {
        break;
      }
    }
    
    return overlap;
  }

  /**
   * Helper: Get indent level
   */
  getIndentLevel(line) {
    const match = line.match(/^\s*/);
    return match ? match[0].length : 0;
  }

  /**
   * Helper: Estimate tokens
   */
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
}
