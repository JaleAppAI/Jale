// Test-only stand-in for src/lib/server/device-trust.ts (K1.2).
export function isDeviceTrustEnabled() {
  return globalThis.__adminCheck?.deviceTrust ?? false;
}
