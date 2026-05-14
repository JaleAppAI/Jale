import {
    CognitoUserPool, CognitoUser, CognitoUserAttribute, AuthenticationDetails,
    CognitoUserSession
} from 'amazon-cognito-identity-js';

export type AuthTokens = {
    accessToken: string;
    idToken: string;
    refreshToken: string;
};

const workerPool = new CognitoUserPool({
    UserPoolId: process.env.NEXT_PUBLIC_WORKER_POOL_ID!,
    ClientId: process.env.NEXT_PUBLIC_WORKER_CLIENT_ID!,
});

const employerPool = new CognitoUserPool({
    UserPoolId: process.env.NEXT_PUBLIC_EMPLOYER_POOL_ID!,
    ClientId: process.env.NEXT_PUBLIC_EMPLOYER_CLIENT_ID!,
});

function randomPassword(): string {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes).map((b) => b.toString(36)).join('');
    return `Jale!${token}9aA`;
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
    const phone = input.phone.trim();
    return signUp(workerPool, phone, randomPassword(), {
        phone_number: phone,
        name: input.fullName.trim(),
        'custom:user_type': 'worker',
    });
}

export function workerConfirmSignUp(phone: string, code: string): Promise<void> {
    return confirm(workerPool, phone.trim(), code);
}

export function workerSignIn(phone: string): Promise<CognitoUser> {
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: phone, Pool: workerPool });
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
    return signUp(employerPool, email, input.password, {
        email,
        name: input.companyName.trim(),
        phone_number: input.phone.trim(),
        'custom:company_name': input.companyName.trim(),
        'custom:user_type': 'employer',
    });
}

export function employerConfirmSignUp(email: string, code: string): Promise<void> {
    return confirm(employerPool, email.trim().toLowerCase(), code);
}

export function employerSignIn(email: string, password: string): Promise<AuthTokens> {
    return new Promise((resolve, reject) => {
        const user = new CognitoUser({ Username: email, Pool: employerPool });
        const authDetails = new AuthenticationDetails({ Username: email, Password: password });
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
