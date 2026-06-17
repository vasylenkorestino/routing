const router = require('express').Router();
const { createOrchestrator, TOOL_LABELS } = require('../services/anthropic');
const skillRegistry = require('../skills');
const { logAction } = require('../services/actionLogger');
const { createRecorder } = require('../services/stepRecorder');
const aiJobs = require('../services/aiJobs');
const { publishJobProgress } = require('../services/aiJobPublisher');
const sessionStore = require('../agent/memory/sessionStore');
const { buildMemoryContext } = require('../agent/memory/recall');
const { composeSystemPrompt } = require('../agent/prompts/composer');
const { isRouteEditIntent, runRouteEditPrefetch } = require('../agent/workflows/routeEditPrefetch');
const logger = require('../utils/logger');

/** Task-specific tool subsets and iteration caps for chat. */
const TASK_MODES = {
  route_edit: {
    toolNames: ['compare_routes', 'route_enhancement', 'account_discovery', 'geo_utils', 'route_generation', 'route_logger'],
    maxIterations: 3,
  },
  qa: {
    toolNames: ['route_enhancement', 'salesforce_query', 'agent_memory'],
    maxIterations: 2,
  },
  multi_route: {
    toolNames: ['multi_route_context', 'account_discovery', 'route_generation', 'compare_routes', 'route_logger'],
    maxIterations: 4,
  },
  general: {
    toolNames: ['route_enhancement', 'compare_routes', 'salesforce_query', 'agent_memory'],
    maxIterations: 4,
  },
  full: {
    toolNames: null,
    maxIterations: 20,
  },
};

/** Resolves chat task mode from message and context. */
function resolveChatMode(message, context) {
  if (context?.multiRoute) return 'multi_route';
  if (!context?.routeId) return 'qa';
  if (isRouteEditIntent(message, context)) return 'route_edit';
  return 'general';
}

/** Builds slim route pointer block (no inline stop list). */
function buildContextPrompt(context, recordType) {
  if (!context) return '';

  if (context.multiRoute && Array.isArray(context.routes) && context.routes.length > 0) {
    const parts = ['\n\n--- SELECTED ROUTES (MULTI-ROUTE REDESIGN) ---'];
    if (context.serviceDate) parts.push(`Date: ${context.serviceDate}`);
    if (recordType || context.recordType) parts.push(`Record Type: ${recordType || context.recordType}`);
    parts.push(`Selected route count: ${context.routes.length}`);
    parts.push('');
    context.routes.forEach((r, i) => {
      parts.push(
        `  ${i + 1}. "${r.routeName || '—'}" (${r.routeId})` +
        ` | Driver: ${r.driver || '—'}` +
        ` | Stops: ${r.stopsCount ?? 0}` +
        ` | Distance: ${r.totalDistance || '—'}` +
        ` | Time: ${r.totalTime || '—'}`,
      );
    });
    const idList = context.routes.map((r) => r.routeId).filter(Boolean);
    parts.push('');
    parts.push('INSTRUCTIONS:');
    parts.push('The user wants you to redesign the routes above.');
    parts.push(`1. Call multi_route_context with routeIds=${JSON.stringify(idList)} to load stops, accounts, service history, and open UCO tickets.`);
    parts.push('2. Optionally call account_discovery for the same date and record type to widen the candidate pool.');
    parts.push('3. Apply routing rules to group accounts into NEW optimized routes.');
    parts.push('4. Call route_generation to create Google_Route__c + Route__c records (isAI__c = true, isInherit__c = true, isAIApproved__c = false).');
    parts.push('5. Reply with a short summary — do not list every stop.');
    parts.push('--- END CONTEXT ---\n');
    return parts.join('\n');
  }

  const parts = ['\n\n--- ROUTE CONTEXT ---'];
  parts.push(`Route: ${context.routeName} (${context.routeId})`);
  if (context.serviceDate) parts.push(`Date: ${context.serviceDate}`);
  if (context.driver) parts.push(`Driver: ${context.driver}`);
  if (recordType) parts.push(`Record Type: ${recordType}`);
  parts.push(`Stops: ${context.stopsCount ?? 0}`);
  parts.push('Instruction: Call compare_routes and route_enhancement to load stop/account details and historical diff before making changes.');
  parts.push('--- END CONTEXT ---\n');
  return parts.join('\n');
}

