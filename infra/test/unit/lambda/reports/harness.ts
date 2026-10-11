/**
 * harness.ts -- shared stand-ins for the report handler suites. Not a test
 * file: jest only runs *.test.ts.
 *
 * The database stand-in answers each jale_cap report function by name and
 * records a timeline of statements, transaction control, the caller context
 * and every storage call, so a test can assert what ran inside a
 * transaction and what ran outside one.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

export type Rows = Array<Record<string, unknown>>;
export type Answer = Rows | Error | ((args: unknown[]) => Rows | Error);

export const FUNCTIONS = [
  'problem_report_config',
  'problem_report_create_verified',
  'problem_report_create_unverified',
  'problem_report_upload_grant',
  'problem_report_pending_upload',
  'problem_report_attach',
  'problem_report_cleanup',
] as const;
export type FunctionName = (typeof FUNCTIONS)[number];

export interface FakeDb {
  timeline: string[];
  /** Arguments of each call to a report function, by name. */
  calls: Record<string, unknown[][]>;
  answers: Partial<Record<FunctionName, Answer>>;
  query: jest.Mock;
  release: jest.Mock;
  connect: jest.Mock;
  pool: { connect: jest.Mock };
}

export function fakeDb(timeline: string[]): FakeDb {
  const db: FakeDb = {
    timeline,
    calls: {},
    answers: {},
    query: jest.fn(),
    release: jest.fn(),
    connect: jest.fn(),
    pool: { connect: jest.fn() },
  };
  db.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) {
      timeline.push(text);
      return { rows: [] };
    }
    const name = FUNCTIONS.find((fn) => text.includes(`jale_cap.${fn}(`));
    if (!name) throw new Error(`unexpected statement in a report handler: ${text}`);
    timeline.push(name);
    (db.calls[name] ??= []).push(args);
    let answer = db.answers[name];
    if (typeof answer === 'function') answer = answer(args);
    if (answer instanceof Error) throw answer;
    return { rows: answer ?? [] };
  });
  db.release.mockImplementation(() => {
    timeline.push('RELEASE');
  });
  db.pool.connect.mockImplementation(async () => {
    timeline.push('CONNECT');
    return { query: db.query, release: db.release };
  });
  return db;
}

/** Answers S3 commands by class and records each call in the timeline. */
export interface FakeS3Answers {
  head?: Record<string, unknown> | Error;
  range?: number[] | Error;
  copy?: Record<string, unknown> | Error;
  del?: Record<string, unknown> | Error;
  batchDelete?: Record<string, unknown> | Error;
}

export function answerS3(send: jest.Mock, timeline: string[], answers: FakeS3Answers): Array<{ command: string; input: any }> {
  const calls: Array<{ command: string; input: any }> = [];
  send.mockImplementation(async (command: { input: any }) => {
    const name = command.constructor.name;
    timeline.push(`S3:${name.replace(/Command$/, '')}`);
    calls.push({ command: name, input: command.input });
    const answer = command instanceof HeadObjectCommand ? answers.head
      : command instanceof GetObjectCommand ? answers.range
        : command instanceof CopyObjectCommand ? answers.copy ?? {}
          : command instanceof DeleteObjectCommand ? answers.del ?? {}
            : command instanceof DeleteObjectsCommand ? answers.batchDelete ?? {}
              : new Error(`unexpected S3 command ${name}`);
    if (answer instanceof Error) throw answer;
    if (command instanceof GetObjectCommand) {
      return { Body: { transformToByteArray: async () => Uint8Array.from(answer as number[]) } };
    }
    return answer;
  });
  return calls;
}

export function s3Error(name: string, status: number): Error {
  const err = new Error(name) as Error & { $metadata: { httpStatusCode: number } };
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

export const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
export const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1];

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface EventInput {
  method?: string;
  action: string;
  body?: unknown;
  rawBody?: string;
  claims?: Record<string, unknown> | null;
  headers?: Record<string, string>;
}

/** An API Gateway proxy event for `/…/reports/{action}`. */
export function reportEvent(input: EventInput): APIGatewayProxyEvent {
  const body = input.rawBody ?? (input.body === undefined ? null : JSON.stringify(input.body));
  return {
    resource: '/reports/{action}',
    path: `/reports/${input.action}`,
    httpMethod: input.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(input.headers ?? {}) },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: { action: input.action },
    stageVariables: null,
    body,
    isBase64Encoded: false,
    requestContext: {
      requestId: `fixture-request-${randomUUID()}`,
      authorizer: input.claims ? { claims: input.claims } : undefined,
    },
  } as unknown as APIGatewayProxyEvent;
}

export function parse(result: APIGatewayProxyResult): { status: number; body: any; headers: Record<string, unknown> } {
  return {
    status: result.statusCode,
    body: result.body ? JSON.parse(result.body) : null,
    headers: (result.headers ?? {}) as Record<string, unknown>,
  };
}

/** Every console line, captured; EMF lines parsed into metrics. */
export interface ConsoleCapture {
  lines: string[];
  logs: Array<Record<string, unknown>>;
  metrics(): Array<{ name: string; value: unknown; dimensions: Record<string, unknown> }>;
  restore(): void;
}

export function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }));
  const parsed = (): Array<Record<string, any>> => lines.flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? [value] : [];
    } catch {
      return [];
    }
  });
  return {
    lines,
    get logs() {
      return parsed().filter((line) => !('_aws' in line));
    },
    metrics() {
      return parsed().filter((line) => '_aws' in line).flatMap((line) => {
        const [directive] = line._aws.CloudWatchMetrics;
        const dimensions = Object.fromEntries((directive.Dimensions[0] as string[]).map((key) => [key, line[key]]));
        return (directive.Metrics as Array<{ Name: string }>).map(({ Name }) => ({ name: Name, value: line[Name], dimensions }));
      });
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** A created report's row as the create functions return it. */
export function createdRow(overrides: Record<string, unknown> = {}): Rows {
  return [{
    outcome: 'ok',
    report_id: randomUUID(),
    report_number: '1042',
    replayed: false,
    email_queued: true,
    ...overrides,
  }];
}

export function refusedRow(outcome: string): Rows {
  return [{ outcome, report_id: null, report_number: null, replayed: false, email_queued: null }];
}

/** Half of a surrogate pair standing alone. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function jsonStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...jsonStrings(entry)]);
  }
  return [];
}

function databaseError(code: string): Error {
  return Object.assign(new Error('fixture: the database refused the value'), { code });
}

/**
 * Answers `rows`, unless an argument holds text PostgreSQL cannot store: a NUL
 * in a text value (22021), or, in a JSON value, a NUL (22P05) or half of a
 * surrogate pair standing alone (22P02). A lone half in a plain text value
 * never reaches the database as such: the driver's UTF-8 encoding replaces it.
 */
export function storingLikePostgres(rows: Rows): (args: unknown[]) => Rows | Error {
  return (args) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      let json: unknown;
      if (arg.startsWith('{')) {
        try {
          json = JSON.parse(arg);
        } catch {
          json = undefined;
        }
      }
      if (json === undefined) {
        if (arg.includes('\u0000')) return databaseError('22021');
        continue;
      }
      for (const text of jsonStrings(json)) {
        if (text.includes('\u0000')) return databaseError('22P05');
        if (LONE_SURROGATE.test(text)) return databaseError('22P02');
      }
    }
    return rows;
  };
}
