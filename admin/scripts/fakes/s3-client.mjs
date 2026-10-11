// Fake for @aws-sdk/client-s3 in the admin check scripts. Clients and commands
// only record what they were built with; the fake presigner reads them.
function state() {
  const check = (globalThis.__adminCheck ??= {});
  return (check.s3 ??= { clients: [] });
}

export class S3Client {
  constructor(config) {
    this.config = config ?? {};
    state().clients.push(this.config);
  }
}

export class GetObjectCommand {
  constructor(input) {
    this.name = 'GetObject';
    this.input = input;
  }
}
