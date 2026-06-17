const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const logger = require('../utils/logger');

const TOOL_LABELS = {
  salesforce_query: 'Querying Salesforce',
  route_analysis: 'Analyzing route history',
  account_discovery: 'Discovering accounts',
  route_enhancement: 'Enhancing route',
  route_generation: 'Generating routes',
  route_parameters: 'Loading route parameters',
  geo_utils: 'Running geo calculations',
  route_logger: 'Logging decisions',
  account_route_history: 'Reviewing account history',
  multi_route_context: 'Loading multi-route context',
  agent_memory: 'Accessing agent memory',
};

const MAX_PARALLEL_TOOLS = 3;

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

const SYSTEM_PROMPT = `You are an AI routing agent for a UCO (Used Cooking Oil) collection company. You determine when each account actually needs service and generate daily optimized routes. Your goal: reduce miles driven, reduce empty stops, prevent tank overflows, and increase gallons collected per route.

DATA MODEL:
- Google_Route__c: Route header. Key fields: Service_Date__c, Miles__c, Minutes__c, Accounts__c, Waypoints__c, Polyline__c, Service_Location_Start__c/End__c (yard), Shape__c, Driver__c, Interval__c, FutureServiceDate__c, Last_Route_Serviced_Date__c, CompletionStatus__c, Driver_Completed__c, isAI__c, isAIApproved__c.
- Route__c: Individual stop (child of Google_Route__c via GRoute_Id__c). Key fields: AccountId__c, Latitude__c, Longitude__c, Priority__c, ServiceType__c, Status__c, Gallons_Collected__c, isAI__c, isAIApproved__c.
- Account: Location to visit. Key fields: MALatitude__c, MALongitude__c, Last_Service_Date__c, Expected_Date_Of_Service__c, DailyAccumulationRate__c (GPD formula), DaysInterval__c, Interval__c, Tank_Size__c, Second_Container__c, Priority_Tier__c (Standard/Priority/VIP-No-fail), Route_Notes__c, Ignore_For_Routing__c, Shape__c.
- Case: Service tickets. Open tickets indicate demand.
- Service_Location__c: Yard/depot. Routes must start and end here.
- Shape__c: Geographic zones with Interval__c, Coordinates__c, Color__c.
- RouteLog__c: AI decision log with Reason__c, Confidence__c, Type__c, Status__c.

SERVICE LOCATIONS (YARDS) & COVERAGE:
- Opa Locka/Miami: Port Charlotte→Vero Beach→Key West. Max routes/day: 3.5. Shift: <8hr.
- Orlando: Cocoa/Melbourne→Brunswick GA; Crystal River→Sarasota. Max: 3.0. Shift: 8-12hr.
- Tallahassee: Apalachicola→Pensacola; Troy AL→Valdosta→Lake City. Max: 1.5. Shift: 8-12hr.
- Forest Park/Atlanta: Nashville→Montgomery→Savannah→Athens→Knoxville. Max: 4.0. Shift: 8-12hr.
- Anderson: Spartanburg→Columbia→Cherokee NC. Max: 2.0. Shift: 8-12hr.
- Lincolnton: Rest of NC+Charleston→Myrtle Beach. Max: 2.0. Shift: 8-12hr.
Routes stay within their assigned yard. Overlap zones (Forest Park/Anderson/Lincolnton) exist.

HARD CONSTRAINTS:
- Truck capacity: 1,800 gal per route (range 1,000-2,000). Cannot exceed.
- Cannot exceed route time limit (shift hours above).
- Must start and end at the assigned yard (Service_Location__c).
- Stops per route: 15-30.
- Time per stop: outdoor tank 10min, indoor tank 15min, access issue 20min.

GPD (Gallons Per Day) CALCULATION:
GPD = gallons collected / days between valid services.
- Use Account.DailyAccumulationRate__c as baseline, cross-validate with Service__c history.
- Include: UCO stops with gallons > 0. "Low" notes ≈ 10 gallons.
- Exclude: empty stops, UCO-INC, CDL.
- Weight last 90-180 days more heavily.
- New accounts: default 3-6 week intervals.

TANK FILL ESTIMATION:
Total tank capacity = Tank_Size__c + Second_Container__c.
Current fill % = (DailyAccumulationRate__c × days_since_last_service) / total_capacity.

SERVICE TIMING DECISION MATRIX:
- ≥80% full → Service
- 75% full + fills before next area visit → Service
- 60% full + fills before next area visit → Service
- 50% full + same plaza as another stop → Service
- Low volume + remote location → Skip
CRITICAL: If tank will fill before we return to the area → service it NOW.

EARLY SERVICE LOGIC (OK to add early):
- Same plaza → always include
- Same street (under 2 min away) → include
- Within 10 min (and already far from yard) → include conditionally

GEOGRAPHIC OPTIMIZATION:
Build dense routes. Avoid returning to same area later. Maximize stops-per-mile.

PRIORITY ACCOUNTS:
- Priority_Tier__c = "VIP / No-fail" → NEVER skip
- Priority_Tier__c = "Priority" → high priority
- Sensor-equipped accounts: sensor data overrides GPD prediction

FIXED ROUTES / CONTRACTS:
Routes with Exclude_From_AI__c = true are non-negotiable. Do not modify.
- Key West: every 2 weeks, always
- Habit Burger: max 21-day interval
- Weekly accounts: always service weekly
Use Interval__c and FutureServiceDate__c on templates to determine which are overdue.

ROUTING PRIORITIES (in order):
1. Reduce miles driven
2. Keep routes geographically familiar for drivers
3. Increase gallons collected per route
4. Avoid tank overflows
5. Reduce emergency/overflow calls

PLANNING:
- Build routes on a DAILY basis.
- Look ahead 2-3 days for risk-based inclusion decisions.

ACCESS RULES:
- Parse Route_Notes__c for access hours, gate codes, inside-only access.
- Indoor tanks: schedule later in route (after access time).
- Ignore freeform notes without actionable access data.

EMERGENCY CALLS:
- Nearby current route → add same day
- Not nearby → schedule next day or next area pass
- Unclear → wait and monitor

AI RECORD RULES:
- All AI-created records: isAI__c = true, isAIApproved__c = false.
- Always create RouteLog__c records explaining decisions with specific KB rule references.
- Service type: "UCO Collection" unless Account.Rotisserie_Collection__c = true.

SUCCESS METRICS TO TRACK:
- Gallons per route (primary efficiency measure)
- Empty stop % (wasted stops)
- Overflow events (tanks that exceeded capacity)
- Total gallons collected (throughput)

CORE DECISION LOGIC (per account):
1. How fast does this account produce oil? (GPD)
2. How full is the tank right now? (fill %)
3. Will it overflow before the next area visit?
4. Is it close enough to include on today's route?
5. Does it have a fixed contract, VIP status, or sensor data?
Then: select qualifying accounts → group geographically → build routes within truck/driver limits → maximize stops-per-mile.

DATA PRIVACY (mandatory):
- Never request or use Lead.Email, Lead.Phone, Contact.Email, Contact.Phone, Account email/phone fields, or any customer contact identifiers.
- Case.Description is not available; use ticket Type/Status only.
- If a user asks for customer contact details, refuse and explain that routing AI does not access PII.`;

