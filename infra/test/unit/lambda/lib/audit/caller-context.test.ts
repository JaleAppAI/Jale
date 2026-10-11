import { auditCaller, auditCallerFor, type AuditCaller } from '../../../../../lambda/lib/audit/caller';
import {
  SET_AUDIT_CONTEXT_SQL,
  auditContextValues,
  setAuditContext,
} from '../../../../../lambda/lib/audit/context';

const WORKER = '11111111-1111-4111-8111-111111111111';
const EMPLOYER = '22222222-2222-4222-8222-222222222222';
const REQUEST = 'c6af9ac6-7b61-11e6-9a41-93e8deadbeef';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('auditCaller', () => {
  it('takes the request id from the API Gateway event', () => {
    const event = { requestContext: { requestId: REQUEST, authorizer: { claims: { sub: 'fixture-sub' } } } };
    expect(auditCaller(event, { kind: 'employer', id: EMPLOYER }, 'web')).toEqual({
      actorKind: 'employer',
      actorId: EMPLOYER,
      channel: 'web',
      requestId: REQUEST,
    });
  });

  it('reads the request id with optional chaining, so fixtures without one still work', () => {
    for (const event of [undefined, null, {}, { requestContext: null }, { requestContext: {} }]) {
      const caller = auditCaller(event as never, { kind: 'worker', id: WORKER }, 'web');
      expect(caller.requestId).toMatch(UUID_SHAPE);
    }
  });

  it('generates a request id when the event carries one the records cannot hold', () => {
    for (const requestId of ['', 'has space', 'x'.repeat(65), 42, { id: REQUEST }]) {
      const caller = auditCaller({ requestContext: { requestId } }, { kind: 'worker', id: WORKER }, 'web');
      expect(caller.requestId).toMatch(UUID_SHAPE);
      expect(caller.requestId).not.toBe(requestId);
    }
  });

  it('gives each call without a request id its own generated id', () => {
    const a = auditCallerFor(undefined, { kind: 'worker', id: WORKER }, 'whatsapp');
    const b = auditCallerFor(undefined, { kind: 'worker', id: WORKER }, 'whatsapp');
    expect(a.requestId).not.toBe(b.requestId);
  });

  it('needs a users.id for a worker or an employer', () => {
    expect(() => auditCallerFor(REQUEST, { kind: 'worker', id: '' }, 'web')).toThrow('the worker actor needs its users.id');
    expect(() => auditCallerFor(REQUEST, { kind: 'employer', id: 42 } as never, 'web')).toThrow(
      'the employer actor needs its users.id',
    );
    expect(() => auditCallerFor(REQUEST, { kind: 'worker' } as never, 'web')).toThrow('the worker actor needs its users.id');
  });

  it.each(['anonymous', 'platform', 'token_holder'])('refuses any id for a %s actor', (kind) => {
    for (const id of [WORKER, 'fixture-provider-id', 'fixture-unverified-sub', '']) {
      expect(() => auditCallerFor(REQUEST, { kind, id } as never, 'web')).toThrow(`the ${kind} actor carries no id`);
    }
    expect(auditCallerFor(REQUEST, { kind } as never, 'whatsapp')).toEqual({
      actorKind: kind,
      actorId: null,
      channel: 'whatsapp',
      requestId: REQUEST,
    });
  });

  it('refuses an unknown actor kind or channel', () => {
    expect(() => auditCallerFor(REQUEST, { kind: 'admin', id: WORKER } as never, 'web')).toThrow('unknown actor kind');
    expect(() => auditCallerFor(REQUEST, { kind: 'worker', id: WORKER }, 'admin' as never)).toThrow('unknown channel');
  });
});

describe('setAuditContext', () => {
  it('sets the five settings transaction-locally, in one statement', () => {
    const calls = SET_AUDIT_CONTEXT_SQL.match(/set_config\(\s*'app\.audit_[a-z_]+',\s*\$\d,\s*true\)/g) ?? [];
    expect(calls).toEqual([
      "set_config('app.audit_actor_kind', $1, true)",
      "set_config('app.audit_actor_id', $2, true)",
      "set_config('app.audit_channel', $3, true)",
      "set_config('app.audit_surface', $4, true)",
      "set_config('app.audit_request_id', $5, true)",
    ]);
    expect(SET_AUDIT_CONTEXT_SQL.match(/set_config/g)).toHaveLength(5);
  });

  it('states a signed-in worker on the web', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const caller = auditCallerFor(REQUEST, { kind: 'worker', id: WORKER }, 'web');
    await setAuditContext(client, caller, 'worker.profile_update');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(SET_AUDIT_CONTEXT_SQL, ['worker', WORKER, 'web', 'worker.profile_update', REQUEST]);
  });

  it.each([
    ['anonymous', 'whatsapp', 'whatsapp.inbound'],
    ['anonymous', 'web', 'auth.worker_web_signup'],
    ['anonymous', 'web', 'auth.post_confirmation'],
    ['platform', 'whatsapp', 'whatsapp.status_callback'],
    ['platform', 'whatsapp', 'whatsapp.ai_profile'],
    ['token_holder', 'web', 'token_holder.document_confirm'],
  ] as const)('states a %s actor with an empty id (%s, %s)', (kind, channel, surface) => {
    const caller = auditCallerFor(REQUEST, { kind }, channel);
    expect(auditContextValues(caller, surface)).toEqual([kind, '', channel, surface, REQUEST]);
  });

  it.each(['anonymous', 'platform', 'token_holder'])('refuses a %s context that carries an id', (kind) => {
    // A hand-built caller, past auditCallerFor's own check.
    for (const actorId of [WORKER, 'fixture-provider-id', 'fixture-unverified-sub', '']) {
      const caller = { actorKind: kind, actorId, channel: 'web', requestId: REQUEST } as unknown as AuditCaller;
      expect(() => auditContextValues(caller, 'auth.worker_web_signup')).toThrow(`the ${kind} actor carries no id`);
    }
  });

  it('refuses a worker or employer context without a users.id in UUID form', () => {
    for (const actorKind of ['worker', 'employer']) {
      for (const actorId of [null, '', 'not-a-uuid']) {
        const caller = { actorKind, actorId, channel: 'web', requestId: REQUEST } as unknown as AuditCaller;
        expect(() => auditContextValues(caller, 'worker.profile_update')).toThrow('needs its users.id');
      }
    }
  });

  it('refuses a surface outside the registry', () => {
    const caller = auditCallerFor(REQUEST, { kind: 'worker', id: WORKER }, 'web');
    expect(() => auditContextValues(caller, 'worker.unknown_thing' as never)).toThrow('unknown surface');
  });

  it('sends an empty request id rather than one the triggers would store as invalid', () => {
    const caller = { actorKind: 'worker', actorId: WORKER, channel: 'web', requestId: 'bad id' } as AuditCaller;
    expect(auditContextValues(caller, 'worker.profile_update')[4]).toBe('');
  });
});
