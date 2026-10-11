// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import {
  expectNoRawMessageKeys,
  interpolate,
  message,
  renderIntl,
  type TestLocale,
} from '@/components/worker/onboarding/__tests__/render-intl';
import { formatPay, type PayTranslator } from '@/lib/pay';
import type { ApplicationHire } from '@/lib/api/worker';

// Same stub the other banner suite uses: the real `Link` reaches
// `next/navigation`, which has no resolvable entry under vitest. Keeping the
// href verbatim means the assertions check the destination the component ASKS
// for rather than the locale prefix the router would add.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { ConfettiBurst } from '../ConfettiBurst';
import { HiredBanner } from '../HiredBanner';
import { HiredCelebrationModal } from '../HiredCelebrationModal';

const APPLICATION_ID = '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071';

function hire(overrides: Partial<ApplicationHire> = {}): ApplicationHire {
  return {
    hired_at: '2026-09-03T18:00:00.000Z',
    seen_at: null,
    acknowledged_at: null,
    start_date: '2026-09-15',
    location: 'Austin, TX',
    shift_schedule: 'Mon-Fri, 7:00-15:30',
    // The LEGACY pay column with no structured columns behind it -- the
    // fallback branch of `formatPay`, and a real shape for a job created
    // before 023/033.
    pay: '$24-$28/hour',
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    ...overrides,
  };
}

/** The `trade` block as the endpoint builds it, defaulting to a 023 enum row. */
function trade(
  over: Partial<NonNullable<ApplicationHire['trade']>> = {},
): ApplicationHire['trade'] {
  return { category: 'electrician', other: null, canonical_en: null, canonical_es: null, ...over };
}

/**
 * The shape the backend sends TODAY: a structured `trade`, and a `company`
 * resolved on its own rather than reused from the list row's legacy
 * `company_name` (which falls back to the "Empleador" placeholder).
 *
 * `hire()` above has NEITHER field, which is not a hypothetical: `hire`
 * shipped in migration 095 before the two existed, so a frontend running
 * ahead of the backend gets exactly that -- and still has to say something.
 * The company name here differs from `SUBJECT.companyName` on purpose, so
 * every assertion below says WHICH of the two sources the copy used.
 */
function hired(overrides: Partial<ApplicationHire> = {}): ApplicationHire {
  return hire({ trade: trade(), company: 'RM Construction', ...overrides });
}

/**
 * A trade word as the finished copy reads it: the REAL catalogue label with
 * its leading capital folded, the same fold `hireTradePhrase` applies.
 *
 * Typing "electrician" out by hand would pass while quietly disagreeing with
 * `employer_dashboard.modal.trade.*` -- which is the catalogue the components
 * read, and the only one carrying all eight of migration 023's tokens.
 */
function tradeWord(slug: string, locale: TestLocale = 'en'): string {
  const label = message(`employer_dashboard.modal.trade.${slug}`, locale);
  return label.slice(0, 1).toLocaleLowerCase(locale === 'es' ? 'es-MX' : 'en-US') + label.slice(1);
}

/** The sentence a `hired_celebration` key renders in the real catalogue. */
function copy(key: string, values: Record<string, string> = {}, locale: TestLocale = 'en'): string {
  return interpolate(message(`worker_applications.hired_celebration.${key}`, locale), values);
}

/** A locale pair, so each case below is asserted in both languages. */
const LOCALES = ['en', 'es'] as const;

/**
 * A `pay` translator over the REAL catalogue, so the expected string below is
 * whatever `formatPay` actually produces for this locale rather than a literal
 * typed out here. Hard-coding "$22-$26/hr" would pass while silently
 * disagreeing with `pay.range`'s en dash or `pay.interval_hourly`'s wording.
 */
const payTranslator: PayTranslator = (key, values) => {
  const raw = message(`pay.${key}`);
  if (!values) return raw;
  const flat: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(values)) {
    flat[name] = value instanceof Date ? value.toISOString() : value;
  }
  return interpolate(raw, flat);
};

/** Every field the two surfaces need, in one place. */
const SUBJECT = {
  applicationId: APPLICATION_ID,
  jobTitle: 'Welder',
  companyName: 'Construcciones Bravo LLC',
};

/**
 * `matchMedia` does not exist in this jsdom at all (not "returns false" --
 * undefined), which is why the components read it optionally. Stubbing it
 * through `vi.stubGlobal` rather than by assignment is what keeps the stub from
 * leaking into the next test in the file: `setup.ts` only runs RTL's `cleanup`.
 */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Element.prototype as { animate?: unknown }).animate;
});

