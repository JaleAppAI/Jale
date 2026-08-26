import {
    CognitoUserPool, CognitoUser, CognitoUserAttribute, AuthenticationDetails,
    CognitoUserSession
} from 'amazon-cognito-identity-js';

export type AuthTokens = {
    accessToken: string;
    idToken: string;
    refreshToken: string;
};

// Lazy singletons: constructed on first use, not at module scope. Module-scope
// construction threw during `next build`'s page-data collection whenever the
// NEXT_PUBLIC_* env vars were absent (e.g. a clean checkout with no .env),
// which broke the build even though the pages that use these pools are
// force-dynamic and never actually need a pool at build time.
let workerPoolInstance: CognitoUserPool | undefined;
let employerPoolInstance: CognitoUserPool | undefined;

function getWorkerPool(): CognitoUserPool {
    if (!workerPoolInstance) {
        const UserPoolId = process.env.NEXT_PUBLIC_WORKER_POOL_ID;
        const ClientId = process.env.NEXT_PUBLIC_WORKER_CLIENT_ID;
        const missing = [
            !UserPoolId && 'NEXT_PUBLIC_WORKER_POOL_ID',
            !ClientId && 'NEXT_PUBLIC_WORKER_CLIENT_ID',
        ].filter(Boolean);
        if (missing.length > 0) {
            throw new Error(`Missing required env var(s): ${missing.join(', ')}`);
        }
        workerPoolInstance = new CognitoUserPool({ UserPoolId: UserPoolId!, ClientId: ClientId! });
    }
    return workerPoolInstance;
}

function getEmployerPool(): CognitoUserPool {
    if (!employerPoolInstance) {
        const UserPoolId = process.env.NEXT_PUBLIC_EMPLOYER_POOL_ID;
        const ClientId = process.env.NEXT_PUBLIC_EMPLOYER_CLIENT_ID;
        const missing = [
            !UserPoolId && 'NEXT_PUBLIC_EMPLOYER_POOL_ID',
            !ClientId && 'NEXT_PUBLIC_EMPLOYER_CLIENT_ID',
        ].filter(Boolean);
        if (missing.length > 0) {
            throw new Error(`Missing required env var(s): ${missing.join(', ')}`);
        }
        employerPoolInstance = new CognitoUserPool({ UserPoolId: UserPoolId!, ClientId: ClientId! });
    }
    return employerPoolInstance;
}

function signUp(
    pool: CognitoUserPool,
    username: string,
    password: string,
    attributes: Record<string, string>,
): Promise<void> {
    const attrs = Object.entries(attributes)
        .filter(([, Value]) => Value.trim().length > 0)
        .map(([Name, Value]) => new CognitoUserAttribute({ Name, Value }));

    return new Promise((resolve, reject) => {
        pool.signUp(username, password, attrs, [], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function confirm(pool: CognitoUserPool, username: string, code: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: username, Pool: pool });
        user.confirmRegistration(code, true, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

export function workerSignUp(input: { phone: string; fullName: string }): Promise<void> {
    return workerWebSignUp(input);
}

export function workerConfirmSignUp(phone: string, code: string): Promise<void> {
    return confirm(getWorkerPool(), phone.trim(), code);
}

export function workerSignIn(phone: string): Promise<CognitoUser> {
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: phone, Pool: getWorkerPool() });
        const authDetails = new AuthenticationDetails({ Username: phone });
        user.initiateAuth(authDetails, {
            onSuccess: () => reject(new Error('Unexpected success on initiate')),
            onFailure: reject,
            customChallenge: () => resolve(user),
        });
    });
}

export function workerVerifyOtp(user: CognitoUser, otp: string): Promise<AuthTokens> {
    return new Promise((resolve, reject) => {
        user.sendCustomChallengeAnswer(otp, {
            onSuccess: (session: CognitoUserSession) => resolve({
                accessToken: session.getAccessToken().getJwtToken(),
                idToken: session.getIdToken().getJwtToken(),
                refreshToken: session.getRefreshToken().getToken(),
            }),
            onFailure: reject,
        });
    });
}

