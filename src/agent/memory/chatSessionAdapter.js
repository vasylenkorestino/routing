const fs = require('fs');
const path = require('path');
const { getConnection } = require('../../services/salesforce');
const { redactFreeText } = require('../../utils/aiDataPolicy');
const logger = require('../../utils/logger');

const USE_FILE_BACKEND = process.env.AGENT_MEMORY_BACKEND === 'file';
const FILE_DIR = path.join(__dirname, '../../../.data/chat-sessions');

const MAX_TRANSCRIPT_CHARS = 131000; // AI_Chat_Session__c.Transcript__c is LongTextArea(131072)
const MAX_SUMMARY_CHARS = 32000;

/** Writes a transcript JSON file in dev (AGENT_MEMORY_BACKEND=file). */
function writeFile(sessionId, payload) {
  if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FILE_DIR, `${sessionId}.json`), JSON.stringify(payload, null, 2));
}

/**
 * Upserts a chat transcript into AI_Chat_Session__c by Session_Id__c (external ID).
 * Best effort — logs a warning on failure and never throws, so it can run
 * fire-and-forget after each assistant reply without affecting the chat request.
 */
async function upsertTranscript({ sessionId, transcript, summary, recordType }) {
  if (!sessionId || !transcript) return null;

  const payload = {
    Session_Id__c: sessionId,
    Transcript__c: redactFreeText(transcript).slice(-MAX_TRANSCRIPT_CHARS),
    Summary__c: summary ? redactFreeText(summary).slice(0, MAX_SUMMARY_CHARS) : null,
    Record_Type_Context__c: recordType || null,
    Last_Activity__c: new Date().toISOString(),
  };

  try {
    if (USE_FILE_BACKEND) {
      writeFile(sessionId, payload);
      return payload;
    }
    const conn = await getConnection();
    await conn.sobject('AI_Chat_Session__c').upsert(payload, 'Session_Id__c');
    return payload;
  } catch (err) {
    logger.warn('[chat-session] transcript upsert failed — AI_Chat_Session__c may not exist yet', { error: err.message });
    return null;
  }
}

module.exports = { upsertTranscript };
