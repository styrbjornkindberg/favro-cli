module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__integration__'],
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Real network calls against the Favro API, each spawning the CLI via ts-node.
  testTimeout: 120000,
  // Favro rate-limits hard; serial runs keep the suite under the limit.
  maxWorkers: 1
};