const CHAT_STEPS = [
  { id: 'understand', label: 'Understanding your request' },
  { id: 'process', label: 'Processing' },
  { id: 'respond', label: 'Preparing response' },
];

function initChatSteps(jobId) {
  for (const s of CHAT_STEPS) {
    aiJobs.upsertStep(jobId, { id: s.id, label: s.label, status: 'pending' });
  }
}

const GENERATION_INTENT = /\b(create|generate|apply|save|build|make)\b/i;

/** Runs chat with prefetch fast-path or full orchestrator. */
async function runChatOrchestrator({ message, recordType, context, sessionId, jobId, recorder, onProgress }) {
  const memoryBlock = await buildMemoryContext({ context, recordType });
  const { staticPrompt, dynamicPrompt } = composeSystemPrompt('chat', { memoryBlock });
  const priorMessages = sessionId ? sessionStore.getMessages(sessionId) : [];
  const contextPrompt = buildContextPrompt(context, recordType);
  const fullUserMessage = message + contextPrompt;
  const mode = resolveChatMode(message, context);
  const modeConfig = TASK_MODES[mode] || TASK_MODES.full;

  if (isRouteEditIntent(message, context) && !GENERATION_INTENT.test(message)) {
    logger.info('[chat] route-edit prefetch path', { routeId: context.routeId });
    return runRouteEditPrefetch({
      message: fullUserMessage,
      context,
      recordType,
      skillRegistry,
      staticPrompt,
      dynamicPrompt,
      recorder,
      onProgress,
    });
  }

  const orchestrator = createOrchestrator(
    skillRegistry.getToolDefinitions(modeConfig.toolNames),
    skillRegistry,
    recorder,
    {
      staticPrompt,
      dynamicPrompt,
      priorMessages,
      maxIterations: modeConfig.maxIterations,
      onProgress,
    },
  );

  return orchestrator.run(fullUserMessage);
}

/** Runs chat orchestrator with live job progress. */
async function runChatJob(jobId, body) {
  const { message, recordType, context, sessionId } = body;
  initChatSteps(jobId);
  aiJobs.upsertStep(jobId, { id: 'understand', label: 'Understanding your request', status: 'running' });
  aiJobs.updateProgress(jobId, { step: 'understand', label: 'Understanding your request…', percent: 5 });
  publishJobProgress(jobId);

  if (sessionId) sessionStore.append(sessionId, { role: 'user', content: message });

  aiJobs.upsertStep(jobId, { id: 'understand', label: 'Understanding your request', status: 'done' });
  aiJobs.upsertStep(jobId, { id: 'process', label: 'Processing', status: 'running' });
  aiJobs.updateProgress(jobId, { step: 'process', label: 'Processing…', percent: 15 });
  publishJobProgress(jobId);

  const recorder = createRecorder({ onStep: () => publishJobProgress(jobId) });
  const memoryBlock = await buildMemoryContext({ context, recordType });
  const { staticPrompt, dynamicPrompt } = composeSystemPrompt('chat', { memoryBlock });

  const onProgress = ({ phase, label, toolName, detail, iteration }) => {
    if (phase === 'tool' && toolName) {
      aiJobs.addFinding(jobId, label || TOOL_LABELS[toolName] || toolName);
    }
    if (phase === 'prefetch') aiJobs.addFinding(jobId, label || 'Prefetching route data…');
    if (detail) aiJobs.addFinding(jobId, detail);
    const pct = Math.min(90, 15 + (iteration || 1) * 8);
    aiJobs.updateProgress(jobId, { step: 'process', label: label || 'Processing…', percent: pct });
    publishJobProgress(jobId);
  };

  const result = await runChatOrchestrator({
    message,
    recordType,
    context,
    sessionId,
    jobId,
    recorder,
    onProgress,
  });

  aiJobs.upsertStep(jobId, { id: 'process', label: 'Processing', status: 'done' });
  aiJobs.upsertStep(jobId, { id: 'respond', label: 'Preparing response', status: 'done' });
  aiJobs.setMessage(jobId, result.message);
  if (sessionId) sessionStore.append(sessionId, { role: 'assistant', content: result.message });

  return { result, recorder, fullUserMessage: message + buildContextPrompt(context, recordType), systemPrompt: { staticPrompt, dynamicPrompt } };
}

