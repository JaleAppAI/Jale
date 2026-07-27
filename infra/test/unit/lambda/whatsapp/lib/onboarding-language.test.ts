// infra/test/unit/lambda/whatsapp/lib/onboarding-language.test.ts
//
// Pure module: nothing is mocked, no clock is faked. `now` is injected.

import {
  parseLanguageChoice, detectCommandLang, resolveResponseLanguage,
  isLanguageCommand, isResendCommand, isReviewTermsCommand, isOnboardingHelpCommand,
  isRestartCommand, isBackCommand,
  classifyBlockedCommand, classifyBlockedCommandExact,
  evaluateStartCooldown, shouldRepeatPrompt, appendSendTimestamp,
  START_COOLDOWN_MS, START_DAILY_CAP, REPROMPT_COOLDOWN_MS,
} from '../../../../../lambda/whatsapp/lib/onboarding-language';

const T0 = new Date('2026-07-21T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('parseLanguageChoice', () => {
  it('maps START to en and EMPEZAR to es', () => {
    expect(parseLanguageChoice('START')).toBe('en');
    expect(parseLanguageChoice('  empezar ')).toBe('es');
  });

  it('maps the interactive payloads', () => {
    expect(parseLanguageChoice('', 'start:lang:en')).toBe('en');
    expect(parseLanguageChoice('', 'start:lang:es')).toBe('es');
  });

  it('returns null for unrelated text', () => {
    expect(parseLanguageChoice('hello there')).toBeNull();
  });
});

describe('resolveResponseLanguage', () => {
  it('answers a command in the command language', () => {
    expect(resolveResponseLanguage('es', 'HELP', false)).toBe('en');
    expect(resolveResponseLanguage('en', 'AYUDA', false)).toBe('es');
  });

  it('always uses the preferred language for interactive taps', () => {
    expect(resolveResponseLanguage('es', 'HELP', true)).toBe('es');
  });

  it('uses the preferred language for non-command free text', () => {
    expect(resolveResponseLanguage('es', 'Juan Perez', false)).toBe('es');
  });
});

describe('command recognizers', () => {
  it.each(['LANGUAGE', 'idioma'])('recognizes %s as the language command', (b) => {
    expect(isLanguageCommand(b)).toBe(true);
  });

  it.each(['RESEND', 'reenviar'])('recognizes %s as resend', (b) => {
    expect(isResendCommand(b)).toBe(true);
  });

  it.each(['REVIEW TERMS', 'revisar terminos', 'REVISAR TÉRMINOS'])(
    'recognizes %s as review-terms', (b) => {
      expect(isReviewTermsCommand(b)).toBe(true);
    });

  it.each(['HELP', 'ayuda'])('recognizes %s as onboarding help', (b) => {
    expect(isOnboardingHelpCommand(b)).toBe(true);
  });

  it('does not recognize a step answer as a command', () => {
    expect(isLanguageCommand('Juan Perez')).toBe(false);
    expect(isResendCommand('78701')).toBe(false);
  });

  it('applies 1-edit fuzzy tolerance to families outside flows.ts COMMAND_KEYWORDS', () => {
    expect(isResendCommand('resendd')).toBe(true);
    expect(isResendCommand('reenvia')).toBe(true);
    expect(isLanguageCommand('idiona')).toBe(true);
    expect(isLanguageCommand('languag')).toBe(true);
  });

  it('keeps the whitespace and length guards for the fuzzy fallback', () => {
    expect(isResendCommand('resent me')).toBe(false);
    expect(isResendCommand('res')).toBe(false);
  });
});

describe('isRestartCommand / isBackCommand — exact match only', () => {
  it.each(['RESTART', 'restart', ' Restart ', 'REINICIAR', 'reiniciar'])(
    'recognizes %s as restart', (b) => {
      expect(isRestartCommand(b)).toBe(true);
    });

  it.each(['BACK', 'back', ' Back ', 'ATRAS', 'atras', 'ATRÁS', 'atrás'])(
    'recognizes %s as back', (b) => {
      expect(isBackCommand(b)).toBe(true);
    });

  it('does not fuzzy-match a near-miss (unlike the resend/language families)', () => {
    expect(isRestartCommand('restar')).toBe(false);
    expect(isRestartCommand('restartt')).toBe(false);
    expect(isBackCommand('bac')).toBe(false);
    expect(isBackCommand('backk')).toBe(false);
  });

  it('does not recognize a step answer as restart/back', () => {
    expect(isRestartCommand('Juan Perez')).toBe(false);
    expect(isBackCommand('78701')).toBe(false);
    expect(isRestartCommand('')).toBe(false);
    expect(isBackCommand('')).toBe(false);
  });

  it('is exact-only: extra words disqualify the match', () => {
    expect(isRestartCommand('please restart')).toBe(false);
    expect(isBackCommand('go back')).toBe(false);
  });
});

