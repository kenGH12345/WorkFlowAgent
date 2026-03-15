/**
 * Socratic Interaction Engine
 *
 * Implements Requirement 7: AI Socratic-style questioning paradigm.
 *
 * Instead of asking users to proactively review and recall information,
 * the system presents structured multiple-choice questions at decision points.
 *
 * Benefits:
 *  - Reduces cognitive load (user picks from options, not free-form recall)
 *  - Externalises implicit knowledge (answers written to context files)
 *  - Enables automatic continuation after human input
 *  - Lowers hallucination risk (decisions are explicit, not assumed)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PATHS } = require('../core/constants');

// ─── Question Builder ─────────────────────────────────────────────────────────

/**
 * Builds a structured multiple-choice question.
 *
 * @param {string}   id       - Unique question ID (used as key in context file)
 * @param {string}   question - The question text
 * @param {string[]} options  - Array of option strings
 * @param {string}   [context] - Additional context shown before the question
 * @returns {SocraticQuestion}
 */
function buildQuestion(id, question, options, context = '') {
  if (options.length < 2) throw new Error(`[Socratic] Question "${id}" must have at least 2 options.`);
  return { id, question, options, context, askedAt: null, answeredAt: null, answer: null };
}

// ─── Pre-defined Decision Questions ──────────────────────────────────────────

const DECISION_QUESTIONS = {
  ARCHITECTURE_APPROVAL: buildQuestion(
    'architecture_approval',
    'Does the generated architecture meet your expectations?',
    [
      'Yes, approve and proceed to code generation',
      'No, the architecture needs revision – abort and restart',
      'Partially – proceed but note concerns in the context',
    ],
    'The Architecture Design Agent has produced architecture.md. Please review it before code generation begins.'
  ),

  TECH_STACK_PREFERENCE: buildQuestion(
    'tech_stack_preference',
    'Which technology stack do you prefer for this project?',
    [
      'Follow the architecture document recommendation',
      'Use a minimal/lightweight stack',
      'Use an enterprise-grade stack with full observability',
    ]
  ),

  TEST_DEFECTS_ACTION: buildQuestion(
    'test_defects_action',
    'The test report found defects. How should the workflow proceed?',
    [
      'Fix all Critical and High defects before delivery',
      'Fix Critical defects only, log others as known issues',
      'Deliver as-is with the full defect report attached',
    ],
    'The Quality Testing Agent has found defects in the code. Please decide how to proceed.'
  ),

  SCOPE_CLARIFICATION: buildQuestion(
    'scope_clarification',
    'The requirement has ambiguous scope. Which interpretation is correct?',
    [
      'Minimal scope – implement only the core feature',
      'Full scope – implement all mentioned features',
      'Let the Analyst Agent decide based on best practices',
    ]
  ),
};

// ─── Socratic Engine ──────────────────────────────────────────────────────────

class SocraticEngine {
  /**
   * @param {string} contextFilePath - Path to the context file where answers are persisted
   */
  constructor(contextFilePath = null) {
    this.contextFilePath = contextFilePath || path.join(PATHS.OUTPUT_DIR, 'decisions.json');
    this._decisions = this._loadDecisions();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Asks a structured multiple-choice question and waits for the user's answer.
   * The answer is persisted to the context file (implicit knowledge → explicit).
   *
   * @param {SocraticQuestion} question
   * @returns {Promise<{ optionIndex: number, optionText: string }>}
   */
  async ask(question) {
    // Check if already answered (idempotent – supports resume)
    const cached = this._decisions[question.id];
    if (cached) {
      console.log(`[Socratic] Question "${question.id}" already answered: "${cached.optionText}". Skipping.`);
      return cached;
    }

    question.askedAt = new Date().toISOString();
    const answer = await this._promptUser(question);

    question.answeredAt = new Date().toISOString();
    question.answer = answer;

    // Persist answer (implicit knowledge → explicit)
    this._decisions[question.id] = answer;
    this._saveDecisions();

    console.log(`[Socratic] Answer recorded: "${question.id}" → "${answer.optionText}"`);
    return answer;
  }

  /**
   * Asks a question by its pre-defined ID from DECISION_QUESTIONS.
   *
   * @param {string} questionId - Key from DECISION_QUESTIONS
   * @returns {Promise<{ optionIndex: number, optionText: string }>}
   */
  async askById(questionId) {
    const question = DECISION_QUESTIONS[questionId];
    if (!question) {
      throw new Error(`[Socratic] Unknown question ID: "${questionId}". Available: ${Object.keys(DECISION_QUESTIONS).join(', ')}`);
    }
    return this.ask(question);
  }

  /**
   * Returns all recorded decisions (the externalised knowledge base).
   */
  getDecisions() {
    return { ...this._decisions };
  }

  /**
   * Clears all recorded decisions (for fresh runs).
   */
  clearDecisions() {
    this._decisions = {};
    this._saveDecisions();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  async _promptUser(question) {
    const lines = [
      ``,
      `╔══════════════════════════════════════════════════════════╗`,
      `║  🤔 DECISION REQUIRED (Socratic Mode)                    ║`,
      `╚══════════════════════════════════════════════════════════╝`,
      ``,
    ];

    if (question.context) {
      lines.push(`Context: ${question.context}`);
      lines.push(``);
    }

    lines.push(`❓ ${question.question}`);
    lines.push(``);
    question.options.forEach((opt, i) => {
      lines.push(`  [${i + 1}] ${opt}`);
    });
    lines.push(``);

    console.log(lines.join('\n'));

    const TIMEOUT_MS = 30000;

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const settle = (optionIndex) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { rl.close(); } catch (_) {}
        resolve({
          optionIndex,
          optionText: question.options[optionIndex],
          timestamp: new Date().toISOString(),
        });
      };

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const validChoices = question.options.map((_, i) => String(i + 1));

      // Auto-select option 0 on timeout
      timer = setTimeout(() => {
        console.log(`\n[Socratic] ⏱️  No response in ${TIMEOUT_MS / 1000}s. Auto-selecting option [1]: "${question.options[0]}"`);
        settle(0);
      }, TIMEOUT_MS);

      const prompt = () => {
        if (settled) return;
        rl.question(`Your choice (${validChoices.join('/')}): `, (answer) => {
          if (settled) return;
          const trimmed = answer.trim();
          if (!validChoices.includes(trimmed)) {
            console.log(`Invalid choice. Please enter ${validChoices.join(' or ')}.`);
            prompt();
            return;
          }
          settle(parseInt(trimmed, 10) - 1);
        });
      };
      prompt();
    });
  }

  _loadDecisions() {
    if (fs.existsSync(this.contextFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.contextFilePath, 'utf-8'));
      } catch (_) {
        return {};
      }
    }
    return {};
  }

  _saveDecisions() {
    const dir = path.dirname(this.contextFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // N66 fix: atomic write – write to a .tmp file first, then rename over the target.
    // Prevents a process crash mid-write from corrupting decisions.json.
    const tmpPath = this.contextFilePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this._decisions, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.contextFilePath);
  }
}

module.exports = { SocraticEngine, DECISION_QUESTIONS, buildQuestion };
