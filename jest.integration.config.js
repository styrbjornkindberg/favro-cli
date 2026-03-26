/**
 * Jest config for integration tests.
 * These tests require FAVRO_API_TOKEN and FAVRO_TEST_BOARD_ID env vars.
 *
 * Run with: pnpm test:integration
 *   or:     FAVRO_API_TOKEN=xxx FAVRO_TEST_BOARD_ID=yyy pnpm test:integration
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/tests/integration/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Integration tests are slower — allow 5 minutes per test file
  testTimeout: 300000,
  // Run serially to avoid hammering the API
  maxWorkers: 1,
  // Verbose output to see each test result
  verbose: true,
};