describe('classifyBlockedCommand', () => {
  it.each([
    ['JOBS', 'jobs'], ['trabajos', 'jobs'],
    ['CHATS', 'chats'], ['mensajes', 'chats'],
    ['PROFILE', 'profile'], ['perfil', 'profile'],
  ])('classifies %s as %s', (body, expected) => {
    expect(classifyBlockedCommand(body)).toBe(expected);
  });

  it('returns null for a step answer', () => {
    expect(classifyBlockedCommand('Austin, TX')).toBeNull();
  });

  it('fuzzy-catches a near-miss name — precisely the behavior that makes it unsafe at free-text steps', () => {
    expect(classifyBlockedCommand('Chata')).toBe('chats');
  });
});

describe('classifyBlockedCommandExact', () => {
  it.each([
    ['JOBS', 'jobs'], ['jobs', 'jobs'], ['trabajos', 'jobs'], ['TRABAJOS', 'jobs'],
    ['CHATS', 'chats'], ['chats', 'chats'], ['mensajes', 'chats'], ['MENSAJES', 'chats'],
    ['PROFILE', 'profile'], ['profile', 'profile'], ['perfil', 'profile'], ['PERFIL', 'profile'],
  ])('classifies exact %s as %s', (body, expected) => {
    expect(classifyBlockedCommandExact(body)).toBe(expected);
  });

  it.each(['Chata', 'trabjos', 'profil'])(
    'returns null for the near-miss %s that fuzzy matching (classifyBlockedCommand) would catch',
    (body) => {
      expect(classifyBlockedCommand(body)).not.toBeNull();
      expect(classifyBlockedCommandExact(body)).toBeNull();
    },
  );

  it('returns null for "Perla" — not actually within fuzzy edit-distance 1 of "perfil"/"profile", but still exercised as a plausible false-positive name', () => {
    expect(classifyBlockedCommandExact('Perla')).toBeNull();
  });

  it('returns null for ordinary free text', () => {
    expect(classifyBlockedCommandExact('Austin, TX')).toBeNull();
    expect(classifyBlockedCommandExact('Juan Perez')).toBeNull();
  });
});

describe('evaluateStartCooldown', () => {
  it('allows the first invitation', () => {
    expect(evaluateStartCooldown([], T0)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('blocks a second invitation inside 10 minutes', () => {
    const history = [T0.toISOString()];
    expect(evaluateStartCooldown(history, at(START_COOLDOWN_MS - 1)))
      .toEqual({ allowed: false, reason: 'cooldown' });
  });

  it('allows one after the cooldown', () => {
    const history = [T0.toISOString()];
    expect(evaluateStartCooldown(history, at(START_COOLDOWN_MS)))
      .toEqual({ allowed: true, reason: 'ok' });
  });

  it('blocks the sixth in 24 hours', () => {
    const history = Array.from({ length: START_DAILY_CAP },
      (_, i) => at(i * START_COOLDOWN_MS).toISOString());
    const now = at(START_DAILY_CAP * START_COOLDOWN_MS + START_COOLDOWN_MS);
    expect(evaluateStartCooldown(history, now))
      .toEqual({ allowed: false, reason: 'daily_cap' });
  });

  it('does not count sends older than 24 hours', () => {
    const history = Array.from({ length: START_DAILY_CAP },
      (_, i) => at(i * START_COOLDOWN_MS).toISOString());
    const now = at(25 * 60 * 60 * 1000);
    expect(evaluateStartCooldown(history, now)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('ignores a future-dated entry (clock skew / bad data) instead of treating it as recent', () => {
    const history = [at(60 * 60 * 1000).toISOString()]; // 1 hour in the future
    expect(evaluateStartCooldown(history, T0)).toEqual({ allowed: true, reason: 'ok' });
  });
});

describe('shouldRepeatPrompt', () => {
  it('is true when never repeated', () => {
    expect(shouldRepeatPrompt(null, T0)).toBe(true);
  });

  it('is false inside 30 seconds', () => {
    expect(shouldRepeatPrompt(T0.toISOString(), at(REPROMPT_COOLDOWN_MS - 1))).toBe(false);
  });

  it('is true after 30 seconds', () => {
    expect(shouldRepeatPrompt(T0.toISOString(), at(REPROMPT_COOLDOWN_MS))).toBe(true);
  });
});

describe('appendSendTimestamp', () => {
  it('appends now and prunes entries older than 24 hours', () => {
    const old = new Date(T0.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const result = appendSendTimestamp([old, T0.toISOString()], at(60_000));
    expect(result).not.toContain(old);
    expect(result).toContain(at(60_000).toISOString());
    expect(result).toHaveLength(2);
  });

  it('returns entries in ascending chronological order', () => {
    const history = [at(2000).toISOString(), T0.toISOString(), at(1000).toISOString()];
    const result = appendSendTimestamp(history, at(3000));
    const timestamps = result.map((iso) => Date.parse(iso));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(result).toEqual([
      T0.toISOString(), at(1000).toISOString(), at(2000).toISOString(), at(3000).toISOString(),
    ]);
  });
});

describe('purity', () => {
  it('detectCommandLang delegates without side effects', () => {
    expect(detectCommandLang('AYUDA')).toBe('es');
    expect(detectCommandLang('Juan Perez')).toBeNull();
  });
});