/** jsdom implements no Web Animations API; this is the stub the guard dodges. */
function stubAnimate() {
  // Parameters are declared so `mock.calls[n]` is a two-tuple rather than the
  // empty tuple a zero-arg `vi.fn()` infers -- the options assertion below
  // reads index 1.
  const animate = vi.fn((_keyframes: unknown, options?: KeyframeAnimationOptions) => {
    void options;
    return { cancel: vi.fn(), finish: vi.fn() };
  });
  (Element.prototype as unknown as { animate: unknown }).animate = animate;
  return animate;
}

describe('HiredCelebrationModal', () => {
  /*
   * THE HEADLINE MATRIX (option A1).
   *
   * Production rendered "Empleador te contrató para welder needed in metta
   * dara enter": the company was the DB placeholder, and the headline was
   * carrying free text the employer typed into the job-title box. So the
   * headline now names the TRADE, and each of the four (company? trade?)
   * combinations gets its own key -- which means each of the four needs a
   * test, because the fallback is exactly where the sentinel got in.
   */

  it('names the company and the TRADE, with the job title bare beneath', () => {
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hired()} onClose={vi.fn()} />);

    expect(screen.getByText(message('worker_applications.hired_celebration.modal.eyebrow')))
      .toBeInTheDocument();
    // Both halves of one claim: the key the component picked, AND the sentence
    // a worker actually reads. A key-only assertion passes just as happily on
    // the production bug this replaces.
    const expected = copy('modal.title_trade', { company: 'RM Construction', trade: tradeWord('electrician') });
    expect(expected).toBe('RM Construction hired you for the electrician position');
    expect(screen.getByRole('heading', { name: expected })).toBeInTheDocument();
    // `hire.company`, not the list row's `company_name`.
    expect(screen.queryByText(new RegExp(SUBJECT.companyName))).not.toBeInTheDocument();
    // The job title is its OWN quiet line now -- no "Position:" label in
    // front of it, which is what the picked artifact shows.
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expect(screen.queryByText(/Position:/)).not.toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('reads the trade from the real catalogue (%s)', (locale) => {
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={hired()} onClose={vi.fn()} />,
      locale,
    );

    expect(screen.getByRole('heading', {
      name: copy('modal.title_trade', {
        company: 'RM Construction', trade: tradeWord('electrician', locale),
      }, locale),
    })).toBeInTheDocument();
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expect(screen.queryByText(/Position:|Puesto:/)).not.toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)("uses the alias cache's canonical for an 'other' trade (%s)", (locale) => {
    // The employer typed "welder" into the free-text box and migration 060's
    // cache resolved it, so the reader's own language wins over their words.
    const subject = hired({
      trade: trade({
        category: 'other', other: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador',
      }),
    });
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={subject} onClose={vi.fn()} />,
      locale,
    );

    const word = locale === 'es' ? 'soldador' : 'welder';
    expect(screen.getByRole('heading', {
      name: copy('modal.title_trade', { company: 'RM Construction', trade: word }, locale),
    })).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)("keeps the employer's own words when the cache missed (%s)", (locale) => {
    // A cache miss fails OPEN, so this is a real shape. The capitals stay:
    // lower-casing someone's "HVAC tech" reads as a typo.
    const subject = hired({
      trade: trade({ category: 'other', other: 'Tile setter helper' }),
    });
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={subject} onClose={vi.fn()} />,
      locale,
    );

    expect(screen.getByRole('heading', {
      name: copy('modal.title_trade', {
        company: 'RM Construction', trade: 'Tile setter helper',
      }, locale),
    })).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('falls back to the plain headline when there is no trade (%s)', (locale) => {
    // "...te contrató como Otro" says nothing, so the clause is dropped
    // rather than filled with the catalogue's "Other" label.
    const subject = hired({ trade: trade({ category: null }) });
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={subject} onClose={vi.fn()} />,
      locale,
    );

    expect(screen.getByRole('heading', {
      name: copy('modal.title', { company: 'RM Construction' }, locale),
    })).toBeInTheDocument();
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it('falls back the same way for a backend that sends no trade field at all', () => {
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={hired({ trade: undefined })} onClose={vi.fn()} />,
    );

    expect(screen.getByRole('heading', {
      name: copy('modal.title', { company: 'RM Construction' }),
    })).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('never names the sentinel: no company, but a trade (%s)', (locale) => {
    // `company: null` means the employer HAS no company name -- the endpoint
    // reports the "Empleador" placeholder that way on purpose. The legacy
    // `companyName` prop still carries it, and must not reach the sentence.
    const subject = hired({ company: null });
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={subject} onClose={vi.fn()} />,
      locale,
    );

    expect(screen.getByRole('heading', {
      name: copy('modal.title_no_company_trade', { trade: tradeWord('electrician', locale) }, locale),
    })).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SUBJECT.companyName))).not.toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('celebrates plainly when it knows neither company nor trade (%s)', (locale) => {
    // `ApplicationHire.trade` is optional, never nullable, so the two
    // no-trade shapes are a `category: null` block (here) and an absent field
    // (the banner's twin of this test) -- both must reach the same key.
    const subject = hired({ company: null, trade: trade({ category: null }) });
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={subject} onClose={vi.fn()} />,
      locale,
    );

    expect(screen.getByRole('heading', { name: copy('modal.title_no_company', {}, locale) }))
      .toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SUBJECT.companyName))).not.toBeInTheDocument();
    // The job title still shows: it is the one thing that is always known.
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it("uses the list row's company_name when the backend sends no company field", () => {
    // `undefined` is not `null`: an old backend said nothing about the
    // company, so the legacy prop is still the best answer available.
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={hired({ company: undefined })} onClose={vi.fn()} />,
    );

    expect(screen.getByRole('heading', {
      name: copy('modal.title_trade', {
        company: SUBJECT.companyName, trade: tradeWord('electrician'),
      }),
    })).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it('shows every fact the hire carries, with the start date in the reader-independent day', () => {
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={vi.fn()} />);

    for (const key of ['start_date', 'location', 'pay', 'schedule'] as const) {
      expect(screen.getByText(message(`worker_applications.hired_celebration.modal.${key}`)))
        .toBeInTheDocument();
    }
    // 2026-09-15 is a Tuesday. A naive (reader-timezone) format of a date-only
    // value says Monday the 14th, so this asserts the UTC pin as well.
    expect(screen.getByText('Tue, Sep 15, 2026')).toBeInTheDocument();
    expect(screen.getByText('Austin, TX')).toBeInTheDocument();
    expect(screen.getByText('$24-$28/hour')).toBeInTheDocument();
    expect(screen.getByText('Mon-Fri, 7:00-15:30')).toBeInTheDocument();
  });

  it('omits the facts the job does not have rather than printing an empty row', () => {
    renderIntl(
      <HiredCelebrationModal
        open
        {...SUBJECT}
        hire={hire({ location: null, pay: null, shift_schedule: null })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText(message('worker_applications.hired_celebration.modal.location')))
      .not.toBeInTheDocument();
    expect(screen.queryByText(message('worker_applications.hired_celebration.modal.pay')))
      .not.toBeInTheDocument();
    expect(screen.queryByText(message('worker_applications.hired_celebration.modal.schedule')))
      .not.toBeInTheDocument();
  });

  it('says the start date is unset rather than hiding it -- the one fact that always shows', () => {
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={hire({ start_date: null })} onClose={vi.fn()} />,
    );

    expect(screen.getByText(message('worker_applications.hired_celebration.modal.start_date')))
      .toBeInTheDocument();
    expect(screen.getByText(message('worker_applications.hired_celebration.modal.start_date_tbc')))
      .toBeInTheDocument();
  });

  it('localizes a structured pay range rather than echoing the English column', () => {
    // The shape the backend now sends: no legacy `pay` text, the figures in
    // their own columns. Showing `hire.pay` verbatim was the bug `lib/pay.ts`
    // exists to fix -- a Spanish-locale worker was reading English free text.
    const structured = hire({ pay: null, pay_min: 22, pay_max: 26, pay_interval: 'hourly' });
    const expected = formatPay(structured, payTranslator);

    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={structured} onClose={vi.fn()} />);

    expect(expected).not.toBeNull();
    expect(screen.getByText(message('worker_applications.hired_celebration.modal.pay')))
      .toBeInTheDocument();
    expect(screen.getByText(expected as string)).toBeInTheDocument();
  });

  it('drops the pay fact when the sentinel is all the employer gave', () => {
    // `PAY_UNSPECIFIED` is not a figure, and `formatPay` answers null for it.
    // Printing "Pay: Pay not specified" would be worse than saying nothing.
    renderIntl(
      <HiredCelebrationModal
        open
        {...SUBJECT}
        hire={hire({ pay: 'Pay not specified' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText(message('worker_applications.hired_celebration.modal.pay')))
      .not.toBeInTheDocument();
  });

  it('says what happens next, and what to do if it does not', () => {
    // The most common failure after a hire is silence, so the body has to
    // cover both halves. Asserted through `message()` so this key cannot go
    // missing from either catalogue unnoticed.
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={vi.fn()} />);
    expect(screen.getByText(message('worker_applications.hired_celebration.modal.body')))
      .toBeInTheDocument();
  });

  it('quotes a short application reference, not the whole uuid', () => {
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={vi.fn()} />);

    expect(screen.getByText(
      interpolate(message('worker_applications.hired_celebration.modal.reference'), {
        ref: 'app-8f3a2c1d',
      }),
    )).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(APPLICATION_ID))).not.toBeInTheDocument();
  });

  it('links to THIS application', () => {
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={vi.fn()} />);

    expect(screen.getByRole('link', {
      name: message('worker_applications.hired_celebration.modal.link'),
    })).toHaveAttribute('href', `/worker/applications/${APPLICATION_ID}`);
  });

  it('closes on the primary CTA', () => {
    const onClose = vi.fn();
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta'),
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on its own × -- the hero replaces the foundation Modal header', () => {
    // The hero owns the `--jale-success-bg` block and the confetti, so this
    // dialog passes `labelledById` instead of `title` and the Modal renders no
    // header. Without a × of its own the only ways out would be Escape and the
    // backdrop, which is not a way out on a phone.
    const onClose = vi.fn();
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: message('common.feedback.dismiss') }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at all when closed', () => {
    renderIntl(<HiredCelebrationModal open={false} {...SUBJECT} hire={hire()} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the LEGACY hire shape in Spanish from the real catalogue', () => {
    // No `trade`, no `company`: the pre-095 wire shape, in the locale most of
    // these workers read. It has to produce a sentence, not a key path.
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={vi.fn()} />,
      'es',
    );
    expect(screen.getByRole('heading', {
      name: copy('modal.title', { company: SUBJECT.companyName }, 'es'),
    })).toBeInTheDocument();
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expect(screen.queryByText(/Puesto:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta', 'es'),
    })).toBeInTheDocument();
    expectNoRawMessageKeys();
  });
});

