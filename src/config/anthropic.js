module.exports = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
  maxTokens: 8192,
  agentId: process.env.AGENT_ID || 'routepilot-v1',
  memory: {
    sessionTtlMs: 24 * 60 * 60 * 1000,
    maxRecalledMemories: 20,
    maxActivePerScope: 50,
    unusedArchiveDays: 90,
    reflectionMinFeedbackEvents: 10,
    reflectionMaxEventsPerRun: 100,
    contradictionConfidencePenalty: 25,
    contradictionDeactivateThreshold: 30,
  },
};
