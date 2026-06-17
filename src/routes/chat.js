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
const { runRouteEditPrefetch } = require('../agent/workflows/routeEditPrefetch');
const { classifyChatIntent } = require('../agent/workflows/chatIntent');
const logger = require('../utils/logger');

/** Task-specific tool subsets — chosen by classifyChatIntent(). */
const TASK_MODES = {
  route_edit_simple: {
    toolNames: ['route_edit_proposal', 'route_stops'],
    maxIterations: 2,
  },
  route_edit_plan: {
    toolNames: ['route_enhancement', 'compare_routes', 'route_edit_proposal', 'route_stops'],
    maxIterations: 3,
  },
  route_redesign: {
    toolNames: ['route_enhancement', 'compare_routes', 'account_discovery', 'route_generation', 'route_edit_proposal', 'route_stops'],
    maxIterations: 4,
  },
  route_edit: {
    toolNames: ['route_enhancement', 'compare_routes', 'route_edit_proposal', 'route_stops', 'route_logger'],
    maxIterations: 3,
  },
  qa: {
    toolNames: ['route_stops', 'route_enhancement', 'salesforce_query', 'agent_memory'],
    maxIterations: 2,
  },
  multi_route: {
    toolNames: ['multi_route_context', 'account_discovery', 'route_generation', 'compare_routes', 'route_logger'],
    maxIterations: 4,
  },
  general: {
    toolNames: ['route_stops', 'route_enhancement', 'salesforce_query', 'agent_memory'],
    maxIterations: 3,
  },
  full: {
    toolNames: null,
    maxIterations: 20,
  },
};

/** Builds intent-specific context instructions (minimal data loading). */
function buildContextPrompt(context, recordType, intent) {
  if (!context) return '';

  if (context.multiRoute && Array.isArray(context.routes) && context.routes.length > 1) {
    const parts = ['\n\n--- SELECTED ROUTES (MULTI-ROUTE REDESIGN) ---'];
    if (context.serviceDate) parts.push(`Date: ${context.serviceDate}`);
    if (recordType || context.recordType) parts.push(`Record Type: ${recordType || context.recordType}`);
    parts.push(`Selected route count: ${context.routes.length}`);
    parts.push('');
    context.routes.forEach((r, i) => {
      parts.push(
        `  ${i + 1}. "${r.routeName || '—'}" (${r.routeId})` +
        ` | Driver: ${r.driver || '—'}` +
        ` | Stops: ${r.stopsCount ?? 0}`,
      );
    });
    const idList = context.routes.map((r) => r.routeId).filter(Boolean);
    parts.push('');
    parts.push('INSTRUCTIONS: Multi-route redesign only — call multi_route_context, then route_generation for NEW routes.');
    parts.push(`routeIds=${JSON.stringify(idList)}`);
    parts.push('--- END CONTEXT ---\n');
    return parts.join('\n');
  }

  const parts = ['\n\n--- ROUTE CONTEXT ---'];
  parts.push(`Route: ${context.routeName} (${context.routeId})`);
  if (context.serviceDate) parts.push(`Date: ${context.serviceDate}`);
  if (context.driver) parts.push(`Driver: ${context.driver}`);
  if (recordType) parts.push(`Record Type: ${recordType}`);
  parts.push(`Stops: ${context.stopsCount ?? 0}`);

  if (intent?.tier === 'question') {
    parts.push('Intent: QUESTION — answer briefly. Use route_stops only if you need stop names/IDs.');
    parts.push('Do NOT call route_edit_proposal or compare_routes unless the user asks to apply a change.');
  } else if (intent?.tier === 'actionable') {
    parts.push('Intent: ACTIONABLE EDIT — call route_edit_proposal directly.');
    parts.push('Use removeAccountNames / addAccountNames when the user names stops by name (matched on Account_Name__c).');
    parts.push('Do NOT call compare_routes, multi_route_context, or account_discovery for simple add/remove/assign requests.');
    parts.push('route_edit_proposal shows a manager approval card — only call it when applying a change.');
  } else if (intent?.tier === 'exploratory') {
    parts.push('Intent: EXPLORATORY — recommend options first; call route_edit_proposal only if user confirms.');
    parts.push('May use route_enhancement and compare_routes for history-aware suggestions.');
  } else if (intent?.tier === 'redesign') {
    parts.push('Intent: REDESIGN — may use compare_routes and route_enhancement before route_generation or route_edit_proposal.');
  } else {
    parts.push('Answer concisely. Load only the data needed for this request.');
  }

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

/** Runs chat with optional exploratory prefetch or full orchestrator. */
async function runChatOrchestrator({ message, recordType, context, sessionId, jobId, recorder, onProgress, executionContext }) {
  const intent = classifyChatIntent(message, context);
  const memoryBlock = await buildMemoryContext({ context, recordType });
  const { staticPrompt, dynamicPrompt } = composeSystemPrompt('chat', { memoryBlock });
  const priorMessages = sessionId ? sessionStore.getMessages(sessionId) : [];
  const contextPrompt = buildContextPrompt(context, recordType, intent);
  const fullUserMessage = message + contextPrompt;
  const modeConfig = TASK_MODES[intent.mode] || TASK_MODES.full;

  logger.info('[chat] intent', { mode: intent.mode, tier: intent.tier, routeId: intent.routeId });

  if (intent.usePrefetch) {
    logger.info('[chat] exploratory prefetch path', { routeId: context?.routeId });
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
      executionContext,
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

  const job = aiJobs.get(jobId);
  const executionContext = { owner: job?.owner, jobId };

  const result = await runChatOrchestrator({
    message,
    recordType,
    context,
    sessionId,
    jobId,
    recorder,
    onProgress,
    executionContext,
  });

  aiJobs.upsertStep(jobId, { id: 'process', label: 'Processing', status: 'done' });
  aiJobs.upsertStep(jobId, { id: 'respond', label: 'Preparing response', status: 'done' });
  aiJobs.setMessage(jobId, result.message);
  if (sessionId) sessionStore.append(sessionId, { role: 'assistant', content: result.message });
  if (Array.isArray(result.createdRoutes) && result.createdRoutes.length > 0) {
    aiJobs.mergePartialResults(jobId, { createdRoutes: result.createdRoutes });
  }
  if (Array.isArray(result.editProposals) && result.editProposals.length > 0) {
    aiJobs.mergePartialResults(jobId, { editProposals: result.editProposals });
  }

  const { staticPrompt, dynamicPrompt } = composeSystemPrompt('chat', { memoryBlock: await buildMemoryContext({ context, recordType }) });
  return { result, recorder, fullUserMessage: message + buildContextPrompt(context, recordType, classifyChatIntent(message, context)), systemPrompt: { staticPrompt, dynamicPrompt } };
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
      executionContext: { owner: aiJobs.resolveOwner(req) },
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
