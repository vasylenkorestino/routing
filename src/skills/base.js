/** Abstract base class for all agent skills. Each skill maps to an Anthropic tool. */
class BaseSkill {
  constructor({ name, description, inputSchema }) {
    if (new.target === BaseSkill) {
      throw new Error('BaseSkill is abstract and cannot be instantiated directly');
    }
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
  }

  /** Returns the Anthropic tool definition for this skill. */
  toToolDefinition() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema,
    };
  }

  /** Execute the skill with validated params. Must be overridden by subclasses. */
  async execute(_params) {
    throw new Error(`execute() not implemented in ${this.name}`);
  }
}

module.exports = BaseSkill;
