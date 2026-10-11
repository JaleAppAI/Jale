// Fake for @aws-sdk/s3-request-presigner in the admin check scripts. Every
// call is recorded on globalThis.__adminCheck.presign.calls, and `onPresign`
// lets a check put the call into its ordered statement log. `behavior` may
// return a URL or an Error to throw.
function state() {
  const check = (globalThis.__adminCheck ??= {});
  return (check.presign ??= { calls: [], behavior: undefined, onPresign: undefined });
}

export async function getSignedUrl(client, command, options) {
  const current = state();
  current.calls.push({ client, command: command.name, input: command.input, options });
  current.onPresign?.();
  const outcome = current.behavior?.(command, options);
  if (outcome instanceof Error) {
    throw outcome;
  }
  return outcome ?? 'https://images.example.test/signed-link';
}
