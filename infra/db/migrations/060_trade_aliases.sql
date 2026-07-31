-- Trade Alias Cache: bilingual trade-name/alias cache so the matcher can
-- bridge Spanish/English free-text trades (mirrors trade_questions from 012).
--
-- Forward-only migration. Apply manually through the bastion after review.
--
-- Reuses the jale_ai service role created in 012_ai_trust_assessment.sql;
-- no new role is created here.

-- trade_aliases ---------------------------------------------------------
CREATE TABLE trade_aliases (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_key      TEXT        NOT NULL UNIQUE,      -- normalizeProfession() of the canonical English name
  trade_raw      TEXT        NOT NULL,             -- the raw text that first triggered generation
  canonical_en   TEXT        NOT NULL,
  canonical_es   TEXT        NOT NULL,
  aliases        TEXT[]      NOT NULL,             -- pre-normalized (normalizeProfession applied)
  trade_category TEXT,                             -- matching jobs.trade_category enum value, or NULL
  is_seeded      BOOLEAN     NOT NULL DEFAULT false,
  model_id       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trade_aliases_trade_key ON trade_aliases (trade_key);
CREATE INDEX idx_trade_aliases_aliases ON trade_aliases USING GIN (aliases);

GRANT SELECT, INSERT, UPDATE ON trade_aliases TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON trade_aliases TO jale_ai;
GRANT SELECT ON trade_aliases TO jale_whatsapp;
GRANT SELECT ON trade_aliases TO jale_matching;

-- Seed known trades. Aliases are pre-normalized (lowercase, accents stripped)
-- so a raw cache-key lookup or an ANY(aliases) membership check both work
-- without re-normalizing at read time.
INSERT INTO trade_aliases (trade_key, trade_raw, canonical_en, canonical_es, aliases, trade_category, is_seeded) VALUES
  ('electrician', 'electrician', 'Electrician', 'Electricista',
    ARRAY['electrician','electrical','electricista','electrico','wire','wiring','panel','journeyman'],
    'electrician', true),
  ('plumber', 'plumber', 'Plumber', 'Plomero',
    ARRAY['plumber','plumbing','plomero','fontanero','plomeria','pipe','pipes','fixture','fixtures'],
    'plumber', true),
  ('carpenter', 'carpenter', 'Carpenter', 'Carpintero',
    ARRAY['carpenter','carpentry','carpintero','carpinteria','framer','framing','wood','trim'],
    'carpenter', true),
  ('concrete', 'concrete', 'Concrete', 'Concreto',
    ARRAY['concrete','cement','concreto','cemento','albanil','rebar','formwork','finisher'],
    'concrete', true),
  ('painter', 'painter', 'Painter', 'Pintor',
    ARRAY['painter','painting','paint','pintor','pintura','spray','roller'],
    'painting', true),
  ('drywall', 'drywall', 'Drywall', 'Tablaroquero',
    ARRAY['drywall','drywaller','sheetrock','taper','taping','mud','texture','hanger','tablaroca','tablaroquero'],
    'drywall', true),
  ('welder', 'welder', 'Welder', 'Soldador',
    ARRAY['welder','welding','weld','soldador','soldadura'],
    NULL, true);
