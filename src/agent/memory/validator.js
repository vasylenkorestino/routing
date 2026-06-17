const aiDataPolicy = require('../../utils/aiDataPolicy');

/** Validates memory content before storage. */
function validateMemoryContent(input) {
  return aiDataPolicy.validateMemoryContent(input);
}

/** Sanitizes and validates memory for persistence. */
function sanitizeMemoryForStorage(input) {
  return aiDataPolicy.sanitizeMemoryForStorage(input);
}

module.exports = { validateMemoryContent, sanitizeMemoryForStorage };
