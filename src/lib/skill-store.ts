/**
 * Skill Store — Discovery, Loading, and Persistence for Skills
 *
 * Skills are YAML files stored in two locations:
 * - Built-in:  <projectRoot>/skills/builtin/  (shipped with CLI)
 * - User:      ~/.favro/skills/               (user-created)
 *
 * Each skill is a single YAML file named <skillName>.yaml.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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

const USER_SKILLS_DIR = path.join(os.homedir(), '.favro', 'skills');

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
  if (fs.existsSync(USER_SKILLS_DIR)) {
    for (const file of fs.readdirSync(USER_SKILLS_DIR)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const name = file.replace(/\.ya?ml$/, '');
      const fullPath = path.join(USER_SKILLS_DIR, file);
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
  const userPath = path.join(USER_SKILLS_DIR, `${name}.yaml`);
  if (fs.existsSync(userPath)) {
    return loadSkillFromFile(userPath);
  }

  // Check builtin
  const builtinPath = path.join(getBuiltinSkillsDir(), `${name}.yaml`);
  if (fs.existsSync(builtinPath)) {
    return loadSkillFromFile(builtinPath);
  }

  throw new Error(`Skill not found: "${name}"\n  Run \`favro skill list\` to see available skills.`);
}

/**
 * Load and validate a skill from a YAML file path.
 */
export function loadSkillFromFile(filePath: string): SkillDefinition {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid skill file: ${filePath}`);
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Skill missing "name" field: ${filePath}`);
  }
  if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`Skill missing "steps" array: ${filePath}`);
  }

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    if (!step.command || typeof step.command !== 'string') {
      throw new Error(`Step ${i + 1} missing "command" in skill "${parsed.name}"`);
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
    })),
    variables: parsed.variables,
  };
}

/**
 * Save a skill definition to the user skills directory.
 */
export function saveSkill(skill: SkillDefinition): string {
  ensureDir(USER_SKILLS_DIR);
  const filePath = path.join(USER_SKILLS_DIR, `${skill.name}.yaml`);

  const yamlContent = stringifyYaml({
    name: skill.name,
    description: skill.description,
    ...(skill.triggers?.length ? { triggers: skill.triggers } : {}),
    steps: skill.steps.map(s => ({
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      ...(s.confirm ? { confirm: true } : {}),
      ...(s.continueOnError ? { continueOnError: true } : {}),
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
  const userPath = path.join(USER_SKILLS_DIR, `${name}.yaml`);
  if (!fs.existsSync(userPath)) {
    throw new Error(`User skill not found: "${name}". Only user skills can be deleted.`);
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
    throw new Error('Invalid skill YAML: missing "name" or "steps".');
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
  return USER_SKILLS_DIR;
}

/**
 * Get the path to a specific skill file (user or builtin).
 */
export function getSkillPath(name: string): string {
  const userPath = path.join(USER_SKILLS_DIR, `${name}.yaml`);
  if (fs.existsSync(userPath)) return userPath;

  const builtinPath = path.join(getBuiltinSkillsDir(), `${name}.yaml`);
  if (fs.existsSync(builtinPath)) return builtinPath;

  throw new Error(`Skill not found: "${name}"`);
}
