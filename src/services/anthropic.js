const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const logger = require('../utils/logger');

const TOOL_LABELS = {
  salesforce_query: 'Querying Salesforce',
  route_analysis: 'Analyzing route history',
  compare_routes: 'Comparing route history',
  account_discovery: 'Discovering accounts',
  route_enhancement: 'Enhancing route',
  route_generation: 'Generating routes',
  route_edit_proposal: 'Proposing route edits',
  route_stops: 'Loading route stops',
  route_parameters: 'Loading route parameters',
  geo_utils: 'Running geo calculations',
  route_logger: 'Logging decisions',
  account_route_history: 'Reviewing account history',
  multi_route_context: 'Loading multi-route context',
  agent_memory: 'Accessing agent memory',
};

const MAX_PARALLEL_TOOLS = 3;
const PROMPT_REF = 'static-system-v1';

const TOOL_RESULT_LIMITS = {
  compare_routes: 12000,
  route_enhancement: 15000,
  account_discovery: 15000,
  salesforce_query: 10000,
  multi_route_context: 15000,
  default: 20000,
};

/** Sleep helper for rate-limit backoff. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Calls Anthropic with exponential backoff on 429/rate limits. */
async function createMessageWithRetry(client, params, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const isRateLimit = err?.status === 429 || /rate limit/i.test(err?.message || '');
      if (!isRateLimit || attempt >= maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      logger.warn(`Anthropic rate limit, retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** Builds cached system blocks: static (cached) + optional dynamic memory (uncached). */
function buildSystemBlocks(staticPrompt, dynamicPrompt) {
  const blocks = [];
  if (staticPrompt) {
    blocks.push({ type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } });
  }
  if (dynamicPrompt) {
    blocks.push({ type: 'text', text: dynamicPrompt });
  }
  return blocks.length ? blocks : staticPrompt || '';
}

/** Adds cache_control breakpoint on the last tool definition. */
function buildCachedTools(toolDefinitions) {
  if (!toolDefinitions?.length) return toolDefinitions;
  return toolDefinitions.map((t, i, arr) =>
    (i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t),
  );
}

/** Resolves static/dynamic prompts from orchestrator options (supports legacy systemPrompt string). */
function resolvePrompts(options) {
  if (options.staticPrompt) {
    return { staticPrompt: options.staticPrompt, dynamicPrompt: options.dynamicPrompt || '' };
  }
  if (options.systemPrompt?.staticPrompt) {
    return {
      staticPrompt: options.systemPrompt.staticPrompt,
      dynamicPrompt: options.systemPrompt.dynamicPrompt || '',
    };
  }
  const legacy = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
  return { staticPrompt: legacy, dynamicPrompt: '' };
}

/** Skill-aware slimming before JSON.stringify for tool results. */
function slimToolResult(toolName, result) {
  if (!result || result.error) return result;

  if (toolName === 'compare_routes') {
    return result;
  }

  if (toolName === 'route_enhancement') {
    const route = result.route || {};
    const candidates = (result.candidates || []).slice(0, 40).map((c) => ({
      id: c.Id || c.id,
      name: c.Name || c.name,
      distanceFromRoute: c.distanceFromRoute,
      hasOpenTicket: c.hasOpenTicket,
      expectedDate: c.Expected_Date_Of_Service__c,
    }));
    const stops = (route.stops || result.stops || []).slice(0, 50).map((s) => ({
      accountId: s.AccountId__c || s.accountId,
      accountName: s.Account_Name__c || s.accountName,
      priority: s.Priority__c || s.priority,
      lat: s.Latitude__c || s.lat,
      lng: s.Longitude__c || s.lng,
    }));
    return { route: { id: route.id || route.Id, name: route.name || route.Name, stops }, candidates, message: result.message };
  }

  if (toolName === 'account_discovery') {
    const accounts = (result.accounts || []).slice(0, 80).map((a) => ({
      id: a.Id || a.id,
      name: a.Name || a.name,
      expectedDate: a.Expected_Date_Of_Service__c,
      hasOpenTicket: a.hasOpenTicket,
      lat: a.MALatitude__c,
      lng: a.MALongitude__c,
    }));
    return { accounts, totalFound: result.totalFound ?? accounts.length, targetDate: result.targetDate };
  }

  if (toolName === 'salesforce_query') {
    const records = (result.records || result).slice?.(0, 30) ?? result;
    return Array.isArray(records) ? { records, truncated: (result.records?.length || 0) > 30 } : result;
  }

  if (toolName === 'multi_route_context') {
    const routes = (result.routes || []).map((r) => ({
      id: r.routeId || r.id,
      name: r.routeName || r.name,
      stopCount: r.stops?.length ?? r.stopCount,
    }));
    return { routes, nearbyTickets: (result.nearbyTickets || []).slice(0, 20), summary: result.summary };
  }

  return result;
}

/** Trims tool result JSON to skill-specific char budget. */
function trimToolResult(toolName, result) {
  const slim = slimToolResult(toolName, result);
  const max = TOOL_RESULT_LIMITS[toolName] || TOOL_RESULT_LIMITS.default;
  let json = JSON.stringify(slim);
  if (json.length > max) json = json.substring(0, max);
  return json;
}

/** Label for action-log input on turns after the first. */
function buildTurnInputLabel(iterations, lastToolNames, messages) {
  if (messages.length === 1) return null;
  if (lastToolNames?.length) {
    return `Tool results from: ${lastToolNames.join(', ')} (turn ${iterations}, ${messages.length} messages)`;
  }
  return `Conversation continuation (turn ${iterations}, ${messages.length} messages)`;
}

/** Logs cache usage metrics from Anthropic response.usage. */
function logCacheUsage(iterations, usage) {
  if (!usage) return;
  const created = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  if (created || read) {
    logger.info(`Orchestrator turn ${iterations} cache`, { cache_creation_input_tokens: created, cache_read_input_tokens: read });
  }
}

/**
 * Creates an orchestrator that runs a multi-turn tool-use loop with Claude.
 * Options: recorder, onProgress, staticPrompt, dynamicPrompt, systemPrompt (legacy string),
 * priorMessages, toolNames, maxIterations
 */
function createOrchestrator(toolDefinitions, skillRegistry, recorder, options = {}) {
  const client = new Anthropic({ apiKey: config.apiKey });
  const onProgress = options.onProgress;
  const { staticPrompt, dynamicPrompt } = resolvePrompts(options);
  const priorMessages = options.priorMessages || [];
  const maxIterations = options.maxIterations ?? 20;
  const executionContext = options.executionContext || {};

  const allTools = toolDefinitions;
  const filteredTools = options.toolNames?.length
    ? allTools.filter((t) => options.toolNames.includes(t.name))
    : allTools;
  const cachedTools = buildCachedTools(filteredTools);
  const systemBlocks = buildSystemBlocks(staticPrompt, dynamicPrompt);

  const emit = (payload) => {
    if (typeof onProgress === 'function') {
      try { onProgress(payload); } catch (err) {
        logger.warn('[orchestrator] onProgress failed', { error: err.message });
      }
    }
  };

  return {
    async run(userMessage) {
      const messages = priorMessages.length
        ? [...priorMessages, { role: 'user', content: userMessage }]
        : [{ role: 'user', content: userMessage }];
      let finalText = '';
      let iterations = 0;
      let lastToolNames = [];
      const createdRoutes = [];
      const editProposals = [];

      emit({ phase: 'thinking', iteration: 0, label: 'Understanding your request…' });

      while (iterations < maxIterations) {
        iterations++;
        logger.info(`Orchestrator iteration ${iterations}`, { messages: messages.length, maxIterations });
        emit({ phase: 'thinking', iteration: iterations, label: `Analyzing (step ${iterations})…` });

        const isFirstTurn = iterations === 1 && messages.length <= (priorMessages.length + 1);
        const turnInput = isFirstTurn
          ? userMessage
          : buildTurnInputLabel(iterations, lastToolNames, messages);

        const turnT0 = Date.now();
        let response;
        try {
          response = await createMessageWithRetry(client, {
            model: config.model,
            max_tokens: config.maxTokens,
            system: systemBlocks,
            tools: cachedTools.length ? cachedTools : undefined,
            messages,
          });
        } catch (err) {
          if (recorder) {
            recorder.record({
              skill: `Claude Reasoning (turn ${iterations})`,
              type: 'AI Call',
              status: 'Error',
              prompt: isFirstTurn ? staticPrompt : undefined,
              promptRef: isFirstTurn ? undefined : PROMPT_REF,
              input: turnInput,
              error: err?.message || String(err),
              durationMs: Date.now() - turnT0,
            });
          }
          throw err;
        }

        logCacheUsage(iterations, response.usage);

        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const textBlocks = response.content.filter((b) => b.type === 'text');
        const turnText = textBlocks.map((b) => b.text).join('\n');

        if (recorder) {
          const toolNames = toolUseBlocks.map((t) => t.name).join(', ');
          recorder.record({
            skill: `Claude Reasoning (turn ${iterations})`,
            type: 'AI Call',
            status: 'Success',
            prompt: isFirstTurn ? staticPrompt : undefined,
            promptRef: isFirstTurn ? undefined : PROMPT_REF,
            input: turnInput,
            output: turnText + (toolNames ? `\n[tools: ${toolNames}]` : ''),
            durationMs: Date.now() - turnT0,
            usage: response.usage,
            messagesCount: messages.length,
          });
        }

        if (textBlocks.length > 0) finalText = turnText;

        if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) break;

        messages.push({ role: 'assistant', content: response.content });
        lastToolNames = toolUseBlocks.map((t) => t.name);

        const batches = [];
        for (let i = 0; i < toolUseBlocks.length; i += MAX_PARALLEL_TOOLS) {
          batches.push(toolUseBlocks.slice(i, i + MAX_PARALLEL_TOOLS));
        }

        const toolResults = [];
        for (const batch of batches) {
          const batchResults = await Promise.all(batch.map(async (toolUse) => {
            const label = TOOL_LABELS[toolUse.name] || toolUse.name;
            emit({ phase: 'tool', iteration: iterations, toolName: toolUse.name, label: `${label}…` });
            logger.info(`Tool call: ${toolUse.name}`, { input: JSON.stringify(toolUse.input).substring(0, 300) });

            const toolT0 = Date.now();
            let result;
            let toolError = null;
            try {
              result = await skillRegistry.execute(toolUse.name, toolUse.input, executionContext);
              if (toolUse.name === 'route_generation' && Array.isArray(result?.googleRoutes)) {
                createdRoutes.push(...result.googleRoutes);
              }
              if (toolUse.name === 'route_edit_proposal' && result?.proposalId) {
                editProposals.push(result);
              }
            } catch (err) {
              logger.error(`Tool ${toolUse.name} failed`, { error: err.message });
              result = { error: err.message };
              toolError = err.message;
            }

            if (recorder) {
              recorder.record({
                skill: toolUse.name,
                type: 'Tool Use',
                status: toolError ? 'Error' : 'Success',
                input: toolUse.input,
                output: toolError ? null : slimToolResult(toolUse.name, result),
                error: toolError,
                durationMs: Date.now() - toolT0,
              });
            }

            emit({ phase: 'finding', iteration: iterations, toolName: toolUse.name, label, detail: toolError ? 'Failed' : 'Done' });

            return {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: trimToolResult(toolUse.name, result),
            };
          }));
          toolResults.push(...batchResults);
        }

        messages.push({ role: 'user', content: toolResults });
      }

      return {
        message: finalText,
        iterations,
        toolCallsExecuted: messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).length,
        createdRoutes,
        editProposals,
        steps: recorder ? recorder.steps : [],
      };
    },
  };
}

module.exports = {
  createOrchestrator,
  buildSystemBlocks,
  buildCachedTools,
  trimToolResult,
  slimToolResult,
  TOOL_LABELS,
  PROMPT_REF,
};
