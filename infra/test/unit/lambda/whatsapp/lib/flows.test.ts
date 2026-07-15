import {
  isGreetingKeyword,
  isJobsKeyword,
  isHelpCommand,
  isProfileCommand,
  isAccept,
  isDecline,
  parseButtonPayload,
  parseEmployerConversationButtonPayload,
  parseLegalReplyPayload,
  parseMediaPayload,
  parseProfileAnswer,
  parseProfilePayloadAnswer,
  getTrustOptions,
  buildTrustQuestion,
  parseTrustAnswer,
  parseTrustPayloadAnswer,
  parseTypedJobAction,
  computeNextField,
  PROFILE_FIELDS,
  isSkipKeyword,
  normalizeCommandText,
  matchCommandFuzzy,
  parseCommandPayload,
  type ConversationState,
  type ProfileStateContext,
} from '../../../../../lambda/whatsapp/lib/flows';

describe('flows.ts — keyword detection', () => {
  describe('isGreetingKeyword', () => {
    test.each([
      ['Hola', true],
      ['hola', true],
      ['HOLA', true],
      ['Hola!', true],
      ['Hello', true],
      ['hello.', true],
      ['hi', true],
      ['Hi', true],
      ['hey', true],
      ['Hey there', true],
      ['Buenas', true],
      ['buenas', true],
      ['Buenos días', true],
      ['buenos dias', true],
      ['hola quiero trabajo', true],
      ['hola trabajos', true],
      ['Trabajos', false],
      ['', false],
      ['hell', false], // not 'hello' prefix
    ])('isGreetingKeyword("%s") → %s', (input, expected) => {
      expect(isGreetingKeyword(input)).toBe(expected);
    });
  });

  describe('isJobsKeyword', () => {
    test.each([
      ['Trabajos', true],
      ['trabajos', true],
      ['trabajo', true],
      ['Jobs', true],
      ['job', true],
      ['Empleo', true],
      ['empleos', true],
      ['trabajos!!', true],
      ['trabjos', true], // typo tolerance
      ['Hola', false],
      ['', false],
    ])('isJobsKeyword("%s") → %s', (input, expected) => {
      expect(isJobsKeyword(input)).toBe(expected);
    });
  });

  describe('isAccept / isDecline', () => {
    it('accepts "Acepto" in Spanish', () => {
      expect(isAccept('Acepto', 'es')).toBe(true);
      expect(isAccept('acepto', 'es')).toBe(true);
      expect(isAccept('Sí', 'es')).toBe(true);
    });
    it('accepts "Accept" in English', () => {
      expect(isAccept('Accept', 'en')).toBe(true);
      expect(isAccept('Yes', 'en')).toBe(true);
    });
    it('declines "No acepto" in Spanish', () => {
      expect(isDecline('No acepto', 'es')).toBe(true);
      expect(isDecline('No', 'es')).toBe(true);
    });
    it('declines "Decline" in English', () => {
      expect(isDecline('Decline', 'en')).toBe(true);
      expect(isDecline('No', 'en')).toBe(true);
    });
    it('tolerates stray punctuation', () => {
      expect(isAccept('sí!', 'es')).toBe(true);
      expect(isAccept('👍 si', 'es')).toBe(true);
      expect(isDecline('no.', 'es')).toBe(true);
    });
    it('"no se" still declines (regression — prefix match unaffected by normalization)', () => {
      expect(isDecline('no se', 'es')).toBe(true);
    });
  });
});

describe('flows.ts — normalizeCommandText', () => {
  test.each([
    ['help.', 'help'],
    ['Ayuda!', 'ayuda'],
    [' Help ?', 'help'],
    ['¡ayuda!', 'ayuda'],
    ['AYUDA…', 'ayuda'],
    ['perfil.', 'perfil'],
  ])('normalizeCommandText("%s") → "%s"', (input, expected) => {
    expect(normalizeCommandText(input)).toBe(expected);
  });
});

