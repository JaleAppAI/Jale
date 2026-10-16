// Fake for @aws-sdk/client-sqs in the admin check scripts. Every command sent
// is recorded on globalThis.__adminCheck.sqs.sent with the options it was sent
// with; `behavior(command)` may return a result, an Error to throw, or
// 'hang' to wait until the request's abort signal fires.
function state() {
  const check = (globalThis.__adminCheck ??= {});
  return (check.sqs ??= { clients: [], sent: [], behavior: undefined });
}

export class GetQueueAttributesCommand {
  constructor(input) {
    this.name = 'GetQueueAttributes';
    this.input = input;
  }
}

function abortError() {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

export class SQSClient {
  constructor(config) {
    state().clients.push(config ?? {});
  }

  async send(command, options) {
    const current = state();
    current.sent.push({ name: command.name, input: command.input, options });
    const outcome = current.behavior?.(command);
    if (outcome === 'hang') {
      const signal = options?.abortSignal;
      // AbortSignal.timeout's timer does not hold the event loop open; a real
      // request's socket does, so the hang holds it until the abort.
      const keepAlive = setInterval(() => {}, 50);
      try {
        await new Promise((resolve, reject) => {
          if (!signal) {
            reject(new Error('fake: a hanging request without an abort signal would never end'));
            return;
          }
          if (signal.aborted) reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      } finally {
        clearInterval(keepAlive);
      }
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome ?? {};
  }
}
