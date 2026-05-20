const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'routing-ai-default-secret';

/** Validates either API key (server-to-server) or JWT (client session). */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = header.replace('Bearer ', '');
  const apiKey = process.env.API_KEY;

  if (apiKey && token === apiKey) {
    req.authType = 'apikey';
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.driver = decoded;
    req.authType = 'jwt';
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Middleware that only allows JWT-authenticated drivers. */
function requireDriver(req, res, next) {
  if (req.authType !== 'jwt' || !req.driver) {
    return res.status(403).json({ error: 'Driver authentication required' });
  }
  next();
}

module.exports = { authMiddleware, requireDriver, JWT_SECRET };
