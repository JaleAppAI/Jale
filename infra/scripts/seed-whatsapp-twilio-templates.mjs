import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';

const SECRET_ID = 'jale/whatsapp/twilio';
const REGION = process.env.AWS_REGION ?? 'us-east-2';

const NEW_TEMPLATES = {
  onboarding_voice_choice_es: 'HXc5c30aac43f61d77aed3cb7578106947',
  onboarding_voice_choice_en: 'HX5722c3b606311e688308320f2c9bdc0c',
  onboarding_photo_type_es: 'HXaf78fd6b485523fcf96d739da5f78320',
  onboarding_photo_type_en: 'HX6e1f86a6032b876b5b1c9359adf8a080',
  onboarding_photo_skip_es: 'HX6534a7132d334a5ad03bde8142d6961e',
  onboarding_photo_skip_en: 'HXfc65b30cdada3cae815436b1f80b8ca5',
  onboarding_availability_es: 'HX07a3cb3d9a522a317bd0289c33457ee7',
  onboarding_availability_en: 'HX81a27a7572343576a46db4009f15cfc4',
  onboarding_experience_es: 'HX1ca983ca5d7975a122f9b26dbb27bac9',
  onboarding_experience_en: 'HXa85d15d0c553a72236886aa037da1501',
  onboarding_transportation_es: 'HX532e5cbbc7ea076b584a2ad05f9a283e',
  onboarding_transportation_en: 'HXd64cfab2b317e21c2461cd42b2983b6f',
  onboarding_trade_en: 'HX5de9da29c61f41a3580d8d4832cfad41',
  onboarding_trade_es: 'HXd2e03da923913d234e5a82d4949c8993',
  onboarding_legal_es: 'HX6e8f6ae97297c17176301919f705a840',
  onboarding_legal_en: 'HX30852732ef43c3c67d0901667f74b965',
  employer_message_invite_en: 'HXdb0d6516df17379835c8b669cf66e2c6',
  employer_message_invite_es: 'HX0c2d10546a96bfe3453e3b76f9432231',
  employer_message_resume_en: 'HXf6f08652c231c555ed7e755b77740672',
  employer_message_resume_es: 'HX2966e5a109ca7035f78aef898eda7db3',
};

function parseSecret(secretString) {
  try {
    return JSON.parse(secretString);
  } catch (err) {
    throw new Error(`Failed to parse Twilio secret JSON: ${err.message}`);
  }
}

function mergeTemplates(existing) {
  const templates = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...NEW_TEMPLATES,
  };
  return templates;
}

async function main() {
  const client = new SecretsManagerClient({ region: REGION });

  const current = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  if (!current.SecretString) {
    throw new Error(`Secret ${SECRET_ID} is empty`);
  }

  const secret = parseSecret(current.SecretString);
  const templates = mergeTemplates(secret.templates);
  const nextSecret = { ...secret, templates };

  const verifyBeforeWrite = Object.fromEntries(
    Object.entries(NEW_TEMPLATES).filter(([key, value]) => templates[key] !== value),
  );
  if (Object.keys(verifyBeforeWrite).length > 0) {
    throw new Error(`Template merge failed before write: ${Object.keys(verifyBeforeWrite).join(', ')}`);
  }

  const nextSecretString = JSON.stringify(nextSecret);
  if (nextSecretString !== current.SecretString) {
    await client.send(
      new UpdateSecretCommand({
        SecretId: SECRET_ID,
        SecretString: nextSecretString,
      }),
    );
  }

  const verified = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const verifiedSecret = parseSecret(verified.SecretString ?? '{}');
  const missing = Object.entries(NEW_TEMPLATES)
    .filter(([key, value]) => verifiedSecret.templates?.[key] !== value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Secret update did not persist these template keys: ${missing.join(', ')}`);
  }

  const templateCount = Object.keys(verifiedSecret.templates ?? {}).length;
  console.log(`Updated ${SECRET_ID} in ${REGION}; verified ${Object.keys(NEW_TEMPLATES).length} onboarding SIDs and ${templateCount} total template entries.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
