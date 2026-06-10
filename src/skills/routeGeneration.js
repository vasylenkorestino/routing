const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/** Creates Google_Route__c + Route__c records in Salesforce, marked as AI-generated. */
class RouteGenerationSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_generation',
      description:
        'Create new routes in Salesforce. Accepts a list of route definitions, each with a name, ' +
        'service date, record type, service location (depot), and ordered list of account IDs. ' +
        'Creates Google_Route__c (header) and Route__c (stops) records with isAI__c = true. ' +
        'The service location is the start and end point for the route.',
      inputSchema: {
        type: 'object',
        properties: {
          routes: {
            type: 'array',
            description: 'Array of route definitions to create.',
            items: {
              type: 'object',
              properties: {
                routeName: { type: 'string', description: 'Name for the Google_Route__c.' },
                serviceDate: { type: 'string', description: 'Service date (YYYY-MM-DD).' },
                recordTypeName: { type: 'string', description: 'Record type name (e.g. "EZG").' },
                serviceLocationId: { type: 'string', description: 'Service_Location__c Id (depot start/end).' },
                accountIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Ordered list of Account IDs for route stops.',
                },
              },
              required: ['routeName', 'serviceDate', 'recordTypeName', 'accountIds'],
            },
          },
        },
        required: ['routes'],
      },
    });
  }

  async execute({ routes }) {
    if (!routes || routes.length === 0) {
      return { created: 0, googleRoutes: [] };
    }

    const rtMap = await this._getRecordTypeMap();

    const allAccountIds = new Set();
    for (const r of routes) {
      for (const id of r.accountIds) allAccountIds.add(id);
    }

    const accountMap = await this._getAccountMap([...allAccountIds]);

    const googleRoutes = routes.map((r) => ({
      Name: r.routeName,
      Service_Date__c: r.serviceDate,
      RecordTypeId: rtMap.googleRoute[r.recordTypeName],
      Service_Location_Start__c: r.serviceLocationId || null,
      Service_Location_End__c: r.serviceLocationId || null,
      isAI__c: true,
      isAIApproved__c: false,
      isInherit__c: false,
      Custom_Route__c: false,
      Accounts__c: r.accountIds.join(','),
    }));

    const grResults = await sf.insert('Google_Route__c', googleRoutes);

    const routePoints = [];
    for (let i = 0; i < routes.length; i++) {
      const grResult = grResults[i];
      if (!grResult.success) continue;

      const routeDef = routes[i];
      let priority = 1;

      for (const accountId of routeDef.accountIds) {
        const acct = accountMap[accountId];
        if (!acct) continue;

        const point = {
          AccountId__c: acct.Id,
          Account_Name__c: acct.Name,
          RecordTypeId: rtMap.route[routeDef.recordTypeName],
          DateOfService__c: routeDef.serviceDate,
          Container_Address__c: [acct.ShippingStreet, acct.ShippingCity, acct.ShippingState, acct.ShippingCountry]
            .filter(Boolean).join(', '),
          Name: routeDef.routeName,
          Google_Route_Id__c: grResult.id,
          GRoute_Id__c: grResult.id,
          Latitude__c: acct.MALatitude__c,
          Longitude__c: acct.MALongitude__c,
          Status__c: 'New',
          Priority__c: priority,
          isAI__c: true,
          isAIApproved__c: false,
          ServiceType__c: acct.Rotisserie_Collection__c ? 'Rotisserie Water' : 'UCO Collection',
        };

        if (acct.Services__r?.records?.[0]) {
          point.LastGallonsCollected__c = acct.Services__r.records[0].Qty_Gallons__c;
        }

        routePoints.push(point);
        priority++;
      }
    }

    let pointResults = [];
    if (routePoints.length > 0) {
      pointResults = await sf.insert('Route__c', routePoints);
    }

    const createdRoutes = grResults
      .filter((r) => r.success)
      .map((r, idx) => ({
        id: r.id,
        name: routes[idx].routeName,
        serviceDate: routes[idx].serviceDate,
        stopCount: routes[idx].accountIds.length,
      }));

    return {
      created: createdRoutes.length,
      googleRoutes: createdRoutes,
      totalStops: pointResults.filter((r) => r.success).length,
    };
  }

  async _getRecordTypeMap() {
    const grTypes = await sf.query(
      "SELECT Id, Name FROM RecordType WHERE SobjectType = 'Google_Route__c' AND IsActive = true"
    );
    const rTypes = await sf.query(
      "SELECT Id, Name FROM RecordType WHERE SobjectType = 'Route__c' AND IsActive = true"
    );

    const googleRoute = {};
    const route = {};
    for (const rt of grTypes) googleRoute[rt.Name] = rt.Id;
    for (const rt of rTypes) route[rt.Name] = rt.Id;

    return { googleRoute, route };
  }

  async _getAccountMap(accountIds) {
    if (accountIds.length === 0) return {};

    const idList = accountIds.map((id) => `'${id}'`).join(',');
    const accounts = await sf.query(
      `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ` +
      `MALatitude__c, MALongitude__c, Rotisserie_Collection__c, ` +
      `(SELECT Id, Qty_Gallons__c FROM Services__r WHERE RecordType.Name = 'UCO Collection' ORDER BY CreatedDate DESC LIMIT 1), ` +
      `(SELECT Id, Type, Status FROM Cases WHERE Status = 'Open' ORDER BY CreatedDate DESC LIMIT 3) ` +
      `FROM Account WHERE Id IN (${idList})`
    );

    const map = {};
    for (const a of accounts) map[a.Id] = a;
    return map;
  }
}

module.exports = RouteGenerationSkill;
