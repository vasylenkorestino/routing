const BaseSkill = require('./base');
const sf = require('../services/salesforce');
const { redactFreeText, sanitizeCaseForAI } = require('../utils/aiDataPolicy');

/** Loads multiple Google_Route__c routes with their stops, account/service detail, and open UCO tickets. */
class MultiRouteContextSkill extends BaseSkill {
  constructor() {
    super({
      name: 'multi_route_context',
      description:
        'Load several Google_Route__c routes at once with their stops, account details, recent service history, ' +
        'and open UCO Collection cases. Optionally also returns nearby accounts (not on these routes) that have ' +
        'open tickets or are overdue, bounded by the geographic envelope of the supplied routes. ' +
        'Use this when the user has selected multiple routes to redesign/combine/split before calling route_generation.',
      inputSchema: {
        type: 'object',
        properties: {
          routeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Salesforce Ids of the Google_Route__c records to load.',
          },
          includeNearby: {
            type: 'boolean',
            description: 'If true (default), also return nearby ticketed/overdue accounts inside the routes\' bounding box.',
          },
          nearbyPaddingDeg: {
            type: 'number',
            description: 'Bounding box padding in degrees (~0.15 ≈ 10 miles). Default 0.15.',
          },
          maxAccounts: {
            type: 'number',
            description: 'Maximum number of nearby candidate accounts to return. Default 250.',
          },
        },
        required: ['routeIds'],
      },
    });
  }

  async execute({ routeIds, includeNearby = true, nearbyPaddingDeg = 0.15, maxAccounts = 250 }) {
    if (!Array.isArray(routeIds) || routeIds.length === 0) {
      return { error: 'routeIds is required' };
    }

    const sanitizedIds = routeIds.filter((id) => typeof id === 'string' && /^[a-zA-Z0-9]+$/.test(id));
    if (sanitizedIds.length === 0) return { error: 'No valid routeIds provided' };
    const routeIdList = sanitizedIds.map((id) => `'${id}'`).join(',');

    const routes = await sf.query(
      `SELECT Id, Name, Service_Date__c, DriverName__c, Miles__c, Minutes__c, ` +
      `Total_Distance__c, Total_Time__c, Service_Location_Start__c, Service_Location_End__c, ` +
      `RecordType.Name, Accounts__c ` +
      `FROM Google_Route__c WHERE Id IN (${routeIdList})`
    );

    if (routes.length === 0) {
      return { error: 'No routes found for the supplied Ids', routeIds: sanitizedIds };
    }

    const stops = await sf.query(
      `SELECT Id, Google_Route_Id__c, AccountId__c, Account_Name__c, Container_Address__c, ` +
      `Priority__c, ServiceType__c, ServiceSubType__c, LastGallonsCollected__c, Notes__c, ` +
      `Driver_Notes__c, Status__c, Fixed_point__c, Latitude__c, Longitude__c ` +
      `FROM Route__c WHERE Google_Route_Id__c IN (${routeIdList}) ` +
      `ORDER BY Google_Route_Id__c, Priority__c ASC`
    );

    const accountIds = [...new Set(stops.map((s) => s.AccountId__c).filter(Boolean))];

    let accounts = [];
    if (accountIds.length > 0) {
      const acctIdList = accountIds.map((id) => `'${id}'`).join(',');
      accounts = await sf.query(
        `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState, ` +
        `MALatitude__c, MALongitude__c, Last_Service_Date__c, Expected_Date_Of_Service__c, ` +
        `DaysInterval__c, Pickup_Frequency_in_Days__c, DailyAccumulationRate__c, ` +
        `Tank_Size__c, Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c, ` +
        `Ignore_For_Routing__c, Rotisserie_Collection__c, Shape_Name__c, ` +
        `(SELECT Id, Qty_Gallons__c, Service_Date__c FROM Services__r ` +
        `WHERE RecordType.Name = 'UCO Collection' ORDER BY CreatedDate DESC LIMIT 5), ` +
        `(SELECT Id, Subject, Type, Status, CreatedDate FROM Cases ` +
        `WHERE Status = 'Open' AND Type = 'UCO Collection' ORDER BY CreatedDate DESC LIMIT 5) ` +
        `FROM Account WHERE Id IN (${acctIdList})`
      );
    }

    const acctMap = {};
    for (const a of accounts) acctMap[a.Id] = a;

    const stopsByRoute = {};
    for (const s of stops) {
      const rid = s.Google_Route_Id__c;
      if (!stopsByRoute[rid]) stopsByRoute[rid] = [];
      const acct = acctMap[s.AccountId__c] || {};
      const services = acct.Services__r?.records || [];
      const cases = acct.Cases?.records || [];
      stopsByRoute[rid].push({
        stopId: s.Id,
        accountId: s.AccountId__c,
        accountName: s.Account_Name__c,
        address: s.Container_Address__c,
        priority: s.Priority__c,
        serviceType: s.ServiceType__c,
        status: s.Status__c,
        isFixed: s.Fixed_point__c,
        lastGallons: s.LastGallonsCollected__c,
        driverNotes: s.Driver_Notes__c,
        lat: s.Latitude__c,
        lng: s.Longitude__c,
        tankSize: acct.Tank_Size__c,
        secondContainer: acct.Second_Container__c,
        gpd: acct.DailyAccumulationRate__c,
        interval: acct.DaysInterval__c,
        lastServiceDate: acct.Last_Service_Date__c,
        expectedServiceDate: acct.Expected_Date_Of_Service__c,
        priorityTier: acct.Priority_Tier__c,
        routeNotes: redactFreeText(acct.Route_Notes__c),
        specialInstructions: redactFreeText(acct.Notes__c),
        rotisserie: acct.Rotisserie_Collection__c,
        recentServices: services.map((sv) => ({ gallons: sv.Qty_Gallons__c, date: sv.Service_Date__c })),
        openTickets: cases.map((c) => sanitizeCaseForAI(c)),
      });
    }

    const openTickets = [];
    for (const a of accounts) {
      const cases = a.Cases?.records || [];
      for (const c of cases) {
        openTickets.push({
          accountId: a.Id,
          accountName: a.Name,
          ...sanitizeCaseForAI(c),
          createdDate: c.CreatedDate,
        });
      }
    }

    const routesOut = routes.map((r) => ({
      routeId: r.Id,
      name: r.Name,
      serviceDate: r.Service_Date__c,
      driver: r.DriverName__c,
      recordType: r.RecordType?.Name,
      miles: r.Miles__c,
      minutes: r.Minutes__c,
      totalDistance: r.Total_Distance__c,
      totalTime: r.Total_Time__c,
      serviceLocationStart: r.Service_Location_Start__c,
      serviceLocationEnd: r.Service_Location_End__c,
      stopCount: stopsByRoute[r.Id]?.length || 0,
    }));

    let nearby = [];
    let nearbyError = null;
    if (includeNearby) {
      const lats = stops.map((s) => s.Latitude__c).filter((v) => typeof v === 'number');
      const lngs = stops.map((s) => s.Longitude__c).filter((v) => typeof v === 'number');
      if (lats.length > 0 && lngs.length > 0) {
        const minLat = Math.min(...lats) - nearbyPaddingDeg;
        const maxLat = Math.max(...lats) + nearbyPaddingDeg;
        const minLng = Math.min(...lngs) - nearbyPaddingDeg;
        const maxLng = Math.max(...lngs) + nearbyPaddingDeg;
        const excludeIds = accountIds.length > 0 ? accountIds.map((id) => `'${id}'`).join(',') : "''";

        try {
          const nearbyRows = await sf.query(
            `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState, ` +
            `MALatitude__c, MALongitude__c, Last_Service_Date__c, Expected_Date_Of_Service__c, ` +
            `DaysInterval__c, DailyAccumulationRate__c, Tank_Size__c, Second_Container__c, ` +
            `Priority_Tier__c, Route_Notes__c, Notes__c, Rotisserie_Collection__c, ` +
            `(SELECT Id, Subject, Type, Status FROM Cases WHERE Status = 'Open' AND Type = 'UCO Collection' LIMIT 3), ` +
            `(SELECT Id, Qty_Gallons__c, Service_Date__c FROM Services__r ` +
            `WHERE RecordType.Name = 'UCO Collection' ORDER BY CreatedDate DESC LIMIT 3) ` +
            `FROM Account ` +
            `WHERE MALatitude__c >= ${minLat} AND MALatitude__c <= ${maxLat} ` +
            `AND MALongitude__c >= ${minLng} AND MALongitude__c <= ${maxLng} ` +
            `AND Id NOT IN (${excludeIds}) ` +
            `AND Ignore_For_Routing__c = false ` +
            `AND Account_Status__c = 'Active' ` +
            `AND MALatitude__c != null AND MALongitude__c != null ` +
            `LIMIT ${Math.min(maxAccounts, 1000)}`
          );

          nearby = nearbyRows.map((a) => ({
            accountId: a.Id,
            accountName: a.Name,
            address: [a.ShippingStreet, a.ShippingCity, a.ShippingState].filter(Boolean).join(', '),
            lat: a.MALatitude__c,
            lng: a.MALongitude__c,
            lastServiceDate: a.Last_Service_Date__c,
            expectedServiceDate: a.Expected_Date_Of_Service__c,
            interval: a.DaysInterval__c,
            gpd: a.DailyAccumulationRate__c,
            tankSize: a.Tank_Size__c,
            secondContainer: a.Second_Container__c,
            priorityTier: a.Priority_Tier__c,
            routeNotes: redactFreeText(a.Route_Notes__c),
            specialInstructions: redactFreeText(a.Notes__c),
            rotisserie: a.Rotisserie_Collection__c,
            hasOpenTicket: (a.Cases?.records?.length || 0) > 0,
            openTicketCount: a.Cases?.records?.length || 0,
            recentServices: (a.Services__r?.records || []).map((sv) => ({
              gallons: sv.Qty_Gallons__c,
              date: sv.Service_Date__c,
            })),
          }));

          nearby.sort((a, b) => {
            if (a.hasOpenTicket !== b.hasOpenTicket) return a.hasOpenTicket ? -1 : 1;
            const da = a.expectedServiceDate || '9999-12-31';
            const db = b.expectedServiceDate || '9999-12-31';
            return da.localeCompare(db);
          });
          nearby = nearby.slice(0, maxAccounts);
        } catch (err) {
          nearbyError = err.message;
        }
      }
    }

    return {
      routes: routesOut,
      stopsByRoute,
      totalStops: stops.length,
      uniqueAccounts: accountIds.length,
      openTicketCount: openTickets.length,
      openTickets: openTickets.slice(0, 100),
      nearby,
      nearbyCount: nearby.length,
      nearbyWithTickets: nearby.filter((n) => n.hasOpenTicket).length,
      nearbyError,
    };
  }
}

module.exports = MultiRouteContextSkill;
