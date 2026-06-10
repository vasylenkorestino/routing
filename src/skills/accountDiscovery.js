const BaseSkill = require('./base');
const sf = require('../services/salesforce');
const { redactFreeText } = require('../utils/aiDataPolicy');

/** Finds accounts eligible for routing based on service schedules, tickets, and location. */
class AccountDiscoverySkill extends BaseSkill {
  constructor() {
    super({
      name: 'account_discovery',
      description:
        'Find accounts that need to be serviced. Filters by: service schedule ' +
        '(Expected_Date_Of_Service__c <= target date), open UCO Collection tickets, ' +
        'valid coordinates, active status (Account_Status__c = Active), not ignored for routing, ' +
        'and not already on an active route for the target date. ' +
        'Returns accounts with location, service history, and open tickets.',
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
      'Last_Service_Date__c, Expected_Date_Of_Service__c, Pickup_Frequency_in_Days__c, ' +
      'Interval__c, Ignore_For_Routing__c, UCO_Collection__c, Rotisserie_Collection__c, Route_Notes__c, Notes__c, ' +
      '(SELECT Id, Qty_Gallons__c FROM Services__r WHERE RecordType.Name = \'UCO Collection\' ORDER BY CreatedDate DESC LIMIT 3), ' +
      '(SELECT Id, Subject, Type, Status FROM Cases WHERE Status = \'Open\' AND Type = \'UCO Collection\' ORDER BY CreatedDate DESC) ' +
      'FROM Account ' +
      'WHERE Ignore_For_Routing__c = false ' +
      'AND Account_Status__c = \'Active\' ' +
      'AND MALatitude__c != null AND MALongitude__c != null ';

    if (recordTypeName) {
      soql += `AND RecordType.Name = '${recordTypeName}' `;
    }

    soql += `AND (Expected_Date_Of_Service__c <= ${targetDate} OR Expected_Date_Of_Service__c = null) `;
    soql += `ORDER BY Expected_Date_Of_Service__c ASC NULLS LAST LIMIT ${Math.min(maxResults * 2, 2000)}`;

    let accounts = await sf.query(soql);

    accounts = accounts.filter((a) => !routedIds.has(a.Id));

    const withTickets = [];
    const withoutTickets = [];
    for (const a of accounts) {
      const hasTicket = a.Cases?.records?.length > 0;
      (hasTicket ? withTickets : withoutTickets).push(a);
    }

    const result = [...withTickets, ...withoutTickets].slice(0, maxResults);

    return {
      totalFound: result.length,
      withOpenTickets: withTickets.length,
      withoutTickets: withoutTickets.length,
      accounts: result.map((a) => ({
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
