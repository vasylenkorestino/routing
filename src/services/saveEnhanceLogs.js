/**
 * Upserts AI Enhance RouteLog__c rows without creating duplicates per account.
 * Proposed logs get Reason/Confidence refreshed; Accepted/Declined are skipped.
 */

/** Builds the Salesforce fields for one enhance recommendation. */
function buildLogFields(rec) {
  return {
    Type__c: rec.action === 'add' ? 'Account Recommended' : (rec.action === 'keep' ? 'Account Added' : 'Account Recommended'),
    Reason__c: `[${(rec.action || '').toUpperCase()}] ${rec.accountName || ''}: ${rec.reason || ''}`,
    Confidence__c: (rec.confidence || 0) / 100,
  };
}

/**
 * Saves enhance recommendations to RouteLog__c with account-level dedupe.
 * @returns {Promise<object[]>} allRecs enriched with logId / logName
 */
async function saveEnhanceLogs(conn, googleRouteId, allRecs, recorder) {
  if (!allRecs.length) return [];

  const accountIds = [...new Set(allRecs.map((r) => r.accountId).filter(Boolean))];
  const existingByAccount = {};

  if (accountIds.length) {
    const ids = accountIds.map((id) => `'${id}'`).join(',');
    const query = `
      SELECT Id, Name, Account__c, Status__c
      FROM RouteLog__c
      WHERE Google_Route__c = '${googleRouteId}'
        AND Skill__c = 'AI Enhance'
        AND Account__c IN (${ids})
      ORDER BY CreatedDate DESC
    `;
    const run = () => conn.query(query);
    const result = recorder
      ? await recorder.wrap('Load Existing RouteLogs', 'SOQL', run, { input: { count: accountIds.length } })
      : await run();

    for (const log of result.records || []) {
      const prev = existingByAccount[log.Account__c];
      // Prefer an open Proposed log when duplicates already exist.
      if (!prev || (prev.Status__c !== 'Proposed' && log.Status__c === 'Proposed')) {
        existingByAccount[log.Account__c] = log;
      }
    }
  }

  const toCreate = [];
  const toUpdate = [];
  const byAccount = {};

  for (const rec of allRecs) {
    const fields = buildLogFields(rec);
    const existing = rec.accountId ? existingByAccount[rec.accountId] : null;

    if (existing) {
      if (existing.Status__c === 'Proposed') {
        toUpdate.push({ Id: existing.Id, ...fields });
        byAccount[rec.accountId] = { Id: existing.Id, Name: existing.Name };
      } else {
        // Decision already made — skip creating a new log.
        byAccount[rec.accountId] = { Id: existing.Id, Name: existing.Name, skipped: true };
      }
      continue;
    }

    const record = {
      Google_Route__c: googleRouteId,
      Account__c: rec.accountId || null,
      ...fields,
      Status__c: 'Proposed',
      Skill__c: 'AI Enhance',
    };
    toCreate.push({ rec, record });
  }

  if (toUpdate.length) {
    const run = () => conn.sobject('RouteLog__c').update(toUpdate);
    if (recorder) {
      await recorder.wrap('Update RouteLogs', 'Skill', run, { input: { count: toUpdate.length } });
    } else {
      await run();
    }
  }

  if (toCreate.length) {
    const payload = toCreate.map((c) => c.record);
    const run = () => conn.sobject('RouteLog__c').create(payload);
    const created = recorder
      ? await recorder.wrap('Create RouteLogs', 'Skill', run, { input: { count: payload.length } })
      : await run();

    const results = Array.isArray(created) ? created : [created];
    const newIds = results.map((r) => r.id || r.Id).filter(Boolean);

    if (newIds.length) {
      const ids = newIds.map((id) => `'${id}'`).join(',');
      const logResult = await conn.query(
        `SELECT Id, Name, Account__c FROM RouteLog__c WHERE Id IN (${ids})`,
      );
      for (const log of logResult.records || []) {
        if (log.Account__c) byAccount[log.Account__c] = { Id: log.Id, Name: log.Name };
      }
      // Fallback by create order when Account__c is missing.
      toCreate.forEach((c, i) => {
        const id = newIds[i];
        if (!c.rec.accountId && id) {
          const saved = (logResult.records || []).find((r) => r.Id === id);
          if (saved) byAccount[`__idx_${i}`] = { Id: saved.Id, Name: saved.Name };
        }
      });
    }
  }

  return allRecs.map((rec, i) => {
    const saved = rec.accountId
      ? byAccount[rec.accountId]
      : byAccount[`__idx_${i}`];
    return {
      ...rec,
      logId: saved?.Id || null,
      logName: saved?.Name || null,
      _skipped: !!saved?.skipped,
    };
  });
}

module.exports = { saveEnhanceLogs, buildLogFields };
