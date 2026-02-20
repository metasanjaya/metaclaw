/**
 * LessonLearner — Learn from errors and user corrections
 * 
 * Detects correction patterns in user messages, extracts lessons via AI,
 * appends to MY_RULES.md. Confirmed preferences (3+ occurrences) get
 * promoted to SOUL.md.
 * 
 * Storage: <instanceDir>/lessons.json
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Correction patterns (Indonesian + English)
const CORRECTION_PATTERNS = [
  /\b(salah|bukan|yang bener|yang benar|koreksi|wrong|incorrect|not right|no,?\s+it'?s)/i,
  /\b(maksud\s*(ku|gue|gw|aku)|i\s+mean(t)?|actually|seharusnya|harusnya)\b/i,
  /\b(jangan\s+gitu|don'?t\s+do\s+(that|it\s+like))\b/i,
  /\b(tolong\s+jangan|please\s+don'?t|stop\s+(doing|saying))\b/i,
];

export class LessonLearner {
  /**
   * @param {Object} opts
   * @param {string} opts.instanceDir
   * @param {import('../core/Router.js').Router} opts.router
   * @param {string} opts.instanceId
   * @param {string} [opts.extractModel] — cheap model for lesson extraction
   */
  constructor({ instanceDir, router, instanceId, extractModel }) {
    this.dir = instanceDir;
    this.router = router;
    this.instanceId = instanceId;
    this.extractModel = extractModel || 'gemini-2.5-flash';

    this._lessonsPath = join(instanceDir, 'lessons.json');
    this._myRulesPath = join(instanceDir, 'MY_RULES.md');
    this._soulPath = join(instanceDir, 'SOUL.md');

    /** @type {Array<{id: string, lesson: string, context: string, category: string, timestamp: string, chatId?: string}>} */
    this.lessons = [];
    this._saveTimer = null;

    this._load();
  }

  _load() {
    try {
      if (existsSync(this._lessonsPath)) {
        this.lessons = JSON.parse(readFileSync(this._lessonsPath, 'utf-8'));
      }
    } catch { this.lessons = []; }
  }

  /**
   * Check if a user message is a correction, and learn from it
   * @param {string} userMessage
   * @param {string} previousAssistant — the AI response being corrected
   * @param {string} chatId
   * @returns {Promise<boolean>} true if correction detected
   */
  async checkCorrection(userMessage, previousAssistant, chatId) {
    const isCorrection = CORRECTION_PATTERNS.some(p => p.test(userMessage));
    if (!isCorrection) return false;

    const context = `User: "${userMessage.substring(0, 200)}"\nAI: "${(previousAssistant || '').substring(0, 200)}"`;
    await this._extractAndSave(context, 'user_correction', chatId);
    this._checkPreferencePromotion();
    return true;
  }

  /**
   * Log a tool execution error as a lesson
   * @param {string} toolName
   * @param {any} input
   * @param {string} error
   * @param {string} chatId
   */
  async logError(toolName, input, error, chatId) {
    const context = `Tool "${toolName}" failed: ${error.substring(0, 200)}`;
    await this._extractAndSave(context, 'tool_error', chatId);
  }

  /**
   * Get relevant lessons for a query (keyword search)
   * @param {string} query
   * @param {number} topK
   * @returns {Array<{lesson: string, category: string, score: number}>}
   */
  getRelevantLessons(query, topK = 3) {
    if (!this.lessons.length) return [];
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return [];

    return this.lessons
      .map(l => {
        const text = (l.lesson + ' ' + l.context).toLowerCase();
        const hits = words.filter(w => text.includes(w)).length;
        return { lesson: l.lesson, category: l.category, score: hits / words.length };
      })
      .filter(l => l.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Build context string for system prompt
   * @param {string} query
   * @returns {string}
   */
  buildContext(query) {
    const lessons = this.getRelevantLessons(query);
    if (!lessons.length) return '';
    return '\n## Lessons Learned\n' + lessons.map(l => `- [${l.category}] ${l.lesson}`).join('\n') + '\n';
  }

  // ========== Internal ==========

  async _extractAndSave(context, category, chatId) {
    if (!this.router) return;

    try {
      const response = await this.router.chat({
        instanceId: this.instanceId,
        model: this.extractModel,
        messages: [
          { role: 'system', content: 'Extract a 1-line actionable lesson from this error/correction. Max 100 chars. Be specific.' },
          { role: 'user', content: context },
        ],
        options: { maxTokens: 60, temperature: 0 },
      });

      let lesson = (response.text || '').trim().replace(/^[`#*\-]+\s*/, '').replace(/[`*]+$/, '').trim();
      if (!lesson || lesson.length < 10 || lesson.length > 150) return;

      // Dedup: skip if similar lesson exists
      const lessonKey = lesson.substring(0, 40).toLowerCase();
      if (this.lessons.some(l => l.lesson.substring(0, 40).toLowerCase() === lessonKey)) return;

      const entry = {
        id: `l_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        lesson,
        context: context.substring(0, 200),
        category,
        timestamp: new Date().toISOString(),
        chatId,
      };

      this.lessons.push(entry);
      if (this.lessons.length > 200) this.lessons = this.lessons.slice(-200);

      this._scheduleSave();
      this._appendToMyRules(lesson, category);
      console.log(`[LessonLearner:${this.instanceId}] Learned [${category}]: ${lesson}`);
    } catch (e) {
      console.error(`[LessonLearner:${this.instanceId}] Extract failed: ${e.message}`);
    }
  }

  _appendToMyRules(lesson, category) {
    try {
      const date = new Date().toISOString().split('T')[0];
      const line = `- [${date}] ${lesson} (${category})\n`;

      let existing = '';
      if (existsSync(this._myRulesPath)) existing = readFileSync(this._myRulesPath, 'utf-8');
      if (existing.includes(lesson.substring(0, 40))) return;

      appendFileSync(this._myRulesPath, line);
    } catch {}
  }

  /** Promote confirmed preferences (3+ occurrences) to SOUL.md */
  _checkPreferencePromotion() {
    const corrections = this.lessons.filter(l => l.category === 'user_correction');
    const groups = {};
    for (const c of corrections) {
      const key = c.lesson.substring(0, 40).toLowerCase();
      groups[key] = groups[key] || [];
      groups[key].push(c);
    }

    for (const [, items] of Object.entries(groups)) {
      if (items.length >= 3 && !items[0]._promoted) {
        this._promotToSoul(items[0].lesson);
        items[0]._promoted = true;
        this._scheduleSave();
      }
    }
  }

  _promotToSoul(preference) {
    try {
      if (!existsSync(this._soulPath)) return;
      let soul = readFileSync(this._soulPath, 'utf-8');
      if (soul.includes(preference)) return;

      const section = '## Learned Preferences';
      if (!soul.includes(section)) soul += `\n\n${section}\n`;

      const idx = soul.indexOf(section) + section.length;
      soul = soul.substring(0, idx) + `\n- ${preference}` + soul.substring(idx);
      writeFileSync(this._soulPath, soul);
      console.log(`[LessonLearner:${this.instanceId}] Promoted to SOUL.md: ${preference}`);
    } catch {}
  }

  // ========== Persistence ==========

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { writeFileSync(this._lessonsPath, JSON.stringify(this.lessons, null, 2)); } catch {}
    }, 3000);
  }

  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try { writeFileSync(this._lessonsPath, JSON.stringify(this.lessons, null, 2)); } catch {}
  }

  getStats() {
    return {
      totalLessons: this.lessons.length,
      corrections: this.lessons.filter(l => l.category === 'user_correction').length,
      toolErrors: this.lessons.filter(l => l.category === 'tool_error').length,
    };
  }
}
