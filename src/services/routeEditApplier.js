const sf = require('./salesforce');
const { optimizeGoogleRoute } = require('./sfRoutingApi');
const logger = require('../utils/logger');

/** Applies an approved route edit proposal to Salesforce. */
async function applyProposal(proposal, { approvedBy } = {}) {
  const raw = proposal.raw || {};
  const googleRouteId = proposal.googleRouteId;
  const routeRows = await sf.query(
    `SELECT Id, Name, Service_Date__c, Driver__c, DriverName__c, RecordType.Name, ` +
    `Service_Location_Start__c, Service_Location_End__c, Accounts__c ` +
    `FROM Google_Route__c WHERE Id = '${googleRouteId}' LIMIT 1`,
  );
  if (!routeRows.length) throw new Error('Route not found');

  const current = routeRows[0];
  const headerPatch = { Id: googleRouteId };
  let headerChanged = false;

  if (raw.serviceDate && raw.serviceDate !== current.Service_Date__c) {
    headerPatch.Service_Date__c = raw.serviceDate;
    headerChanged = true;
  }
  if (raw.driverId !== undefined && raw.driverId !== current.Driver__c) {
    headerPatch.Driver__c = raw.driverId || null;
    headerChanged = true;
  }
  if (raw.serviceLocationStartId && raw.serviceLocationStartId !== current.Service_Location_Start__c) {
    headerPatch.Service_Location_Start__c = raw.serviceLocationStartId;
    headerChanged = true;
  }
  if (raw.serviceLocationEndId && raw.serviceLocationEndId !== current.Service_Location_End__c) {
    headerPatch.Service_Location_End__c = raw.serviceLocationEndId;
    headerChanged = true;
  }

  if (headerChanged) {
    await sf.update('Google_Route__c', [headerPatch]);
  }

  const serviceDate = raw.serviceDate || current.Service_Date__c;
  const removeIds = (raw.removeStopIds || []).filter(Boolean);
  if (removeIds.length > 0) {
    const idList = removeIds.map((id) => `'${id}'`).join(',');
    const toDelete = await sf.query(
      `SELECT Id FROM Route__c WHERE Id IN (${idList}) AND GRoute_Id__c = '${googleRouteId}'`,
    );
    if (toDelete.length > 0) {
      const conn = await sf.getConnection();
      await conn.sobject('Route__c').destroy(toDelete.map((r) => r.Id));
    }
  }

  const addAccountIds = (raw.addAccountIds || []).filter(Boolean);
  let addedStops = 0;
  if (addAccountIds.length > 0) {
    addedStops = await _insertStops({
      googleRouteId,
      routeName: current.Name,
      recordTypeName: current.RecordType?.Name,
      serviceDate,
      accountIds: addAccountIds,
    });
  }

  if (raw.serviceDate && raw.serviceDate !== current.Service_Date__c) {
    const remaining = await sf.query(
      `SELECT Id FROM Route__c WHERE GRoute_Id__c = '${googleRouteId}' AND Status__c != 'Complete'`,
    );
    if (remaining.length > 0) {
      await sf.update('Route__c', remaining.map((r) => ({ Id: r.Id, DateOfService__c: serviceDate })));
    }
  }

  const optimized = await _optimizeRoute(googleRouteId);

  await _writeAuditLogs(proposal, { approvedBy, addedStops, removedCount: removeIds.length });

  return {
    googleRouteId,
    headerChanged,
    addedStops,
    removedStops: removeIds.length,
    optimized,
  };
}

