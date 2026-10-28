import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 3 invite sign-up (Task 16). The invite token reaches Cognito's
 * post-confirmation trigger only as ConfirmSignUp's ClientMetadata, which
 * `amazon-cognito-identity-js` takes as `confirmRegistration`'s FOURTH
 * argument. A foreman's Cognito `name` is their own name, and they send no
 * `custom:company_name` (I5).
 *
 * The SDK is mocked wholesale, as in `cognito-employer-sign-in.test.ts`.
 */

const confirmCalls: unknown[][] = [];
const signUpCalls: { username: string; attributes: Record<string, string> }[] = [];

vi.mock('amazon-cognito-identity-js', () => {
    class CognitoUserPool {
        constructor(readonly config: { UserPoolId: string; ClientId: string }) {}
        signUp(
            username: string,
            _password: string,
            attrs: { attribute: { Name: string; Value: string } }[],
            _validation: unknown[],
            cb: (err: unknown) => void,
        ) {
            signUpCalls.push({
                username,
                attributes: Object.fromEntries(attrs.map(({ attribute }) => [attribute.Name, attribute.Value])),
            });
            cb(null);
        }
    }
    class CognitoUserAttribute {
        constructor(readonly attribute: { Name: string; Value: string }) {}
    }
    class AuthenticationDetails {}
    class CognitoUser {
        constructor(readonly details: { Username: string; Pool: unknown }) {}
        confirmRegistration(...args: unknown[]) {
            confirmCalls.push([this.details.Username, ...args]);
            (args[2] as (err: unknown) => void)(null);
        }
    }
    return { CognitoUserPool, CognitoUser, CognitoUserAttribute, AuthenticationDetails };
});

beforeEach(() => {
    confirmCalls.length = 0;
    signUpCalls.length = 0;
    vi.stubEnv('NEXT_PUBLIC_EMPLOYER_POOL_ID', 'us-east-1_test');
    vi.stubEnv('NEXT_PUBLIC_EMPLOYER_CLIENT_ID', 'test-client-id');
    vi.stubEnv('NEXT_PUBLIC_WORKER_POOL_ID', 'us-east-1_worker');
    vi.stubEnv('NEXT_PUBLIC_WORKER_CLIENT_ID', 'worker-client-id');
});

describe('employerConfirmSignUp', () => {
    it('confirmRegistration receives the clientMetadata as its fourth argument', async () => {
        const { employerConfirmSignUp } = await import('@/lib/cognito');

        await employerConfirmSignUp(' Foreman@Example.com ', '123456', { inviteToken: 'tok-abc' });

        expect(confirmCalls).toHaveLength(1);
        const [username, code, forceAliasCreation, callback, clientMetadata] = confirmCalls[0];
        expect(username).toBe('foreman@example.com');
        expect(code).toBe('123456');
        expect(forceAliasCreation).toBe(true);
        expect(typeof callback).toBe('function');
        expect(clientMetadata).toEqual({ inviteToken: 'tok-abc' });
    });

    it('sends no clientMetadata without an invite token (Phase 2 call unchanged)', async () => {
        const { employerConfirmSignUp, workerConfirmSignUp } = await import('@/lib/cognito');

        await employerConfirmSignUp('owner@example.com', '123456');
        await employerConfirmSignUp('owner@example.com', '123456', {});
        await workerConfirmSignUp('+12100000000', '654321');

        for (const call of confirmCalls) expect(call[4]).toBeUndefined();
    });
});

describe('employerSignUp', () => {
    const INPUT = {
        email: ' Foreman@Example.com ',
        password: 'S3cret!pass',
        companyName: 'Acme Builders',
        contactName: '  Ana Ruiz ',
        phone: '+12105550100',
    };

    it('invite-mode signUp sends name = contact name and no custom:company_name', async () => {
        const { employerSignUp } = await import('@/lib/cognito');

        await employerSignUp({ ...INPUT, companyName: '' }, { invite: true });

        expect(signUpCalls).toHaveLength(1);
        expect(signUpCalls[0].username).toBe('foreman@example.com');
        expect(signUpCalls[0].attributes).toEqual({
            email: 'foreman@example.com',
            name: 'Ana Ruiz',
            phone_number: '+12105550100',
            'custom:user_type': 'employer',
        });
    });

    it('invite mode ignores a company name even when one is passed', async () => {
        const { employerSignUp } = await import('@/lib/cognito');

        await employerSignUp(INPUT, { invite: true });

        expect(signUpCalls[0].attributes.name).toBe('Ana Ruiz');
        expect(signUpCalls[0].attributes).not.toHaveProperty('custom:company_name');
    });

    it('without invite keeps today\'s attributes (name = company name)', async () => {
        const { employerSignUp } = await import('@/lib/cognito');

        await employerSignUp(INPUT);

        expect(signUpCalls[0].attributes).toEqual({
            email: 'foreman@example.com',
            name: 'Acme Builders',
            phone_number: '+12105550100',
            'custom:company_name': 'Acme Builders',
            'custom:user_type': 'employer',
        });
    });
});
