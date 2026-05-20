const logger = require('../utils/logger');
const { logErrorToSalesforce } = require('../services/errorLogger');

/** Centralized Express error handler — logs to Salesforce then responds. */
function errorHandler(err, req, res, _next) {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });

  logErrorToSalesforce({
    errorType: err.name || 'UnhandledError',
    errorMessage: err.message,
    stackTrace: err.stack,
    source: `${req.method} ${req.originalUrl}`,
    requestBody: req.body ? JSON.stringify(req.body).substring(0, 30000) : null,
    userInfo: req.driver?.Name || req.driver?.Email__c || 'unknown',
  });

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
}

module.exports = { errorHandler };
