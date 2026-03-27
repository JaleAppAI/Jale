module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.integration.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testTimeout: 30000,
  globalSetup: '<rootDir>/test/integration/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/setup/global-teardown.ts',
};
