const BaseSkill = require('./base');
const sf = require('../services/salesforce');
const proposals = require('../services/routeEditProposals');
const logger = require('../utils/logger');

/**
 * Proposes edits to an existing Google_Route__c without applying them.
 * Manager must approve via the chat confirmation UI before changes are applied.
 */
class RouteEditProposalSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_edit_proposal',
      description:
        'Propose edits to an EXISTING Google_Route__c record. Does NOT apply changes — ' +
        'creates a pending proposal for manager approval in the chat UI. Use this (not route_generation) when ' +
        'modifying a route in place: change service date, driver, start/end yard, add stops, or remove stops.',
      inputSchema: {
        type: 'object',
        properties: {
          googleRouteId: { type: 'string', description: 'Salesforce Id of the Google_Route__c to edit.' },
          serviceDate: { type: 'string', description: 'New Service_Date__c (YYYY-MM-DD) if moving the route.' },
          serviceLocationStartId: { type: 'string', description: 'New Service_Location_Start__c Id.' },
          serviceLocationEndId: { type: 'string', description: 'New Service_Location_End__c Id.' },
          driverId: { type: 'string', description: 'New Driver__c Id (or empty string to unassign).' },
          addAccountIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Account Ids to add as new Route__c stops.',
          },
          removeStopIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Route__c stop Ids to remove from the route.',
          },
          summary: { type: 'string', description: 'Short summary shown to the manager (required).' },
          reason: { type: 'string', description: 'Explanation of why these changes are recommended.' },
        },
        required: ['googleRouteId', 'summary'],
      },
    });
  }

  async execute(input, { owner } = {}) {
    const {
      googleRouteId,
      serviceDate,
      serviceLocationStartId,
      serviceLocationEndId,
      driverId,
      addAccountIds = [],
      removeStopIds = [],
      summary,
      reason,
    } = input;

    const route = await this._loadRoute(googleRouteId);
    if (!route) return { error: 'Route not found', googleRouteId };

    const stops = route.stops || [];
    const names = await this._resolveNames({
      driverId: driverId !== undefined ? driverId : route.Driver__c,
      prevDriverId: route.Driver__c,
      serviceLocationStartId: serviceLocationStartId || route.Service_Location_Start__c,
      prevStartId: route.Service_Location_Start__c,
      serviceLocationEndId: serviceLocationEndId || route.Service_Location_End__c,
      prevEndId: route.Service_Location_End__c,
      addAccountIds,
      removeStopIds,
      stops,
    });

    const changes = this._buildChanges({
      route,
      serviceDate,
      serviceLocationStartId,
      serviceLocationEndId,
      driverId,
      addAccountIds,
      removeStopIds,
      stops,
      names,
    });

    if (!this._hasChanges(changes)) {
      return { error: 'No changes detected — proposal must modify at least one field or stop.' };
    }

    const validationError = this._validate({ route, stops, changes, removeStopIds, addAccountIds });
    if (validationError) return { error: validationError };

    const raw = {
      googleRouteId,
      serviceDate: changes.header.serviceDate?.to || undefined,
      serviceLocationStartId: changes.header.serviceLocationStart?.to || undefined,
      serviceLocationEndId: changes.header.serviceLocationEnd?.to || undefined,
      driverId: changes.header.driver?.to !== undefined ? (changes.header.driver.to || null) : undefined,
      addAccountIds: changes.addStops.map((s) => s.accountId),
      removeStopIds: changes.removeStops.map((s) => s.stopId),
    };

    const proposal = proposals.create({
      googleRouteId,
      routeName: route.Name,
      summary,
      reason: reason || '',
      changes,
      raw,
      owner,
    });

    logger.info('[route_edit_proposal] created', { proposalId: proposal.id, googleRouteId });

    return {
      proposalId: proposal.id,
      status: 'pending',
      summary: proposal.summary,
      routeName: proposal.routeName,
      changes: proposal.changes,
      message: 'Proposal created — awaiting manager approval in chat.',
    };
  }

  async _loadRoute(googleRouteId) {
    const rows = await sf.query(
      `SELECT Id, Name, Service_Date__c, Driver__c, DriverName__c, ` +
      `Service_Location_Start__c, Service_Location_End__c, RecordType.Name ` +
      `FROM Google_Route__c WHERE Id = '${googleRouteId}' LIMIT 1`,
    );
    if (!rows.length) return null;
    const route = rows[0];
    const stops = await sf.query(
      `SELECT Id, AccountId__c, Account_Name__c, Priority__c, Container_Address__c ` +
      `FROM Route__c WHERE GRoute_Id__c = '${googleRouteId}' ORDER BY Priority__c ASC`,
    );
    route.stops = stops;
    return route;
  }

  async _resolveNames(ctx) {
    const ids = new Set();
    if (ctx.driverId) ids.add(ctx.driverId);
    if (ctx.prevDriverId) ids.add(ctx.prevDriverId);
    if (ctx.serviceLocationStartId) ids.add(ctx.serviceLocationStartId);
    if (ctx.prevStartId) ids.add(ctx.prevStartId);
    if (ctx.serviceLocationEndId) ids.add(ctx.serviceLocationEndId);
    if (ctx.prevEndId) ids.add(ctx.prevEndId);
    for (const id of ctx.addAccountIds || []) ids.add(id);

    const drivers = {};
    const locations = {};
    const accounts = {};

    if (ids.size > 0) {
      const idList = [...ids].map((id) => `'${id}'`).join(',');
      try {
        const driverRows = await sf.query(`SELECT Id, Name FROM Driver__c WHERE Id IN (${idList})`);
        driverRows.forEach((d) => { drivers[d.Id] = d.Name; });
      } catch { /* driver lookup optional */ }

      try {
        const locRows = await sf.query(`SELECT Id, Name FROM Service_Location__c WHERE Id IN (${idList})`);
        locRows.forEach((l) => { locations[l.Id] = l.Name; });
      } catch { /* ignore */ }

      if (ctx.addAccountIds?.length) {
        const acctList = ctx.addAccountIds.map((id) => `'${id}'`).join(',');
        const acctRows = await sf.query(
          `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState FROM Account WHERE Id IN (${acctList})`,
        );
        acctRows.forEach((a) => {
          accounts[a.Id] = {
            name: a.Name,
            address: [a.ShippingStreet, a.ShippingCity, a.ShippingState].filter(Boolean).join(', '),
          };
        });
      }
    }

    const stopMap = Object.fromEntries((ctx.stops || []).map((s) => [s.Id, s]));

    return { drivers, locations, accounts, stopMap };
  }

  _buildChanges({ route, serviceDate, serviceLocationStartId, serviceLocationEndId, driverId, addAccountIds, removeStopIds, stops, names }) {
    const header = {};

    if (serviceDate && serviceDate !== route.Service_Date__c) {
      header.serviceDate = { from: route.Service_Date__c, to: serviceDate };
    }

    if (driverId !== undefined && driverId !== (route.Driver__c || '')) {
      header.driver = {
        from: route.Driver__c || null,
        fromName: names.drivers[route.Driver__c] || route.DriverName__c || 'Unassigned',
        to: driverId || null,
        toName: driverId ? (names.drivers[driverId] || driverId) : 'Unassigned',
      };
    }

    if (serviceLocationStartId && serviceLocationStartId !== route.Service_Location_Start__c) {
      header.serviceLocationStart = {
        from: route.Service_Location_Start__c,
        fromName: names.locations[route.Service_Location_Start__c] || 'None',
        to: serviceLocationStartId,
        toName: names.locations[serviceLocationStartId] || serviceLocationStartId,
      };
    }

    if (serviceLocationEndId && serviceLocationEndId !== route.Service_Location_End__c) {
      header.serviceLocationEnd = {
        from: route.Service_Location_End__c,
        fromName: names.locations[route.Service_Location_End__c] || 'None',
        to: serviceLocationEndId,
        toName: names.locations[serviceLocationEndId] || serviceLocationEndId,
      };
    }

    const removeSet = new Set(removeStopIds || []);
    const removeStops = stops
      .filter((s) => removeSet.has(s.Id))
      .map((s) => ({
        stopId: s.Id,
        accountId: s.AccountId__c,
        accountName: s.Account_Name__c,
        priority: s.Priority__c,
        address: s.Container_Address__c,
      }));

    const onRouteAccounts = new Set(stops.map((s) => s.AccountId__c).filter(Boolean));
    const addStops = (addAccountIds || [])
      .filter((id) => !onRouteAccounts.has(id))
      .map((id) => ({
        accountId: id,
        accountName: names.accounts[id]?.name || id,
        address: names.accounts[id]?.address || '',
      }));

    return { header, addStops, removeStops };
  }

  _hasChanges(changes) {
    const h = changes.header || {};
    return Boolean(
      h.serviceDate || h.driver || h.serviceLocationStart || h.serviceLocationEnd
      || changes.addStops?.length || changes.removeStops?.length,
    );
  }

  _validate({ stops, changes, removeStopIds, addAccountIds }) {
    const stopIds = new Set(stops.map((s) => s.Id));
    for (const id of removeStopIds || []) {
      if (!stopIds.has(id)) return `Stop ${id} is not on this route.`;
    }
    const remaining = stops.length - (changes.removeStops?.length || 0) + (changes.addStops?.length || 0);
    if (remaining < 1 && (removeStopIds?.length || addAccountIds?.length)) {
      return 'Cannot remove all stops from a route.';
    }
    return null;
  }
}

module.exports = RouteEditProposalSkill;