export function employerSignUp(input: {
    email: string;
    password: string;
    companyName: string;
    contactName: string;
    phone: string;
}): Promise<void> {
    const email = input.email.trim().toLowerCase();
    return signUp(getEmployerPool(), email, input.password, {
        email,
        name: input.companyName.trim(),
        phone_number: input.phone.trim(),
        'custom:company_name': input.companyName.trim(),
        'custom:user_type': 'employer',
    });
}

export function employerConfirmSignUp(email: string, code: string): Promise<void> {
    return confirm(getEmployerPool(), email.trim().toLowerCase(), code);
}

/**
 * Sends a fresh confirmation code to an unconfirmed employer.
 *
 * Unauthenticated by design — the whole point is that the user cannot get in
 * yet. The app client is created with `generateSecret: false`, so there is no
 * SecretHash to compute here.
 *
 * `resendConfirmationCode` is node-style (a single `(err) => void` callback),
 * NOT the `{ onSuccess, onFailure }` shape the neighbouring `forgotPassword`
 * and `confirmPassword` calls use. Passing an object here would leave the
 * promise pending forever.
 *
 * The username is normalised the same way `employerConfirmSignUp` normalises
 * it, so a user who typed `Foo@Example.com` reaches the same Cognito record on
 * the resend and on the confirm that follows it.
 */
export function employerResendConfirmationCode(email: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: getEmployerPool() });
        user.resendConfirmationCode((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * The username is normalised exactly as every other employer call normalises it
 * (`employerSignUp`, `employerConfirmSignUp`, `employerResendConfirmationCode`,
 * `employerForgotPassword`, `employerConfirmNewPassword`). This was the one
 * that did not, so a user who typed `Foo@Example.com` had the account created,
 * the code sent and the confirm applied against `foo@example.com`, and was then
 * authenticated against a different username string — the confirm succeeded and
 * the sign-in immediately behind it failed. Both constructors read the same
 * normalised value; normalising only one of them would still send Cognito a
 * mismatched pair. The password is untouched: leading and trailing spaces are
 * legal password characters.
 */
export function employerSignIn(email: string, password: string): Promise<AuthTokens> {
    const username = email.trim().toLowerCase();
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: username, Pool: getEmployerPool() });
        const authDetails = new AuthenticationDetails({ Username: username, Password: password });
        user.authenticateUser(authDetails, {
            onSuccess: (session) => resolve({
                accessToken: session.getAccessToken().getJwtToken(),
                idToken: session.getIdToken().getJwtToken(),
                refreshToken: session.getRefreshToken().getToken(),
            }),
            onFailure: reject,
        });
    });
}

export function employerForgotPassword(email: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: getEmployerPool() });
        user.forgotPassword({
            onSuccess: () => resolve(),
            onFailure: reject,
        });
    });
}

export function employerConfirmNewPassword(
    email: string,
    code: string,
    newPassword: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: getEmployerPool() });
        user.confirmPassword(code.trim(), newPassword, {
            onSuccess: () => resolve(),
            onFailure: reject,
        });
    });
}

async function workerWebSignUp(input: { phone: string; fullName: string }): Promise<void> {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/worker/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            phone: input.phone.trim(),
            fullName: input.fullName.trim(),
        }),
    });

    if (res.ok) return;

    let body: { error?: string; message?: string } = {};
    try {
        body = await res.json();
    } catch {
        // Keep the generic message below.
    }

    const err = new Error(body.message || 'Worker signup failed') as Error & { code?: string };
    err.code =
        body.error === 'account_exists' ? 'UsernameExistsException' :
            body.error === 'invalid_phone' ? 'InvalidParameterException' :
                body.error === 'too_many_attempts' ? 'TooManyRequestsException' :
                    'WorkerSignupException';
    throw err;
}
