import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
    ArrowRight,
    Briefcase,
    Building2,
    Check,
    Clock,
    FileCheck,
    FileText,
    HardHat,
    Info,
    Languages,
    Lock,
    MessageCircle,
    Mic,
    Target,
    UploadCloud,
    Zap,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { LandingNav } from '@/components/landing/LandingNav';
import { PhoneMockup } from '@/components/landing/PhoneMockup';
import { CompaniesCarousel } from '@/components/landing/CompaniesCarousel';

/*
 * ===== THEME CONTRACT FOR THIS PAGE =====================================
 *
 * Two kinds of surface live here, and they behave differently on purpose.
 *
 * BRAND surfaces -- the nav, the hero, the audience split, the CTA band and the
 * footer -- are navy/brand-blue in BOTH themes. This is the marketing face of
 * the product: it appears in ads, share cards and screenshots, and it must not
 * change colour because a visitor's OS is set to dark. They are still written
 * with tokens, not hexes: `--jale-blue-500/600/800/900/950` are exactly the
 * brand-ramp tokens `globals.css` does NOT re-point under `.dark` (unlike
 * `--jale-blue-50/700`, which flip so app chrome stays legible), so naming them
 * keeps this file token-only while the band stays fixed. White and white-alpha
 * are the navy band's own ink and are stable for the same reason.
 *
 * APP surfaces -- every light section between them, and every card on one --
 * are ordinary themed surfaces: `--jale-paper`/`--jale-shell` grounds,
 * `--jale-card` cards, `--jale-ink`/`--jale-ink-2` text, `--jale-blue-50` +
 * `--jale-blue-700` tinted tiles. Those all flip, so the middle of the page
 * follows the theme the same way the signed-in app does.
 *
 * The `<style>` block below is marketing-only motion (float, slide-in,
 * carousel). It stays hand-written CSS -- these are long, looping, decorative
 * animations, not the app's entrance signature -- and it is already
 * reduced-motion guarded.
 */

// WhatsApp deep link (from the design source). Only the #cta section button
// opens it; nav/hero/audience CTAs scroll to #cta.
const WHATSAPP_HREF = 'https://wa.me/17376880702';

// Dot patterns for the brand bands. `--jale-blue-300` is #78a4ff, the exact
// value the design used, and it does not flip -- so the hero keeps its texture
// in both themes.
const DOT_PATTERN_BLUE: React.CSSProperties = {
    backgroundImage:
        'radial-gradient(circle, color-mix(in srgb, var(--jale-blue-300) 16%, transparent) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
};
const DOT_PATTERN_WHITE: React.CSSProperties = {
    backgroundImage: 'radial-gradient(circle, rgba(255,255,255,.12) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
};

// Rich-text renderers for spans in the i18n copy (styles from the design).
// TWO blues on purpose, and the names carry the constraint: the accent stop has
// to match the ground it lands on, because `--jale-blue-500` is tuned to carry
// white ON it, not to be read against a dark surface.
//   - ...OnNavy -> `--jale-blue-300` (#78a4ff), 6.58:1 on the fixed brand navy
//     `--jale-blue-900`. blue-500 there is 2.92:1, a straight 1.4.3 fail.
//   - ...OnSurface -> `--jale-blue-500`, on themed app surfaces only.
// Do not swap one for the other without re-measuring against the new ground.
const blueStrongOnNavy = (chunks: React.ReactNode) => (
    <span className="font-semibold text-[var(--jale-blue-300)]">{chunks}</span>
);
const blueBoldOnSurface = (chunks: React.ReactNode) => (
    <span className="font-bold text-[var(--jale-blue-500)]">{chunks}</span>
);
const semibold = (chunks: React.ReactNode) => <span className="font-semibold">{chunks}</span>;

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
    return (
        <div className="mx-auto mb-12 max-w-[640px] text-center">
            <div className="text-[13px] font-bold uppercase tracking-[.08em] text-[var(--jale-blue-500)]">
                {eyebrow}
            </div>
            <h2
                className="mt-3.5 font-extrabold text-[var(--jale-ink)]"
                style={{ fontSize: 'clamp(2rem, 5vw, 2.5rem)', lineHeight: 1.05, letterSpacing: '-0.03em' }}
            >
                {title}
            </h2>
        </div>
    );
}

