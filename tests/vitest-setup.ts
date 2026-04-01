/**
 * Vitest setup: provide `jest` global as alias for `vi`
 * so test files written with jest.* APIs work under both Jest and Vitest.
 */
import { vi } from 'vitest';

(globalThis as any).jest = vi;
