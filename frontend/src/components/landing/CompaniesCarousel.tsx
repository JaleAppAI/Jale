import * as React from 'react';
import { useTranslations } from 'next-intl';

// Logo URLs verbatim from the "1a Bold" design source.
const COMPANIES = [
    { key: 'co1', src: 'https://spearcommercial.com/assets/spear-arrow.png', darken: false },
    {
        key: 'co2',
        src: 'https://i0.wp.com/rucomaya.com/wp-content/uploads/2020/07/rm-logo.png',
        darken: false,
    },
    {
        key: 'co3',
        src: 'https://static.wixstatic.com/media/b51157_3090607360174eec915c4330ac6c0491~mv2.png/v1/fill/w_518,h_174,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/L%26L-homes-logo-colored_edited.png',
        darken: false,
    },
    { key: 'co4', src: 'https://yerba-buena.net/wp-content/uploads/2023/03/logo.webp', darken: true },
] as const;

/**
 * "Companies using Jale" logo marquee. The full set of companies is rendered
 * twice back-to-back; the track slides via the `jale-carousel-track` class
 * (translateX 0 → -50%, 40s linear infinite, pause-on-hover, reduced-motion
 * guarded) defined by the landing page's style block. Because the second copy
 * is identical to the first, the -50% point lands exactly where the loop
 * started, so the repeat is seamless (no snap). Cards are a fixed, comfortable
 * width so the quotes never crowd the edges.
 *
 * The logo cards are a BRAND/ASSET surface: they stay a light plate in BOTH
 * themes. These are other companies' logos, supplied as light-background PNGs
 * (one is force-darkened with `brightness(0)` precisely because it ships white),
 * and a partner's mark is not ours to re-tint. Their text therefore rides
 * `--jale-blue-900`, one of the brand-ramp tokens the dark theme leaves fixed,
 * rather than `--jale-ink`, which would flip to near-white and vanish. The
 * surrounding plate IS themed, so the wall reads as a deliberate light panel
 * inside a dark section.
 */
export function CompaniesCarousel() {
    const t = useTranslations('landing.employers');
    const loop = [...COMPANIES, ...COMPANIES];

    const blue = (chunks: React.ReactNode) => (
        <span className="font-bold text-[var(--jale-blue-500)]">{chunks}</span>
    );

    return (
        <div className="overflow-hidden rounded-[20px] border border-[var(--jale-divider)] bg-[var(--jale-card)] p-6 md:p-12">
            <h3 className="mb-8 text-center text-2xl font-extrabold text-[var(--jale-ink)]">
                {t('companies_title')}
            </h3>
            {/* Edge fades so cards entering/leaving the marquee don't look clipped. */}
            <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)]">
                <div className="jale-carousel-track flex gap-[18px]">
                    {loop.map((c, i) => (
                        <figure
                            key={`${c.key}-${i}`}
                            aria-hidden={i >= COMPANIES.length}
                            // `bg-white`: see the asset note above — the plate a
                            // partner logo sits on is fixed, in both themes.
                            className="m-0 w-[300px] shrink-0 grow-0 rounded-2xl bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,.04),0_4px_16px_rgba(0,0,0,.06)] md:w-[360px]"
                        >
                            <div className="mb-4 flex items-center gap-3">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={c.src}
                                    alt={t(`${c.key}_logo_alt`)}
                                    loading="lazy"
                                    className="h-12 w-auto shrink-0 object-contain"
                                    style={c.darken ? { filter: 'brightness(0)' } : undefined}
                                />
                                <figcaption className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-bold text-[var(--jale-blue-900)]">
                                        {t(`${c.key}_name`)}
                                    </div>
                                    <div className="truncate text-xs text-[var(--jale-blue-900)]/60">
                                        {t(`${c.key}_industry`)}
                                    </div>
                                </figcaption>
                            </div>
                            <p className="text-[15px] leading-[1.5] text-[var(--jale-blue-900)]">
                                {t.rich(`${c.key}_quote`, { blue })}
                            </p>
                        </figure>
                    ))}
                </div>
            </div>
        </div>
    );
}
