import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

type TwilioSecret = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
};

const secretsManager = new SecretsManagerClient({});
let cachedSecret: TwilioSecret | undefined;

async function getTwilioSecret(): Promise<TwilioSecret> {
  if (cachedSecret) return cachedSecret;

  const secretId = process.env.TWILIO_SECRET_ARN?.trim();
  if (!secretId) {
    throw new Error('TWILIO_SECRET_ARN is required for admin WhatsApp replies');
  }

  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) {
    throw new Error('Twilio secret response did not include SecretString');
  }

  cachedSecret = JSON.parse(result.SecretString) as TwilioSecret;
  return cachedSecret;
}

export async function sendAdminWhatsAppMessage(phone: string, body: string): Promise<string> {
  const secret = await getTwilioSecret();
  const normalizedPhone = phone.startsWith('+') ? phone : `+${phone.replace(/\D/g, '')}`;
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${secret.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${secret.accountSid}:${secret.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        MessagingServiceSid: secret.messagingServiceSid,
        To: `whatsapp:${normalizedPhone}`,
        Body: body,
      }).toString(),
    },
  );

  if (!response.ok) {
    throw new Error(`Twilio rejected the WhatsApp reply (${response.status}): ${await response.text()}`);
  }

  const result = await response.json() as { sid?: string };
  if (!result.sid) throw new Error('Twilio accepted the request without returning a message SID');
  return result.sid;
}
