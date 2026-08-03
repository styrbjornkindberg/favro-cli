/**
 * `favro skill list|run|create|edit|export|import|delete|record|stop` (#100).
 *
 * Two things carry real logic here. One is `skill run`'s rollback advice: a
 * skill run is ONE transaction, and the sentence it prints must read from
 * `retryable` — a clean unwind around a deterministic refusal is undone AND not
 * worth repeating, and re-deriving that from the outcome said the opposite
 * (#66). The other is the recording state machine, which is module-level
 * mutable state shared between `record`, `recordStep` and `stop`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before any require that might touch the real ~/.favro — the runner reads the
// config before every handler now (#118), and `jest.mock('fs')` below does not
// cover `fs/promises`, which is what `readConfig` uses.
process.env.FAVRO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'favro-skill-'));

import { Command } from 'commander';
import { registerSkillCommands, isRecording, recordStep } from '../../commands/skill';
import * as store from '../../lib/skill-store';
import * as engine from '../../lib/skill-engine';
import { spawnSync } from 'child_process';
import fs from 'fs';

jest.mock('../../lib/skill-store');
jest.mock('../../lib/skill-engine');
jest.mock('fs');
jest.mock('child_process');

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

/**
 * `--human` and `--pretty` are root flags the runner owns (ADR-0002); `cli.ts`
 * declares them on the real root and `resolveFormat` merges globals, so
 * declaring them on the parse root here is equivalent.
 *
 * JSON is now the DEFAULT, so a test that reads the human rendering has to ask
 * for it — the leaf `--json` these commands used to carry is gone (#118).
 */
async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerSkillCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', '--human', ...args]);
}

/** The same run without `--human`: the machine path, which is the default. */
async function runJson(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose');
  registerSkillCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
const spawnSyncMock = () => spawnSync as unknown as jest.Mock;

const runResult = (over: Partial<engine.SkillRunResult> = {}): engine.SkillRunResult => ({
  skill: 'standup',
  status: 'completed',
  steps: [{ step: 1, command: 'standup', status: 'success', output: 'two cards' }],
  ...over,
});

// `skill edit` reads them; leave the developer's own shell environment alone.
const savedEditorEnv = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL };

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // The runner sets `process.exitCode`; this spy proves it never reaches for
  // the hard exit, rather than steering control flow the way it used to.
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);

  (store.listSkills as jest.Mock).mockReturnValue([]);
  (store.loadSkill as jest.Mock).mockReturnValue({ name: 'standup', description: 'Daily standup', steps: [] });
  (store.saveSkill as jest.Mock).mockReturnValue('/home/me/.favro/skills/mine.yaml');
  (store.getSkillPath as jest.Mock).mockReturnValue('/home/me/.favro/skills/mine.yaml');
  (store.exportSkill as jest.Mock).mockReturnValue('name: standup\n');
  (store.importSkill as jest.Mock).mockReturnValue({ name: 'imported' });
  (engine.runSkill as jest.Mock).mockResolvedValue(runResult());
});