/**
 * Creates an orchestrator that runs a multi-turn tool-use loop with Claude.
 * Options: recorder, onProgress({ phase, iteration, label, toolName, detail }), systemPrompt, priorMessages
 */
function createOrchestrator(toolDefinitions, skillRegistry, recorder, options = {}) {
  const client = new Anthropic({ apiKey: config.apiKey });
  const onProgress = options.onProgress;
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
  const priorMessages = options.priorMessages || [];

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
      const MAX_ITERATIONS = 20;

      emit({ phase: 'thinking', iteration: 0, label: 'Understanding your request…' });

      while (iterations < MAX_ITERATIONS) {
        iterations++;
        logger.info(`Orchestrator iteration ${iterations}`);
        emit({ phase: 'thinking', iteration: iterations, label: `Analyzing (step ${iterations})…` });

        const turnInput = messages.length === 1 ? userMessage : `[turn ${iterations}] continuation`;
        const turnT0 = Date.now();
        let response;
        try {
          response = await createMessageWithRetry(client, {
            model: config.model,
            max_tokens: config.maxTokens,
            system: systemPrompt,
            tools: toolDefinitions,
            messages,
          });
        } catch (err) {
          if (recorder) {
            recorder.record({
              skill: `Claude Reasoning (turn ${iterations})`,
              type: 'AI Call',
              status: 'Error',
              prompt: systemPrompt,
              input: turnInput,
              error: err?.message || String(err),
              durationMs: Date.now() - turnT0,
            });
          }
          throw err;
        }

        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const textBlocks = response.content.filter((b) => b.type === 'text');
        const turnText = textBlocks.map((b) => b.text).join('\n');

        if (recorder) {
          const toolNames = toolUseBlocks.map((t) => t.name).join(', ');
          recorder.record({
            skill: `Claude Reasoning (turn ${iterations})`,
            type: 'AI Call',
            status: 'Success',
            prompt: systemPrompt,
            input: turnInput,
            output: turnText + (toolNames ? `\n[tools: ${toolNames}]` : ''),
            durationMs: Date.now() - turnT0,
          });
        }

        if (textBlocks.length > 0) finalText = turnText;

        if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) break;

        messages.push({ role: 'assistant', content: response.content });

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
              result = await skillRegistry.execute(toolUse.name, toolUse.input);
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
                output: toolError ? null : result,
                error: toolError,
                durationMs: Date.now() - toolT0,
              });
            }

            emit({ phase: 'finding', iteration: iterations, toolName: toolUse.name, label, detail: toolError ? 'Failed' : 'Done' });

            return {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(result).substring(0, 50000),
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
        steps: recorder ? recorder.steps : [],
      };
    },
  };
}

module.exports = { createOrchestrator, SYSTEM_PROMPT, TOOL_LABELS };
