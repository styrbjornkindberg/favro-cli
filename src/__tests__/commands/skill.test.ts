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
import { Command } from 'commander';
import { registerSkillCommands, isRecording, recordStep } from '../../commands/skill';
import * as store from '../../lib/skill-store';
import * as engine from '../../lib/skill-engine';
import fs from 'fs';

jest.mock('../../lib/skill-store');
jest.mock('../../lib/skill-engine');
jest.mock('fs');
jest.mock('child_process');

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerSkillCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

const runResult = (over: Partial<engine.SkillRunResult> = {}): engine.SkillRunResult => ({
  skill: 'standup',
  status: 'completed',
  steps: [{ step: 1, command: 'standup', status: 'success', output: 'two cards' }],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
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
  jest.restoreAllMocks();
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

  test('--json emits the raw list', async () => {
    (store.listSkills as jest.Mock).mockReturnValue([{ name: 'standup', description: 'd', source: 'builtin' }]);

    await runCli(['skill', 'list', '--json']);

    expect(JSON.parse(output())).toEqual([{ name: 'standup', description: 'd', source: 'builtin' }]);
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

  test('--json suppresses the per-step chatter and emits the whole result', async () => {
    (engine.runSkill as jest.Mock).mockImplementation(async (_s: unknown, opts: engine.SkillRunOptions) => {
      opts.onStepComplete?.({ step: 1, command: 'standup', status: 'success', output: 'two cards' });
      return runResult();
    });

    await runCli(['skill', 'run', 'standup', '--json']);

    expect(output()).not.toContain('✓ Step 1');
    const printed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{'))!);
    expect(printed.status).toBe('completed');
  });

  test('a clean unwind of a retryable failure invites a retry', async () => {
    (engine.runSkill as jest.Mock).mockResolvedValue(
      runResult({ status: 'failed', rollback: { outcome: 'rolled-back', retryable: true, orphans: [] } }),
    );

    await runCli(['skill', 'run', 'standup']);

    expect(output()).toContain('safe to retry');
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('edit names the file and the editor it is opening it in', async () => {
    await runCli(['skill', 'edit', 'mine']);

    expect(store.getSkillPath).toHaveBeenCalledWith('mine');
    expect(output()).toContain('/home/me/.favro/skills/mine.yaml');
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
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(1);
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
