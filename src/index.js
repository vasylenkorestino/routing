require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { authMiddleware } = require('./middleware/auth');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const enhanceRoutes = require('./routes/enhance');
const generateRoutes = require('./routes/generate');
const chatRoutes = require('./routes/chat');
const routingRoutes = require('./routes/routing');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const notificationRoutes = require('./routes/notifications');
const aiJobRoutes = require('./routes/aiJobs');
const { runReflectionJob } = require('./agent/learning/reflectionJob');
const { queueLength } = require('./agent/learning/feedbackObserver');
const anthropicConfig = require('./config/anthropic');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);

app.use('/api', (req, res, next) => {
  if (req.path === '/notifications/stream') return next();
  return authMiddleware(req, res, next);
});
app.use('/api/webhooks', webhookRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/ai-jobs', aiJobRoutes);
app.use('/api/enhance-route', enhanceRoutes);
app.use('/api/generate-routes', generateRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/routing', routingRoutes);
app.use('/api/admin', adminRoutes);

const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`Routing AI Agent running on port ${PORT}`);

  const reflectionIntervalMs = Number(process.env.REFLECTION_INTERVAL_MS || 6 * 60 * 60 * 1000);
  const reflectionTimer = setInterval(async () => {
    try {
      const minEvents = anthropicConfig.memory?.reflectionMinFeedbackEvents || 10;
      if (queueLength() < minEvents) return;
      const result = await runReflectionJob();
      logger.info('[reflectionJob] scheduled run complete', result);
    } catch (err) {
      logger.error('[reflectionJob] scheduled run failed', { error: err.message });
    }
  }, reflectionIntervalMs);
  if (reflectionTimer.unref) reflectionTimer.unref();
});

module.exports = app;
