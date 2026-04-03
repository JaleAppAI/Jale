import {
    CognitoUserPool, CognitoUser, AuthenticationDetails,
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
