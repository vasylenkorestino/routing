const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Derives a 32-byte key from JWT_SECRET using SHA-256 */
function getKey() {
  const secret = process.env.JWT_SECRET || 'routing-ai-default-secret';
  return crypto.createHash('sha256').update(secret).digest();
}

/** Encrypt a JSON-serializable payload into a URL-safe base64 string */
function encrypt(payload) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/** Decrypt a token back into the original payload. Returns null if invalid. */
function decrypt(token) {
  try {
    const key = getKey();
    const buf = Buffer.from(token, 'base64url');
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
