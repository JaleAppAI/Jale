/**
 * seed-trade-questions.test.ts
 *
 * scripts/seed-trade-questions.ps1 UPSERTs the five standard trades'
 * trade_questions rows (`ON CONFLICT (profession_key) DO UPDATE`). Migration
 * 086 Part 4 rewrote those same five rows as open-ended questions. If the two
 * ever drift, an operator rerunning the script silently reverts the migration
 * and puts "What is your seniority level?" back in front of workers.
 *
 * This test parses BOTH files -- no third copy of the text lives here -- and
 * compares the JSON, so it checks meaning rather than formatting.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const migrationPath = path.join(
  repoRoot, 'infra', 'db', 'migrations',
  '086_trust_extractions_and_web_onboarding.sql',
);
const scriptPath = path.join(repoRoot, 'scripts', 'seed-trade-questions.ps1');

const TRADES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting'] as const;

interface Question { q_en: string; q_es: string }

function parseQuestions(raw: string, where: string): Question[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${where}: questions literal is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${where}: questions literal is not an array`);
  return parsed as Question[];
}

/** The five `UPDATE trade_questions SET questions = '[...]'` literals in 086. */
function migrationQuestions(): Map<string, Question[]> {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const pattern =
    /UPDATE trade_questions SET questions = '(\[[\s\S]*?\])'::jsonb\s*\n\s*WHERE is_seeded = true AND profession_key = '([a-z]+)';/g;
  const out = new Map<string, Question[]>();
  for (const match of sql.matchAll(pattern)) {
    out.set(match[2], parseQuestions(match[1], `086 ${match[2]}`));
  }
  return out;
}

/** The five `('key', 'raw', '[...]'::jsonb, true)` tuples in the PowerShell heredoc. */
function scriptQuestions(): Map<string, { raw: string; questions: Question[] }> {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const pattern = /\('([a-z]+)',\s*'([a-z]+)',\s*'(\[[\s\S]*?\])'::jsonb,\s*true\)/g;
  const out = new Map<string, { raw: string; questions: Question[] }>();
  for (const match of script.matchAll(pattern)) {
    out.set(match[1], {
      raw: match[2],
      questions: parseQuestions(match[3], `seed script ${match[1]}`),
    });
  }
  return out;
}

describe('seed-trade-questions.ps1 stays in lockstep with migration 086 Part 4', () => {
  const fromMigration = migrationQuestions();
  const fromScript = scriptQuestions();

  it('covers exactly the five standard trades in both files', () => {
    expect([...fromMigration.keys()].sort()).toEqual([...TRADES].sort());
    expect([...fromScript.keys()].sort()).toEqual([...TRADES].sort());
  });

  it.each(TRADES)('seeds %s with the exact questions migration 086 writes', (trade) => {
    const migration = fromMigration.get(trade);
    const script = fromScript.get(trade);
    expect(migration).toBeDefined();
    expect(script).toBeDefined();
    expect(script!.questions).toEqual(migration!);
    // profession_raw must match profession_key, as 012 seeded it -- 086 never
    // rewrites that column, so a mismatch here would be invisible to a
    // questions-only comparison and would silently create a second row.
    expect(script!.raw).toBe(trade);
  });

  it.each(TRADES)('asks %s three open questions with no years, seniority or numbered options', (trade) => {
    const questions = fromScript.get(trade)!.questions;
    expect(questions).toHaveLength(3);

    const forbiddenEn = /years|how long|seniority|\b[1-3]\.\s/i;
    const forbiddenEs = /años|cuánto tiempo|antigüedad|\b[1-3]\.\s/i;
    for (const question of questions) {
      expect(typeof question.q_en).toBe('string');
      expect(typeof question.q_es).toBe('string');
      expect(question.q_en).not.toMatch(forbiddenEn);
      expect(question.q_es).not.toMatch(forbiddenEs);
      expect(question.q_en.trim().endsWith('?')).toBe(true);
      expect(question.q_es.trim().endsWith('?')).toBe(true);
    }
  });

  it('no longer contains the retired seniority-level prompt anywhere', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    // The header explains what was replaced, so scope the negative to the SQL
    // heredoc's INSERT block rather than the whole file.
    const insertBlock = script.slice(
      script.indexOf('INSERT INTO trade_questions'),
      script.indexOf('ON CONFLICT (profession_key)'),
    );
    expect(insertBlock).not.toMatch(/seniority/i);
    expect(insertBlock).not.toMatch(/nivel de experiencia/i);
  });

  it('still upserts, so a rerun repairs rather than duplicates rows', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    expect(script).toContain('ON CONFLICT (profession_key) DO UPDATE');
    expect(script).toContain('is_seeded  = true');
    // It must never resurrect the AI-generated cache rows migration 086
    // deletes; it only ever touches the five standard profession_keys.
    expect(script).not.toMatch(/is_seeded\s*=\s*false/);
  });
});
