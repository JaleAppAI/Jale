import * as fs from 'node:fs';
import * as path from 'node:path';

describe('OTP SMS transport contract', () => {
  const infraRoot = path.resolve(__dirname, '../../../..');

  test('WhatsApp onboarding directs workers to SMS for verification codes', () => {
    const templates = fs.readFileSync(
      path.join(infraRoot, 'lambda/whatsapp/lib/templates.ts'),
      'utf8',
    );

    expect(templates).toContain('verification code by SMS');
    expect(templates).toContain('codigo de verificacion por SMS');
    expect(templates).not.toMatch(/verification code on WhatsApp/i);
    expect(templates).not.toMatch(/codigo de verificacion por WhatsApp/i);
  });

  test('web worker OTP inputs opt into browser one-time-code autofill', () => {
    const workerForm = fs.readFileSync(
      path.join(infraRoot, '../frontend/src/components/auth/WorkerAuthForm.tsx'),
      'utf8',
    );

    expect(workerForm).toContain("autoComplete={i === 0 ? 'one-time-code' : 'off'}");
  });
});
