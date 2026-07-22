const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/**
 * Resolves an account (by Id or name) and returns coordinates so the client can
 * pan/zoom the map. Does not change Salesforce data.
 */
class MapFocusSkill extends BaseSkill {
  constructor() {
    super({
      name: 'map_focus',
      description:
        'Show / center the map on an account. Call when the user asks to show something on the map, ' +
        'zoom to, locate, or pan to an account. Prefer accountId when known; otherwise accountName. ' +
        'If the user says "show on the map" without a name, use recentFocusCandidates from context ' +
        '(most recently proposed add) or the last named account in the conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Salesforce Account Id when known.' },
          accountName: {
            type: 'string',
            description: 'Account name to resolve via LIKE search when Id is unknown.',
          },
        },
      },
    });
  }

  async execute(input = {}) {
    const accountId = String(input.accountId || '').trim();
    const accountName = String(input.accountName || '').trim();

    if (accountId) {
      const row = await this._byId(accountId);
      if (!row) return { error: 'Account not found', accountId };
      return this._payload(row);
    }

    if (!accountName) {
      return {
        error: 'Provide accountId or accountName (or pick from recentFocusCandidates in context).',
      };
    }

    const term = accountName.replace(/'/g, "\\'");
    const rows = await sf.query(
      `SELECT Id, Name, MALatitude__c, MALongitude__c, ShippingStreet, ShippingCity, ShippingState ` +
      `FROM Account WHERE Name LIKE '%${term}%' AND MALatitude__c != null AND MALongitude__c != null ` +
      `ORDER BY Name LIMIT 5`,
    );

    if (!rows.length) return { error: `No account with coordinates matching "${accountName}"`, accountName };
    if (rows.length > 1) {
      return {
        error: 'Multiple accounts match — ask the user to clarify.',
        ambiguous: rows.map((r) => ({ id: r.Id, name: r.Name })),
      };
    }
    return this._payload(rows[0]);
  }

  async _byId(id) {
    const rows = await sf.query(
      `SELECT Id, Name, MALatitude__c, MALongitude__c, ShippingStreet, ShippingCity, ShippingState ` +
      `FROM Account WHERE Id = '${id}' LIMIT 1`,
    );
    return rows[0] || null;
  }

  _payload(row) {
    const lat = Number(row.MALatitude__c);
    const lng = Number(row.MALongitude__c);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      return { error: 'Account has no map coordinates', accountId: row.Id, accountName: row.Name };
    }
    return {
      mapFocus: true,
      accountId: row.Id,
      accountName: row.Name,
      lat,
      lng,
      address: [row.ShippingStreet, row.ShippingCity, row.ShippingState].filter(Boolean).join(', '),
    };
  }
}

module.exports = MapFocusSkill;
