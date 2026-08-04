const BaseSkill = require('./base');
const sf = require('../services/salesforce');
const { redactFreeText } = require('../utils/aiDataPolicy');
const { accountRoutingFilterClause } = require('../utils/accountRoutingFilters');
const serviceDue = require('../modules/serviceDue');
const { withServiceHistoryForAccounts } = require('../modules/serviceHistoryLoader');

/**
 * Finds accounts that actually need UCO service by the target date.
 * Candidates (UCO_Collection__c = true, active, routable, with coordinates) are
 * evaluated individually by the shared serviceDue engine: newest UCO Collection
 * Service__c + pickup frequency (declared or estimated from history), with a
 * Gross Gallons fill-rate model against tank capacity.
 */
class AccountDiscoverySkill extends BaseSkill {
  constructor() {
    super({
      name: 'account_discovery',
      description:
        'Find accounts that need UCO service by the target date. Each candidate ' +
        '(UCO_Collection__c = true, active, not ignored for routing, valid coordinates, ' +
        'not already on an active route) is evaluated individually: last service date ' +
        '(newest UCO Collection Service__c only) ' +
        'plus pickup frequency (Estimated_Pickup_Frequency__c, falling back to a frequency ' +
        'estimated from service history) must land on or before the target date. ' +
        'Also factors tank capacity (Tank_Size__c) and Gross Gallons collection history. ' +
        'Returns only due accounts, each with nextDueDate, frequency and gallons estimates.',
      inputSchema: {
        type: 'object',
        properties: {
          targetDate: {
            type: 'string',
            description: 'Target service date (YYYY-MM-DD). Accounts due on or before this date are included.',
          },
          recordTypeName: {
            type: 'string',
            description: 'Record type filter (e.g. "EZG").',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum accounts to return. Default 500.',
          },
        },
        required: ['targetDate'],
      },
    });
  }

  async execute({ targetDate, recordTypeName, maxResults = 500 }) {
    const alreadyRouted = await sf.query(
      `SELECT AccountId__c FROM Route__c ` +
      `WHERE DateOfService__c = ${targetDate} ` +
      `AND AccountId__c != null AND Status__c != 'Complete'`
    );
    const routedIds = new Set(alreadyRouted.map((r) => r.AccountId__c));

    let soql =
      'SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode, ' +
      'MALatitude__c, MALongitude__c, Shape__c, Shape_Name__c, ' +
      'Last_Service_Date__c, Expected_Date_Of_Service__c, ' +
      `${serviceDue.ACCOUNT_DUE_FIELDS}, ` +
      'Interval__c, Ignore_For_Routing__c, UCO_Collection__c, Rotisserie_Collection__c, Route_Notes__c, Notes__c, ' +
      '(SELECT Id, Subject, Type, Status FROM Cases WHERE Status = \'Open\' AND Type = \'UCO Collection\' ORDER BY CreatedDate DESC) ' +
      'FROM Account ' +
      `WHERE ${accountRoutingFilterClause()} ` +
      'AND MALatitude__c != null AND MALongitude__c != null ';

    if (recordTypeName) {
      soql += `AND RecordType.Name = '${recordTypeName}' `;
    }

    soql += `ORDER BY UCOLastServiceDate__c ASC NULLS FIRST LIMIT ${Math.min(maxResults * 4, 4000)}`;

    let accounts = await sf.query(soql);

    accounts = accounts.filter((a) => !routedIds.has(a.Id));
    accounts = await withServiceHistoryForAccounts(accounts);

    // Per-account due evaluation — only accounts that actually need service pass.
    const skippedByReason = {};
    const due = [];
    for (const a of accounts) {
      const svc = serviceDue.evaluateAccount(a, targetDate, targetDate);
      if (svc.due) {
        due.push({ account: a, svc });
      } else {
        const key = svc.reason.startsWith('not_due_until') ? 'not_due_yet' : svc.reason;
        skippedByReason[key] = (skippedByReason[key] || 0) + 1;
      }
    }

    // Open tickets first (prioritization only — tickets never force inclusion).
    const withTickets = [];
    const withoutTickets = [];
    for (const entry of due) {
      const hasTicket = entry.account.Cases?.records?.length > 0;
      (hasTicket ? withTickets : withoutTickets).push(entry);
    }

    const result = [...withTickets, ...withoutTickets].slice(0, maxResults);

    return {
      totalFound: result.length,
      totalEvaluated: accounts.length,
      skippedNotDue: accounts.length - due.length,
      skippedByReason,
      withOpenTickets: withTickets.length,
      withoutTickets: withoutTickets.length,
      accounts: result.map(({ account: a, svc }) => ({
        Id: a.Id,
        Name: a.Name,
        ShippingStreet: a.ShippingStreet,
        ShippingCity: a.ShippingCity,
        ShippingState: a.ShippingState,
        MALatitude__c: a.MALatitude__c,
        MALongitude__c: a.MALongitude__c,
        Shape_Name__c: a.Shape_Name__c,
        Last_Service_Date__c: a.Last_Service_Date__c,
        Expected_Date_Of_Service__c: a.Expected_Date_Of_Service__c,
        Pickup_Frequency_in_Days__c: a.Pickup_Frequency_in_Days__c,
        lastServiceDate: svc.lastServiceDate,
        lastDateSource: svc.lastDateSource,
        nextDueDate: svc.nextDueDate,
        frequencyDays: svc.effectiveFrequencyDays,
        frequencySource: svc.frequencySource,
        frequencyLabel: svc.frequencyLabel,
        capacityGallons: svc.capacityGallons,
        fillRatePerDay: svc.fillRatePerDay,
        estimatedGallons: svc.estimatedGallonsAtDate,
        hasOpenTicket: (a.Cases?.records?.length || 0) > 0,
        ticketCount: a.Cases?.records?.length || 0,
        lastGallons: a.Services__r?.records?.[0]?.Qty_Gallons__c || null,
        Route_Notes__c: redactFreeText(a.Route_Notes__c),
        Notes__c: redactFreeText(a.Notes__c),
      })),
    };
  }
}

module.exports = AccountDiscoverySkill;