describe('flows.ts — matchCommandFuzzy', () => {
  test.each([
    ['hlep', 'help'],
    ['ayudda', 'ayuda'],
    ['trabjos', 'trabajos'],
    ['porfile', 'profile'],
  ])('matchCommandFuzzy("%s") → "%s"', (input, expected) => {
    expect(matchCommandFuzzy(input)).toBe(expected);
  });

  test.each(['nos', 'ni', 'sin', 'hey', 'no'])(
    'matchCommandFuzzy("%s") → null (too short, never fuzzy-matched)',
    (input) => {
      expect(matchCommandFuzzy(input)).toBeNull();
    },
  );

  it('does not fuzzy-match multi-word input', () => {
    expect(matchCommandFuzzy('help me')).toBeNull();
  });

  it('does not fuzzy-match unrelated words far from any keyword', () => {
    expect(matchCommandFuzzy('helpful')).toBeNull();
  });
});

describe('flows.ts — parseCommandPayload', () => {
  it('parses known command payloads', () => {
    expect(parseCommandPayload('command:jobs')).toBe('jobs');
    expect(parseCommandPayload('command:profile')).toBe('profile');
    expect(parseCommandPayload('command:chats')).toBe('chats');
    expect(parseCommandPayload('command:help')).toBe('help');
  });

  it('rejects unknown or missing payloads', () => {
    expect(parseCommandPayload('command:bogus')).toBeNull();
    expect(parseCommandPayload(undefined)).toBeNull();
  });
});

