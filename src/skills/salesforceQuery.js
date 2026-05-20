const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/** Executes parameterized SOQL queries against Salesforce. */
class SalesforceQuerySkill extends BaseSkill {
  constructor() {
    super({
      name: 'salesforce_query',
      description:
        'Execute a SOQL query against Salesforce to retrieve data. ' +
        'Available objects: Google_Route__c (routes), Route__c (stops/points), Account, Case (tickets), ' +
        'Shape__c (zones), Service__c (services), Service_Location__c (depots), Driver__c, RouteLog__c. ' +
        'A completed route has CompletionStatus__c = "Completed" OR Driver_Completed__c = true. ' +
        'Route__c is a child of Google_Route__c via GRoute_Id__c (master-detail). ' +
        'Account coordinates are in MALatitude__c and MALongitude__c. ' +
        'Account.Expected_Date_Of_Service__c = Last_Service_Date__c + Pickup_Frequency_in_Days__c.',
      inputSchema: {
        type: 'object',
        properties: {
          soql: {
            type: 'string',
            description: 'The SOQL query to execute. Use proper Salesforce SOQL syntax.',
          },
        },
        required: ['soql'],
      },
    });
  }

  async execute({ soql }) {
    const records = await sf.query(soql);
    return {
      totalSize: records.length,
      records: records.slice(0, 200),
      truncated: records.length > 200,
    };
  }
}

module.exports = SalesforceQuerySkill;
