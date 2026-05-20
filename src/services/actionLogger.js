const logger = require('../utils/logger');
const { getConnection } = require('./salesforce');

const MAX_LONG = 131072;
const MAX_TEXT = 255;
const MAX_STEP_FIELD = 131072;
const MAX_STEP_ERROR = 32768;
const STEP_CHUNK = 200;

function trunc(val, max) {
  if (!val) return '';
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  return s.substring(0, max);
}

/** Maps an in-memory step (from stepRecorder) to a Routing_Action_Step__c create payload. */
function buildStepRecord(step, parentId) {
  return {
    Action_Log__c: parentId,
    Step_Number__c: step.stepNumber || null,
    Skill__c: trunc(step.skill, MAX_TEXT),
    Type__c: trunc(step.type || 'Skill', 40),
    Status__c: trunc(step.status || 'Success', 40),
    Prompt__c: trunc(step.prompt, MAX_STEP_FIELD),
    Input__c: trunc(step.input, MAX_STEP_FIELD),
    Output__c: trunc(step.output, MAX_STEP_FIELD),
    Duration_Ms__c: step.durationMs != null ? step.durationMs : null,
    Error_Message__c: trunc(step.error, MAX_STEP_ERROR),
  };
}

/** Best-effort: insert child step rows under a parent Routing_Action_Log__c. Never throws. */
async function insertSteps(conn, parentId, steps) {
  if (!parentId || !Array.isArray(steps) || steps.length === 0) return;
  const records = steps.map((s) => buildStepRecord(s, parentId));
  for (let i = 0; i < records.length; i += STEP_CHUNK) {
    const chunk = records.slice(i, i + STEP_CHUNK);
    try {
      await conn.sobject('Routing_Action_Step__c').create(chunk, { allOrNone: false });
    } catch (err) {
      logger.error('[actionLogger] Failed to insert step chunk', { error: err.message, chunkStart: i });
    }
  }
}

/**
 * Logs an action to the Routing_Action_Log__c Salesforce object.
 * Fires asynchronously and never throws — failures are logged locally only.
 * Optional `steps` array (from stepRecorder) is inserted as child Routing_Action_Step__c rows.
 */
async function logAction({ action, status, requestBody, responseBody, aiPrompt, aiResponse, durationMs, userInfo, googleRouteId, source, steps }) {
  try {
    const conn = await getConnection();
    const result = await conn.sobject('Routing_Action_Log__c').create({
      Action__c: trunc(action, MAX_TEXT),
      Status__c: trunc(status, 50),
      Request_Body__c: trunc(requestBody, MAX_LONG),
      Response_Body__c: trunc(responseBody, MAX_LONG),
      AI_Prompt__c: trunc(aiPrompt, MAX_LONG),
      AI_Response__c: trunc(aiResponse, MAX_LONG),
      Duration_Ms__c: durationMs || null,
      User_Info__c: trunc(userInfo, MAX_TEXT),
      Source__c: trunc(source, MAX_TEXT),
      ...(googleRouteId ? { Google_Route__c: googleRouteId } : {}),
    });
    const parentId = result?.id || result?.Id;
    logger.info('[actionLogger] Action logged', { action, status, durationMs, steps: steps?.length || 0 });
    if (parentId && Array.isArray(steps) && steps.length > 0) {
      await insertSteps(conn, parentId, steps);
    }
  } catch (err) {
    logger.error('[actionLogger] Failed to log to SF:', err.message);
  }
}

module.exports = { logAction };
