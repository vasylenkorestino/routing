const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '../../../.data/memory');
const DATA_FILE = path.join(DATA_DIR, 'memories.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
}

function readAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(list) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function upsert(record) {
  const list = readAll();
  const entry = { id: randomUUID(), ...record, isActive: true, createdAt: Date.now() };
  list.push(entry);
  writeAll(list);
  return entry;
}

function query({ scopeIds = [], yardId, limit = 20 }) {
  const list = readAll().filter((m) => m.isActive !== false);
  const scoped = list.filter((m) => {
    if (m.scope === 'global') return true;
    if (m.scope === 'account' && scopeIds.includes(m.scopeId)) return true;
    if (m.scope === 'service_location' && yardId && m.scopeId === yardId) return true;
    return false;
  });
  return scoped.slice(0, limit).map((m) => ({
    Id: m.id,
    Summary__c: m.summary,
    Content__c: m.content,
    Category__c: m.category,
    Confidence__c: (m.confidence ?? 80) / 100,
    Scope__c: m.scope,
    Tags__c: m.tags,
  }));
}

module.exports = { upsert, query };
