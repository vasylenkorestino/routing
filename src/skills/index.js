const SalesforceQuerySkill = require('./salesforceQuery');
const RouteAnalysisSkill = require('./routeAnalysis');
const AccountDiscoverySkill = require('./accountDiscovery');
const RouteEnhancementSkill = require('./routeEnhancement');
const RouteGenerationSkill = require('./routeGeneration');
const RouteParametersSkill = require('./routeParameters');
const GeoUtilsSkill = require('./geoUtils');
const RouteLoggerSkill = require('./routeLogger');
const AccountRouteHistorySkill = require('./accountRouteHistory');
const MultiRouteContextSkill = require('./multiRouteContext');
const CompareRoutesSkill = require('./compareRoutes');
const AgentMemorySkill = require('./memory/agentMemory');

/** Central skill registry. Loads all skills and provides lookup by name. */
class SkillRegistry {
  constructor() {
    this.skills = new Map();
    this._registerDefaults();
  }

  _registerDefaults() {
    const defaults = [
      new SalesforceQuerySkill(),
      new RouteAnalysisSkill(),
      new AccountDiscoverySkill(),
      new RouteEnhancementSkill(),
      new RouteParametersSkill(),
      new GeoUtilsSkill(),
      new RouteLoggerSkill(),
      new RouteGenerationSkill(),
      new AccountRouteHistorySkill(),
      new MultiRouteContextSkill(),
      new CompareRoutesSkill(),
      new AgentMemorySkill(),
    ];
    for (const skill of defaults) {
      this.register(skill);
    }
  }

  register(skill) {
    this.skills.set(skill.name, skill);
  }

  get(name) {
    return this.skills.get(name);
  }

  /** Returns Anthropic tool definitions for all or named skills. */
  getToolDefinitions(toolNames) {
    const all = Array.from(this.skills.values());
    if (!toolNames?.length) return all.map((s) => s.toToolDefinition());
    return all.filter((s) => toolNames.includes(s.name)).map((s) => s.toToolDefinition());
  }

  /** Executes a skill by name with the given params. */
  async execute(name, params) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill.execute(params);
  }
}

module.exports = new SkillRegistry();