describe('HiredBanner', () => {
  /* The same four-case matrix as the modal, with the banner's own wording --
     and one extra rule: when the heading carries the TRADE it no longer names
     the job, so the job title gets a line of its own. When the heading already
     names the job, repeating it below would read as two different hires. */

  it('leads with the trade and the company, and puts the job title on its own line', () => {
    renderIntl(<HiredBanner {...SUBJECT} hire={hired()} onDismiss={vi.fn()} />);

    const expected = copy('banner.title_trade', {
      trade: tradeWord('electrician'), company: 'RM Construction',
    });
    expect(expected).toBe("You're hired for the electrician position · RM Construction");
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: message('worker_applications.hired_celebration.banner.cta'),
    })).toHaveAttribute('href', `/worker/applications/${APPLICATION_ID}`);
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('reads the trade from the real catalogue (%s)', (locale) => {
    renderIntl(<HiredBanner {...SUBJECT} hire={hired()} onDismiss={vi.fn()} />, locale);

    expect(screen.getByText(copy('banner.title_trade', {
      trade: tradeWord('electrician', locale), company: 'RM Construction',
    }, locale))).toBeInTheDocument();
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)("uses the alias cache's canonical for an 'other' trade (%s)", (locale) => {
    const subject = hired({
      trade: trade({
        category: 'other', other: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador',
      }),
    });
    renderIntl(<HiredBanner {...SUBJECT} hire={subject} onDismiss={vi.fn()} />, locale);

    const word = locale === 'es' ? 'soldador' : 'welder';
    expect(screen.getByText(copy('banner.title_trade', {
      trade: word, company: 'RM Construction',
    }, locale))).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)("keeps the employer's own words when the cache missed (%s)", (locale) => {
    const subject = hired({ trade: trade({ category: 'other', other: 'Tile setter helper' }) });
    renderIntl(<HiredBanner {...SUBJECT} hire={subject} onDismiss={vi.fn()} />, locale);

    expect(screen.getByText(copy('banner.title_trade', {
      trade: 'Tile setter helper', company: 'RM Construction',
    }, locale))).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('never names the sentinel: no company, but a trade (%s)', (locale) => {
    renderIntl(
      <HiredBanner {...SUBJECT} hire={hired({ company: null })} onDismiss={vi.fn()} />,
      locale,
    );

    expect(screen.getByText(
      copy('banner.title_no_company_trade', { trade: tradeWord('electrician', locale) }, locale),
    )).toBeInTheDocument();
    expect(screen.getByText(SUBJECT.jobTitle)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SUBJECT.companyName))).not.toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('keeps the legacy heading when there is no trade (%s)', (locale) => {
    const subject = hired({ trade: trade({ category: null }) });
    renderIntl(<HiredBanner {...SUBJECT} hire={subject} onDismiss={vi.fn()} />, locale);

    expect(screen.getByText(copy('banner.title', {
      title: SUBJECT.jobTitle, company: 'RM Construction',
    }, locale))).toBeInTheDocument();
    // The heading already names the job, so there is NO separate title line --
    // no element whose whole text is the job title.
    expect(screen.queryByText(SUBJECT.jobTitle)).not.toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it('keeps the legacy heading for a backend that sends no trade field at all', () => {
    renderIntl(
      <HiredBanner {...SUBJECT} hire={hired({ trade: undefined })} onDismiss={vi.fn()} />,
    );

    expect(screen.getByText(copy('banner.title', {
      title: SUBJECT.jobTitle, company: 'RM Construction',
    }))).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it.each(LOCALES)('states the job alone when it knows neither company nor trade (%s)', (locale) => {
    // The absent-field shape of "no trade", against the modal twin's
    // `category: null` one.
    const subject = hired({ company: null, trade: undefined });
    renderIntl(<HiredBanner {...SUBJECT} hire={subject} onDismiss={vi.fn()} />, locale);

    expect(screen.getByText(copy('banner.title_no_company', { title: SUBJECT.jobTitle }, locale)))
      .toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SUBJECT.companyName))).not.toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it("uses the list row's company_name when the backend sends no company field", () => {
    renderIntl(
      <HiredBanner {...SUBJECT} hire={hired({ company: undefined })} onDismiss={vi.fn()} />,
    );

    expect(screen.getByText(copy('banner.title_trade', {
      trade: tradeWord('electrician'), company: SUBJECT.companyName,
    }))).toBeInTheDocument();
    expectNoRawMessageKeys();
  });

  it('carries the start date in the dated sentence', () => {
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} onDismiss={vi.fn()} />);

    expect(screen.getByText(
      interpolate(message('worker_applications.hired_celebration.banner.body_dated'), {
        date: 'Tue, Sep 15',
      }),
    )).toBeInTheDocument();
  });

  it('switches to the undated sentence rather than saying "Starts null"', () => {
    renderIntl(
      <HiredBanner {...SUBJECT} hire={hire({ start_date: null })} onDismiss={vi.fn()} />,
    );

    expect(screen.getByText(message('worker_applications.hired_celebration.banner.body_undated')))
      .toBeInTheDocument();
    expect(screen.queryByText(/Starts/)).not.toBeInTheDocument();
  });

  it('dismisses through an × labelled from its own key', () => {
    const onDismiss = vi.fn();
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), {
        title: SUBJECT.jobTitle,
      }),
    }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /*
   * A worker hired for two jobs sees two of these stacked. With one shared
   * label, a screen reader announced "Dismiss, button" twice and neither one
   * said which notice it closed -- the only distinguishing information was the
   * visual position. The job title is what tells them apart.
   */
  it('names the job in the dismiss label, so stacked banners are distinguishable', () => {
    renderIntl(
      <>
        <HiredBanner {...SUBJECT} hire={hire()} onDismiss={vi.fn()} />
        <HiredBanner {...SUBJECT} jobTitle="Drywall Finisher" hire={hire()} onDismiss={vi.fn()} />
      </>,
    );

    const labels = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '');

    expect(labels).toEqual([
      interpolate(message('worker_applications.hired_celebration.banner.dismiss'), {
        title: 'Welder',
      }),
      interpolate(message('worker_applications.hired_celebration.banner.dismiss'), {
        title: 'Drywall Finisher',
      }),
    ]);
    // The assertion above passes for ANY label that ignores its placeholder,
    // so the point of the change is asserted separately: the two differ, and
    // each one names its own job.
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain('Welder');
    expect(labels[1]).toContain('Drywall Finisher');
  });

  it('drops the heading and the link in the compact row variant, keeping the ×', () => {
    const onDismiss = vi.fn();
    renderIntl(<HiredBanner {...SUBJECT} hire={hired()} compact onDismiss={onDismiss} />);

    // Unchanged by A1: no heading of any variant, and no job-title line
    // either -- the row above states the job, the company and the Hired chip.
    expect(screen.queryByText(copy('banner.title_trade', {
      trade: tradeWord('electrician'), company: 'RM Construction',
    }))).not.toBeInTheDocument();
    expect(screen.queryByText(SUBJECT.jobTitle)).not.toBeInTheDocument();
    // The row already shows the job, the company and the Hired chip; the
    // banner under it only has to say what happens next.
    expect(screen.getByText(message('worker_applications.hired_celebration.row.body')))
      .toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), {
        title: SUBJECT.jobTitle,
      }),
    }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('announces politely -- standing page state, not an event firing at the worker', () => {
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the LEGACY hire shape in Spanish from the real catalogue', () => {
    // No `trade`, no `company`: the pre-095 wire shape still has to read as a
    // sentence in the locale most of these workers use.
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} onDismiss={vi.fn()} />, 'es');

    expect(screen.getByText(copy('banner.title', {
      title: SUBJECT.jobTitle, company: SUBJECT.companyName,
    }, 'es'))).toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: message('worker_applications.hired_celebration.banner.cta', 'es'),
    })).toBeInTheDocument();
    expectNoRawMessageKeys();
  });
});

