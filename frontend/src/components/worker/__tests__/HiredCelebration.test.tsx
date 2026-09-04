// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { interpolate, message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
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
    pay: '$24-$28/hour',
    shift_schedule: 'Mon-Fri, 7:00-15:30',
    ...overrides,
  };
}

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
  it('names the employer and the job in the header', () => {
    renderIntl(<HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={vi.fn()} />);

    expect(screen.getByText(message('worker_applications.hired_celebration.modal.eyebrow')))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', {
      name: interpolate(message('worker_applications.hired_celebration.modal.title'), {
        company: SUBJECT.companyName,
      }),
    })).toBeInTheDocument();
    expect(screen.getByText(
      interpolate(message('worker_applications.hired_celebration.modal.position'), {
        title: SUBJECT.jobTitle,
      }),
    )).toBeInTheDocument();
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

  it('renders in Spanish from the real catalogue', () => {
    renderIntl(
      <HiredCelebrationModal open {...SUBJECT} hire={hire()} onClose={vi.fn()} />,
      'es',
    );
    expect(screen.getByRole('heading', {
      name: interpolate(message('worker_applications.hired_celebration.modal.title', 'es'), {
        company: SUBJECT.companyName,
      }),
    })).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta', 'es'),
    })).toBeInTheDocument();
  });
});

describe('HiredBanner', () => {
  it('names the job and the employer, and links to the application', () => {
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} onDismiss={vi.fn()} />);

    expect(screen.getByText(
      interpolate(message('worker_applications.hired_celebration.banner.title'), {
        title: SUBJECT.jobTitle,
        company: SUBJECT.companyName,
      }),
    )).toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: message('worker_applications.hired_celebration.banner.cta'),
    })).toHaveAttribute('href', `/worker/applications/${APPLICATION_ID}`);
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
      name: message('worker_applications.hired_celebration.banner.dismiss'),
    }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('drops the heading and the link in the compact row variant, keeping the ×', () => {
    const onDismiss = vi.fn();
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} compact onDismiss={onDismiss} />);

    expect(screen.queryByText(
      interpolate(message('worker_applications.hired_celebration.banner.title'), {
        title: SUBJECT.jobTitle,
        company: SUBJECT.companyName,
      }),
    )).not.toBeInTheDocument();
    // The row already shows the job, the company and the Hired chip; the
    // banner under it only has to say what happens next.
    expect(screen.getByText(message('worker_applications.hired_celebration.row.body')))
      .toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.banner.dismiss'),
    }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('announces politely -- standing page state, not an event firing at the worker', () => {
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders in Spanish from the real catalogue', () => {
    renderIntl(<HiredBanner {...SUBJECT} hire={hire()} onDismiss={vi.fn()} />, 'es');
    expect(screen.getByRole('link', {
      name: message('worker_applications.hired_celebration.banner.cta', 'es'),
    })).toBeInTheDocument();
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
