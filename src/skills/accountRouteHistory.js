const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/** Looks up Route__c, RouteLog__c, and RouteLogComment__c for an account to analyze routing history and feedback patterns. */
class AccountRouteHistorySkill extends BaseSkill {
  constructor() {
    super({
      name: 'account_route_history',
      description:
        'Look up all Route__c records for an Account, then find related RouteLog__c and RouteLogComment__c records. ' +
        'Analyzes patterns in AI recommendations, human feedback, and discussion threads to inform future routing decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: {
            type: 'string',
            description: 'The Salesforce Account Id to analyze.',
          },
        },
        required: ['accountId'],
      },
    });
  }

  async execute({ accountId }) {
    const routeStops = await sf.query(
      `SELECT Id, Google_Route_Id__c, Account_Name__c, Priority__c, ServiceType__c,
              Gallons_Collected__c, Is_Full__c, Notes__c, CreatedDate
       FROM Route__c
       WHERE AccountId__c = '${accountId}'
       ORDER BY CreatedDate DESC LIMIT 200`
    );

    const routeLogs = await sf.query(
      `SELECT Id, Name, Google_Route__c, Reason__c, Confidence__c, Status__c,
              Type__c, Skill__c, Accepted_By__c, Accepted_Date__c, CreatedDate
       FROM RouteLog__c
       WHERE Account__c = '${accountId}'
       ORDER BY CreatedDate DESC LIMIT 100`
    );

    const logIds = routeLogs.map((l) => l.Id);
    let comments = [];
    if (logIds.length > 0) {
      const idList = logIds.map((id) => `'${id}'`).join(',');
      comments = await sf.query(
        `SELECT Id, Route_Log__c, Body__c, Author__c, Is_AI__c, Parent_Comment__c, CreatedDate
         FROM RouteLogComment__c
         WHERE Route_Log__c IN (${idList})
         ORDER BY CreatedDate ASC`
      );
    }

    const commentsByLog = {};
    for (const c of comments) {
      const lid = c.Route_Log__c;
      if (!commentsByLog[lid]) commentsByLog[lid] = [];
      commentsByLog[lid].push({
        author: c.Author__c,
        isAI: c.Is_AI__c,
        body: c.Body__c,
        date: c.CreatedDate,
      });
    }

    const statusCounts = { Proposed: 0, Accepted: 0, Declined: 0 };
    for (const l of routeLogs) {
      if (statusCounts[l.Status__c] !== undefined) statusCounts[l.Status__c]++;
    }

    const uniqueRoutes = new Set(routeStops.map((r) => r.Google_Route_Id__c).filter(Boolean));

    return {
      accountId,
      summary: {
        totalRouteStops: routeStops.length,
        uniqueRoutes: uniqueRoutes.size,
        totalLogs: routeLogs.length,
        totalComments: comments.length,
        logStatusBreakdown: statusCounts,
      },
      recentStops: routeStops.slice(0, 20).map((r) => ({
        id: r.Id,
        routeId: r.Google_Route_Id__c,
        name: r.Account_Name__c,
        priority: r.Priority__c,
        serviceType: r.ServiceType__c,
        gallons: r.Gallons_Collected__c,
        isFull: r.Is_Full__c,
        notes: r.Notes__c,
        date: r.CreatedDate,
      })),
      logs: routeLogs.map((l) => ({
        id: l.Id,
        name: l.Name,
        routeId: l.Google_Route__c,
        reason: l.Reason__c,
        confidence: l.Confidence__c,
        status: l.Status__c,
        type: l.Type__c,
        skill: l.Skill__c,
        acceptedBy: l.Accepted_By__c,
        acceptedDate: l.Accepted_Date__c,
        date: l.CreatedDate,
        comments: commentsByLog[l.Id] || [],
      })),
    };
  }
}

module.exports = AccountRouteHistorySkill;