describe('ConfettiBurst', () => {
  it('draws its pieces already at rest, so there is nothing to animate back from', () => {
    const { container } = renderIntl(<ConfettiBurst />);
    const pieces = container.querySelectorAll('[data-confetti-piece]');

    expect(pieces).toHaveLength(27);
    for (const piece of Array.from(pieces)) {
      const style = (piece as HTMLElement).style;
      // Position is the RESTING spot in percentages, not the origin: the
      // flight is a transform delta layered on top, which is what makes the
      // reduced-motion and no-WAAPI paths correct with no extra branch.
      expect(style.left).toMatch(/%$/);
      expect(style.top).toMatch(/%$/);
    }
  });

  it('is hidden from assistive tech and takes no pointer events', () => {
    const { container } = renderIntl(<ConfettiBurst />);
    const layer = container.querySelector('[data-confetti-layer]');

    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer).toHaveClass('pointer-events-none');
  });

  it('flies the pieces out when motion is welcome', () => {
    stubReducedMotion(false);
    const animate = stubAnimate();

    renderIntl(<ConfettiBurst />);

    // 27 pieces plus the flash at the header centre.
    expect(animate).toHaveBeenCalledTimes(28);
    const [, options] = animate.mock.calls[0];
    // `forwards` is the whole reason the resting markup and the animation can
    // agree: nothing ever rewinds to its start frame.
    expect(options?.fill).toBe('forwards');
  });

  it('leaves them where they are under prefers-reduced-motion', () => {
    stubReducedMotion(true);
    const animate = stubAnimate();

    const { container } = renderIntl(<ConfettiBurst />);

    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-confetti-piece]')).toHaveLength(27);
  });

  it('survives a runtime with no Web Animations API at all', () => {
    // `Element.prototype.animate` is undefined in jsdom, and was undefined in
    // older mobile Safari. The guard is `el.animate?.(…)`; without it this
    // render throws and takes the whole celebration modal with it.
    stubReducedMotion(false);
    expect(() => renderIntl(<ConfettiBurst />)).not.toThrow();
    expect(screen.queryAllByText('nothing')).toHaveLength(0);
  });

  it('does not re-scatter its pieces when the parent re-renders', () => {
    const { container, rerender } = renderIntl(<ConfettiBurst />);
    const before = Array.from(container.querySelectorAll('[data-confetti-piece]'))
      .map((el) => (el as HTMLElement).style.left);

    rerender(<ConfettiBurst />);
    const after = Array.from(container.querySelectorAll('[data-confetti-piece]'))
      .map((el) => (el as HTMLElement).style.left);

    expect(after).toEqual(before);
  });
});
