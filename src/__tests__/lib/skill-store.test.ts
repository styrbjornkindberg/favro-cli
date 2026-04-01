/**
 * Tests for skill-store.ts
 * Skill loading, saving, listing, import/export
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse as parseYaml } from 'yaml';
import {
  listSkills,
  loadSkill,
  loadSkillFromFile,
  saveSkill,
  exportSkill,
  importSkill,
  deleteSkill,
  SkillDefinition,
} from '../../lib/skill-store';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const TEST_SKILLS_DIR = path.join(os.tmpdir(), `favro-test-skills-${Date.now()}`);

function writeTestSkillFile(dir: string, filename: string, content: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const VALID_SKILL_YAML = `
name: test-skill
description: A test skill
triggers:
  - manual
steps:
  - command: standup
    args:
      board: "{{board}}"
  - command: query
    args:
      board: "{{board}}"
      query: "status:done"
    continueOnError: true
variables:
  board:
    prompt: "Which board?"
    default: my-board
`;

const MINIMAL_SKILL_YAML = `
name: minimal
description: ""
steps:
  - command: context
    args:
      board: test
`;

afterAll(() => {
  // Cleanup test directory
  if (fs.existsSync(TEST_SKILLS_DIR)) {
    fs.rmSync(TEST_SKILLS_DIR, { recursive: true, force: true });
  }
});

// ─── loadSkillFromFile Tests ──────────────────────────────────────────────────

describe('loadSkillFromFile', () => {
  test('loads a valid skill YAML file', () => {
    const filePath = writeTestSkillFile(TEST_SKILLS_DIR, 'valid.yaml', VALID_SKILL_YAML);
    const skill = loadSkillFromFile(filePath);

    expect(skill.name).toBe('test-skill');
    expect(skill.description).toBe('A test skill');
    expect(skill.triggers).toEqual(['manual']);
    expect(skill.steps).toHaveLength(2);
    expect(skill.steps[0].command).toBe('standup');
    expect(skill.steps[0].args?.board).toBe('{{board}}');
    expect(skill.steps[1].continueOnError).toBe(true);
    expect(skill.variables?.board?.prompt).toBe('Which board?');
    expect(skill.variables?.board?.default).toBe('my-board');
  });

  test('loads a minimal skill file', () => {
    const filePath = writeTestSkillFile(TEST_SKILLS_DIR, 'minimal.yaml', MINIMAL_SKILL_YAML);
    const skill = loadSkillFromFile(filePath);

    expect(skill.name).toBe('minimal');
    expect(skill.steps).toHaveLength(1);
  });

  test('throws on missing name', () => {
    const content = 'steps:\n  - command: context';
    const filePath = writeTestSkillFile(TEST_SKILLS_DIR, 'no-name.yaml', content);
    expect(() => loadSkillFromFile(filePath)).toThrow('missing "name"');
  });

  test('throws on missing steps', () => {
    const content = 'name: no-steps\ndescription: test';
    const filePath = writeTestSkillFile(TEST_SKILLS_DIR, 'no-steps.yaml', content);
    expect(() => loadSkillFromFile(filePath)).toThrow('missing "steps"');
  });

  test('throws on empty steps array', () => {
    const content = 'name: empty-steps\nsteps: []';
    const filePath = writeTestSkillFile(TEST_SKILLS_DIR, 'empty-steps.yaml', content);
    expect(() => loadSkillFromFile(filePath)).toThrow('missing "steps"');
  });

  test('throws on step missing command', () => {
    const content = 'name: bad-step\nsteps:\n  - args:\n      board: test';
    const filePath = writeTestSkillFile(TEST_SKILLS_DIR, 'bad-step.yaml', content);
    expect(() => loadSkillFromFile(filePath)).toThrow('missing "command"');
  });

  test('throws on invalid YAML content', () => {
    const filePath = writeTestSkillFile(TEST_SKILLS_DIR, 'invalid.yaml', 'just a string');
    expect(() => loadSkillFromFile(filePath)).toThrow();
  });
});

// ─── saveSkill Tests ──────────────────────────────────────────────────────────

describe('saveSkill', () => {
  test('saves a skill and creates valid YAML', () => {
    const skill: SkillDefinition = {
      name: 'save-test',
      description: 'Test saving',
      steps: [
        { command: 'standup', args: { board: 'test-board' } },
      ],
    };

    const filePath = saveSkill(skill);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content);
    expect(parsed.name).toBe('save-test');
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].command).toBe('standup');
  });
});

// ─── listSkills / Built-in Skills Tests ───────────────────────────────────────

describe('listSkills', () => {
  test('returns an array of skill info objects', () => {
    const skills = listSkills();
    expect(Array.isArray(skills)).toBe(true);
    // Should at least have the builtin skills
    expect(skills.length).toBeGreaterThanOrEqual(5);
  });

  test('includes builtin skills', () => {
    const skills = listSkills();
    const names = skills.map(s => s.name);
    expect(names).toContain('daily-digest');
    expect(names).toContain('triage');
    expect(names).toContain('sprint-close');
    expect(names).toContain('stale-cleanup');
    expect(names).toContain('release-prep');
  });

  test('builtin skills have correct source', () => {
    const skills = listSkills();
    const builtin = skills.filter(s => s.source === 'builtin');
    expect(builtin.length).toBeGreaterThanOrEqual(5);
    for (const s of builtin) {
      expect(s.description).toBeTruthy();
      expect(s.path).toBeTruthy();
    }
  });
});

// ─── loadSkill (by name) Tests ────────────────────────────────────────────────

describe('loadSkill', () => {
  test('loads a builtin skill by name', () => {
    const skill = loadSkill('daily-digest');
    expect(skill.name).toBe('daily-digest');
    expect(skill.steps.length).toBeGreaterThanOrEqual(1);
  });

  test('throws for non-existent skill', () => {
    expect(() => loadSkill('does-not-exist-xyz')).toThrow('Skill not found');
  });
});

// ─── exportSkill Tests ────────────────────────────────────────────────────────

describe('exportSkill', () => {
  test('exports a skill as valid YAML string', () => {
    const yaml = exportSkill('daily-digest');
    expect(typeof yaml).toBe('string');
    const parsed = parseYaml(yaml);
    expect(parsed.name).toBe('daily-digest');
    expect(parsed.steps).toBeDefined();
  });
});

// ─── importSkill Tests ────────────────────────────────────────────────────────

describe('importSkill', () => {
  test('imports a valid YAML skill', () => {
    const yaml = `
name: imported-test-${Date.now()}
description: Imported skill
steps:
  - command: standup
    args:
      board: test
`;
    const skill = importSkill(yaml);
    expect(skill.name).toContain('imported-test');
    expect(skill.steps).toHaveLength(1);

    // Clean up
    try { deleteSkill(skill.name); } catch { /* already deleted */ }
  });

  test('throws on invalid YAML', () => {
    expect(() => importSkill('name: test\nsteps: not-an-array')).toThrow();
  });
});
