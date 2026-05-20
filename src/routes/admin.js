const { Router } = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getConnection: getSalesforceConnection } = require('../services/salesforce');
const logger = require('../utils/logger');

const INVITE_DAYS = 7;
const router = Router();

/** Only allow requests from admin users (JWT with isAdmin === true) */
function requireAdmin(req, res, next) {
  if (req.authType !== 'jwt' || !req.driver?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/** Generates a cryptographically random 64-char hex token */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function inviteExpiry() {
  return new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

router.use(requireAdmin);

/** GET /api/admin/users — list all RoutingUser__c records */
router.get('/users', async (req, res, next) => {
  try {
    const conn = await getSalesforceConnection();
    const result = await conn.query(
      `SELECT Id, Name, Name__c, First_Name__c, Last_Name__c, Email__c, isAdmin__c, Status__c,
              Password_Hash__c, Invite_Token__c, Invite_Expires__c, CreatedDate
       FROM RoutingUser__c ORDER BY Last_Name__c ASC NULLS LAST`
    );
    const clientUrl = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const users = result.records.map((u) => ({
      ...u,
      isRegistered: !!u.Password_Hash__c,
      inviteLink: u.Invite_Token__c ? `${clientUrl}/register?token=${u.Invite_Token__c}` : null,
      inviteExpired: u.Invite_Expires__c ? new Date(u.Invite_Expires__c) < new Date() : true,
      Password_Hash__c: undefined,
      Invite_Token__c: undefined,
    }));
    res.json(users);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/users — create a new RoutingUser__c */
router.post('/users', async (req, res, next) => {
  try {
    const { firstName, lastName, email, isAdmin, status, password } = req.body;
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'First name, last name, and email are required' });
    }

    const conn = await getSalesforceConnection();

    const dup = await conn.query(
      `SELECT Id FROM RoutingUser__c WHERE Email__c = '${email.replace(/'/g, "\\'")}' LIMIT 1`
    );
    if (dup.totalSize > 0) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    const token = generateToken();
    const record = {
      First_Name__c: firstName,
      Last_Name__c: lastName,
      Email__c: email,
      isAdmin__c: isAdmin || false,
      Status__c: status || 'Active',
      Invite_Token__c: token,
      Invite_Expires__c: inviteExpiry(),
    };

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      record.Password_Hash__c = await bcrypt.hash(password, 12);
      record.Invite_Token__c = null;
      record.Invite_Expires__c = null;
    }

    const created = await conn.sobject('RoutingUser__c').create(record);
    logger.info(`Admin ${req.driver.email} created user ${email} (${created.id})`);

    const clientUrl = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const registrationLink = password ? null : `${clientUrl}/register?token=${token}`;

    if (!password) {
      try {
        const userName = [firstName, lastName].filter(Boolean).join(' ');
        const emailBody = `Hello${userName ? ' ' + userName : ''},\n\n` +
          'You have been invited to the UCO Routing System.\n\n' +
          'Please click the link below to set your password and complete registration:\n\n' +
          registrationLink + '\n\n' +
          `This link expires in ${INVITE_DAYS} days.\n\n` +
          'If you did not expect this email, please ignore it.\n\n' +
          'UCO Routing Team';

        await conn.request({
          method: 'POST',
          url: '/services/data/v61.0/actions/standard/emailSimple',
          body: JSON.stringify({
            inputs: [{
              emailBody,
              emailSubject: 'UCO Routing System - Complete Your Registration',
              emailAddresses: email,
              senderType: 'CurrentUser',
            }],
          }),
          headers: { 'Content-Type': 'application/json' },
        });
        logger.info(`Registration invite email sent to ${email}`);
      } catch (emailErr) {
        logger.error('Failed to send invite email', { error: emailErr.message });
      }
    }

    res.json({ id: created.id, registrationLink, success: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/users/:id/regenerate-invite — generate a new invite token */
router.post('/users/:id/regenerate-invite', async (req, res, next) => {
  try {
    const { id } = req.params;
    const conn = await getSalesforceConnection();

    const result = await conn.query(
      `SELECT Id, Email__c, Name__c, Password_Hash__c FROM RoutingUser__c WHERE Id = '${id}' LIMIT 1`
    );
    const user = result.records[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.Password_Hash__c) {
      return res.status(400).json({ error: 'User already registered. Use "Reset Password" instead.' });
    }

    const token = generateToken();
    const expires = inviteExpiry();
    await conn.sobject('RoutingUser__c').update({
      Id: id,
      Invite_Token__c: token,
      Invite_Expires__c: expires,
    });

    const clientUrl = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const registrationLink = `${clientUrl}/register?token=${token}`;

    try {
      const emailBody = `Hello${user.Name__c ? ' ' + user.Name__c : ''},\n\n` +
        'A new registration link has been generated for your UCO Routing System account.\n\n' +
        'Please click the link below to set your password:\n\n' +
        registrationLink + '\n\n' +
        `This link expires in ${INVITE_DAYS} days.\n\n` +
        'UCO Routing Team';

      await conn.request({
        method: 'POST',
        url: '/services/data/v61.0/actions/standard/emailSimple',
        body: JSON.stringify({
          inputs: [{
            emailBody,
            emailSubject: 'UCO Routing System - New Registration Link',
            emailAddresses: user.Email__c,
            senderType: 'CurrentUser',
          }],
        }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (emailErr) {
      logger.error('Failed to send invite email', { error: emailErr.message });
    }

    logger.info(`Admin ${req.driver.email} regenerated invite for ${user.Email__c}`);
    res.json({ registrationLink, success: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/users/:id/reset-password — admin resets a user's password */
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    const conn = await getSalesforceConnection();
    const result = await conn.query(
      `SELECT Id, Email__c, Name__c FROM RoutingUser__c WHERE Id = '${id}' LIMIT 1`
    );
    const user = result.records[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      const hash = await bcrypt.hash(password, 12);
      await conn.sobject('RoutingUser__c').update({ Id: id, Password_Hash__c: hash });
      logger.info(`Admin ${req.driver.email} reset password for ${user.Email__c} (manual)`);
      return res.json({ success: true, method: 'manual' });
    }

    const token = generateToken();
    const expires = inviteExpiry();
    await conn.sobject('RoutingUser__c').update({
      Id: id,
      Invite_Token__c: token,
      Invite_Expires__c: expires,
      Password_Hash__c: null,
    });

    const clientUrl = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const registrationLink = `${clientUrl}/register?token=${token}`;

    try {
      const emailBody = `Hello${user.Name__c ? ' ' + user.Name__c : ''},\n\n` +
        'Your password has been reset by an administrator.\n\n' +
        'Please click the link below to set a new password:\n\n' +
        registrationLink + '\n\n' +
        `This link expires in ${INVITE_DAYS} days.\n\n` +
        'UCO Routing Team';

      await conn.request({
        method: 'POST',
        url: '/services/data/v61.0/actions/standard/emailSimple',
        body: JSON.stringify({
          inputs: [{
            emailBody,
            emailSubject: 'UCO Routing System - Password Reset',
            emailAddresses: user.Email__c,
            senderType: 'CurrentUser',
          }],
        }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (emailErr) {
      logger.error('Failed to send reset email', { error: emailErr.message });
    }

    logger.info(`Admin ${req.driver.email} reset password for ${user.Email__c} (link)`);
    res.json({ registrationLink, success: true, method: 'link' });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/users/:id — update a RoutingUser__c */
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, email, isAdmin, status, password } = req.body;
    const conn = await getSalesforceConnection();

    const update = { Id: id };
    if (firstName !== undefined) update.First_Name__c = firstName;
    if (lastName !== undefined) update.Last_Name__c = lastName;
    if (email !== undefined) update.Email__c = email;
    if (isAdmin !== undefined) update.isAdmin__c = isAdmin;
    if (status !== undefined) update.Status__c = status;
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      update.Password_Hash__c = await bcrypt.hash(password, 12);
    }

    await conn.sobject('RoutingUser__c').update(update);
    logger.info(`Admin ${req.driver.email} updated user ${id}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/admin/users/:id — delete a RoutingUser__c */
router.delete('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (id === req.driver.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const conn = await getSalesforceConnection();
    await conn.sobject('RoutingUser__c').destroy(id);
    logger.info(`Admin ${req.driver.email} deleted user ${id}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