/** POST /api/chat — general-purpose chat with route context */
router.post('/', async (req, res, next) => {
  const t0 = Date.now();
  const recorder = createRecorder();
  try {
    const { message, recordType, context, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    logger.info('Chat request', { message: message.substring(0, 100), hasContext: !!context });

    if (sessionId) sessionStore.append(sessionId, { role: 'user', content: message });

    const result = await runChatOrchestrator({
      message,
      recordType,
      context,
      sessionId,
      recorder,
    });

    if (sessionId) sessionStore.append(sessionId, { role: 'assistant', content: result.message });

    logAction({
      action: 'Chat',
      status: 'Success',
      requestBody: req.body,
      responseBody: result,
      durationMs: Date.now() - t0,
      userInfo: req.driver?.name,
      googleRouteId: context?.routeId,
      source: 'POST /chat',
      steps: recorder.steps,
    });

    res.json({ ...result, sessionId: sessionId || sessionStore.createId() });
  } catch (err) {
    logAction({
      action: 'Chat',
      status: 'Error',
      requestBody: req.body,
      responseBody: err.message,
      durationMs: Date.now() - t0,
      userInfo: req.driver?.name,
      googleRouteId: req.body?.context?.routeId,
      source: 'POST /chat',
      steps: recorder.steps,
    });
    next(err);
  }
});

/** POST /api/chat/async — async chat with SSE progress */
router.post('/async', (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const owner = aiJobs.resolveOwner(req);
  const active = aiJobs.findActiveForOwner(owner, 'chat');
  if (active) {
    return res.status(409).json({ error: 'A chat request is already in progress', jobId: active.id });
  }
  const sessionId = req.body.sessionId || sessionStore.createId();
  const job = aiJobs.create({
    type: 'chat',
    params: { ...req.body, sessionId },
    owner,
  });

  res.status(202).json({ jobId: job.id, status: job.status, sessionId });
  publishJobProgress(job.id);

  const t0 = Date.now();
  const userName = req.driver?.name;
  const body = { ...req.body, sessionId };

  setImmediate(async () => {
    try {
      const { result, recorder, fullUserMessage, systemPrompt } = await runChatJob(job.id, body);
      aiJobs.complete(job.id, result);
      publishJobProgress(job.id, { status: 'complete' });
      logAction({
        action: 'Chat',
        status: 'Success',
        requestBody: body,
        responseBody: result,
        aiPrompt: systemPrompt.text,
        durationMs: Date.now() - t0,
        userInfo: userName,
        googleRouteId: body.context?.routeId,
        source: 'POST /chat/async',
        steps: recorder.steps,
      });
    } catch (err) {
      aiJobs.fail(job.id, err);
      publishJobProgress(job.id, { status: 'error', error: err.message });
      logAction({
        action: 'Chat',
        status: 'Error',
        requestBody: body,
        responseBody: err.message,
        durationMs: Date.now() - t0,
        userInfo: userName,
        source: 'POST /chat/async',
      });
      logger.error('[chat/async] job failed', { jobId: job.id, error: err.message });
    }
  });
});

module.exports = router;
