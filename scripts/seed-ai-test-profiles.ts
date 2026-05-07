/**
 * Seed 5 AI test profiles for Sprint 7 manual review.
 *
 * Usage (from repo root, with DB access via bastion or local tunnel):
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx ts-node scripts/seed-ai-test-profiles.ts
 *
 * Each profile has ai_test_profile=TRUE in worker_profile_ai_extractions.
 * Find them with the query in the Sprint 7 design doc.
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const TEST_PROFILES = [
  {
    phone: '+19990000001',
    full_name: 'Carlos Mendoza',
    city: 'San Antonio',
    main_trade: 'electrician',
    years_experience: '5-9',
    has_transportation: true,
    availability: 'full_time',
    language: 'es',
    transcript: 'Soy electricista con seis años de experiencia. Trabajo en San Antonio. Tengo transporte propio y estoy disponible tiempo completo.',
    extracted_fields: { city: 'San Antonio', main_trade: 'electrician', years_experience: '5-9', has_transportation: true, availability: 'full_time' },
    confidence_scores: { city: 0.95, main_trade: 0.98, years_experience: 0.90, has_transportation: 0.92, availability: 0.88 },
    summary_en: 'Electrician in San Antonio with 5-9 years of experience, available full-time.',
    summary_es: 'Electricista en San Antonio con 5-9 años de experiencia, disponible tiempo completo.',
  },
  {
    phone: '+19990000002',
    full_name: 'Maria Gonzalez',
    city: 'Austin',
    main_trade: 'painting',
    years_experience: '2-4',
    has_transportation: false,
    availability: 'part_time',
    language: 'es',
    transcript: 'Me llamo Maria y soy pintora. Tengo como tres años de experiencia. Estoy en Austin pero no tengo carro. Solo puedo trabajar medio tiempo.',
    extracted_fields: { full_name: 'Maria', city: 'Austin', main_trade: 'painting', years_experience: '2-4', has_transportation: false, availability: 'part_time' },
    confidence_scores: { full_name: 0.80, city: 0.92, main_trade: 0.96, years_experience: 0.85, has_transportation: 0.93, availability: 0.88 },
    summary_en: 'Painter in Austin with 2-4 years of experience, part-time availability, no transportation.',
    summary_es: 'Pintora en Austin con 2-4 años de experiencia, disponible medio tiempo, sin transporte.',
  },
  {
    phone: '+19990000003',
    full_name: 'James Thompson',
    city: 'Houston',
    main_trade: 'plumber',
    years_experience: '10+',
    has_transportation: true,
    availability: 'flexible',
    language: 'en',
    transcript: 'Hi, I\'m James. I\'ve been a plumber for over 12 years, mostly commercial work in Houston. I have my own truck and I\'m pretty flexible with my schedule.',
    extracted_fields: { full_name: 'James', city: 'Houston', main_trade: 'plumber', years_experience: '10+', has_transportation: true, availability: 'flexible' },
    confidence_scores: { full_name: 0.88, city: 0.95, main_trade: 0.97, years_experience: 0.92, has_transportation: 0.94, availability: 0.83 },
    summary_en: 'Experienced plumber in Houston with 10+ years of commercial work, flexible schedule.',
    summary_es: 'Plomero experimentado en Houston con más de 10 años de trabajo comercial, horario flexible.',
  },
  {
    phone: '+19990000004',
    full_name: 'Robert Kim',
    city: 'Dallas',
    main_trade: 'carpenter',
    years_experience: '0-1',
    has_transportation: true,
    availability: 'weekends',
    language: 'en',
    transcript: 'My name is Robert. I just started doing carpentry work, less than a year. I\'m in Dallas. I have a car. Right now I\'m only available on weekends because of my other job.',
    extracted_fields: { full_name: 'Robert', city: 'Dallas', main_trade: 'carpenter', years_experience: '0-1', has_transportation: true, availability: 'weekends' },
    confidence_scores: { full_name: 0.85, city: 0.90, main_trade: 0.89, years_experience: 0.87, has_transportation: 0.91, availability: 0.93 },
    summary_en: 'Entry-level carpenter in Dallas, available weekends only.',
    summary_es: 'Carpintero principiante en Dallas, disponible solo los fines de semana.',
  },
  {
    phone: '+19990000005',
    full_name: 'Luis Vega',
    city: 'El Paso',
    main_trade: 'concrete',
    years_experience: '5-9',
    has_transportation: null,
    availability: 'full_time',
    language: 'es',
    transcript: 'Trabajo en concreto, tengo como siete años. Soy de El Paso. Quiero trabajar tiempo completo.',
    extracted_fields: { city: 'El Paso', main_trade: 'concrete', years_experience: '5-9', availability: 'full_time' },
    confidence_scores: { city: 0.91, main_trade: 0.94, years_experience: 0.88, availability: 0.86, has_transportation: 0.30 },
    summary_en: 'Concrete worker in El Paso with 5-9 years of experience, seeking full-time work.',
    summary_es: 'Trabajador de concreto en El Paso con 5-9 años de experiencia, busca trabajo tiempo completo.',
  },
];

const BEDROCK_MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';

async function main() {
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'jale',
    user: process.env.DB_USER ?? 'jale_admin',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true'
      ? {
          rejectUnauthorized: true,
          ca: fs.readFileSync(
            path.join(__dirname, '../infra/lambda/lib/rds-ca-bundle.pem'),
            'utf-8',
          ),
        }
      : false,
  });

  await client.connect();

  try {
    await client.query('BEGIN');

    for (const profile of TEST_PROFILES) {
      // Insert or find user by phone
      const userRes = await client.query<{ id: string }>(
        `INSERT INTO users
           (cognito_sub, user_type, phone, full_name, city, main_trade,
            years_experience, has_transportation, availability)
         VALUES
           ($1, 'worker', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (phone) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               city = EXCLUDED.city,
               main_trade = EXCLUDED.main_trade,
               years_experience = EXCLUDED.years_experience,
               has_transportation = EXCLUDED.has_transportation,
               availability = EXCLUDED.availability
         RETURNING id`,
        [
          `test-sub-${profile.phone}`,
          profile.phone,
          profile.full_name,
          profile.city,
          profile.main_trade,
          profile.years_experience,
          profile.has_transportation,
          profile.availability,
        ],
      );
      const userId = userRes.rows[0].id;

      // Insert a voice_message media row (no real S3 key for test profiles)
      const mediaRes = await client.query<{ id: string }>(
        `INSERT INTO worker_profile_media
           (user_id, media_type, s3_key, content_type)
         VALUES ($1, 'voice_message', $2, 'audio/ogg')
         RETURNING id`,
        [userId, `${userId}/voice-messages/test-seed`],
      );
      const mediaId = mediaRes.rows[0].id;

      // Insert the AI extraction row
      await client.query(
        `INSERT INTO worker_profile_ai_extractions
           (user_id, voice_message_media_id, bedrock_model_id,
            transcript_text, extracted_fields, confidence_scores,
            status, ai_test_profile)
         VALUES ($1, $2, $3, $4, $5, $6, 'completed', TRUE)`,
        [
          userId,
          mediaId,
          BEDROCK_MODEL_ID,
          profile.transcript,
          JSON.stringify(profile.extracted_fields),
          JSON.stringify(profile.confidence_scores),
        ],
      );

      console.log(`Seeded: ${profile.full_name} (${profile.phone}) → userId ${userId}`);
    }

    await client.query('COMMIT');
    console.log('\nAll 5 test profiles seeded. Verify with:');
    console.log(`SELECT u.full_name, u.main_trade, e.status, e.extracted_fields
FROM worker_profile_ai_extractions e
JOIN users u ON u.id = e.user_id
WHERE e.ai_test_profile = TRUE;`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
