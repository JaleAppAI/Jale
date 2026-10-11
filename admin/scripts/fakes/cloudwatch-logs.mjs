// Fake for @aws-sdk/client-cloudwatch-logs in the admin check scripts. Every
// command sent is recorded on globalThis.__adminCheck.cloudwatch.sent;
// `behavior(command)` may return a result or an Error to throw.
function state() {
  const check = (globalThis.__adminCheck ??= {});
  return (check.cloudwatch ??= { clients: [], sent: [], behavior: undefined });
}

export class CreateLogStreamCommand {
  constructor(input) {
    this.name = 'CreateLogStream';
    this.input = input;
  }
}

export class PutLogEventsCommand {
  constructor(input) {
    this.name = 'PutLogEvents';
    this.input = input;
  }
}

export class CloudWatchLogsClient {
  constructor(config) {
    state().clients.push(config ?? {});
  }

  async send(command) {
    const current = state();
    current.sent.push({ name: command.name, input: command.input });
    const outcome = current.behavior?.(command);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome ?? {};
  }
}
