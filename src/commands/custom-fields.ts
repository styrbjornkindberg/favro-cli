/**
 * Custom Fields Commands
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 *
 * Commands:
 *   favro custom-fields list <board-id>              — List all custom fields for a board
 *   favro custom-fields get <field-id>               — Get custom field details
 *   favro custom-fields set <card-id> <field-id> <value> — Set custom field value on card
 *   favro custom-fields values <field-id>            — List all possible values for a field
 */
import { Command } from 'commander';
import CustomFieldsAPI, {
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldOption,
  formatFieldType,
} from '../lib/custom-fields-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

// ─── Formatters ──────────────────────────────────────────────────────────────

export function formatFieldsTable(fields: CustomFieldDefinition[]): void {
  if (fields.length === 0) {
    console.log('No custom fields found for this board.');
    return;
  }

  const rows = fields.map(f => ({
    ID: f.fieldId,
    Name: (f.name ?? '—').length > 35 ? (f.name ?? '—').slice(0, 32) + '...' : (f.name ?? '—'),
    Type: formatFieldType(f),
    Required: f.required ? 'yes' : 'no',
  }));

  console.table(rows);
}

export function formatFieldDetail(field: CustomFieldDefinition): void {
  console.log(`ID:       ${field.fieldId}`);
  console.log(`Name:     ${field.name}`);
  console.log(`Type:     ${field.type}`);
  console.log(`Required: ${field.required ? 'yes' : 'no'}`);
  if (field.boardId) console.log(`Board:    ${field.boardId}`);
  if (field.description) console.log(`Desc:     ${field.description}`);
  if (field.options && field.options.length > 0) {
    console.log('Options:');
    for (const opt of field.options) {
      console.log(`  - ${opt.name} (id: ${opt.optionId})`);
    }
  }
}

export function formatFieldValuesTable(values: CustomFieldValue[]): void {
  if (values.length === 0) {
    console.log('No custom field values set on this card.');
    return;
  }

  const rows = values.map(v => ({
    'Field ID': v.fieldId,
    Value: v.displayValue ?? v.value ?? '—',
  }));

  console.table(rows);
}

export function formatOptionsTable(options: CustomFieldOption[]): void {
  if (options.length === 0) {
    console.log('No options defined for this field (may not be a select field).');
    return;
  }

  const rows = options.map(o => ({
    ID: o.optionId,
    Name: o.name,
    Color: o.color ?? '—',
  }));

  console.table(rows);
}

// ─── Command Registration ─────────────────────────────────────────────────────

export function registerCustomFieldsCommands(program: Command): void {
  const cfCmd = program
    .command('custom-fields')
    .description(
      'Custom field operations — list, get, set, and inspect field values.\n\n' +
      'Subcommands:\n' +
      '  list <board-id>                  List all custom fields for a board\n' +
      '  get <field-id>                   Get custom field definition and options\n' +
      '  set <card-id> <field-id> <value> Set a custom field value on a card\n' +
      '  values <field-id>                List all allowed values for a select field\n\n' +
      'Examples:\n' +
      '  favro custom-fields list <board-id>\n' +
      '  favro custom-fields get <field-id>\n' +
      '  favro custom-fields set <card-id> <field-id> "In Progress"\n' +
      '  favro custom-fields values <field-id>'
    );

  // ─── custom-fields list <board-id> ─────────────────────────────────────────
  cfCmd
    .command('list <board-id>')
    .description('List all custom fields defined for a board')
    .option('--json', 'Output as JSON')
    .action(async (boardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CustomFieldsAPI(client);

        const fields = await api.listFields(boardId);

        if (options.json) {
          console.log(JSON.stringify(fields, null, 2));
        } else {
          console.log(`Found ${fields.length} custom field(s) for board ${boardId}:`);
          formatFieldsTable(fields);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── custom-fields get <field-id> ──────────────────────────────────────────
  cfCmd
    .command('get <field-id>')
    .description('Get details for a specific custom field')
    .option('--json', 'Output as JSON')
    .action(async (fieldId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CustomFieldsAPI(client);

        const field = await api.getField(fieldId);

        if (options.json) {
          console.log(JSON.stringify(field, null, 2));
        } else {
          formatFieldDetail(field);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── custom-fields set <card-id> <field-id> <value> ────────────────────────
  cfCmd
    .command('set <card-id> <field-id> <value>')
    .description(
      'Set a custom field value on a card.\n\n' +
      'For select fields, value must match one of the allowed option names.\n' +
      'For date fields, use ISO 8601 format (e.g. "2024-12-31").\n' +
      'For text/user/link fields, pass the string value directly.'
    )
    .option('--json', 'Output updated field value as JSON')
    .option('--dry-run', 'Print what would be updated without making API calls')
    .option('--yes, -y', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, fieldId: string, value: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          console.log(`[dry-run] Would set custom field ${fieldId} on ${cardId} to "${value}"`);
          return;
        }

        const client = await createFavroClient();
        
        const { default: CardsAPI } = await import('../lib/cards-api');
        const cardsApi = new CardsAPI(client);
        const card = await cardsApi.getCard(cardId);
        
        const { readConfig } = await import('../lib/config');
        const { checkScope, confirmAction } = await import('../lib/safety');
        await checkScope(card.boardId ?? '', client, await readConfig(), options.force);
        
        if (!(await confirmAction(`Set custom field ${fieldId} on card ${cardId}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }

        const api = new CustomFieldsAPI(client);

        const result = await api.setFieldValue(cardId, fieldId, value);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✓ Custom field updated successfully.`);
          console.log(`  Field: ${fieldId}`);
          console.log(`  Value: ${result.displayValue ?? result.value ?? value}`);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── custom-fields values <field-id> ────────────────────────────────────────
  cfCmd
    .command('values <field-id>')
    .description('List all possible values (options) for a select-type custom field')
    .option('--board <board-id>', 'Board ID to scope the field lookup')
    .option('--json', 'Output as JSON')
    .action(async (fieldId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CustomFieldsAPI(client);

        const opts = await api.listFieldValues(fieldId, options.board);

        if (options.json) {
          console.log(JSON.stringify(opts, null, 2));
        } else {
          if (opts.length === 0) {
            console.log('No options found. This field may not be a select type.');
          } else {
            console.log(`Found ${opts.length} option(s) for field ${fieldId}:`);
            formatOptionsTable(opts);
          }
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCustomFieldsCommands;