describe('flows.ts — parseButtonPayload', () => {
  it('parses accept payload', () => {
    expect(parseButtonPayload('accept:job-abc-123')).toEqual({
      action: 'accept',
      jobId: 'job-abc-123',
    });
  });
  it('parses decline payload', () => {
    expect(parseButtonPayload('decline:job-xyz')).toEqual({
      action: 'decline',
      jobId: 'job-xyz',
    });
  });
  it('parses info payload', () => {
    expect(parseButtonPayload('info:job-42')).toEqual({
      action: 'info',
      jobId: 'job-42',
    });
  });
  it('rejects unknown action', () => {
    expect(parseButtonPayload('hack:job-1')).toBeNull();
  });
  it('rejects missing jobId', () => {
    expect(parseButtonPayload('accept:')).toBeNull();
  });
  it('rejects random text', () => {
    expect(parseButtonPayload('Hola')).toBeNull();
  });
});
describe('flows.ts - parseEmployerConversationButtonPayload', () => {
  const conversationId = '11111111-2222-3333-4444-555555555555';

  it('parses open and decline payloads', () => {
    expect(parseEmployerConversationButtonPayload(`conversation:open:${conversationId}`)).toEqual({
      action: 'open',
      conversationId,
    });
    expect(parseEmployerConversationButtonPayload(`conversation:decline:${conversationId}`)).toEqual({
      action: 'decline',
      conversationId,
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseEmployerConversationButtonPayload('conversation:open:not-a-uuid')).toBeNull();
    expect(parseEmployerConversationButtonPayload(`conversation:accept:${conversationId}`)).toBeNull();
  });
});

describe('flows.ts — rich onboarding payloads', () => {
  it('parses legal quick reply payloads', () => {
    expect(parseLegalReplyPayload('legal:accept')).toBe('accept');
    expect(parseLegalReplyPayload('legal:decline')).toBe('decline');
    expect(parseLegalReplyPayload('profile:main_trade:electrician')).toBeNull();
    expect(parseLegalReplyPayload(undefined)).toBeNull();
  });

  it('maps matching profile payloads to canonical values', () => {
    expect(parseProfilePayloadAnswer('main_trade', 'profile:main_trade:electrician')).toBe('electrician');
    expect(parseProfilePayloadAnswer('years_experience', 'profile:years_experience:2-4')).toBe('2-4');
    expect(parseProfilePayloadAnswer('has_transportation', 'profile:has_transportation:true')).toBe(true);
    expect(parseProfilePayloadAnswer('has_transportation', 'profile:has_transportation:false')).toBe(false);
    expect(parseProfilePayloadAnswer('availability', 'profile:availability:flexible')).toBe('flexible');
  });

  it('rejects stale or invalid profile payloads', () => {
    expect(parseProfilePayloadAnswer('main_trade', 'profile:availability:flexible')).toBeNull();
    expect(parseProfilePayloadAnswer('main_trade', 'profile:main_trade:welder')).toBeNull();
    expect(parseProfilePayloadAnswer('full_name', 'profile:full_name:Juan')).toBeNull();
    expect(parseProfilePayloadAnswer('has_transportation', 'profile:has_transportation:maybe')).toBeNull();
  });

  it('maps trust payloads only for the current step', () => {
    expect(parseTrustPayloadAnswer(0, 'electrician', 'trust:0:1')).toMatchObject({
      questionKey: 'specialization',
      optionKey: 'opt_1',
      label: 'Commercial',
    });
    expect(parseTrustPayloadAnswer(1, 'electrician', 'trust:0:1')).toBeNull();
    expect(parseTrustPayloadAnswer(0, 'electrician', 'trust:0:9')).toBeNull();
  });

  it('parses media quick reply payloads', () => {
    expect(parseMediaPayload('media:photo:skip')).toEqual({ kind: 'photo', value: 'skip' });
    expect(parseMediaPayload('media:photo_type:profile_photo')).toEqual({
      kind: 'photo_type',
      value: 'profile_photo',
    });
    expect(parseMediaPayload('media:photo_type:work_sample')).toEqual({
      kind: 'photo_type',
      value: 'work_sample',
    });
    expect(parseMediaPayload('media:voice:text')).toEqual({ kind: 'voice', value: 'text' });
    expect(parseMediaPayload('media:voice:bad')).toBeNull();
  });
});

describe('flows.ts — parseProfileAnswer', () => {
  it('accepts text for full_name', () => {
    expect(parseProfileAnswer('full_name', '  Juan Garcia  ')).toBe('Juan Garcia');
  });

  it('rejects empty text for full_name', () => {
    expect(parseProfileAnswer('full_name', '   ')).toBeNull();
  });

  it('maps numeric choice to canonical trade slug', () => {
    // 1)Electrician  2)Plumber  3)Carpenter  4)Concrete  5)Painting  6)Other
    expect(parseProfileAnswer('main_trade', '1')).toBe('electrician');
    expect(parseProfileAnswer('main_trade', '3')).toBe('carpenter');
    expect(parseProfileAnswer('main_trade', '6')).toBe('other');
  });

  it('rejects out-of-range trade choice', () => {
    expect(parseProfileAnswer('main_trade', '7')).toBeNull();
    expect(parseProfileAnswer('main_trade', '0')).toBeNull();
  });

  it('rejects non-numeric for button fields', () => {
    expect(parseProfileAnswer('main_trade', 'Electrician')).toBeNull();
  });

  it('maps numeric choice to years_experience slug', () => {
    expect(parseProfileAnswer('years_experience', '1')).toBe('0-1');
    expect(parseProfileAnswer('years_experience', '4')).toBe('10+');
  });

  it('maps numeric choice to boolean for has_transportation', () => {
    expect(parseProfileAnswer('has_transportation', '1')).toBe(true);
    expect(parseProfileAnswer('has_transportation', '2')).toBe(false);
  });

  it('maps numeric choice to availability slug', () => {
    expect(parseProfileAnswer('availability', '1')).toBe('full_time');
    expect(parseProfileAnswer('availability', '4')).toBe('flexible');
  });
});

describe('flows.ts — computeNextField', () => {
  it('starts at full_name when nothing is collected', () => {
    expect(computeNextField({}, {})).toBe('full_name');
  });

  it('advances to city after full_name is collected', () => {
    expect(computeNextField({ full_name: 'Juan' }, {})).toBe('city');
  });

  it('skips main_trade_other when main_trade !== "other"', () => {
    expect(
      computeNextField(
        { full_name: 'J', city: 'Houston', main_trade: 'electrician' },
        {},
      ),
    ).toBe('years_experience');
  });

  it('includes main_trade_other when main_trade === "other"', () => {
    expect(
      computeNextField(
        { full_name: 'J', city: 'Houston', main_trade: 'other' },
        {},
      ),
    ).toBe('main_trade_other');
  });

  it('skips fields already filled in DB (existing-user partial resume)', () => {
    expect(
      computeNextField({}, { full_name: 'Juan', city: 'Houston' }),
    ).toBe('main_trade');
  });

  it('returns null when all fields are complete', () => {
    expect(
      computeNextField(
        {
          full_name: 'Juan',
          city: 'Houston',
          main_trade: 'electrician',
          years_experience: '5-9',
          has_transportation: true,
          availability: 'full_time',
        },
        {},
      ),
    ).toBeNull();
  });

  it('returns null when all fields are pre-filled in DB', () => {
    expect(
      computeNextField(
        {},
        {
          full_name: 'Juan',
          city: 'Houston',
          main_trade: 'electrician',
          years_experience: '5-9',
          has_transportation: true,
          availability: 'full_time',
        },
      ),
    ).toBeNull();
  });

  it('honors "Otro" branch even when pre-filled in DB', () => {
    expect(
      computeNextField(
        {},
        {
          full_name: 'Juan',
          city: 'Houston',
          main_trade: 'other',
          // main_trade_other NOT filled
        },
      ),
    ).toBe('main_trade_other');
  });

  it('treats null DB values as "needs to be asked"', () => {
    expect(
      computeNextField({}, { full_name: null, city: null }),
    ).toBe('full_name');
  });
});

describe('flows.ts — trust signals', () => {
  it('returns trade-specific specialization options', () => {
    expect(getTrustOptions(0, 'electrician')).toEqual([
      'Residential',
      'Commercial',
      'Industrial',
    ]);
  });

  describe('isHelpCommand / isProfileCommand', () => {
    test.each([
      'Help', 'help', 'Ayuda', 'commands', 'comandos',
      'help.', 'Ayuda!', ' Help ?', '¡ayuda!', 'AYUDA…', 'hlep',
    ])(
      'isHelpCommand("%s") -> true',
      (input) => {
        expect(isHelpCommand(input)).toBe(true);
      },
    );

    test.each(['Profile', 'perfil', 'my profile', 'mi perfil', 'perfil.', 'porfile'])(
      'isProfileCommand("%s") -> true',
      (input) => {
        expect(isProfileCommand(input)).toBe(true);
      },
    );

    test.each(['Trabajos', 'Hola', '1 aceptar', '', 'helpful', 'help me now'])('rejects "%s"', (input) => {
      expect(isHelpCommand(input)).toBe(false);
      expect(isProfileCommand(input)).toBe(false);
    });
  });

  it('returns shared seniority options', () => {
    expect(getTrustOptions(1, 'plumber')).toEqual([
      'Helper',
      'Can work alone',
      'Lead crew',
    ]);
  });

  it('falls back to other for unknown trades', () => {
    expect(getTrustOptions(2, 'welder')).toEqual([
      'Use power tools',
      'Read plans',
      'Site cleanup/safety',
    ]);
  });

  it('builds a numbered trust question', () => {
    const question = buildTrustQuestion(0, 'electrician', 'en');
    expect(question).toContain('One more question');
    expect(question).toContain('What is your specialty?');
    expect(question).toContain('1. Residential');
    expect(question).toContain('Reply with the number.');
  });

  it('builds Spanish trust questions without profile headers', () => {
    const question = buildTrustQuestion(0, 'electrician', 'es');
    expect(question).toContain('Una pregunta mas');
    expect(question).toContain('En que te especializas?');
    expect(question).toContain('1. Residencial');
    expect(question).not.toContain('Perfil de confianza');
  });

  it('parses a valid trust answer', () => {
    const answer = parseTrustAnswer(0, 'electrician', '2');
    expect(answer).toMatchObject({
      questionKey: 'specialization',
      optionKey: 'opt_1',
      label: 'Commercial',
    });
  });

  it('rejects invalid trust answers', () => {
    expect(parseTrustAnswer(0, 'electrician', '0')).toBeNull();
    expect(parseTrustAnswer(0, 'electrician', '9')).toBeNull();
    expect(parseTrustAnswer(0, 'electrician', 'yes')).toBeNull();
  });
});

describe('flows.ts — parseTypedJobAction', () => {
  test.each([
    ['1 aceptar', { index: 0, action: 'accept' }],
    ['2 accept', { index: 1, action: 'accept' }],
    ['3 si', { index: 2, action: 'accept' }],
    ['1 no', { index: 0, action: 'decline' }],
    ['2 rechazar', { index: 1, action: 'decline' }],
    ['1 info', { index: 0, action: 'info' }],
    ['1 aceptar.', { index: 0, action: 'accept' }],
  ])('parses "%s"', (input, expected) => {
    expect(parseTypedJobAction(input)).toEqual(expected);
  });

  test.each(['Trabajos', '1', 'apply 1', ''])('rejects "%s"', (input) => {
    expect(parseTypedJobAction(input)).toBeNull();
  });
});

describe('flows.ts — PROFILE_FIELDS structural', () => {
  it('contains all 7 fields including conditional', () => {
    expect(PROFILE_FIELDS.map((f) => f.field)).toEqual([
      'full_name',
      'city',
      'main_trade',
      'main_trade_other',
      'years_experience',
      'has_transportation',
      'availability',
    ]);
  });

  it('only main_trade_other is conditional', () => {
    const conditionals = PROFILE_FIELDS.filter((f) => f.conditional);
    expect(conditionals.map((f) => f.field)).toEqual(['main_trade_other']);
  });

  it('main_trade options match the DB CHECK constraint slugs', () => {
    const trade = PROFILE_FIELDS.find((f) => f.field === 'main_trade');
    expect(trade?.options).toEqual([
      'electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other',
    ]);
  });

  it('years_experience options match the DB CHECK constraint slugs', () => {
    const exp = PROFILE_FIELDS.find((f) => f.field === 'years_experience');
    expect(exp?.options).toEqual(['0-1', '2-4', '5-9', '10+']);
  });

  it('availability options match the DB CHECK constraint slugs', () => {
    const av = PROFILE_FIELDS.find((f) => f.field === 'availability');
    expect(av?.options).toEqual(['full_time', 'part_time', 'weekends', 'flexible']);
  });
});

describe('new media state types', () => {
  test('ConversationState includes awaiting_media_photo', () => {
    const s: ConversationState = 'awaiting_media_photo';
    expect(s).toBe('awaiting_media_photo');
  });

  test('ConversationState includes awaiting_media_voice', () => {
    const s: ConversationState = 'awaiting_media_voice';
    expect(s).toBe('awaiting_media_voice');
  });

  test('ConversationState includes processing_ai', () => {
    const s: ConversationState = 'processing_ai';
    expect(s).toBe('processing_ai');
  });

  test('ProfileStateContext accepts ai_pipeline_execution_arn', () => {
    const ctx: ProfileStateContext = {
      ai_pipeline_execution_arn: 'arn:aws:states:us-east-2:123:execution:test:run-1',
      pending_media_photo_id: 'uuid-1',
    };
    expect(ctx.ai_pipeline_execution_arn).toBeDefined();
    expect(ctx.pending_media_photo_id).toBeDefined();
  });

  test('isSkipKeyword detects English skip', () => {
    expect(isSkipKeyword('skip')).toBe(true);
    expect(isSkipKeyword('Skip')).toBe(true);
    expect(isSkipKeyword('SKIP')).toBe(true);
  });

  test('isSkipKeyword detects Spanish skip', () => {
    expect(isSkipKeyword('saltar')).toBe(true);
    expect(isSkipKeyword('Saltar')).toBe(true);
  });

  test('isSkipKeyword returns false for non-skip input', () => {
    expect(isSkipKeyword('hello')).toBe(false);
    expect(isSkipKeyword('si')).toBe(false);
  });

  test('isSkipKeyword tolerates stray punctuation', () => {
    expect(isSkipKeyword('skip.')).toBe(true);
  });
});
