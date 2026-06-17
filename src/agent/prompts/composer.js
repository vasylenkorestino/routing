const fs = require('fs');
const path = require('path');
const { createOrchestrator, SYSTEM_PROMPT } = require('../../services/anthropic');

const PROMPTS_DIR = path.join(__dirname);

/** Reads a markdown prompt fragment if it exists. */
function readFragment(...parts) {
  const filePath = path.join(PROMPTS_DIR, ...parts);
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Assembles a system prompt for a task.
 * @param {'chat'|'enhance'|'triage'|'generate'} task
 * @param {{ memoryBlock?: string, style?: 'none' }} ctx
 */
function composeSystemPrompt(task, ctx = {}) {
  const style = ctx.style ?? (task === 'chat' ? 'personality' : 'none');
  const parts = [
    readFragment('core', 'domain-rules.md'),
    readFragment('core', 'privacy-policy.md'),
  ];
  if (style !== 'none') parts.push(readFragment('core', 'personality.md'));
  parts.push(readFragment('tasks', `${task}.md`));
  if (ctx.memoryBlock) parts.push(ctx.memoryBlock);

  const composed = parts.filter(Boolean).join('\n\n');
  if (task === 'chat' && !composed) return SYSTEM_PROMPT;
  return composed || SYSTEM_PROMPT;
}

module.exports = { composeSystemPrompt, readFragment };
