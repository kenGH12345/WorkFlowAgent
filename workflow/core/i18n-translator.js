'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Translates a Markdown file to Chinese and writes a sibling `.zh.md` file.
 *
 * Rules:
 *  - All technical symbols (class/function/variable names, file paths, code blocks) are kept as-is.
 *  - Only natural-language text (headings, descriptions, comments, labels) is translated.
 *  - If llmCall is not provided, the translation is silently skipped.
 *
 * @param {string}        mdPath  - Absolute path to the source .md file.
 * @param {Function|null} llmCall - async (prompt: string) => string
 * @returns {Promise<string|null>} Path to the written .zh.md file, or null if skipped.
 */
async function translateMdFile(mdPath, llmCall) {
  if (!llmCall || typeof llmCall !== 'function') return null;
  if (!fs.existsSync(mdPath)) return null;

  // Skip if the file is already a translated file
  if (mdPath.endsWith('.zh.md')) return null;

  const zhPath = mdPath.replace(/\.md$/, '.zh.md');

  try {
    const content = fs.readFileSync(mdPath, 'utf-8');
    if (!content.trim()) return null;

    const prompt = buildTranslationPrompt(content);
    const translated = await llmCall(prompt);

    // Atomic write
    const tmp = `${zhPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, translated.trim(), 'utf-8');
    fs.renameSync(tmp, zhPath);

    console.log(`[i18n] ✅ Chinese version written: ${path.basename(zhPath)}`);
    return zhPath;
  } catch (err) {
    console.warn(`[i18n] ⚠️  Translation failed for ${path.basename(mdPath)}: ${err.message}`);
    return null;
  }
}

/**
 * Build the translation prompt.
 * @param {string} content - Original Markdown content
 * @returns {string}
 */
function buildTranslationPrompt(content) {
  return `You are a professional technical translator. Translate the following Markdown document from English to Simplified Chinese.

Translation rules (MUST follow strictly):
1. Keep ALL of the following unchanged: code blocks (\`\`\`...\`\`\`), inline code (\`...\`), file paths, class names, function names, variable names, method names, command strings, JSON/YAML keys, URLs, version numbers, and any technical identifiers.
2. Translate ONLY natural-language text: headings, descriptions, comments, labels, sentences, and explanatory notes.
3. Preserve the exact Markdown structure, formatting, and whitespace.
4. Do NOT add any extra explanation, preamble, or suffix — output ONLY the translated Markdown.

--- BEGIN DOCUMENT ---
${content}
--- END DOCUMENT ---`;
}

module.exports = { translateMdFile };
