/**
 * Skill Commands
 *
 * favro skill list                     — List available skills
 * favro skill run <name>               — Execute a skill
 * favro skill create <name>            — Create a new skill interactively
 * favro skill edit <name>              — Open skill file in $EDITOR
 * favro skill export <name>            — Output skill YAML to stdout
 * favro skill import <path>            — Import skill from file
 * favro skill delete <name>            — Delete a user skill
 * favro skill record <name>            — Start recording commands as a skill
 * favro skill stop                     — Stop recording and save skill
 *
 * ANONYMOUS (ADR-0002, #118). Skills are files on disk and `skill run` hands
 * each step to the dispatch table, which builds its own client — so nothing
 * here needs one, and `{ anonymous: true }` drops `ctx.client` from the type so
 * a later edit cannot quietly reach for one.
 */
import { Command } from 'commander';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { AnonymousCtx, resolveFormat, run } from '../lib/run';
import { RefusalError } from '../lib/refusal';
import { splitCommand } from '../lib/split-command';
import {
  listSkills,
  loadSkill,
  saveSkill,
  deleteSkill,
  exportSkill,
  importSkill,
  getSkillPath,
  loadSkillFromFile,
  SkillDefinition,
} from '../lib/skill-store';
import { runSkill, StepResult } from '../lib/skill-engine';

// ─── Recording State ──────────────────────────────────────────────────────────

let recording: { name: string; steps: Array<{ command: string; args?: Record<string, string> }> } | null = null;

export function isRecording(): boolean {
  return recording !== null;
}

