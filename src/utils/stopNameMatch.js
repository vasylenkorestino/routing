/** Normalizes a string for fuzzy account/stop name matching. */
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches route stops by account name (Route__c.Account_Name__c).
 * Returns resolved stops or ambiguity/error details.
 */
function matchStopsByAccountNames(stops, nameQueries) {
  const resolved = [];
  const ambiguous = [];
  const notFound = [];

  for (const rawQuery of nameQueries || []) {
    const query = normalizeName(rawQuery);
    if (!query) continue;

    const matches = (stops || []).filter((stop) => {
      const name = normalizeName(stop.Account_Name__c);
      if (!name) return false;
      return name.includes(query) || query.includes(name)
        || name.split(' ').some((word) => word.length > 2 && query.includes(word));
    });

    if (matches.length === 1) {
      resolved.push({ query: rawQuery, stop: matches[0] });
    } else if (matches.length > 1) {
      ambiguous.push({
        query: rawQuery,
        matches: matches.map((s) => ({
          stopId: s.Id,
          accountId: s.AccountId__c,
          accountName: s.Account_Name__c,
          priority: s.Priority__c,
        })),
      });
    } else {
      notFound.push(rawQuery);
    }
  }

  return { resolved, ambiguous, notFound };
}

module.exports = { normalizeName, matchStopsByAccountNames };
