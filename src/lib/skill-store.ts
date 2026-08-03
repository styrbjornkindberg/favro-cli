/**
 * Skill Store — Discovery, Loading, and Persistence for Skills
 *
 * Skills are YAML files stored in two locations:
 * - Built-in:  <projectRoot>/skills/builtin/  (shipped with CLI)
 * - User:      ~/.favro/skills/               (user-created)
 *
 * Each skill is a single YAML file named <skillName>.yaml.
 *
 * EVERY DECLINE HERE IS A `RefusalError` (#118). A name nothing matches, a file
 * that will not parse, a step with no command, a name that is really a path —
 * all deterministic: the same call reads the same bytes and declines the same
 * way. As bare `Error`s they had no HTTP response for `classifyThrownError` to
 * name, so `isRetryable` read them as transient and the CLI told an agent to
 * repeat `favro skill run <typo>`. Visible since #118, when the skill commands
 * adopted the runner and its error envelope.
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { configDir } from './config';
import { RefusalError } from './refusal';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillVariable {
  prompt: string;
  default?: string;
}

export interface SkillStep {
  command: string;
  args?: Record<string, string>;
  confirm?: boolean;
  /** If true, continue even if this step fails */
  continueOnError?: boolean;
  /**
   * Capture this step's STRUCTURED result under this name, for a later step to
   * read as `{{<name>.<field>}}`. Without it the result is display output only.
   */
  as?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  triggers?: string[];
  steps: SkillStep[];
  variables?: Record<string, SkillVariable>;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: 'builtin' | 'user';
  path: string;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * User skills directory. Resolved per call, not at import: a frozen constant
 * ignored FAVRO_CONFIG_DIR entirely, so tests wrote into the developer's real
 * ~/.favro/skills (issue #65, same class of bug as config.ts).
 */
function userSkillsDir(): string {
  return path.join(configDir(), 'skills');
}

function getBuiltinSkillsDir(): string {
  // Resolve relative to this file — works in both src/ and dist/
  return path.resolve(__dirname, '..', '..', 'skills', 'builtin');
}

// ─── Store ────────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * List all available skills (builtin + user).
 * User skills override builtin skills of the same name.
 */
export function listSkills(): SkillInfo[] {
  const skills = new Map<string, SkillInfo>();

  // Load built-in skills first
  const builtinDir = getBuiltinSkillsDir();
  if (fs.existsSync(builtinDir)) {
    for (const file of fs.readdirSync(builtinDir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const name = file.replace(/\.ya?ml$/, '');
      const fullPath = path.join(builtinDir, file);
      try {
        const def = loadSkillFromFile(fullPath);
        skills.set(name, {
          name: def.name,
          description: def.description,
          source: 'builtin',
          path: fullPath,
        });
      } catch {
        // Skip invalid files
      }
    }
  }

  // Load user skills (override builtin)
  if (fs.existsSync(userSkillsDir())) {
    for (const file of fs.readdirSync(userSkillsDir())) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const name = file.replace(/\.ya?ml$/, '');
      const fullPath = path.join(userSkillsDir(), file);
      try {
        const def = loadSkillFromFile(fullPath);
        skills.set(name, {
          name: def.name,
          description: def.description,
          source: 'user',
          path: fullPath,
        });
      } catch {
        // Skip invalid files
      }
    }
  }

  return Array.from(skills.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load a skill by name. Checks user dir first, then builtin.
 */
export function loadSkill(name: string): SkillDefinition {
  // Check user skills first
  const userPath = path.join(userSkillsDir(), `${name}.yaml`);
  if (fs.existsSync(userPath)) {
    return loadSkillFromFile(userPath);
  }

  // Check builtin
  const builtinPath = path.join(getBuiltinSkillsDir(), `${name}.yaml`);
  if (fs.existsSync(builtinPath)) {
    return loadSkillFromFile(builtinPath);
  }

  throw new RefusalError(`Skill not found: "${name}"\n  Run \`favro skill list\` to see available skills.`);
}

/**
 * Load and validate a skill from a YAML file path.
 */
export function loadSkillFromFile(filePath: string): SkillDefinition {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);

  if (!parsed || typeof parsed !== 'object') {
    throw new RefusalError(`Invalid skill file: ${filePath}`);
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new RefusalError(`Skill missing "name" field: ${filePath}`);
  }
  if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new RefusalError(`Skill missing "steps" array: ${filePath}`);
  }

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    if (!step.command || typeof step.command !== 'string') {
      throw new RefusalError(`Step ${i + 1} missing "command" in skill "${parsed.name}"`);
    }
  }

  return {
    name: parsed.name,
    description: parsed.description ?? '',
    triggers: parsed.triggers,
    steps: parsed.steps.map((s: any) => ({
      command: s.command,
      args: s.args,
      confirm: s.confirm ?? false,
      continueOnError: s.continueOnError ?? false,
      ...(s.as ? { as: s.as } : {}),
    })),
    variables: parsed.variables,
  };
}

