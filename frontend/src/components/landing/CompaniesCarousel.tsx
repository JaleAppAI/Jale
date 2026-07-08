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
 */
export function CompaniesCarousel() {
    const t = useTranslations('landing.employers');
    const loop = [...COMPANIES, ...COMPANIES];

    const blue = (chunks: React.ReactNode) => (
        <span className="font-bold text-[#0179FF]">{chunks}</span>
    );

    return (
        <div className="overflow-hidden rounded-[20px] border border-[#e5e7eb] bg-[#f9fafb] p-6 md:p-12">
            <h3 className="mb-8 text-center text-2xl font-bold text-[#181855]">
                {t('companies_title')}
            </h3>
            {/* Edge fades so cards entering/leaving the marquee don't look clipped. */}
            <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)]">
                <div className="jale-carousel-track flex gap-[18px]">
                    {loop.map((c, i) => (
                        <figure
                            key={`${c.key}-${i}`}
                            aria-hidden={i >= COMPANIES.length}
                            className="m-0 w-[300px] shrink-0 grow-0 rounded-2xl bg-white p-6 md:w-[360px]"
                            style={{ boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.06)' }}
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
                                    <div className="truncate text-sm font-bold text-[#181855]">
                                        {t(`${c.key}_name`)}
                                    </div>
                                    <div className="truncate text-xs text-[#5b6480]">
                                        {t(`${c.key}_industry`)}
                                    </div>
                                </figcaption>
                            </div>
                            <p className="text-[15px] leading-[1.5] text-[#181855]">
                                {t.rich(`${c.key}_quote`, { blue })}
                            </p>
                        </figure>
                    ))}
                </div>
            </div>
        </div>
    );
}
