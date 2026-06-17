const fs = require('fs');
const path = require('path');

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
 * Assembles static + dynamic system prompt blocks for a task.
 * @param {'chat'|'enhance'|'triage'|'generate'} task
 * @param {{ memoryBlock?: string, style?: 'none'|'personality' }} ctx
 * @returns {{ staticPrompt: string, dynamicPrompt: string, text: string }}
 */
function composeSystemPrompt(task, ctx = {}) {
  const style = ctx.style ?? (task === 'chat' ? 'personality' : 'none');
  const staticParts = [
    readFragment('core', 'domain-rules.md'),
    readFragment('core', 'privacy-policy.md'),
  ];
  if (style !== 'none') staticParts.push(readFragment('core', 'personality.md'));
  staticParts.push(readFragment('tasks', `${task}.md`));

  const staticPrompt = staticParts.filter(Boolean).join('\n\n');
  const dynamicPrompt = ctx.memoryBlock || '';

  if (!staticPrompt) {
    throw new Error(
      `Missing prompt fragments for task "${task}". Ensure agent/src/agent/prompts/ is deployed.`,
    );
  }

  return {
    staticPrompt,
    dynamicPrompt,
    text: [staticPrompt, dynamicPrompt].filter(Boolean).join('\n\n'),
  };
}

module.exports = { composeSystemPrompt, readFragment };
