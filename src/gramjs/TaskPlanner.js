/**
 * TaskPlanner — persistent goal/plan/execute/track system
 * Plans survive restarts and conversation compaction via file persistence + prompt injection.
 */

import fs from 'fs';
import path from 'path';

const PLANS_DIR = path.resolve('data/plans');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

export class TaskPlanner {
  constructor() {
    this.plans = new Map(); // planId → plan
    if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
    this._loadAll();
  }

  _loadAll() {
    try {
      const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const plan = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf-8'));
          // Auto-expire old active plans
          if (plan.status === 'active' && Date.now() - new Date(plan.createdAt).getTime() > EXPIRY_MS) {
            plan.status = 'cancelled';
            this._save(plan);
          }
          this.plans.set(plan.id, plan);
        } catch (e) {
          console.warn(`  ⚠️ TaskPlanner: failed to load ${f}: ${e.message}`);
        }
      }
      console.log(`  📋 TaskPlanner: loaded ${this.plans.size} plans`);
    } catch (e) {
      console.warn(`  ⚠️ TaskPlanner: init error: ${e.message}`);
    }
  }

  _save(plan) {
    fs.writeFileSync(path.join(PLANS_DIR, `${plan.id}.json`), JSON.stringify(plan, null, 2));
  }

  _genId() {
    return Math.random().toString(36).substring(2, 10);
  }

  create(chatId, goal, steps) {
    // Cancel any existing active plan for this chat
    const existing = this.getActive(chatId);
    if (existing) {
      existing.status = 'cancelled';
      this._save(existing);
    }

    const plan = {
      id: this._genId(),
      chatId: String(chatId),
      goal,
      createdAt: new Date().toISOString(),
      status: 'active',
      steps: steps.map((desc, i) => ({ id: i + 1, desc, status: 'pending' })),
    };
    this.plans.set(plan.id, plan);
    this._save(plan);
    console.log(`  📋 Plan created: [${plan.id}] "${goal}" (${steps.length} steps) for chat ${chatId}`);
    return plan.id;
  }

  updateStep(planId, stepId, status, result) {
    const plan = this.plans.get(planId);
    if (!plan) return;
    const step = plan.steps.find(s => s.id === stepId);
    if (!step) return;
    step.status = status;
    if (result) step.result = result;
    // Auto-complete if all steps done
    if (plan.steps.every(s => s.status === 'done')) {
      plan.status = 'completed';
      console.log(`  ✅ Plan [${planId}] auto-completed`);
    }
    this._save(plan);
  }

  getActive(chatId) {
    const cid = String(chatId);
    for (const plan of this.plans.values()) {
      if (plan.chatId === cid && plan.status === 'active') {
        // Check expiry
        if (Date.now() - new Date(plan.createdAt).getTime() > EXPIRY_MS) {
          plan.status = 'cancelled';
          this._save(plan);
          continue;
        }
        return plan;
      }
    }
    return null;
  }

  complete(planId) {
    const plan = this.plans.get(planId);
    if (plan) { plan.status = 'completed'; this._save(plan); }
  }

  cancel(planId) {
    const plan = this.plans.get(planId);
    if (plan) { plan.status = 'cancelled'; this._save(plan); }
  }

  buildContext(chatId) {
    const plan = this.getActive(chatId);
    if (!plan) return '';

    const done = plan.steps.filter(s => s.status === 'done').length;
    const total = plan.steps.length;
    const nextStep = plan.steps.find(s => s.status === 'pending');

    let ctx = `\n\n## Active Plan\n**Goal:** ${plan.goal}\n**Status:** Step ${done}/${total}\n\n`;
    for (const s of plan.steps) {
      const icon = s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : '⬜';
      ctx += `${icon} ${s.id}. ${s.desc}`;
      if (s.result) ctx += ` → ${s.result}`;
      ctx += '\n';
    }
    if (nextStep) {
      ctx += `\n**Next:** Execute step ${nextStep.id}. Langsung kerjain tanpa tanya user.\n`;
    }
    return ctx;
  }

  processResponse(chatId, responseText) {
    const cid = String(chatId);

    // Process [PLAN: {...}] tags
    const planRegex = /\[PLAN:\s*(\{[\s\S]*?\})\s*\]/gi;
    let planMatch;
    while ((planMatch = planRegex.exec(responseText)) !== null) {
      try {
        const data = JSON.parse(planMatch[1]);
        if (data.complete) {
          const plan = this.getActive(cid);
          if (plan) this.complete(plan.id);
        } else if (data.cancel) {
          const plan = this.getActive(cid);
          if (plan) this.cancel(plan.id);
        } else if (data.goal && data.steps) {
          this.create(cid, data.goal, data.steps);
        }
      } catch (e) {
        console.warn(`  ⚠️ TaskPlanner: invalid PLAN JSON: ${e.message}`);
      }
    }
    responseText = responseText.replace(/\s*\[PLAN:\s*\{[\s\S]*?\}\s*\]/gi, '').trim();

    // Process [STEP: {...}] tags
    const stepRegex = /\[STEP:\s*(\{[\s\S]*?\})\s*\]/gi;
    let stepMatch;
    while ((stepMatch = stepRegex.exec(responseText)) !== null) {
      try {
        const data = JSON.parse(stepMatch[1]);
        const plan = this.getActive(cid);
        if (plan && data.id && data.status) {
          this.updateStep(plan.id, data.id, data.status, data.result);
        }
      } catch (e) {
        console.warn(`  ⚠️ TaskPlanner: invalid STEP JSON: ${e.message}`);
      }
    }
    responseText = responseText.replace(/\s*\[STEP:\s*\{[\s\S]*?\}\s*\]/gi, '').trim();

    return responseText;
  }
}
