/**
 * LessonLearner - Learn from errors and user corrections
 * Stores lessons in data/lessons.json, injects relevant ones into system prompt.
 * Auto-updates SOUL.md with confirmed preferences (3+ occurrences).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_PATH = path.join(__dirname, '../../data/lessons.json');
const SOUL_PATH = path.join(__dirname, '../../personality/SOUL.md');

// Correction patterns (Indonesian + English)
const CORRECTION_PATTERNS = [
  /\b(salah|bukan|yang bener|yang benar|koreksi|wrong|incorrect|not right|no,?\s+it'?s)/i,
  /\b(maksud\s*(ku|gue|gw|aku)|i\s+mean(t)?|actually|seharusnya|harusnya)\b/i,
  /\b(jangan\s+gitu|don'?t\s+do\s+(that|it\s+like))\b/i,
];

export class LessonLearner {
  constructor({ ai, embedder, config }) {
    this.ai = ai;
    this.embedder = embedder;
    this.config = config;
    this.lessons = [];
    this._lessonEmbeddings = new Map(); // id → embedding
    this._saveTimer = null;

    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(LESSONS_PATH)) {
        this.lessons = JSON.parse(fs.readFileSync(LESSONS_PATH, 'utf-8'));
      }
    } catch {
      this.lessons = [];
    }
    console.log(`🎓 LessonLearner: ${this.lessons.length} lessons loaded`);
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 3000);
  }

  _save() {
    try {
      const dir = path.dirname(LESSONS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LESSONS_PATH, JSON.stringify(this.lessons, null, 2));
    } catch (err) {
      console.warn(`⚠️ LessonLearner save failed: ${err.message}`);
    }
  }

  _appendToMyRules(lesson, category) {
    try {
      const myRulesPath = path.join(__dirname, '../../personality/MY_RULES.md');
      const date = new Date().toISOString().split('T')[0];
      const line = `- [${date}] ${lesson} (${category})\n`;

      // Read existing to avoid duplicates
      let existing = '';
      if (fs.existsSync(myRulesPath)) {
        existing = fs.readFileSync(myRulesPath, 'utf-8');
      }

      // Skip if similar rule already exists (first 40 chars match)
      const lessonKey = lesson.substring(0, 40).toLowerCase();
      if (existing.toLowerCase().includes(lessonKey)) return;

      fs.appendFileSync(myRulesPath, line);
      console.log(`📝 MY_RULES.md updated: ${lesson}`);
    } catch (err) {
      console.warn(`⚠️ MY_RULES.md append failed: ${err.message}`);
    }
  }

  /**
   * Log a tool error
   */
  async logError(toolName, input, error, chatId) {
    const context = `Tool "${toolName}" with input ${JSON.stringify(input).substring(0, 200)} failed: ${error.substring(0, 200)}`;
    await this._addLesson(context, 'tool_error', chatId);
  }

  /**
   * Check if a message is a user correction and log it
   */
  async checkCorrection(userMessage, previousAssistant, chatId) {
    const isCorrection = CORRECTION_PATTERNS.some(p => p.test(userMessage));
    if (!isCorrection) return false;

    const context = `User said: "${userMessage.substring(0, 200)}"\nPrevious AI: "${(previousAssistant || '').substring(0, 200)}"`;
    await this._addLesson(context, 'user_correction', chatId);

    // Track preference patterns
    this._trackPreference(userMessage, chatId);
    return true;
  }

  /**
   * Get relevant lessons for system prompt injection
   */
  async getRelevantLessons(query, topK = 3) {
    if (this.lessons.length === 0) return [];

    if (this.embedder) {
      try {
        const queryEmb = await this.embedder.embed(query);
        const scored = [];
        for (const lesson of this.lessons) {
          if (!this._lessonEmbeddings.has(lesson.id)) {
            try {
              this._lessonEmbeddings.set(lesson.id, await this.embedder.embed(lesson.lesson));
            } catch { continue; }
          }
          const emb = this._lessonEmbeddings.get(lesson.id);
          if (!emb) continue;
          const sim = this.embedder.cosineSimilarity(queryEmb, emb);
          if (sim > 0.25) scored.push({ ...lesson, score: sim });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
      } catch {}
    }

    // Fallback: keyword match
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return this.lessons
      .map(l => {
        const text = (l.lesson + ' ' + l.context).toLowerCase();
        const hits = words.filter(w => text.includes(w)).length;
        return { ...l, score: hits / Math.max(words.length, 1) };
      })
      .filter(l => l.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Build context string for system prompt
   */
  async buildContext(query) {
    const lessons = await this.getRelevantLessons(query);
    if (lessons.length === 0) return { context: '', count: 0 };

    let ctx = '\n\n## Lessons Learned\n';
    for (const l of lessons) {
      ctx += `- [${l.category}] ${l.lesson}\n`;
    }
    return { context: ctx, count: lessons.length };
  }

  async _addLesson(context, category, chatId) {
    try {
      const intentCfg = this.config.models?.intent || { provider: 'google', model: 'gemini-2.5-flash' };
      const result = await this.ai.generate(
        `Extract a 1-line lesson from this error/correction. Max 100 chars. Be specific and actionable.\n\nContext: ${context}`,
        { provider: intentCfg.provider, model: intentCfg.model, maxTokens: 60, temperature: 0 }
      );

      let lesson = (result?.text || result?.content || '').trim();
      if (!lesson || lesson === '[object Object]' || lesson.length < 10 || lesson.length > 150) return;
      // Remove markdown artifacts and incomplete sentences
      lesson = lesson.replace(/^[`#*\-]+\s*/, '').replace(/[`*]+$/, '').trim();
      if (!lesson || lesson.length < 10) return;

      const entry = {
        id: `l_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        error: context.substring(0, 300),
        context: context.substring(0, 200),
        lesson,
        category,
        timestamp: new Date().toISOString(),
        chatId,
      };

      this.lessons.push(entry);

      // Keep max 200 lessons (remove oldest)
      if (this.lessons.length > 200) this.lessons = this.lessons.slice(-200);

      this._scheduleSave();
      this._appendToMyRules(lesson, category);
      console.log(`🎓 Lesson learned [${category}]: ${lesson}`);
    } catch (err) {
      console.error(`❌ LessonLearner extract failed: ${err.message}`);
    }
  }

  _trackPreference(userMessage, chatId) {
    // Count correction patterns per category
    const prefs = this.lessons.filter(l => l.category === 'preference' || l.category === 'user_correction');
    
    // Group by similar lessons
    const groups = {};
    for (const p of prefs) {
      const key = p.lesson.substring(0, 40).toLowerCase();
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }

    // If any group hits 3+, update SOUL.md
    for (const [key, items] of Object.entries(groups)) {
      if (items.length >= 3 && !items[0]._soulUpdated) {
        this._updateSoulPreference(items[0].lesson);
        items[0]._soulUpdated = true;
        this._scheduleSave();
      }
    }
  }

  _updateSoulPreference(preference) {
    try {
      if (!fs.existsSync(SOUL_PATH)) return;
      let soul = fs.readFileSync(SOUL_PATH, 'utf-8');

      const section = '## Learned Preferences';
      if (!soul.includes(section)) {
        soul += `\n\n${section}\n`;
      }

      // Check if already added
      if (soul.includes(preference)) return;

      // Append under section
      const idx = soul.indexOf(section);
      const insertAt = idx + section.length;
      soul = soul.substring(0, insertAt) + `\n- ${preference}` + soul.substring(insertAt);

      fs.writeFileSync(SOUL_PATH, soul);
      console.log(`🧬 SOUL.md updated with preference: ${preference}`);
    } catch (err) {
      console.error(`❌ SOUL.md update failed: ${err.message}`);
    }
  }

  getStats() {
    return { total: this.lessons.length };
  }
}