afterEach(() => {
  process.exitCode = undefined;
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEditorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('skill list', () => {
  test('tags each skill with its source and shows the description', async () => {
    (store.listSkills as jest.Mock).mockReturnValue([
      { name: 'standup', description: 'Daily standup', source: 'builtin' },
      { name: 'mine', description: 'My thing', source: 'user' },
    ]);

    await runCli(['skill', 'list']);

    expect(output()).toContain('Available skills (2):');
    expect(output()).toMatch(/\[builtin\]\s+standup\s+Daily standup/);
    expect(output()).toMatch(/\[user\]\s+mine\s+My thing/);
  });

  test('an empty list points at how to make one instead of printing nothing', async () => {
    await runCli(['skill', 'list']);

    expect(output()).toContain('favro skill create <name>');
  });

  test('the default emits the list in the envelope, like every other list read', async () => {
    (store.listSkills as jest.Mock).mockReturnValue([{ name: 'standup', description: 'd', source: 'builtin' }]);

    // No flag: JSON is the default now, and the leaf `--json` is gone (#118).
    await runJson(['skill', 'list']);

    // A local read rather than a Favro one, but one shape for an agent (#99).
    expect(JSON.parse(output())).toEqual({
      rows: [{ name: 'standup', description: 'd', source: 'builtin' }],
    });
  });
});

describe('skill run', () => {
  test('threads --board and each --var into the run as variables', async () => {
    await runCli(['skill', 'run', 'standup', '--board', 'board-a', '--var', 'sprint=42', '--var', 'who=alice']);

    expect(engine.runSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'standup' }),
      expect.objectContaining({ variables: { board: 'board-a', sprint: '42', who: 'alice' } }),
    );
  });

  test('a --var with no "=" is ignored rather than becoming an empty key', async () => {
    await runCli(['skill', 'run', 'standup', '--var', 'nonsense', '--var', '=novalue']);

    expect(engine.runSkill).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ variables: {} }),
    );
  });

  test('--dry-run and --force reach the engine', async () => {
    await runCli(['skill', 'run', 'standup', '--dry-run', '--force', '-y']);

    expect(engine.runSkill).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true, force: true, yes: true }),
    );
  });

  test('reports each step as it lands, then the completed tally', async () => {
    (engine.runSkill as jest.Mock).mockImplementation(async (_s: unknown, opts: engine.SkillRunOptions) => {
      opts.onStepComplete?.({ step: 1, command: 'standup', status: 'success', output: 'two cards' });
      opts.onStepComplete?.({ step: 2, command: 'next', status: 'skipped' });
      opts.onStepComplete?.({ step: 3, command: 'cards move', status: 'failed', error: 'out of scope' });
      return runResult({ status: 'partial', steps: [
        { step: 1, command: 'standup', status: 'success' },
        { step: 2, command: 'next', status: 'skipped' },
        { step: 3, command: 'cards move', status: 'failed' },
      ] });
    });

    await runCli(['skill', 'run', 'standup']);

    expect(output()).toContain('✓ Step 1: standup');
    expect(output()).toContain('two cards');
    expect(output()).toContain('⊘ Step 2: next');
    expect(output()).toContain('✗ Step 3: cards move');
    expect(errors()).toContain('Error: out of scope');
    expect(output()).toContain('Skill "standup" partial (1/3 steps)');
  });

  test('the machine mode suppresses the per-step chatter and emits the whole result', async () => {
    (engine.runSkill as jest.Mock).mockImplementation(async (_s: unknown, opts: engine.SkillRunOptions) => {
      opts.onStepComplete?.({ step: 1, command: 'standup', status: 'success', output: 'two cards' });
      return runResult();
    });

    // The default. The chatter is written AS THE RUN HAPPENS, so it cannot be
    // deferred into `human` — the handler reads the format and stays quiet.
    await runJson(['skill', 'run', 'standup']);

    expect(output()).not.toContain('✓ Step 1');
    expect(output()).not.toContain('Running skill:');
    const printed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{'))!);
    expect(printed.status).toBe('completed');
  });

  test('a clean unwind of a retryable failure invites a retry', async () => {
    (engine.runSkill as jest.Mock).mockResolvedValue(
      runResult({ status: 'failed', rollback: { outcome: 'rolled-back', retryable: true, orphans: [] } }),
    );

    await runCli(['skill', 'run', 'standup']);

    expect(output()).toContain('safe to retry');
    expect(process.exitCode).toBe(1);
  });

  test('a clean unwind of a DETERMINISTIC failure forbids one — the outcome alone cannot say this', async () => {
    (engine.runSkill as jest.Mock).mockResolvedValue(
      runResult({ status: 'failed', rollback: { outcome: 'rolled-back', retryable: false, orphans: [] } }),
    );

    await runCli(['skill', 'run', 'standup']);

    expect(errors()).toContain('Do NOT retry it unchanged.');
    expect(output()).not.toContain('safe to retry');
  });

  test('an incomplete rollback lists what it left behind', async () => {
    (engine.runSkill as jest.Mock).mockResolvedValue(
      runResult({
        status: 'failed',
        rollback: {
          outcome: 'rollback-incomplete',
          retryable: false,
          orphans: [{ reason: 'compensation-skipped: assignees on card-1' }] as never,
        },
      }),
    );

    await runCli(['skill', 'run', 'standup']);

    expect(errors()).toContain('Rollback incomplete — do NOT retry.');
    expect(errors()).toContain('- compensation-skipped: assignees on card-1');
  });

  test('an unknown skill exits 1 without running anything', async () => {
    (store.loadSkill as jest.Mock).mockImplementation(() => {
      throw new Error('Skill "ghost" not found');
    });

    await runCli(['skill', 'run', 'ghost']);

    expect(engine.runSkill).not.toHaveBeenCalled();
    expect(errors()).toContain('Skill "ghost" not found');
    expect(process.exitCode).toBe(1);
  });
});

