/**
 * Cards Update Command
 * FAVRO-007: Cards Update Command
 */
import { Command } from 'commander';
/**
 * Max cards that can be updated in a single batch.
 * Spec: "Max 100 cards per command (warn if > 100 match)"
 */
export declare const BATCH_LIMIT = 100;
/**
 * Prompt the user for confirmation (y/n).
 * Returns true if the user answered 'y' or 'yes'.
 * Exported for testing purposes.
 */
export declare function confirmPrompt(question: string): Promise<boolean>;
export declare function registerCardsUpdateCommand(program: Command): void;
export default registerCardsUpdateCommand;
//# sourceMappingURL=cards-update.d.ts.map