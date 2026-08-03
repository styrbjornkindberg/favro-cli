/**
 * `favro skill edit` against a REAL child process (#129).
 *
 * WHY A SECOND FILE
 * `skill.test.ts` mocks `child_process` wholesale, so it can assert the argv and
 * the `stdio` option but cannot prove the spawn works — a mock will happily
 * accept `stdio: 'inherit'` on a call shape that has no such option, which is
 * exactly how the original bug survived. So this file mocks nothing: real
 * `spawnSync`, a real skill file under a temp `FAVRO_CONFIG_DIR`, and a real
 * one-line `sh` "editor" that appends to the file it is handed.
 *
 * WHAT IT PROVES
 * The child runs, receives the resolved skill path as its last argument, and is
 * WAITED FOR — the assertion reads the file straight after the action resolves,
 * and the editor sleeps first, so a non-blocking launch fails it. Both are what
 * `exec` got wrong.
 *
 * WHAT IT DOES NOT PROVE
 * That the editor gets a TTY. Jest's own stdio is not a terminal, so `inherit`
 * here inherits a pipe. `stdio: 'inherit'` is pinned by `skill.test.ts` instead;
 * verified by hand under a pty on a real `vi`.
 */
import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerSkillCommands } from '../../commands/skill';

const SKILL_YAML = 'name: e2e\ndescription: round trip\nsteps: []\n';
const EDITED = '# edited by the fake editor\n';

let tmpDir: string;
let editorPath: string;
let skillPath: string;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;
const savedEnv = {
  FAVRO_CONFIG_DIR: process.env.FAVRO_CONFIG_DIR,
  EDITOR: process.env.EDITOR,
  VISUAL: process.env.VISUAL,
};

/**
 * `--human` puts the failure message on stderr through `logError`; without it
 * the runner's default is JSON and the same message arrives on stdout as
 * `{error:{message, retryable}}` (#118). The assertions below read stderr, so
 * they ask for the human mode.
 */
async function runEdit(name: string): Promise<void> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerSkillCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', '--human', 'skill', 'edit', name]);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-skill-edit-'));
  fs.mkdirSync(path.join(tmpDir, 'skills'));
  skillPath = path.join(tmpDir, 'skills', 'e2e.yaml');
  fs.writeFileSync(skillPath, SKILL_YAML, 'utf-8');

  // The sleep is the point: it makes "did the parent wait?" observable.
  editorPath = path.join(tmpDir, 'fake-editor.sh');
  fs.writeFileSync(editorPath, `#!/bin/sh\nsleep 0.3\nprintf '%s' '${EDITED}' >> "$1"\n`, 'utf-8');
  fs.chmodSync(editorPath, 0o755);

  process.env.FAVRO_CONFIG_DIR = tmpDir;
  process.env.EDITOR = editorPath;
  delete process.env.VISUAL;

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  // The runner sets `process.exitCode` and never hard-exits (#118).
  process.exitCode = undefined;
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
});

afterEach(() => {
  process.exitCode = undefined;
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('the editor really runs, gets the skill path, and the command waits for it', async () => {
  await runEdit('e2e');

  // Read immediately: the editor sleeps 300ms before writing, so this only
  // holds if the command blocked on the child rather than firing and forgetting.
  expect(fs.readFileSync(skillPath, 'utf-8')).toBe(SKILL_YAML + EDITED);
  expect(exitSpy).not.toHaveBeenCalled();
  // ADR-0002: a successful command prints something. The editor has repainted
  // the terminal by now, so it has to be the CLOSING line, not just `Opening`.
  expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(`✓ Closed ${skillPath}`);
});

test('$EDITOR arguments reach the editor as separate argv entries', async () => {
  // `$1` is now the flag, `$2` the file — an editor invoked as one long
  // executable name would not find either.
  fs.writeFileSync(editorPath, `#!/bin/sh\ntest "$1" = "--wait" || exit 9\nprintf '%s' '${EDITED}' >> "$2"\n`, 'utf-8');
  fs.chmodSync(editorPath, 0o755);
  process.env.EDITOR = `${editorPath} --wait`;

  await runEdit('e2e');

  expect(fs.readFileSync(skillPath, 'utf-8')).toBe(SKILL_YAML + EDITED);
  expect(exitSpy).not.toHaveBeenCalled();
});

test('a non-zero editor exit fails the command and leaves the file untouched by favro', async () => {
  fs.writeFileSync(editorPath, '#!/bin/sh\nexit 4\n', 'utf-8');
  fs.chmodSync(editorPath, 0o755);

  await runEdit('e2e');

  expect(fs.readFileSync(skillPath, 'utf-8')).toBe(SKILL_YAML);
  expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('exited with code 4');
  expect(process.exitCode).toBe(1);
});

test('an editor binary that does not exist is reported rather than hanging', async () => {
  process.env.EDITOR = path.join(tmpDir, 'not-an-editor');

  await runEdit('e2e');

  expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('not-an-editor');
  expect(process.exitCode).toBe(1);
});

test('no editor configured refuses without spawning anything', async () => {
  delete process.env.EDITOR;
  delete process.env.VISUAL;

  await runEdit('e2e');

  expect(fs.readFileSync(skillPath, 'utf-8')).toBe(SKILL_YAML);
  const errs = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
  expect(errs).toContain('EDITOR');
  expect(errs).toContain('VISUAL');
  expect(process.exitCode).toBe(1);
});
