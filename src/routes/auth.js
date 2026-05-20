const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { getConnection: getSalesforceConnection } = require('../services/salesforce');
const { encrypt, decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const INVITE_DAYS = 7;
const router = Router();

/** POST /api/auth/login */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const conn = await getSalesforceConnection();
    const result = await conn.query(
      `SELECT Id, Name, Email__c, Password_Hash__c, Name__c, isAdmin__c, Status__c
       FROM RoutingUser__c WHERE Email__c = '${email.replace(/'/g, "\\'")}' LIMIT 1`
    );

    if (result.totalSize === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.records[0];
    if (user.Status__c === 'Inactive') {
      return res.status(401).json({ error: 'Account is inactive. Contact admin.' });
    }
    if (!user.Password_Hash__c) {
      return res.status(401).json({ error: 'Account not registered. Check your email for the registration link.' });
    }

    const valid = await bcrypt.compare(password, user.Password_Hash__c);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const fullName = user.Name__c || user.Name;

    const token = jwt.sign(
      {
        userId: user.Id,
        driverId: user.Id,
        email: user.Email__c,
        name: fullName,
        isAdmin: user.isAdmin__c || false,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      driver: {
        id: user.Id,
        name: fullName,
        email: user.Email__c,
        isAdmin: user.isAdmin__c || false,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/auth/resolve-invite?token= — look up invite token in SF to show email */
router.get('/resolve-invite', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const conn = await getSalesforceConnection();
    const result = await conn.query(
      `SELECT Id, Email__c, Invite_Expires__c FROM RoutingUser__c WHERE Invite_Token__c = '${token.replace(/'/g, "\\'")}' LIMIT 1`
    );

    if (result.totalSize === 0) {
      return res.status(400).json({ error: 'Invalid or expired invitation link' });
    }

    const user = result.records[0];
    if (user.Invite_Expires__c && new Date(user.Invite_Expires__c) < new Date()) {
      return res.status(400).json({ error: 'Invitation link has expired. Please contact your admin.' });
    }

    res.json({ email: user.Email__c });
  } catch (err) {
    res.status(400).json({ error: 'Invalid invitation link' });
  }
});

/** POST /api/auth/register — set password using invite token stored in SF */
router.post('/register', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const conn = await getSalesforceConnection();
    const result = await conn.query(
      `SELECT Id, Email__c, Password_Hash__c, Invite_Expires__c FROM RoutingUser__c WHERE Invite_Token__c = '${token.replace(/'/g, "\\'")}' LIMIT 1`
    );
    const user = result.records[0];

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired invitation link' });
    }
    if (user.Invite_Expires__c && new Date(user.Invite_Expires__c) < new Date()) {
      return res.status(400).json({ error: 'Invitation link has expired. Please contact your admin.' });
    }
    if (user.Password_Hash__c) {
      return res.status(400).json({ error: 'Account already registered. Use login or forgot password.' });
    }

    const hash = await bcrypt.hash(password, 12);
    await conn.sobject('RoutingUser__c').update({
      Id: user.Id,
      Password_Hash__c: hash,
      Invite_Token__c: null,
      Invite_Expires__c: null,
    });

    logger.info(`Registration complete for ${user.Email__c} (${user.Id})`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/forgot-password — send reset link via email (encrypted, stateless) */
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const conn = await getSalesforceConnection();
    const result = await conn.query(
      `SELECT Id, Email__c, Name__c FROM RoutingUser__c WHERE Email__c = '${email.replace(/'/g, "\\'")}' AND Status__c = 'Active' LIMIT 1`
    );

    if (result.totalSize === 0) {
      return res.json({ success: true });
    }

    const user = result.records[0];
    const resetToken = encrypt({ userId: user.Id, email: user.Email__c, exp: Date.now() + 60 * 60 * 1000 });

    const clientUrl = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const link = `${clientUrl}/reset-password?token=${resetToken}`;

    const body = `Hello${user.Name__c ? ' ' + user.Name__c : ''},\n\n` +
      `We received a request to reset your password for the UCO Routing System.\n\n` +
      `Click the link below to set a new password (valid for 1 hour):\n\n${link}\n\n` +
      `If you did not request this, please ignore this email.\n\nUCO Routing Team`;

    await conn.request({
      method: 'POST',
      url: '/services/data/v61.0/actions/standard/emailSimple',
      body: JSON.stringify({
        inputs: [{
          emailBody: body,
          emailSubject: 'UCO Routing - Password Reset',
          emailAddresses: user.Email__c,
          senderType: 'CurrentUser',
        }],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    logger.info(`Password reset email sent to ${user.Email__c}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Forgot password error', { error: err.message });
    res.json({ success: true });
  }
});

/** POST /api/auth/reset-password — set new password with encrypted reset token */
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const payload = decrypt(token);
    if (!payload || !payload.userId || !payload.email) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }
    if (payload.exp && Date.now() > payload.exp) {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }

    const conn = await getSalesforceConnection();
    const result = await conn.query(
      `SELECT Id FROM RoutingUser__c WHERE Id = '${payload.userId}' AND Email__c = '${payload.email.replace(/'/g, "\\'")}' LIMIT 1`
    );
    if (result.totalSize === 0) {
      return res.status(400).json({ error: 'Invalid reset link' });
    }

    const hash = await bcrypt.hash(password, 12);
    await conn.sobject('RoutingUser__c').update({ Id: payload.userId, Password_Hash__c: hash });

    logger.info(`Password reset complete for ${payload.email} (${payload.userId})`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** GET /api/auth/me — current user info from JWT */
const { authMiddleware } = require('../middleware/auth');
router.get('/me', authMiddleware, (req, res) => {
  if (!req.driver) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ driver: req.driver });
});

module.exports = router;