function BenefitCard({
    icon,
    title,
    body,
    variant,
}: {
    icon: React.ReactNode;
    title: string;
    body: React.ReactNode;
    variant: 'raised' | 'quiet';
}) {
    return (
        <div
            className={
                variant === 'raised'
                    ? 'rounded-2xl bg-[var(--jale-card)] p-[26px] shadow-[var(--shadow-card)]'
                    : 'rounded-2xl border border-[var(--jale-divider)] bg-[var(--jale-card)] p-[26px]'
            }
        >
            {/* The kit's tinted tile: blue-50 fill on blue-700 ink. Both tokens
                flip together, so the tile stays legible in either theme. */}
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]">
                {icon}
            </span>
            <h3 className="mb-[5px] mt-4 text-[17px] font-bold text-[var(--jale-ink)]">{title}</h3>
            <p className="text-sm leading-[1.55] text-[var(--jale-ink-2)]">{body}</p>
        </div>
    );
}

export default function Home() {
    const t = useTranslations('landing');

    const howSteps = [
        { n: '1', icon: <MessageCircle />, title: t('how.step1_title'), body: t.rich('how.step1_body', { b: semibold }) },
        { n: '2', icon: <FileText />, title: t('how.step2_title'), body: t.rich('how.step2_body', { b: semibold }) },
        { n: '3', icon: <Briefcase />, title: t('how.step3_title'), body: t.rich('how.step3_body', { b: semibold }) },
    ];

    const workerCards = [
        { icon: <MessageCircle />, title: t('workers.c1_title'), body: t('workers.c1_body') },
        { icon: <Mic />, title: t('workers.c2_title'), body: t.rich('workers.c2_body', { b: semibold }) },
        { icon: <Languages />, title: t('workers.c3_title'), body: t('workers.c3_body') },
        { icon: <FileCheck />, title: t('workers.c4_title'), body: t('workers.c4_body') },
        { icon: <Lock />, title: t('workers.c5_title'), body: t('workers.c5_body') },
        { icon: <Zap />, title: t('workers.c6_title'), body: t('workers.c6_body') },
    ];

    const employerCards = [
        { icon: <Target />, title: t('employers.c1_title'), body: t('employers.c1_body') },
        { icon: <UploadCloud />, title: t('employers.c2_title'), body: t('employers.c2_body') },
        { icon: <FileCheck />, title: t('employers.c3_title'), body: t('employers.c3_body') },
        { icon: <Clock />, title: t('employers.c4_title'), body: t('employers.c4_body') },
    ];

    const testimonials = [
        {
            quote: t.rich('testimonials.q1', { blue: blueBoldOnSurface }),
            name: t('testimonials.q1_name'),
            role: t('testimonials.q1_role'),
            initials: t('testimonials.q1_initials'),
            square: false,
        },
        {
            quote: t.rich('testimonials.q2', { blue: blueBoldOnSurface }),
            name: t('testimonials.q2_name'),
            role: t('testimonials.q2_role'),
            initials: t('testimonials.q2_initials'),
            square: true,
        },
    ];

    const chips = ['chip1', 'chip2', 'chip3', 'chip4', 'chip5', 'chip6'] as const;

    return (
        // Brand navy ground. Every section paints its own surface on top; this
        // only shows through above/below them on very tall viewports.
        <div className="min-h-screen bg-[var(--jale-blue-900)] text-[var(--jale-ink)]">
            <style>{`
html { scroll-behavior: smooth; }
::selection { background: rgba(1,121,255,.18); }
.jale-link:hover { color: #fff; }
@keyframes jaleFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
@keyframes jaleSlideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes jaleCarousel { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.jale-float { animation: jaleFloat 6s ease-in-out infinite; }
.jale-slide-in { animation: jaleSlideIn .4s ease-out both; }
.jale-carousel-track { animation: jaleCarousel 40s linear infinite; width: max-content; }
.jale-carousel-track:hover { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .jale-float, .jale-slide-in, .jale-carousel-track { animation: none; }
}
`}</style>

            <LandingNav />

            {/* ===== Hero (BRAND navy + dot pattern) ===== */}
            <header className="bg-[var(--jale-blue-900)] px-5 pb-20 pt-12 md:px-8 md:pt-16" style={DOT_PATTERN_BLUE}>
                <div className="mx-auto grid max-w-[1120px] items-center gap-12 lg:grid-cols-[1.05fr_.95fr]">
                    <div>
                        {/* The locked style's dot+text badge, in place of the
                            tinted pill this eyebrow used to be. `Badge` hard-codes
                            `--jale-ink-2` for its label, which is unreadable on
                            brand navy, so the label colour comes in through
                            `labelClassName`.
                            The label rides `--jale-blue-300` (#78a4ff) rather than
                            the brand `-500`: on this navy blue-500 measures 2.92:1,
                            under AA at any size, while blue-300 clears it at 6.58:1.
                            The dot keeps brand blue: it is decorative -- it carries
                            no text and duplicates no information -- so 1.4.11 does
                            not bite even at 2.92:1. */}
                        <Badge
                            dotClassName="bg-[var(--jale-blue-500)]"
                            labelClassName="text-[var(--jale-blue-300)]"
                            className="uppercase tracking-[.08em]"
                        >
                            {t('hero.eyebrow')}
                        </Badge>
                        {/* Accent word on the FIXED brand navy, so it rides
                            `--jale-blue-300` for the same reason the eyebrow above
                            does: `--jale-blue-900` never re-tints, and the CTA blue
                            `--jale-blue-500` (#0064d6) is only 2.92:1 on it -- under
                            even the 3:1 large-text floor. blue-300 is 6.58:1, so this
                            clears AA outright rather than leaning on the display size.
                            Do NOT "fix" this back to blue-500 for brand consistency:
                            blue-500 is tuned to carry white ON it, not to be read
                            against navy. */}
                        <h1
                            className="mt-[18px] font-extrabold text-white"
                            style={{ fontSize: 'clamp(2.75rem, 8vw, 5.25rem)', lineHeight: 0.98, letterSpacing: '-0.04em' }}
                        >
                            {t('hero.h1_start')} <span className="text-[var(--jale-blue-300)]">{t('hero.h1_accent')}</span>
                        </h1>
                        <p className="mt-5 max-w-[490px] text-[19px] leading-[1.6] text-white/[.78]">
                            {t.rich('hero.sub', { blue: blueStrongOnNavy, b: semibold })}
                        </p>
                        <a
                            href="#cta"
                            style={{ color: '#fff' }}
                            className="mt-7 inline-flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-[var(--jale-blue-500)] px-7 py-[15px] text-base font-bold shadow-[var(--shadow-btn)] transition-colors hover:bg-[var(--jale-blue-600)] sm:w-auto"
                        >
                            <MessageCircle size={20} />
                            {t('hero.cta')}
                        </a>
                        <div className="mt-[18px] flex items-center gap-2 text-[13px] text-white/60">
                            {/* blue-300, not blue-500: same fixed navy as the h1
                                above. blue-500 is 2.92:1 here, below the 3:1
                                non-text floor in 1.4.11; blue-300 is 6.58:1. */}
                            <Check size={16} className="text-[var(--jale-blue-300)]" />
                            {t('hero.free_line')}
                        </div>
                    </div>

                    <PhoneMockup />
                </div>

                {/* Trade chips strip */}
                <div className="mx-auto mt-[52px] max-w-[1120px]">
                    <div className="mb-[18px] text-center text-xs font-bold uppercase tracking-[.1em] text-white/45">
                        {t('hero.chips_label')}
                    </div>
                    <div className="flex flex-wrap justify-center gap-2.5">
                        {chips.map((chip) => (
                            <span
                                key={chip}
                                className="rounded-full border border-white/[.12] bg-white/[.07] px-4 py-[9px] text-sm font-medium text-white/85"
                            >
                                {t(`hero.${chip}`)}
                            </span>
                        ))}
                    </div>
                </div>
            </header>

            {/* ===== Cómo funciona (APP surface) ===== */}
            <section id="how-it-works" className="bg-[var(--jale-paper)] px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('how.eyebrow')} title={t('how.title')} />
                    <div className="grid grid-cols-1 gap-[22px] md:grid-cols-3">
                        {howSteps.map((step) => (
                            <div
                                key={step.n}
                                className="rounded-2xl bg-[var(--jale-card)] p-[30px] shadow-[var(--shadow-card)]"
                            >
                                <div className="flex items-center justify-between">
                                    <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]">
                                        {step.icon}
                                    </span>
                                    <span
                                        className="text-5xl font-extrabold leading-none text-[var(--jale-blue-50)]"
                                        aria-hidden
                                    >
                                        {step.n}
                                    </span>
                                </div>
                                <h3 className="mb-2 mt-5 text-xl font-bold text-[var(--jale-ink)]">{step.title}</h3>
                                <p className="text-[15px] leading-[1.6] text-[var(--jale-ink-2)]">{step.body}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ===== Audience split (BRAND navy) ===== */}
            <section id="for-workers" className="bg-[var(--jale-blue-900)] px-5 py-20 md:px-8">
                <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-[22px] md:grid-cols-2">
                    {/* Busco trabajo */}
                    <div className="rounded-[20px] bg-[var(--jale-blue-500)] p-7 text-white md:p-10">
                        <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-white/[.18]">
                            <HardHat />
                        </span>
                        <h3 className="mb-[18px] mt-[22px] text-3xl font-extrabold">
                            {t('audience.worker_title')}
                        </h3>
                        <ul className="mb-7 flex flex-col gap-[13px]">
                            {(['worker_b1', 'worker_b2', 'worker_b3', 'worker_b4'] as const).map((key) => (
                                <li key={key} className="flex items-start gap-2.5 text-base">
                                    <Check size={20} className="mt-[1px] shrink-0" />
                                    <span>{t.rich(`audience.${key}`, { b: semibold })}</span>
                                </li>
                            ))}
                        </ul>
                        {/* White pill on a brand surface: its ink is `--jale-blue-800`,
                            not the app's `--jale-blue-700`, because blue-700 flips to a
                            pale blue in dark and this pill never does. */}
                        <a
                            href="#cta"
                            style={{ color: 'var(--jale-blue-800)' }}
                            className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full bg-white px-[22px] py-[13px] text-[15px] font-bold transition-colors hover:bg-[var(--jale-blue-100)] sm:w-auto"
                        >
                            <MessageCircle size={17} />
                            {t('audience.worker_cta')}
                        </a>
                    </div>

                    {/* Estoy contratando */}
                    <div
                        id="for-employers"
                        className="rounded-[20px] border border-white/10 bg-[var(--jale-blue-950)] p-7 text-white md:p-10"
                    >
                        {/* Tile FILL stays brand blue at 10% (decorative tint);
                            the glyph rides blue-300 like every other mark on a
                            fixed-navy ground here. Over this tile (blue-500 @10%
                            on blue-950 = #0d174c) blue-500 was a hairline 3.05:1;
                            blue-300 is 6.88:1. */}
                        <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-[var(--jale-blue-500)]/10 text-[var(--jale-blue-300)]">
                            <Building2 />
                        </span>
                        <h3 className="mb-[18px] mt-[22px] text-3xl font-extrabold">
                            {t('audience.employer_title')}
                        </h3>
                        <ul className="mb-7 flex flex-col gap-[13px]">
                            {(['employer_b1', 'employer_b2', 'employer_b3', 'employer_b4'] as const).map((key) => (
                                <li key={key} className="flex items-start gap-2.5 text-base text-white/[.86]">
                                    {/* blue-300 (7.44:1 on blue-950), not blue-500
                                        (3.30:1 -- a hairline pass that drops to a
                                        fail the moment this card's navy shifts). */}
                                    <Check size={20} className="mt-[1px] shrink-0 text-[var(--jale-blue-300)]" />
                                    <span>{t.rich(`audience.${key}`, { b: semibold })}</span>
                                </li>
                            ))}
                        </ul>
                        <Link
                            href="/auth/employer"
                            style={{ color: '#fff' }}
                            className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full bg-[var(--jale-blue-500)] px-[22px] py-[13px] text-[15px] font-bold transition-colors hover:bg-[var(--jale-blue-600)] sm:w-auto"
                        >
                            <ArrowRight size={17} />
                            {t('audience.employer_cta')}
                        </Link>
                        <div className="mt-3.5 flex items-center gap-2 text-[13px] text-white/60">
                            <Info size={16} />
                            {t('audience.employer_note')}
                        </div>
                    </div>
                </div>
            </section>

            {/* ===== Built for workers (APP surface) ===== */}
            <section className="bg-[var(--jale-shell)] px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('workers.eyebrow')} title={t('workers.title')} />
                    <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
                        {workerCards.map((card, i) => (
                            <BenefitCard key={i} icon={card.icon} title={card.title} body={card.body} variant="raised" />
                        ))}
                    </div>
                </div>
            </section>

            {/* ===== Built for employers (APP surface) + companies carousel ===== */}
            <section className="bg-[var(--jale-paper)] px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('employers.eyebrow')} title={t('employers.title')} />
                    <div className="mb-12 grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
                        {employerCards.map((card, i) => (
                            <BenefitCard key={i} icon={card.icon} title={card.title} body={card.body} variant="quiet" />
                        ))}
                    </div>
                    <CompaniesCarousel />
                </div>
            </section>

            {/* ===== Testimonials (APP surface) ===== */}
            <section className="bg-[var(--jale-shell)] px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('testimonials.eyebrow')} title={t('testimonials.title')} />
                    <div className="grid grid-cols-1 gap-[22px] md:grid-cols-2">
                        {testimonials.map((item) => (
                            <figure
                                key={item.name}
                                className="rounded-[20px] bg-[var(--jale-card)] p-7 shadow-[var(--shadow-card)] md:p-9"
                            >
                                <blockquote className="mb-6 text-[21px] font-medium leading-[1.5] text-[var(--jale-ink)]">
                                    {item.quote}
                                </blockquote>
                                <figcaption className="flex items-center gap-3">
                                    <InitialsAvatar
                                        name={item.name}
                                        fallback={item.initials}
                                        size={44}
                                        square={item.square}
                                    />
                                    <span>
                                        <span className="block text-[15px] font-bold text-[var(--jale-ink)]">{item.name}</span>
                                        <span className="block text-[13px] text-[var(--jale-ink-2)]">{item.role}</span>
                                    </span>
                                </figcaption>
                            </figure>
                        ))}
                    </div>
                </div>
            </section>

            {/* ===== CTA (BRAND blue + white dot pattern) ===== */}
            <section id="cta" className="bg-[var(--jale-blue-500)] px-5 py-[84px] md:px-8" style={DOT_PATTERN_WHITE}>
                <div className="mx-auto max-w-[760px] text-center text-white">
                    <h2
                        className="font-extrabold"
                        style={{ fontSize: 'clamp(2.75rem, 7vw, 4rem)', lineHeight: 1, letterSpacing: '-0.04em' }}
                    >
                        {t('cta.title')}
                    </h2>
                    <p className="mt-[18px] text-[19px] leading-[1.55] text-white/90">
                        {t.rich('cta.line', { b: semibold })}
                    </p>
                    <a
                        href={WHATSAPP_HREF}
                        target="_blank"
                        rel="noopener"
                        style={{ color: 'var(--jale-blue-800)' }}
                        className="mt-7 inline-flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-white px-7 py-[15px] text-base font-bold shadow-[0_4px_12px_rgba(0,0,0,.15)] transition-colors hover:bg-[var(--jale-blue-100)] sm:w-auto"
                    >
                        <MessageCircle size={20} />
                        {t('cta.button')}
                    </a>
                    <p className="mt-5 text-sm text-white/75">{t.rich('cta.copy_line', { b: (c) => <span className="font-bold">{c}</span> })}</p>
                </div>
            </section>

            {/* ===== Footer (BRAND deep navy) ===== */}
            <footer className="bg-[var(--jale-blue-950)] px-5 pb-9 pt-14 text-white/70 md:px-8">
                <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr]">
                    <div>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src="/brand/wordmark-white.png"
                            alt="Jale"
                            className="block h-[50px] w-auto"
                            style={{ filter: 'drop-shadow(0 4px 16px rgba(1,121,255,.4))' }}
                        />
                        <p className="mt-4 max-w-[240px] text-sm leading-[1.6]">{t('footer.tagline')}</p>
                    </div>
                    <div>
                        <div className="mb-3.5 text-xs font-bold uppercase tracking-[.08em] text-white/40">
                            {t('footer.product')}
                        </div>
                        <div className="flex flex-col gap-2.5 text-sm">
                            <a href="#how-it-works" className="jale-link transition-colors">{t('nav.how')}</a>
                            <a href="#for-workers" className="jale-link transition-colors">{t('nav.workers')}</a>
                            <a href="#for-employers" className="jale-link transition-colors">{t('nav.employers')}</a>
                        </div>
                    </div>
                    <div>
                        <div className="mb-3.5 text-xs font-bold uppercase tracking-[.08em] text-white/40">
                            {t('footer.legal')}
                        </div>
                        <div className="flex flex-col gap-2.5 text-sm">
                            <a href="/legal/terms" className="jale-link transition-colors">{t('footer.terms')}</a>
                            <a href="/legal/privacy" className="jale-link transition-colors">{t('footer.privacy')}</a>
                        </div>
                    </div>
                </div>
                <div className="mx-auto mt-9 max-w-[1120px] border-t border-white/10 pt-6 text-[13px] text-white/45">
                    {t('footer.copyright')}
                </div>
            </footer>
        </div>
    );
}
