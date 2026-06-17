const fs = require('fs');
const path = require('path');

let cached = null;

/** Minimal YAML loader for persona.yaml (no external deps). */
function parseSimpleYaml(text) {
  const result = { values: [] };
  let listKey = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('- ')) {
      if (listKey) result[listKey].push(trimmed.slice(2).trim());
      continue;
    }
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!val) {
      listKey = key;
      result[key] = [];
    } else {
      result[key] = val;
      listKey = null;
    }
  }
  return result;
}

/** Loads agent persona from persona.yaml. */
function loadPersona() {
  if (cached) return cached;
  const filePath = path.join(__dirname, 'persona.yaml');
  try {
    cached = parseSimpleYaml(fs.readFileSync(filePath, 'utf8'));
  } catch {
    cached = { name: 'RoutePilot', role: 'UCO routing analyst', values: [] };
  }
  return cached;
}

module.exports = { loadPersona };
