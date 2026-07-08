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
import { LandingNav } from '@/components/landing/LandingNav';
import { PhoneMockup } from '@/components/landing/PhoneMockup';
import { CompaniesCarousel } from '@/components/landing/CompaniesCarousel';

// WhatsApp deep link (from the design source). Only the #cta section button
// opens it; nav/hero/audience CTAs scroll to #cta.
const WHATSAPP_HREF = 'https://wa.me/18667873469';

const DOT_PATTERN_BLUE: React.CSSProperties = {
    backgroundImage: 'radial-gradient(circle, rgba(120,164,255,.16) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
};
const DOT_PATTERN_WHITE: React.CSSProperties = {
    backgroundImage: 'radial-gradient(circle, rgba(255,255,255,.12) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
};

// Multi-shadow values don't survive Tailwind arbitrary-value parsing, so the
// design's card shadow is applied as an inline style.
const CARD_SHADOW_STYLE: React.CSSProperties = {
    boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.06)',
};

// Rich-text renderers for spans in the i18n copy (styles from the design).
const blueStrong = (chunks: React.ReactNode) => (
    <span className="font-semibold text-[#0179FF]">{chunks}</span>
);
const blueBold = (chunks: React.ReactNode) => (
    <span className="font-bold text-[#0179FF]">{chunks}</span>
);
const semibold = (chunks: React.ReactNode) => <span className="font-semibold">{chunks}</span>;

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
    return (
        <div className="mx-auto mb-12 max-w-[640px] text-center">
            <div className="text-[13px] font-bold uppercase tracking-[.08em] text-[#0179FF]">
                {eyebrow}
            </div>
            <h2
                className="mt-3.5 font-bold text-[#181855]"
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
    variant: 'white' | 'gray';
}) {
    return (
        <div
            className={variant === 'white' ? 'rounded-2xl bg-white p-[26px]' : 'rounded-2xl bg-[#f4f6fa] p-[26px]'}
            style={variant === 'white' ? CARD_SHADOW_STYLE : undefined}
        >
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#eaf2ff] text-[#0179FF]">
                {icon}
            </span>
            <h3 className="mb-[5px] mt-4 text-[17px] font-bold text-[#181855]">{title}</h3>
            <p className="text-sm leading-[1.55] text-[#5b6480]">{body}</p>
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
            quote: t.rich('testimonials.q1', { blue: blueBold }),
            name: t('testimonials.q1_name'),
            role: t('testimonials.q1_role'),
            initials: t('testimonials.q1_initials'),
            avatarClass: 'rounded-full bg-[#eaf2ff] text-[#0050ad]',
        },
        {
            quote: t.rich('testimonials.q2', { blue: blueBold }),
            name: t('testimonials.q2_name'),
            role: t('testimonials.q2_role'),
            initials: t('testimonials.q2_initials'),
            avatarClass: 'rounded-xl bg-[#e3eaf2] text-[#0179FF]',
        },
    ];

    const chips = ['chip1', 'chip2', 'chip3', 'chip4', 'chip5', 'chip6'] as const;

    return (
        <div className="min-h-screen bg-[#181855] text-[#181855]">
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

            {/* ===== Hero (navy + dot pattern) ===== */}
            <header className="bg-[#181855] px-5 pb-20 pt-12 md:px-8 md:pt-16" style={DOT_PATTERN_BLUE}>
                <div className="mx-auto grid max-w-[1120px] items-center gap-12 lg:grid-cols-[1.05fr_.95fr]">
                    <div>
                        <div className="inline-flex items-center gap-2 rounded-full bg-[rgba(1,121,255,.1)] px-3.5 py-[7px] text-xs font-bold uppercase tracking-[.06em] text-[#0179FF]">
                            <span className="h-[7px] w-[7px] rounded-full bg-[#0179FF]" aria-hidden />
                            {t('hero.eyebrow')}
                        </div>
                        <h1
                            className="mt-[22px] font-extrabold text-white"
                            style={{ fontSize: 'clamp(2.75rem, 8vw, 5.25rem)', lineHeight: 0.98, letterSpacing: '-0.04em' }}
                        >
                            {t('hero.h1_start')} <span className="text-[#0179FF]">{t('hero.h1_accent')}</span>
                        </h1>
                        <p className="mt-5 max-w-[490px] text-[19px] leading-[1.6] text-white/[.78]">
                            {t.rich('hero.sub', { blue: blueStrong, b: semibold })}
                        </p>
                        <a
                            href="#cta"
                            style={{ color: '#fff' }}
                            className="mt-7 inline-flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-[#0179FF] px-7 py-[15px] text-base font-bold text-white shadow-[0_4px_12px_rgba(1,121,255,.35)] transition-colors hover:bg-[#0064d6] sm:w-auto"
                        >
                            <MessageCircle size={20} />
                            {t('hero.cta')}
                        </a>
                        <div className="mt-[18px] flex items-center gap-2 text-[13px] text-white/60">
                            <Check size={16} className="text-[#0179FF]" />
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

            {/* ===== Cómo funciona (light) ===== */}
            <section id="how-it-works" className="bg-[#e3eaf2] px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('how.eyebrow')} title={t('how.title')} />
                    <div className="grid grid-cols-1 gap-[22px] md:grid-cols-3">
                        {howSteps.map((step) => (
                            <div key={step.n} className="rounded-2xl bg-white p-[30px]" style={CARD_SHADOW_STYLE}>
                                <div className="flex items-center justify-between">
                                    <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-[#eaf2ff] text-[#0179FF]">
                                        {step.icon}
                                    </span>
                                    <span className="text-5xl font-extrabold leading-none text-[#eaf2ff]" aria-hidden>
                                        {step.n}
                                    </span>
                                </div>
                                <h3 className="mb-2 mt-5 text-xl font-bold text-[#181855]">{step.title}</h3>
                                <p className="text-[15px] leading-[1.6] text-[#5b6480]">{step.body}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ===== Audience split (navy) ===== */}
            <section id="for-workers" className="bg-[#181855] px-5 py-20 md:px-8">
                <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-[22px] md:grid-cols-2">
                    {/* Busco trabajo */}
                    <div className="rounded-[20px] bg-[#0179FF] p-7 text-white md:p-10">
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
                        <a
                            href="#cta"
                            style={{ color: '#0050ad' }}
                            className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full bg-white px-[22px] py-[13px] text-[15px] font-bold text-[#0050ad] transition-colors hover:bg-[#eaf2ff] sm:w-auto"
                        >
                            <MessageCircle size={17} />
                            {t('audience.worker_cta')}
                        </a>
                    </div>

                    {/* Estoy contratando */}
                    <div
                        id="for-employers"
                        className="rounded-[20px] border border-white/10 bg-[#0e0e3d] p-7 text-white md:p-10"
                    >
                        <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-[rgba(1,121,255,.12)] text-[#0179FF]">
                            <Building2 />
                        </span>
                        <h3 className="mb-[18px] mt-[22px] text-3xl font-extrabold">
                            {t('audience.employer_title')}
                        </h3>
                        <ul className="mb-7 flex flex-col gap-[13px]">
                            {(['employer_b1', 'employer_b2', 'employer_b3', 'employer_b4'] as const).map((key) => (
                                <li key={key} className="flex items-start gap-2.5 text-base text-white/[.86]">
                                    <Check size={20} className="mt-[1px] shrink-0 text-[#0179FF]" />
                                    <span>{t.rich(`audience.${key}`, { b: semibold })}</span>
                                </li>
                            ))}
                        </ul>
                        <Link
                            href="/auth/employer"
                            style={{ color: '#fff' }}
                            className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full bg-[#0179FF] px-[22px] py-[13px] text-[15px] font-bold text-white transition-colors hover:bg-[#0064d6] sm:w-auto"
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

            {/* ===== Built for workers (lighter) ===== */}
            <section className="bg-[#f4f6fa] px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('workers.eyebrow')} title={t('workers.title')} />
                    <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
                        {workerCards.map((card, i) => (
                            <BenefitCard key={i} icon={card.icon} title={card.title} body={card.body} variant="white" />
                        ))}
                    </div>
                </div>
            </section>

            {/* ===== Built for employers (white) + companies carousel ===== */}
            <section className="bg-white px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('employers.eyebrow')} title={t('employers.title')} />
                    <div className="mb-12 grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
                        {employerCards.map((card, i) => (
                            <BenefitCard key={i} icon={card.icon} title={card.title} body={card.body} variant="gray" />
                        ))}
                    </div>
                    <CompaniesCarousel />
                </div>
            </section>

            {/* ===== Testimonials (light) ===== */}
            <section className="bg-[#e3eaf2] px-5 py-20 md:px-8">
                <div className="mx-auto max-w-[1120px]">
                    <SectionHeading eyebrow={t('testimonials.eyebrow')} title={t('testimonials.title')} />
                    <div className="grid grid-cols-1 gap-[22px] md:grid-cols-2">
                        {testimonials.map((item) => (
                            <figure
                                key={item.initials}
                                className="rounded-[20px] bg-white p-7 md:p-9"
                                style={CARD_SHADOW_STYLE}
                            >
                                <blockquote className="mb-6 text-[21px] font-medium leading-[1.5] text-[#181855]">
                                    {item.quote}
                                </blockquote>
                                <figcaption className="flex items-center gap-3">
                                    <span
                                        className={`flex h-11 w-11 items-center justify-center font-bold ${item.avatarClass}`}
                                        aria-hidden
                                    >
                                        {item.initials}
                                    </span>
                                    <span>
                                        <span className="block text-[15px] font-bold text-[#181855]">{item.name}</span>
                                        <span className="block text-[13px] text-[#5b6480]">{item.role}</span>
                                    </span>
                                </figcaption>
                            </figure>
                        ))}
                    </div>
                </div>
            </section>

            {/* ===== CTA (blue + white dot pattern) ===== */}
            <section id="cta" className="bg-[#0179FF] px-5 py-[84px] md:px-8" style={DOT_PATTERN_WHITE}>
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
                        style={{ color: '#0050ad' }}
                        className="mt-7 inline-flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-white px-7 py-[15px] text-base font-bold text-[#0050ad] shadow-[0_4px_12px_rgba(0,0,0,.15)] transition-colors hover:bg-[#eaf2ff] sm:w-auto"
                    >
                        <MessageCircle size={20} />
                        {t('cta.button')}
                    </a>
                    <p className="mt-5 text-sm text-white/75">{t.rich('cta.copy_line', { b: (c) => <span className="font-bold">{c}</span> })}</p>
                </div>
            </section>

            {/* ===== Footer (deep navy) ===== */}
            <footer className="bg-[#0e0e3d] px-5 pb-9 pt-14 text-white/70 md:px-8">
                <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
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
                            {t('footer.company')}
                        </div>
                        <div className="flex flex-col gap-2.5 text-sm">
                            <a href="#" className="jale-link transition-colors">{t('footer.about')}</a>
                            <a href="#" className="jale-link transition-colors">{t('footer.careers')}</a>
                            <a href="#" className="jale-link transition-colors">{t('footer.contact')}</a>
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
