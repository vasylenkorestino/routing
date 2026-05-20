const jsforce = require('jsforce');
const sfConfig = require('../config/salesforce');
const logger = require('../utils/logger');

let connection = null;

/** Returns an authenticated jsforce connection, reusing the existing one if still valid. */
async function getConnection() {
  if (connection && connection.accessToken) {
    try {
      await connection.identity();
      return connection;
    } catch {
      logger.info('Salesforce session expired, re-authenticating');
      connection = null;
    }
  }

  connection = new jsforce.Connection({ loginUrl: sfConfig.loginUrl });

  await connection.login(sfConfig.username, sfConfig.password);
  logger.info('Salesforce authenticated', { user: sfConfig.username });

  return connection;
}

/** Executes a SOQL query and returns all records. */
async function query(soql) {
  const conn = await getConnection();
  logger.info('SOQL query', { soql: soql.substring(0, 200) });
  const result = await conn.query(soql);

  if (result.totalSize > 2000 && !result.done) {
    let records = result.records;
    let nextRecordsUrl = result.nextRecordsUrl;
    while (nextRecordsUrl) {
      const more = await conn.queryMore(nextRecordsUrl);
      records = records.concat(more.records);
      nextRecordsUrl = more.nextRecordsUrl;
    }
    return records;
  }

  return result.records;
}

/** Inserts records into Salesforce. */
async function insert(sObjectName, records) {
  const conn = await getConnection();
  logger.info('Inserting records', { sObjectName, count: records.length });
  const results = await conn.sobject(sObjectName).create(records);
  return Array.isArray(results) ? results : [results];
}

/** Updates records in Salesforce. */
async function update(sObjectName, records) {
  const conn = await getConnection();
  logger.info('Updating records', { sObjectName, count: records.length });
  const results = await conn.sobject(sObjectName).update(records);
  return Array.isArray(results) ? results : [results];
}

/** Retrieves a single record by Id. */
async function retrieve(sObjectName, id) {
  const conn = await getConnection();
  return conn.sobject(sObjectName).retrieve(id);
}

module.exports = { getConnection, query, insert, update, retrieve };