/** Inserts new Route__c stops for accounts being added to an existing route. */
async function _insertStops({ googleRouteId, routeName, recordTypeName, serviceDate, accountIds }) {
  const rtRows = await sf.query(
    `SELECT Id, Name FROM RecordType WHERE SobjectType = 'Route__c' AND IsActive = true`,
  );
  const routeRt = rtRows.find((r) => r.Name === recordTypeName)?.Id;
  if (!routeRt) throw new Error(`Unknown Route__c record type: ${recordTypeName}`);

  const idList = accountIds.map((id) => `'${id}'`).join(',');
  const accounts = await sf.query(
    `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ` +
    `MALatitude__c, MALongitude__c, Rotisserie_Collection__c, ` +
    `(SELECT Id, Qty_Gallons__c FROM Services__r WHERE RecordType.Name = 'UCO Collection' ` +
    `ORDER BY CreatedDate DESC LIMIT 1) ` +
    `FROM Account WHERE Id IN (${idList})`,
  );
  const acctMap = Object.fromEntries(accounts.map((a) => [a.Id, a]));

  const existing = await sf.query(
    `SELECT AccountId__c FROM Route__c WHERE GRoute_Id__c = '${googleRouteId}' AND AccountId__c != null`,
  );
  const onRoute = new Set(existing.map((r) => r.AccountId__c));

  const maxPriRows = await sf.query(
    `SELECT Priority__c FROM Route__c WHERE GRoute_Id__c = '${googleRouteId}' ` +
    `ORDER BY Priority__c DESC NULLS LAST LIMIT 1`,
  );
  let priority = (maxPriRows[0]?.Priority__c || 0) + 1;

  const points = [];
  for (const accountId of accountIds) {
    if (onRoute.has(accountId)) continue;
    const acct = acctMap[accountId];
    if (!acct) continue;
    points.push({
      AccountId__c: acct.Id,
      Account_Name__c: acct.Name,
      RecordTypeId: routeRt,
      DateOfService__c: serviceDate,
      Container_Address__c: [acct.ShippingStreet, acct.ShippingCity, acct.ShippingState, acct.ShippingCountry]
        .filter(Boolean).join(', '),
      Name: routeName,
      Google_Route_Id__c: googleRouteId,
      GRoute_Id__c: googleRouteId,
      Latitude__c: acct.MALatitude__c,
      Longitude__c: acct.MALongitude__c,
      Status__c: 'New',
      Priority__c: priority,
      isAI__c: true,
      isAIApproved__c: true,
      ServiceType__c: acct.Rotisserie_Collection__c ? 'Rotisserie Water' : 'UCO Collection',
      LastGallonsCollected__c: acct.Services__r?.records?.[0]?.Qty_Gallons__c || null,
    });
    priority += 1;
  }

  if (points.length === 0) return 0;
  const results = await sf.insert('Route__c', points);
  return results.filter((r) => r.success).length;
}

/** Re-optimizes stop order after edits when yards are set. */
async function _optimizeRoute(googleRouteId) {
  const routes = await sf.query(
    `SELECT Id, Driver__c, Service_Location_Start__c, Service_Location_End__c ` +
    `FROM Google_Route__c WHERE Id = '${googleRouteId}' LIMIT 1`,
  );
  if (!routes.length) return false;
  const gr = routes[0];
  if (!gr.Service_Location_Start__c || !gr.Service_Location_End__c) return false;

  const stops = await sf.query(
    `SELECT Id, AccountId__c, Fixed_point__c, Priority__c ` +
    `FROM Route__c WHERE GRoute_Id__c = '${googleRouteId}' ORDER BY Priority__c ASC`,
  );
  if (stops.length === 0) return false;

  try {
    await optimizeGoogleRoute(
      {
        Id: googleRouteId,
        Driver__c: gr.Driver__c || null,
        Service_Location_Start__c: gr.Service_Location_Start__c,
        Service_Location_End__c: gr.Service_Location_End__c,
      },
      stops.map((s, i) => ({
        Id: s.Id,
        AccountId__c: s.AccountId__c,
        Fixed_point__c: s.Fixed_point__c || false,
        Priority__c: i + 1,
        Google_Route_Id__c: googleRouteId,
        GRoute_Id__c: googleRouteId,
      })),
    );
    return true;
  } catch (err) {
    logger.warn('[routeEditApplier] optimize failed', { googleRouteId, error: err.message });
    return false;
  }
}

/** Writes RouteLog__c audit entries after a manager-approved edit. */
async function _writeAuditLogs(proposal, { approvedBy, addedStops, removedCount }) {
  const logs = [{
    Google_Route__c: proposal.googleRouteId,
    Type__c: 'Route Optimized',
    Reason__c: `[EDIT APPROVED] ${proposal.summary}. ${proposal.reason || ''}`.trim(),
    Status__c: 'Accepted',
    Skill__c: 'route_edit_proposal',
    Accepted_By__c: approvedBy || null,
    Accepted_Date__c: new Date().toISOString(),
    Input_Data__c: JSON.stringify(proposal.changes).substring(0, 30000),
  }];

  for (const stop of proposal.changes?.addStops || []) {
    logs.push({
      Google_Route__c: proposal.googleRouteId,
      Account__c: stop.accountId,
      Type__c: 'Account Added',
      Reason__c: `[ADD] ${stop.accountName} — approved by manager`,
      Status__c: 'Accepted',
      Skill__c: 'route_edit_proposal',
      Accepted_By__c: approvedBy || null,
    });
  }
  for (const stop of proposal.changes?.removeStops || []) {
    logs.push({
      Google_Route__c: proposal.googleRouteId,
      Account__c: stop.accountId,
      Route__c: stop.stopId,
      Type__c: 'Account Recommended',
      Reason__c: `[REMOVE] ${stop.accountName} — approved by manager`,
      Status__c: 'Accepted',
      Skill__c: 'route_edit_proposal',
      Accepted_By__c: approvedBy || null,
    });
  }

  try {
    await sf.insert('RouteLog__c', logs);
  } catch (err) {
    logger.warn('[routeEditApplier] audit log insert failed', { error: err.message });
  }
}

module.exports = { applyProposal };