describe('skill create / export / import / delete / edit', () => {
  test('create saves a runnable template and tells you how to run it', async () => {
    await runCli(['skill', 'create', 'mine', '--description', 'My thing']);

    expect(store.saveSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mine',
        description: 'My thing',
        triggers: ['manual'],
        steps: [{ command: 'standup', args: { board: '{{board}}' } }],
      }),
    );
    expect(output()).toContain('favro skill run mine --board <boardId>');
  });

  test('create defaults the description rather than leaving it blank', async () => {
    await runCli(['skill', 'create', 'mine']);

    expect(store.saveSkill).toHaveBeenCalledWith(expect.objectContaining({ description: 'Custom skill: mine' }));
  });

  test('export writes the YAML to stdout unadorned, so it can be piped', async () => {
    await runCli(['skill', 'export', 'standup']);

    expect(stdoutSpy).toHaveBeenCalledWith('name: standup\n');
    expect(output()).toBe('');
  });

  test('import reads the file and reports the name the store parsed out of it', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue('name: imported\n');

    await runCli(['skill', 'import', './imported.yaml']);

    expect(fs.readFileSync).toHaveBeenCalledWith('./imported.yaml', 'utf-8');
    expect(store.importSkill).toHaveBeenCalledWith('name: imported\n');
    expect(output()).toContain('✓ Skill imported: imported');
  });

  test('an unreadable import file exits 1', async () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    await runCli(['skill', 'import', './missing.yaml']);

    expect(store.importSkill).not.toHaveBeenCalled();
    expect(errors()).toContain('ENOENT');
    expect(process.exitCode).toBe(1);
  });

  test('delete removes the named skill', async () => {
    await runCli(['skill', 'delete', 'mine']);

    expect(store.deleteSkill).toHaveBeenCalledWith('mine');
    expect(output()).toContain('✓ Skill deleted: mine');
  });

  test('a failed delete exits 1 instead of claiming success', async () => {
    (store.deleteSkill as jest.Mock).mockImplementation(() => {
      throw new Error('builtin skills cannot be deleted');
    });

    await runCli(['skill', 'delete', 'standup']);

    expect(output()).not.toContain('✓ Skill deleted');
    expect(errors()).toContain('builtin skills cannot be deleted');
    expect(process.exitCode).toBe(1);
  });

  // ─── skill edit (#129) ──────────────────────────────────────────────────
  //
  // These assert the ARGUMENTS handed to `spawnSync`, because that is where the
  // bug lived: the old call was `exec(cmd, { stdio: 'inherit' } as any)`, and
  // `child_process.exec` has no `stdio` option — it buffered and handed the
  // child no TTY, so the editor never attached to the terminal. A test that
  // only checked "some child was started" would have passed against that.
  //
  // They do NOT prove the child really gets the terminal — a mocked
  // `child_process` cannot. `skill-edit-spawn.test.ts` runs the real thing.

  test('edit hands the editor the terminal and blocks until it exits', async () => {
    spawnSyncMock().mockReturnValue({ status: 0, signal: null });
    process.env.EDITOR = 'vi';

    await runCli(['skill', 'edit', 'mine']);

    expect(store.getSkillPath).toHaveBeenCalledWith('mine');
    expect(spawnSyncMock()).toHaveBeenCalledWith('vi', ['/home/me/.favro/skills/mine.yaml'], {
      stdio: 'inherit',
    });
    // Both lines, not just the opening one: the editor has repainted the
    // terminal by the time it exits, so the closing line is the one the user
    // is actually left looking at (ADR-0002).
    expect(output()).toContain('Opening /home/me/.favro/skills/mine.yaml');
    expect(output()).toContain('✓ Closed /home/me/.favro/skills/mine.yaml');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('edit never routes the editor through a shell', async () => {
    // `$EDITOR` is user-controlled, and the old `exec` form ran it through
    // `/bin/sh -c`. An argv spawn has no shell to inject into.
    spawnSyncMock().mockReturnValue({ status: 0, signal: null });
    process.env.EDITOR = 'vi; touch /tmp/pwned';

    await runCli(['skill', 'edit', 'mine']);

    const [bin, args, opts] = spawnSyncMock().mock.calls[0];
    expect(opts.shell).toBeFalsy();
    expect(bin).toBe('vi;');
    expect(args).toEqual(['touch', '/tmp/pwned', '/home/me/.favro/skills/mine.yaml']);
  });

  test('an $EDITOR carrying arguments is split into argv, not passed as one name', async () => {
    spawnSyncMock().mockReturnValue({ status: 0, signal: null });
    process.env.EDITOR = 'code --wait';

    await runCli(['skill', 'edit', 'mine']);

    expect(spawnSyncMock()).toHaveBeenCalledWith(
      'code',
      ['--wait', '/home/me/.favro/skills/mine.yaml'],
      { stdio: 'inherit' },
    );
  });

  test('$VISUAL is used when $EDITOR is unset', async () => {
    spawnSyncMock().mockReturnValue({ status: 0, signal: null });
    delete process.env.EDITOR;
    process.env.VISUAL = 'nano';

    await runCli(['skill', 'edit', 'mine']);

    expect(spawnSyncMock()).toHaveBeenCalledWith('nano', ['/home/me/.favro/skills/mine.yaml'], {
      stdio: 'inherit',
    });
  });

  test('$VISUAL wins when both are set', async () => {
    // The Unix convention (git, crontab, vipw, sensible-editor): VISUAL is the
    // full-screen editor, EDITOR the line-editor fallback. Nothing pinned the
    // order before, so swapping it passed the whole suite in either direction.
    spawnSyncMock().mockReturnValue({ status: 0, signal: null });
    process.env.VISUAL = 'nano';
    process.env.EDITOR = 'ed';

    await runCli(['skill', 'edit', 'mine']);

    expect(spawnSyncMock()).toHaveBeenCalledWith('nano', ['/home/me/.favro/skills/mine.yaml'], {
      stdio: 'inherit',
    });
  });

  test('an editor path containing a space stays one argument', async () => {
    // The macOS common case, not an exotic one. A plain whitespace split makes
    // `bin` `/Applications/My` and the spawn ENOENTs.
    spawnSyncMock().mockReturnValue({ status: 0, signal: null });
    process.env.EDITOR = '"/Applications/My Editor.app/bin/edit" --wait';

    await runCli(['skill', 'edit', 'mine']);

    expect(spawnSyncMock()).toHaveBeenCalledWith(
      '/Applications/My Editor.app/bin/edit',
      ['--wait', '/home/me/.favro/skills/mine.yaml'],
      { stdio: 'inherit' },
    );
  });

  test('a whitespace-only $EDITOR refuses rather than spawning nothing-shaped', async () => {
    spawnSyncMock().mockReturnValue({ status: 0, signal: null });
    process.env.EDITOR = '   ';
    delete process.env.VISUAL;

    await runCli(['skill', 'edit', 'mine']);

    expect(spawnSyncMock()).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('with no editor configured it refuses by name rather than guessing one', async () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;

    await runCli(['skill', 'edit', 'mine']);

    expect(spawnSyncMock()).not.toHaveBeenCalled();
    expect(errors()).toContain('EDITOR');
    expect(errors()).toContain('VISUAL');
    expect(process.exitCode).toBe(1);
  });

  test('an editor that does not exist is reported, not swallowed', async () => {
    spawnSyncMock().mockReturnValue({ error: new Error('spawn nosuchedit ENOENT'), status: null });
    process.env.EDITOR = 'nosuchedit';

    await runCli(['skill', 'edit', 'mine']);

    expect(errors()).toContain('Could not start editor "nosuchedit"');
    expect(errors()).toContain('spawn nosuchedit ENOENT');
    expect(process.exitCode).toBe(1);
  });

  test('a non-zero editor exit fails the command and promises no write-back', async () => {
    spawnSyncMock().mockReturnValue({ status: 3, signal: null });
    process.env.EDITOR = 'vi';

    await runCli(['skill', 'edit', 'mine']);

    expect(errors()).toContain('exited with code 3');
    expect(errors()).toContain('wrote nothing');
    expect(process.exitCode).toBe(1);
  });

  test('an editor killed by a signal reports the signal, not a null code', async () => {
    spawnSyncMock().mockReturnValue({ status: null, signal: 'SIGKILL' });
    process.env.EDITOR = 'vi';

    await runCli(['skill', 'edit', 'mine']);

    expect(errors()).toContain('SIGKILL');
    expect(process.exitCode).toBe(1);
  });
});

describe('skill record / stop — the recording state machine', () => {
  afterEach(async () => {
    // The recording flag is module state; leave it off for the next test.
    if (isRecording()) {
      recordStep('cleanup');
      await runCli(['skill', 'stop']);
    }
  });

  test('record opens a session, and stop saves everything recorded in between', async () => {
    expect(isRecording()).toBe(false);

    await runCli(['skill', 'record', 'mine', '--description', 'Recorded run']);
    expect(isRecording()).toBe(true);

    recordStep('standup', { board: 'board-a' });
    recordStep('next');

    await runCli(['skill', 'stop']);

    expect(store.saveSkill).toHaveBeenCalledWith({
      name: 'mine',
      description: 'Recorded run',
      triggers: ['manual'],
      steps: [
        { command: 'standup', args: { board: 'board-a' } },
        { command: 'next', args: undefined },
      ],
    });
    expect(output()).toContain('(2 steps)');
    expect(isRecording()).toBe(false);
  });

  test('recordStep outside a session is a no-op, not a crash', () => {
    expect(isRecording()).toBe(false);
    expect(() => recordStep('standup')).not.toThrow();
  });

  test('a second record while one is open is refused — it would silently drop the first', async () => {
    await runCli(['skill', 'record', 'first']);
    (store.saveSkill as jest.Mock).mockClear();

    await runCli(['skill', 'record', 'second']);

    expect(errors()).toContain('Already recording skill "first"');
    expect(process.exitCode).toBe(1);
    // Still the FIRST session — the second did not take it over.
    recordStep('standup');
    await runCli(['skill', 'stop']);
    expect(store.saveSkill).toHaveBeenCalledWith(expect.objectContaining({ name: 'first' }));
  });

  test('stopping an empty recording saves nothing and closes the session anyway', async () => {
    await runCli(['skill', 'record', 'empty']);

    await runCli(['skill', 'stop']);

    expect(store.saveSkill).not.toHaveBeenCalled();
    expect(output()).toContain('No commands were recorded. Skill not saved.');
    expect(isRecording()).toBe(false);
  });

  test('stop without a recording exits 1 and says how to start one', async () => {
    await runCli(['skill', 'stop']);

    expect(errors()).toContain('favro skill record <name>');
    expect(process.exitCode).toBe(1);
  });

  test('an undescribed recording gets a default description', async () => {
    await runCli(['skill', 'record', 'plain']);
    recordStep('standup');

    await runCli(['skill', 'stop']);

    expect(store.saveSkill).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Recorded skill: plain' }),
    );
  });
});
