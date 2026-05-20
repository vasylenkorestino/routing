const router = require('express').Router();
const { createOrchestrator } = require('../services/anthropic');
const skillRegistry = require('../skills');
const { logAction } = require('../services/actionLogger');
const { createRecorder } = require('../services/stepRecorder');
const logger = require('../utils/logger');

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
        ` | Time: ${r.totalTime || '—'}`
      );
    });
    const idList = context.routes.map((r) => r.routeId).filter(Boolean);
    parts.push('');
    parts.push('INSTRUCTIONS:');
    parts.push('The user wants you to redesign the routes above.');
    parts.push(`1. Call multi_route_context with routeIds=${JSON.stringify(idList)} to load stops, accounts, service history, and open UCO tickets (including nearby ticketed/overdue accounts).`);
    parts.push('2. Optionally call account_discovery for the same date and record type to widen the candidate pool.');
    parts.push('3. Apply the routing rules from the system prompt (truck capacity, shift hours, geographic clustering, fixed/VIP accounts, tank fill %, open tickets) to group accounts into NEW optimized routes.');
    parts.push('4. Call route_generation to create the new Google_Route__c + Route__c records (isAI__c = true, isAIApproved__c = false). Use the same serviceDate and recordType.');
    parts.push('5. Reply with a short summary: how many new routes were created, how stops were redistributed, and the reasoning. Do not list every stop.');
    parts.push('--- END CONTEXT ---\n');
    return parts.join('\n');
  }

  const parts = ['\n\n--- CURRENT ROUTE CONTEXT ---'];
  parts.push(`Route: ${context.routeName} (${context.routeId})`);
  if (context.serviceDate) parts.push(`Date: ${context.serviceDate}`);
  if (context.driver) parts.push(`Driver: ${context.driver}`);
  if (recordType) parts.push(`Record Type: ${recordType}`);
  parts.push(`Distance: ${context.totalDistance || '—'}, Time: ${context.totalTime || '—'}`);
  parts.push(`Total Stops: ${context.stopsCount || 0}`);
  if (context.stops?.length) {
    parts.push('\nStops (first 30):');
    context.stops.forEach((s, i) => {
      parts.push(`  ${i + 1}. ${s.account || '—'} | ${s.address || '—'} | ${s.serviceType || 'UCO Collection'} | Status: ${s.status || 'New'} | Gal: ${s.lastGallons ?? '—'} | Priority: ${s.priority ?? '—'}${s.isFixed ? ' [FIXED]' : ''}${s.notes ? ` | Notes: ${s.notes}` : ''}`);
    });
  }
  parts.push('--- END CONTEXT ---\n');
  return parts.join('\n');
}

/** POST /api/chat — general-purpose chat with route context */
router.post('/', async (req, res, next) => {
  const t0 = Date.now();
  const recorder = createRecorder();
  try {
    const { message, recordType, context } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    logger.info('Chat request', { message: message.substring(0, 100), hasContext: !!context });

    const contextPrompt = buildContextPrompt(context, recordType);
    const orchestrator = createOrchestrator(skillRegistry.getToolDefinitions(), skillRegistry, recorder);
    const result = await orchestrator.run(message + contextPrompt);

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

    res.json(result);
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

module.exports = router;
