const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config/anthropic');
const { analyzeRouteCompare } = require('../../modules/routeCompare');
const { buildSystemBlocks, PROMPT_REF } = require('../../services/anthropic');
const logger = require('../../utils/logger');

const ROUTE_EDIT_PATTERN = /\b(add|remove|rebuild|optimize|reorder|insert|drop|swap|stops?|accounts?)\b|\d+\s*stops?/i;
const DISCOVERY_PATTERN = /\b(add|new|area|near|discover|find|include)\b/i;

/** Returns true when message looks like a route edit with single-route context. */
function isRouteEditIntent(message, context) {
  if (!context?.routeId || context?.multiRoute) return false;
  return ROUTE_EDIT_PATTERN.test(message || '');
}

/** Slims prefetch bundle for a single Claude decide call. */
function slimPrefetchBundle(bundle) {
  const out = {};
  if (bundle.compare) out.compare = bundle.compare;
  if (bundle.enhance) {
    out.enhance = {
      route: bundle.enhance.route,
      candidates: (bundle.enhance.candidates || []).slice(0, 30),
      message: bundle.enhance.message,
    };
  }
  if (bundle.discovery) {
    out.discovery = {
      totalFound: bundle.discovery.totalFound,
      accounts: (bundle.discovery.accounts || []).slice(0, 40),
    };
  }
  return out;
}

/**
 * Prefetches route data in parallel and runs a single Claude decide call.
 * Optional route_generation when user asks to apply changes.
 */
async function runRouteEditPrefetch({
  message,
  context,
  recordType,
  skillRegistry,
  staticPrompt,
  dynamicPrompt,
  recorder,
  onProgress,
}) {
  const routeId = context.routeId;
  const t0 = Date.now();

  onProgress?.({ phase: 'prefetch', label: 'Prefetching route data…' });

  const tasks = [
    analyzeRouteCompare({ googleRouteId: routeId, routeName: context.routeName, limit: 20 })
      .then((compare) => ({ compare }))
      .catch((err) => {
        logger.warn('[prefetch] compare failed', { error: err.message });
        return { compare: { error: err.message } };
      }),
    skillRegistry.execute('route_enhancement', { googleRouteId: routeId, targetDate: context.serviceDate })
      .then((enhance) => ({ enhance }))
      .catch((err) => {
        logger.warn('[prefetch] enhance failed', { error: err.message });
        return { enhance: { error: err.message } };
      }),
  ];

  if (DISCOVERY_PATTERN.test(message) && context.serviceDate) {
    tasks.push(
      skillRegistry.execute('account_discovery', {
        targetDate: context.serviceDate,
        recordTypeName: recordType,
        maxResults: 200,
      })
        .then((discovery) => ({ discovery }))
        .catch((err) => {
          logger.warn('[prefetch] discovery failed', { error: err.message });
          return { discovery: { error: err.message } };
        }),
    );
  }

  const prefetchParts = await Promise.all(tasks);
  const bundle = Object.assign({}, ...prefetchParts);
  const prefetchMs = Date.now() - t0;

  if (recorder) {
    recorder.record({
      skill: 'route_edit_prefetch',
      type: 'System',
      status: 'Success',
      input: { routeId, message: message.substring(0, 200) },
      output: {
        keys: Object.keys(bundle),
        historicalCount: bundle.compare?.historicalRoutes?.length ?? 0,
        candidateCount: bundle.enhance?.candidates?.length ?? 0,
      },
      durationMs: prefetchMs,
    });
  }

  onProgress?.({ phase: 'thinking', label: 'Deciding route changes…' });

  const client = new Anthropic({ apiKey: config.apiKey });
  const systemBlocks = buildSystemBlocks(staticPrompt, dynamicPrompt);
  const slimBundle = slimPrefetchBundle(bundle);

  const decidePrompt =
    `${message}\n\n` +
    '--- PREFETCHED ROUTE DATA (authoritative; do not re-fetch unless data is missing) ---\n' +
    `${JSON.stringify(slimBundle)}\n` +
    '--- END PREFETCH ---\n\n' +
    'Using the prefetched compare history, current stops, and candidates, recommend specific adds/removes/reorder. ' +
    'Reference historical insights (addCandidates, removeCandidates, stableStops). ' +
    'Reply with a clear summary for the user.';

  const decideT0 = Date.now();
  const response = await client.messages.create({
    model: config.model,
    max_tokens: config.maxTokens,
    system: systemBlocks,
    messages: [{ role: 'user', content: decidePrompt }],
  });

  let finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  if (recorder) {
    recorder.record({
      skill: 'Claude Decide (prefetch)',
      type: 'AI Call',
      status: 'Success',
      promptRef: PROMPT_REF,
      input: message,
      output: finalText,
      durationMs: Date.now() - decideT0,
      usage: response.usage,
    });
  }

  return {
    message: finalText,
    iterations: 1,
    toolCallsExecuted: tasks.length,
    prefetched: true,
    steps: recorder ? recorder.steps : [],
  };
}

module.exports = { isRouteEditIntent, runRouteEditPrefetch, ROUTE_EDIT_PATTERN };
