const logger = require('../utils/logger');
const { getConnection } = require('./salesforce');

/**
 * Logs an error to the Routing_Error_Log__c Salesforce object.
 * Fires asynchronously and never throws.
 */
async function logErrorToSalesforce({ errorType, errorMessage, stackTrace, source, requestBody, userInfo, googleRouteId }) {
  try {
    const conn = await getConnection();
    await conn.sobject('Routing_Error_Log__c').create({
      Error_Type__c: (errorType || '').substring(0, 255),
      Error_Message__c: (errorMessage || '').substring(0, 32000),
      Stack_Trace__c: (stackTrace || '').substring(0, 32000),
      Source__c: (source || '').substring(0, 255),
      Request_Body__c: (requestBody || '').substring(0, 32000),
      User_Info__c: (userInfo || '').substring(0, 255),
      Severity__c: 'Error',
      ...(googleRouteId ? { Google_Route__c: googleRouteId } : {}),
    });
    logger.info('[errorLogger] Error logged to Salesforce');
  } catch (err) {
    logger.error('[errorLogger] Failed to log to SF:', err.message);
  }
}

module.exports = { logErrorToSalesforce };
