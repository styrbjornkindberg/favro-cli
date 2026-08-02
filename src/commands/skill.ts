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
 */
import { Command } from 'commander';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { logError } from '../lib/error-handler';
import { splitCommand } from '../lib/split-command';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';
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
    .option('--json', 'Output as JSON')
    .action((options) => {
      try {
        const skills = listSkills();
        // A local read rather than a Favro one, but the same contract: an agent
        // parses one list shape whatever the source (#99).
        const envelope = capRows(skills, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
          return;
        }

        if (envelope.rows.length === 0) {
          console.log('No skills installed.\n  Create one: favro skill create <name>');
          return;
        }

        console.log(`Available skills (${envelope.rows.length}):\n`);
        for (const s of envelope.rows) {
          const tag = s.source === 'builtin' ? '  [builtin]' : '  [user]   ';
          console.log(`${tag} ${s.name.padEnd(20)} ${s.description}`);
        }
        noteTruncation(envelope, skills.length);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill run <name> ─────────────────────────────────────────────────

  skillCmd
    .command('run <name>')
    .description('Execute a skill by name')
    .option('--board <board>', 'Board ID or name (overrides skill default)')
    .option('--dry-run', 'Preview steps without executing')
    .option('-y, --yes', 'Skip confirmation prompts')
    .option('--var <vars...>', 'Set variables: key=value')
    .option('--force', 'Bypass the scope lock on write steps')
    .option('--json', 'Output results as JSON')
    .action(async (name: string, options) => {
      try {
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

        console.log(`Running skill: ${skill.name}`);
        if (skill.description) console.log(`  ${skill.description}\n`);

        const result = await runSkill(skill, {
          dryRun: options.dryRun,
          yes: options.yes,
          force: options.force,
          variables,
          onStepComplete: (stepResult: StepResult) => {
            if (options.json) return;
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

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const completed = result.steps.filter(s => s.status === 'success').length;
          const total = result.steps.length;
          console.log(`\n${result.status === 'completed' ? '✓' : '✗'} Skill "${result.skill}" ${result.status} (${completed}/${total} steps)`);
          // The run is one transaction: report the whole-run unwind, not per step.
          // The advice reads `retryable`, the table's one derivation — a clean
          // unwind around a deterministic refusal is undone AND not worth
          // repeating, and re-deriving it from the outcome here said the
          // opposite (#66).
          // Gated on the outcome too: only `rolled-back` means a clean unwind,
          // so only it may print "the whole run was undone".
          if (result.rollback?.outcome === 'rolled-back' && result.rollback.retryable) {
            console.log('  Rolled back — the whole run was undone, so it is safe to retry.');
          } else if (result.rollback?.outcome === 'rolled-back') {
            console.error(
              '  Rolled back — the whole run was undone, but the failure is deterministic: ' +
                'the same run will fail the same way. Do NOT retry it unchanged.',
            );
          } else if (result.rollback) {
            console.error('  Rollback incomplete — do NOT retry. Left behind:');
            for (const orphan of result.rollback.orphans) console.error(`    - ${orphan.reason}`);
          }
        }

        if (result.status === 'failed') process.exit(1);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill create <name> ──────────────────────────────────────────────

  skillCmd
    .command('create <name>')
    .description('Create a new skill from a template')
    .option('--description <desc>', 'Skill description')
    .action(async (name: string, options) => {
      try {
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
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill edit <name> ────────────────────────────────────────────────

  skillCmd
    .command('edit <name>')
    .description('Open a skill file in $EDITOR (or $VISUAL) and wait for it to close')
    .action((name: string) => {
      try {
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
          console.error('No editor configured. Set $VISUAL (or $EDITOR) first, e.g. EDITOR=nano.');
          process.exit(1);
          return;
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
          console.error(`Could not start editor "${bin}": ${result.error.message}`);
          process.exit(1);
          return;
        }
        if (result.status !== 0) {
          const how = result.signal ? `on signal ${result.signal}` : `with code ${result.status}`;
          // favro never writes this file — the editor does, in place — so a
          // failed edit cannot half-save anything through us.
          console.error(`Editor "${editor}" exited ${how}. favro wrote nothing; ${filePath} is as the editor left it.`);
          process.exit(1);
          return;
        }

        // The editor has almost certainly repainted the terminal, so say what
        // was closed rather than leaving the user staring at their old prompt.
        console.log(`✓ Closed ${filePath}`);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill export <name> ──────────────────────────────────────────────

  skillCmd
    .command('export <name>')
    .description('Output a skill as YAML to stdout')
    .action((name: string) => {
      try {
        const yaml = exportSkill(name);
        process.stdout.write(yaml);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill import <path> ──────────────────────────────────────────────

  skillCmd
    .command('import <path>')
    .description('Import a skill from a YAML file')
    .action((filePath: string) => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const skill = importSkill(content);
        console.log(`✓ Skill imported: ${skill.name}`);
        console.log(`  Run it: favro skill run ${skill.name}`);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill delete <name> ──────────────────────────────────────────────

  skillCmd
    .command('delete <name>')
    .description('Delete a user skill')
    .action((name: string) => {
      try {
        deleteSkill(name);
        console.log(`✓ Skill deleted: ${name}`);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill record <name> ──────────────────────────────────────────────

  skillCmd
    .command('record <name>')
    .description('Start recording CLI commands as a skill')
    .option('--description <desc>', 'Skill description')
    .action((name: string, options) => {
      try {
        if (recording) {
          console.error(`Already recording skill "${recording.name}". Run \`favro skill stop\` first.`);
          process.exit(1);
        }
        recording = { name, steps: [] };
        console.log(`Recording skill "${name}"...`);
        console.log('  Run favro commands normally. They will be recorded.');
        console.log('  When done, run: favro skill stop');

        // Store description for later
        if (options.description) {
          (recording as any).description = options.description;
        }
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── skill stop ───────────────────────────────────────────────────────

  skillCmd
    .command('stop')
    .description('Stop recording and save the skill')
    .action(() => {
      try {
        if (!recording) {
          console.error('Not currently recording. Start with: favro skill record <name>');
          process.exit(1);
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
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });
}
