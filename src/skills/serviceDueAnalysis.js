const BaseSkill = require('./base');
const sf = require('../services/salesforce');
const { accountRoutingFilterClause } = require('../utils/accountRoutingFilters');
const serviceDue = require('../modules/serviceDue');

const MAX_ACCOUNT_IDS = 500;
const CANDIDATE_LIMIT = 4000;
const SKIPPED_SAMPLE_LIMIT = 50;

/** Validates a Salesforce Id (15/18-char alphanumeric) to keep interpolated SOQL safe. */
function safeId(id) {
  const s = String(id || '');
  if (!/^[a-zA-Z0-9]{15,18}$/.test(s)) throw new Error(`Invalid Salesforce Id: ${s}`);
  return s;
}

/**
 * Evaluates which UCO Collection accounts actually require service within a date
 * window, using the shared serviceDue engine. Read-only: never creates or updates
 * Salesforce records; estimated frequencies are in-memory for the planning run.
 */
class ServiceDueAnalysisSkill extends BaseSkill {
  constructor() {
    super({
      name: 'service_due_analysis',
      description:
        'Determine which UCO Collection accounts actually require service within a date window. ' +
        'ALWAYS run this when deciding which accounts need service or should be included in route ' +
        'planning — do not include accounts it reports as not due. Per account it resolves the last ' +
        'service date (UCOLastServiceDate__c, falling back to the newest UCO Collection Service__c ' +
        'record), the pickup frequency (Estimated_Pickup_Frequency__c picklist such as "3 Weeks", ' +
        'falling back to Pickup_Frequency_in_Days__c, falling back to a frequency estimated from the ' +
        'account\'s service history), and a Gross Gallons fill-rate model against tank capacity ' +
        '(Tank_Size__c) that can pull service earlier when the tank fills faster than the declared ' +
        'frequency. Returns due accounts with nextDueDate + gallons estimates, and skipped accounts ' +
        'with reasons. Read-only — never writes to Salesforce.',
      inputSchema: {
        type: 'object',
        properties: {
          dateFrom: {
            type: 'string',
            description: 'Start of the planning window (YYYY-MM-DD).',
          },
          dateTo: {
            type: 'string',
            description: 'End of the planning window (YYYY-MM-DD). Defaults to dateFrom.',
          },
          accountIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: evaluate only these Account Ids instead of all UCO Collection candidates.',
          },
          recordTypeName: {
            type: 'string',
            description: 'Optional record type filter (e.g. "EZG").',
          },
        },
        required: ['dateFrom'],
      },
    });
  }

  async execute({ dateFrom, dateTo, accountIds, recordTypeName }) {
    const target = dateTo || dateFrom;

    let soql =
      `SELECT Id, Name, UCO_Collection__c, ${serviceDue.ACCOUNT_DUE_FIELDS}, ` +
      `${serviceDue.SERVICE_HISTORY_SUBQUERY} FROM Account `;

    if (Array.isArray(accountIds) && accountIds.length > 0) {
      const ids = [...new Set(accountIds.slice(0, MAX_ACCOUNT_IDS).map(safeId))]
        .map((id) => `'${id}'`).join(',');
      soql += `WHERE Id IN (${ids}) AND UCO_Collection__c = true`;
    } else {
      soql += `WHERE ${accountRoutingFilterClause()} `;
      if (recordTypeName) {
        soql += `AND RecordType.Name = '${String(recordTypeName).replace(/'/g, "\\'")}' `;
      }
      soql += `ORDER BY UCOLastServiceDate__c ASC NULLS FIRST LIMIT ${CANDIDATE_LIMIT}`;
    }

    const accounts = await sf.query(soql);

    const dueAccounts = [];
    const skippedByReason = {};
    const skippedSample = [];
    let estimatedFrequencyCount = 0;

    for (const a of accounts) {
      const svc = serviceDue.evaluateAccount(a, dateFrom, target);
      if (svc.frequencySource === 'estimated_from_history' || svc.frequencySource === 'fill_rate') {
        estimatedFrequencyCount += 1;
      }
      if (svc.due) {
        dueAccounts.push({
          Id: a.Id,
          Name: a.Name,
          lastServiceDate: svc.lastServiceDate,
          lastDateSource: svc.lastDateSource,
          frequencyDays: svc.effectiveFrequencyDays,
          frequencySource: svc.frequencySource,
          frequencyLabel: svc.frequencyLabel,
          nextDueDate: svc.nextDueDate,
          capacityGallons: svc.capacityGallons,
          fillRatePerDay: svc.fillRatePerDay,
          estimatedGallons: svc.estimatedGallonsAtDate,
        });
      } else {
        const key = svc.reason.startsWith('not_due_until') ? 'not_due_yet' : svc.reason;
        skippedByReason[key] = (skippedByReason[key] || 0) + 1;
        if (skippedSample.length < SKIPPED_SAMPLE_LIMIT) {
          skippedSample.push({ Id: a.Id, Name: a.Name, reason: svc.reason, nextDueDate: svc.nextDueDate });
        }
      }
    }

    return {
      dateFrom,
      dateTo: target,
      totalEvaluated: accounts.length,
      dueCount: dueAccounts.length,
      skippedCount: accounts.length - dueAccounts.length,
      estimatedFrequencyCount,
      skippedByReason,
      skippedSample,
      dueAccounts,
    };
  }
}

module.exports = ServiceDueAnalysisSkill;