/**
 * Save a skill definition to the user skills directory.
 */
export function saveSkill(skill: SkillDefinition): string {
  ensureDir(userSkillsDir());
  const filePath = path.join(userSkillsDir(), `${skill.name}.yaml`);

  const yamlContent = stringifyYaml({
    name: skill.name,
    description: skill.description,
    ...(skill.triggers?.length ? { triggers: skill.triggers } : {}),
    steps: skill.steps.map(s => ({
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      ...(s.confirm ? { confirm: true } : {}),
      ...(s.continueOnError ? { continueOnError: true } : {}),
      ...(s.as ? { as: s.as } : {}),
    })),
    ...(skill.variables ? { variables: skill.variables } : {}),
  });

  fs.writeFileSync(filePath, yamlContent, 'utf-8');
  return filePath;
}

/**
 * Delete a user skill by name. Cannot delete builtin skills.
 */
export function deleteSkill(name: string): void {
  const userPath = path.join(userSkillsDir(), `${name}.yaml`);
  if (!fs.existsSync(userPath)) {
    throw new RefusalError(`User skill not found: "${name}". Only user skills can be deleted.`);
  }
  fs.unlinkSync(userPath);
}

/**
 * Export a skill as YAML string.
 */
export function exportSkill(name: string): string {
  const skill = loadSkill(name);
  return stringifyYaml(skill);
}

/**
 * Import a skill from a YAML string (e.g., from file or URL).
 */
export function importSkill(yamlContent: string): SkillDefinition {
  const parsed = parseYaml(yamlContent);
  if (!parsed?.name || !parsed?.steps?.length) {
    throw new RefusalError('Invalid skill YAML: missing "name" or "steps".');
  }

  const skill: SkillDefinition = {
    name: parsed.name,
    description: parsed.description ?? '',
    triggers: parsed.triggers,
    steps: parsed.steps.map((s: any) => ({
      command: s.command,
      args: s.args,
      confirm: s.confirm ?? false,
      continueOnError: s.continueOnError ?? false,
      ...(s.as ? { as: s.as } : {}),
    })),
    variables: parsed.variables,
  };

  saveSkill(skill);
  return skill;
}

/**
 * Get the user skills directory path (for opening in editor, etc.)
 */
export function getUserSkillsDir(): string {
  return userSkillsDir();
}

/**
 * Get the path to a specific skill file (user or builtin).
 */
export function getSkillPath(name: string): string {
  // A skill name is a filename, never a path. `path.join` collapses `..`, so
  // `skill edit ../../outside/target` used to resolve outside the skills dir —
  // dormant while the editor never opened, live the moment #129 made it open,
  // and reachable from `favro_run` where the name comes from model output.
  // Refuse the whole shape rather than doing path math on it.
  if (name.includes('/') || name.includes('\\') || name === '..') {
    throw new RefusalError(`Invalid skill name: "${name}". A skill name is a filename, not a path.`);
  }
  const userPath = path.join(userSkillsDir(), `${name}.yaml`);
  if (fs.existsSync(userPath)) return userPath;

  const builtinPath = path.join(getBuiltinSkillsDir(), `${name}.yaml`);
  if (fs.existsSync(builtinPath)) return builtinPath;

  throw new RefusalError(`Skill not found: "${name}"`);
}