export function recordStep(command: string, args?: Record<string, string>): void {
  if (recording) {
    recording.steps.push({ command, args });
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export function registerSkillCommands(program: Command): void {
  const skillCmd = program.command('skill').description('Manage and run reusable workflow skills');

  // ─── skill list ───────────────────────────────────────────────────────

  skillCmd
    .command('list')
    .description('List all available skills (builtin + user)')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    // A local read rather than a Favro one, but the same contract: an agent
    // parses one list shape whatever the source (#99). The runner caps, wraps
    // and notes the truncation, so the leaf `--json` is gone with the rest of
    // them — JSON is the default and `--human` opts out.
    .action(run({ anonymous: true }, (_ctx, options: { limit?: string }) => ({
      rows: listSkills(),
      limit: options.limit,
      human: (rows: ReturnType<typeof listSkills>) => {
        if (rows.length === 0) {
          return 'No skills installed.\n  Create one: favro skill create <name>';
        }
        const lines = rows.map(
          (s) => `${s.source === 'builtin' ? '  [builtin]' : '  [user]   '} ${s.name.padEnd(20)} ${s.description}`,
        );
        return [`Available skills (${rows.length}):\n`, ...lines].join('\n');
      },
    })));

  // ─── skill run <name> ─────────────────────────────────────────────────

  skillCmd
    .command('run <name>')
    .description('Execute a skill by name')
    .option('--board <board>', 'Board ID or name (overrides skill default)')
    .option('--dry-run', 'Preview steps without executing')
    .option('-y, --yes', 'Skip confirmation prompts')
    .option('--var <vars...>', 'Set variables: key=value')
    .option('--force', 'Bypass the scope lock on write steps')
    .action(run({ anonymous: true }, async (
      _ctx,
      name: string,
      options: {
        board?: string;
        dryRun?: boolean;
        yes?: boolean;
        force?: boolean;
        var?: string[];
      },
      command: Command,
    ) => {
      // The one place a handler reads the format: the per-step chatter is
      // written AS THE RUN HAPPENS, so it cannot be deferred into `human` — and
      // in JSON mode it would land on stdout in front of the envelope. The leaf
      // `--json` this replaces meant the same thing with a fourth spelling.
      const { json } = resolveFormat(command);
      const skill = loadSkill(name);

      // Parse --var key=value pairs
      const variables: Record<string, string> = {};
      if (options.board) variables.board = options.board;
      if (options.var) {
        for (const v of options.var) {
          const eq = v.indexOf('=');
          if (eq > 0) {
            variables[v.slice(0, eq)] = v.slice(eq + 1);
          }
        }
      }

      if (!json) {
        console.log(`Running skill: ${skill.name}`);
        if (skill.description) console.log(`  ${skill.description}\n`);
      }

      const result = await runSkill(skill, {
        dryRun: options.dryRun,
        yes: options.yes,
        force: options.force,
        variables,
        onStepComplete: (stepResult: StepResult) => {
          if (json) return;
          const icon = stepResult.status === 'success' ? '✓' : stepResult.status === 'skipped' ? '⊘' : '✗';
          console.log(`\n${icon} Step ${stepResult.step}: ${stepResult.command}`);
          if (stepResult.output) {
            console.log(stepResult.output);
          }
          if (stepResult.error) {
            console.error(`  Error: ${stepResult.error}`);
          }
        },
      });

      // A failed run is the FINDING, not a thrown failure — the steps that did
      // land are in the result and an exception would throw them away.
      return {
        item: result,
        exitCode: result.status === 'failed' ? 1 : undefined,
        human: (r: typeof result) => {
          const completed = r.steps.filter(s => s.status === 'success').length;
          console.log(`\n${r.status === 'completed' ? '✓' : '✗'} Skill "${r.skill}" ${r.status} (${completed}/${r.steps.length} steps)`);
          // The run is one transaction: report the whole-run unwind, not per step.
          // The advice reads `retryable`, the table's one derivation — a clean
          // unwind around a deterministic refusal is undone AND not worth
          // repeating, and re-deriving it from the outcome here said the
          // opposite (#66).
          // Gated on the outcome too: only `rolled-back` means a clean unwind,
          // so only it may print "the whole run was undone".
          if (r.rollback?.outcome === 'rolled-back' && r.rollback.retryable) {
            console.log('  Rolled back — the whole run was undone, so it is safe to retry.');
          } else if (r.rollback?.outcome === 'rolled-back') {
            console.error(
              '  Rolled back — the whole run was undone, but the failure is deterministic: ' +
                'the same run will fail the same way. Do NOT retry it unchanged.',
            );
          } else if (r.rollback) {
            console.error('  Rollback incomplete — do NOT retry. Left behind:');
            for (const orphan of r.rollback.orphans) console.error(`    - ${orphan.reason}`);
          }
        },
      };
    }));

  // ─── skill create <name> ──────────────────────────────────────────────

  skillCmd
    .command('create <name>')
    .description('Create a new skill from a template')
    .option('--description <desc>', 'Skill description')
    .action(run({ anonymous: true }, (_ctx, name: string, options: { description?: string }) => {
      const skill: SkillDefinition = {
        name,
        description: options.description ?? `Custom skill: ${name}`,
        triggers: ['manual'],
        steps: [
          {
            command: 'standup',
            args: { board: '{{board}}' },
          },
        ],
        variables: {
          board: {
            prompt: 'Which board?',
            default: '{{scope.board}}',
          },
        },
      };

      const filePath = saveSkill(skill);
      console.log(`✓ Skill created: ${filePath}`);
      console.log('  Edit it to customize steps, then run with:');
      console.log(`  favro skill run ${name} --board <boardId>`);
    }));

  // ─── skill edit <name> ────────────────────────────────────────────────

  skillCmd
    .command('edit <name>')
    .description('Open a skill file in $EDITOR (or $VISUAL) and wait for it to close')
    .action(run({ anonymous: true }, (_ctx, name: string) => {
      const filePath = getSkillPath(name);
      // $VISUAL first, then $EDITOR: the Unix convention every other tool
      // follows (git, crontab, vipw, sensible-editor). VISUAL is the
      // full-screen editor, EDITOR the line-editor fallback for a dumb
      // terminal, so a user who sets both wants VISUAL here.
      const editor = (process.env.VISUAL || process.env.EDITOR || '').trim();
      if (!editor) {
        // No fallback. Guessing `vi` drops a user who has never used it into a
        // full-screen modal editor with no visible way out; naming the two
        // variables is the shorter path to a working command.
        // A refusal, not a failure: unset stays unset, so the retry declines
        // identically.
        throw new RefusalError('No editor configured. Set $VISUAL (or $EDITOR) first, e.g. EDITOR=nano.');
      }

      // `$EDITOR` routinely carries arguments (`code --wait`, `emacsclient
      // -nw`), so it is argv, not an executable name. Split it and spawn
      // WITHOUT a shell: the old `exec` form built one command string for
      // `/bin/sh -c`, which ran whatever an `$EDITOR` of `vi; rm -rf ~`
      // contained, and interpolated `filePath` into the same string.
      // Quote-aware, because on macOS the spaced path is the common case, not
      // the exotic one: `/Applications/My Editor.app/…`. A plain whitespace
      // split turns that into a `bin` of `/Applications/My` and an ENOENT.
      const [bin, ...editorArgs] = splitCommand(editor);

      console.log(`Opening ${filePath} in ${editor}...`);
      // `stdio: 'inherit'` gives the child the real terminal and `spawnSync`
      // blocks until it closes — #129: `exec` did neither, because it has no
      // `stdio` option at all (the `as any` was there to hide that).
      const result = spawnSync(bin, [...editorArgs, filePath], { stdio: 'inherit' });

      if (result.error) {
        // Also deterministic: the same $EDITOR spells the same ENOENT.
        throw new RefusalError(`Could not start editor "${bin}": ${result.error.message}`);
      }
      if (result.status !== 0) {
        const how = result.signal ? `on signal ${result.signal}` : `with code ${result.status}`;
        // favro never writes this file — the editor does, in place — so a
        // failed edit cannot half-save anything through us. A plain Error, not
        // a refusal: the next attempt may well save cleanly.
        throw new Error(`Editor "${editor}" exited ${how}. favro wrote nothing; ${filePath} is as the editor left it.`);
      }

      // The editor has almost certainly repainted the terminal, so say what
      // was closed rather than leaving the user staring at their old prompt.
      console.log(`✓ Closed ${filePath}`);
    }));

  // ─── skill export <name> ──────────────────────────────────────────────

  skillCmd
    .command('export <name>')
    .description('Output a skill as YAML to stdout')
    // Unadorned, so it can be piped — the YAML IS the answer, not a view of one.
    .action(run({ anonymous: true }, (_ctx, name: string) => {
      process.stdout.write(exportSkill(name));
    }));

  // ─── skill import <path> ──────────────────────────────────────────────

  skillCmd
    .command('import <path>')
    .description('Import a skill from a YAML file')
    .action(run({ anonymous: true }, (_ctx, filePath: string) => {
      const skill = importSkill(fs.readFileSync(filePath, 'utf-8'));
      console.log(`✓ Skill imported: ${skill.name}`);
      console.log(`  Run it: favro skill run ${skill.name}`);
    }));

  // ─── skill delete <name> ──────────────────────────────────────────────

  skillCmd
    .command('delete <name>')
    .description('Delete a user skill')
    .action(run({ anonymous: true }, (_ctx, name: string) => {
      deleteSkill(name);
      console.log(`✓ Skill deleted: ${name}`);
    }));

  // ─── skill record <name> ──────────────────────────────────────────────

  skillCmd
    .command('record <name>')
    .description('Start recording CLI commands as a skill')
    .option('--description <desc>', 'Skill description')
    .action(run({ anonymous: true }, (_ctx, name: string, options: { description?: string }) => {
      if (recording) {
        throw new RefusalError(
          `Already recording skill "${recording.name}". Run \`favro skill stop\` first.`,
        );
      }
      recording = { name, steps: [] };
      console.log(`Recording skill "${name}"...`);
      console.log('  Run favro commands normally. They will be recorded.');
      console.log('  When done, run: favro skill stop');

      // Store description for later
      if (options.description) {
        (recording as any).description = options.description;
      }
    }));

  // ─── skill stop ───────────────────────────────────────────────────────

  skillCmd
    .command('stop')
    .description('Stop recording and save the skill')
    // `_ctx` is spelled out even though it is unused: the scope-lock detector
    // reads the first parameter's TYPE, and a handler with no parameters is
    // invisible to it.
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => {
      if (!recording) {
        throw new RefusalError('Not currently recording. Start with: favro skill record <name>');
      }

      if (recording.steps.length === 0) {
        console.log('No commands were recorded. Skill not saved.');
        recording = null;
        return;
      }

      const skill: SkillDefinition = {
        name: recording.name,
        description: (recording as any).description ?? `Recorded skill: ${recording.name}`,
        triggers: ['manual'],
        steps: recording.steps.map(s => ({
          command: s.command,
          args: s.args,
        })),
      };

      const filePath = saveSkill(skill);
      console.log(`✓ Skill saved: ${filePath} (${recording.steps.length} steps)`);
      recording = null;
    }));
}
