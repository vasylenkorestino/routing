/**
 * Shared SOQL eligibility predicates for selecting candidate accounts when
 * searching for accounts to add to routes (AI Enhance + AI Generate).
 *
 * To add a new global filter criterion, append a SOQL predicate string here
 * and every candidate-account search will pick it up automatically.
 */
const ACCOUNT_ROUTING_FILTERS = [
  'Ignore_For_Routing__c = false',
  "Account_Status__c = 'Active'",
  'UCO_Collection__c = true',
];

/**
 * Builds the shared eligibility WHERE clause.
 * @param {object} [opts]
 * @param {boolean} [opts.leadingAnd=false] - prefix with 'AND ' to append onto an existing WHERE.
 * @param {boolean} [opts.trailingSpace=false] - append a trailing space (helps when concatenating query fragments).
 * @returns {string} e.g. "Ignore_For_Routing__c = false AND Account_Status__c = 'Active' AND UCO_Collection__c = true"
 */
function accountRoutingFilterClause({ leadingAnd = false, trailingSpace = false } = {}) {
  let clause = ACCOUNT_ROUTING_FILTERS.join(' AND ');
  if (leadingAnd) clause = `AND ${clause}`;
  if (trailingSpace) clause = `${clause} `;
  return clause;
}

module.exports = { ACCOUNT_ROUTING_FILTERS, accountRoutingFilterClause };
