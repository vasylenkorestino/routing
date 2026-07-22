const { ROUTE_EDIT_PATTERN } = require('./routeEditPrefetch');

const IMPERATIVE_EDIT_PATTERN = /\b(please\s+)?(remove|delete|drop|take off|take out|add|insert|assign|change|move|set|update|unassign|go ahead|do it now)\b/i;
const QUESTION_START_PATTERN = /^\s*(why|what|how|when|who|which|can you explain|tell me|is there|are there|did you|was|were)\b/i;
const QUESTION_PATTERN = /\b(why|what|how|explain|when did|who|which|tell me|is there|are there|did you|was|were|can you explain)\b/i;
const HISTORY_PATTERN = /\b(histor|past|usual|typically|before|last time|previous|compare)\b/i;
const REDESIGN_PATTERN = /\b(rebuild|redesign|recreate|from scratch|split route|combine routes|merge routes|optimize entire|full redesign)\b/i;
const EXPLORATORY_PATTERN = /\b(should (i|we)|what if|recommend|suggest|what would|ideas? for|options? for|help me plan)\b/i;
/** Along-route / between-stops discovery — needs corridor candidates, not bare route_edit_simple. */
const CORRIDOR_PATTERN = /\b(along the way|on the way|in[\s-]?between|between (the )?(first|last|stops?|stop \d)|nearby|near (the )?(route|path|stops?)|fill the gap|stops? that may need|need service (in[\s-]?)?between|around (stop|the route))\b/i;
/** User wants the map centered on an account (named or the last proposed one). */
const MAP_FOCUS_PATTERN = /\b(show (it |them |that |this )?(on (the )?map)|show on (the )?map|center (on|the map)|zoom (to|in on)|locate|find on (the )?map|pan to|where (is|on the map))\b/i;

/** True when the user is asking for an edit to be applied (not merely asking about one). */
function isDirectEditCommand(message) {
  const msg = message || '';
  if (QUESTION_START_PATTERN.test(msg)) return false;
  return IMPERATIVE_EDIT_PATTERN.test(msg) || (ROUTE_EDIT_PATTERN.test(msg) && !QUESTION_PATTERN.test(msg));
}

/**
 * Classifies chat intent to pick tools, data loading, and approval behavior.
 * @returns {{ mode, tier, needsApproval, loadHistory, usePrefetch, routeId }}
 */
function classifyChatIntent(message, context) {
  const msg = message || '';
  const routeId = context?.routeId || context?.routes?.[0]?.routeId || null;
  const hasRoute = !!routeId;

  if (context?.multiRoute && Array.isArray(context.routes) && context.routes.length > 1) {
    return {
      mode: 'multi_route',
      tier: 'redesign',
      needsApproval: true,
      loadHistory: true,
      usePrefetch: false,
      routeId,
    };
  }

  // Map focus works with or without a selected route (uses name or recentFocusCandidates).
  if (MAP_FOCUS_PATTERN.test(msg)) {
    return {
      mode: 'map_focus',
      tier: 'map_focus',
      needsApproval: false,
      loadHistory: false,
      usePrefetch: false,
      routeId,
    };
  }

  if (!hasRoute) {
    return {
      mode: 'qa',
      tier: 'question',
      needsApproval: false,
      loadHistory: false,
      usePrefetch: false,
      routeId: null,
    };
  }

  const directEdit = isDirectEditCommand(msg);
  const isQuestion = QUESTION_PATTERN.test(msg) && !directEdit;

  if (REDESIGN_PATTERN.test(msg)) {
    return {
      mode: 'route_redesign',
      tier: 'redesign',
      needsApproval: true,
      loadHistory: true,
      usePrefetch: false,
      routeId,
    };
  }

  // Corridor / along-the-way discovery before simple-edit so "stops between…" is not trapped by ROUTE_EDIT_PATTERN.
  if (CORRIDOR_PATTERN.test(msg)) {
    return {
      mode: 'route_edit_plan',
      tier: 'exploratory',
      needsApproval: true,
      loadHistory: false,
      usePrefetch: false,
      routeId,
    };
  }

  if (EXPLORATORY_PATTERN.test(msg) && !directEdit) {
    return {
      mode: 'route_edit_plan',
      tier: 'exploratory',
      needsApproval: false,
      loadHistory: true,
      usePrefetch: true,
      routeId,
    };
  }

  if (isQuestion) {
    return {
      mode: 'qa',
      tier: 'question',
      needsApproval: false,
      loadHistory: HISTORY_PATTERN.test(msg),
      usePrefetch: false,
      routeId,
    };
  }

  if (directEdit) {
    return {
      mode: 'route_edit_simple',
      tier: 'actionable',
      needsApproval: true,
      loadHistory: HISTORY_PATTERN.test(msg),
      usePrefetch: false,
      routeId,
    };
  }

  return {
    mode: 'general',
    tier: 'general',
    needsApproval: false,
    loadHistory: HISTORY_PATTERN.test(msg),
    usePrefetch: false,
    routeId,
  };
}

module.exports = { classifyChatIntent, isDirectEditCommand };
