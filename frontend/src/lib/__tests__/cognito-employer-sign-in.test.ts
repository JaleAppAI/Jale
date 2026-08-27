import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `employerSignIn` was the only employer Cognito call that used the raw typed
 * address. Every sibling (`employerSignUp`, `employerConfirmSignUp`,
 * `employerResendConfirmationCode`, `employerForgotPassword`,
 * `employerConfirmNewPassword`) normalises with `.trim().toLowerCase()`, so a
 * user who typed `Foo@Example.com` had their code sent to — and confirmed
 * against — `foo@example.com`, and was then signed in against a DIFFERENT
 * username string. That mismatch is the root cause behind the
 * confirm-then-sign-in failures the confirm step now has to apologise for.
 *
 * Both constructors matter and are asserted separately: the sign-in path built
 * `CognitoUser` and `AuthenticationDetails` from two independent uses of the
 * same raw value, so normalising only one of them would still send Cognito a
 * mismatched pair.
 *
 * The pools are lazy singletons built from `NEXT_PUBLIC_*`, so the SDK is
 * mocked wholesale and the env vars only have to be non-empty — nothing here
 * reaches the network.
 */

type ConstructedUser = { Username: string; Pool: unknown };
type ConstructedAuthDetails = { Username: string; Password: string };

const constructedUsers: ConstructedUser[] = [];
const constructedAuthDetails: ConstructedAuthDetails[] = [];

/** The minimum of `CognitoUserSession` that `employerSignIn` reads. */
const fakeSession = {
    getAccessToken: () => ({ getJwtToken: () => 'access-token' }),
    getIdToken: () => ({ getJwtToken: () => 'id-token' }),
    getRefreshToken: () => ({ getToken: () => 'refresh-token' }),
};

vi.mock('amazon-cognito-identity-js', () => {
    class CognitoUserPool {
        constructor(readonly config: { UserPoolId: string; ClientId: string }) {}
    }
    class CognitoUserAttribute {
        constructor(readonly attribute: { Name: string; Value: string }) {}
    }
    class AuthenticationDetails {
        constructor(details: { Username: string; Password: string }) {
            constructedAuthDetails.push(details);
        }
    }
    class CognitoUser {
        constructor(details: { Username: string; Pool: unknown }) {
            constructedUsers.push(details);
        }
        authenticateUser(
            _details: unknown,
            callbacks: { onSuccess: (session: typeof fakeSession) => void; onFailure: (err: unknown) => void },
        ) {
            callbacks.onSuccess(fakeSession);
        }
    }
    return { CognitoUserPool, CognitoUser, CognitoUserAttribute, AuthenticationDetails };
});

beforeEach(() => {
    constructedUsers.length = 0;
    constructedAuthDetails.length = 0;
    vi.stubEnv('NEXT_PUBLIC_EMPLOYER_POOL_ID', 'us-east-1_test');
    vi.stubEnv('NEXT_PUBLIC_EMPLOYER_CLIENT_ID', 'test-client-id');
});

describe('employerSignIn', () => {
    it('normalises the username the same way every other employer call does', async () => {
        const { employerSignIn } = await import('@/lib/cognito');

        await employerSignIn('  Foo@Example.com ', 'S3cret!pass');

        expect(constructedUsers).toHaveLength(1);
        expect(constructedUsers[0].Username).toBe('foo@example.com');
    });

    it('normalises the AuthenticationDetails username too, not just the user', async () => {
        const { employerSignIn } = await import('@/lib/cognito');

        await employerSignIn('  Foo@Example.com ', 'S3cret!pass');

        expect(constructedAuthDetails).toHaveLength(1);
        expect(constructedAuthDetails[0].Username).toBe('foo@example.com');
        // The password is deliberately untouched: leading or trailing spaces
        // are legal Cognito password characters, and trimming one would lock
        // out an account that was created with it.
        expect(constructedAuthDetails[0].Password).toBe('S3cret!pass');
    });

    it('hands back the three tokens from the session', async () => {
        const { employerSignIn } = await import('@/lib/cognito');

        await expect(employerSignIn('employer@example.com', 'S3cret!pass')).resolves.toEqual({
            accessToken: 'access-token',
            idToken: 'id-token',
            refreshToken: 'refresh-token',
        });
    });
});
