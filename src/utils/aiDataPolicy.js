/**
 * Data policy for anything sent to the external LLM (Anthropic).
 * Standard CRM contact fields must never be queried or forwarded to the model.
 */

/** Salesforce field API names that must never appear in AI SOQL or payloads. */
const BLOCKED_FIELD_NAMES = new Set([
  'Email',
  'Phone',
  'PersonEmail',
  'PersonMobilePhone',
  'PersonHomePhone',
  'PersonOtherPhone',
  'Fax',
  'MobilePhone',
  'HomePhone',
  'OtherPhone',
  'AssistantPhone',
  'BillingEmail',
  'Email__c',
  'Phone__c',
  'Alt_Phone__c',
  'Password_Hash__c',
  'Invite_Token__c',
]);

/** Case fields excluded from AI context (Description often contains customer PII). */
const CASE_FIELDS_FOR_AI = ['Id', 'Type', 'Status', 'Subject'];

/**
 * Returns true if a SOQL fragment references a blocked field name (case-insensitive).
 * @param {string} soql
 */
function soqlContainsBlockedFields(soql) {
  if (!soql) return false;
  const upper = soql.toUpperCase();
  for (const field of BLOCKED_FIELD_NAMES) {
    if (upper.includes(field.toUpperCase())) return true;
  }
  return false;
}

/**
 * Redacts email and phone-like patterns from free-text routing notes before LLM use.
 * @param {string|null|undefined} text
 * @returns {string|null|undefined}
 */
function redactFreeText(text) {
  if (text == null || text === '') return text;
  return String(text)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[email-redacted]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone-redacted]');
}

/**
 * Maps a Case record to AI-safe ticket metadata (no Description).
 * @param {object} c
 */
function sanitizeCaseForAI(c) {
  if (!c) return null;
  return {
    id: c.Id,
    type: c.Type,
    status: c.Status,
    subject: redactFreeText(c.Subject),
  };
}

/**
 * Strips blocked keys from a plain object before JSON serialization to the LLM.
 * @param {object} record
 */
function stripBlockedKeys(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const key of Object.keys(out)) {
    if (BLOCKED_FIELD_NAMES.has(key)) delete out[key];
  }
  return out;
}

module.exports = {
  BLOCKED_FIELD_NAMES,
  CASE_FIELDS_FOR_AI,
  soqlContainsBlockedFields,
  redactFreeText,
  sanitizeCaseForAI,
  stripBlockedKeys,
};
