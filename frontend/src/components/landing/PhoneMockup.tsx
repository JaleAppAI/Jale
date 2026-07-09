import { useTranslations } from 'next-intl';
import { BatteryFull, Mic, MoreVertical, Plus, Send, Signal, Wifi } from 'lucide-react';

const BUBBLES = [
    { key: 'in1', out: false, delay: '.1s' },
    { key: 'out1', out: true, delay: '.2s' },
    { key: 'in2', out: false, delay: '.3s' },
    { key: 'out2', out: true, delay: '.4s' },
    { key: 'in3', out: false, delay: '.5s' },
    { key: 'out3', out: true, delay: '.6s' },
    { key: 'in4', out: false, delay: '.7s' },
] as const;

/**
 * Pure JSX/CSS phone mockup showing a WhatsApp onboarding chat with Jale,
 * copied from the "1a Bold" design source. Visible strings come from the
 * `landing.chat` namespace ("Jale"/"J" wordmark exempt). Decorative — exposed
 * to AT as a single labeled image. Animation classes (`jale-float`,
 * `jale-slide-in`) are defined by the landing page's style block.
 */
export function PhoneMockup() {
    const t = useTranslations('landing.chat');

    const bubbleIn =
        'max-w-[85%] rounded-[16px_16px_4px_16px] bg-[#e8f0fe] px-3 py-[9px] leading-[1.4] text-[#1a1a1a]';
    const bubbleOut =
        'max-w-[85%] rounded-[16px_4px_16px_16px] bg-[#0179FF] px-3 py-[9px] leading-[1.4] text-white';

    return (
        <div className="flex justify-center">
            <div
                role="img"
                aria-label={t('aria')}
                className="jale-float w-[280px] rounded-[42px] border-[9px] border-[#0e0e3d] bg-[#0e0e3d] shadow-[0_30px_60px_-18px_rgba(0,0,0,.55)] sm:w-[300px]"
            >
                <div className="flex h-[580px] flex-col overflow-hidden rounded-[34px] bg-white">
                    {/* Status bar */}
                    <div className="flex items-center justify-between px-5 pb-1.5 pt-3 text-xs font-semibold text-[#181855]">
                        <span>{t('time')}</span>
                        <span className="flex gap-[5px]">
                            <Signal size={14} />
                            <Wifi size={14} />
                            <BatteryFull size={16} />
                        </span>
                    </div>

                    {/* Chat header */}
                    <div className="flex items-center justify-between border-b border-[#e0e0e0] bg-[#f8f8f8] px-4 py-3">
                        <div className="flex flex-1 items-center gap-2.5">
                            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0179FF] text-xs font-bold text-white">
                                J
                            </span>
                            <span className="flex flex-col">
                                <span className="text-[13px] font-bold leading-tight text-[#181855]">Jale</span>
                                <span className="text-[11px] leading-tight text-[#99a3b3]">{t('status')}</span>
                            </span>
                        </div>
                        <MoreVertical size={18} className="text-[#99a3b3]" />
                    </div>

                    {/* Messages */}
                    <div className="flex flex-1 flex-col gap-2.5 overflow-hidden bg-white p-3 text-[13px]">
                        {BUBBLES.map((b) => (
                            <div
                                key={b.key}
                                className={`jale-slide-in${b.out ? ' flex justify-end' : ''}`}
                                style={{ animationDelay: b.delay }}
                            >
                                <div className={b.out ? bubbleOut : bubbleIn}>{t(b.key)}</div>
                            </div>
                        ))}
                    </div>

                    {/* Input row */}
                    <div className="flex items-center gap-2 border-t border-[#e0e0e0] bg-[#f8f8f8] p-3">
                        <Plus size={20} className="shrink-0 text-[#0179FF]" />
                        <input
                            type="text"
                            placeholder={t('input')}
                            readOnly
                            tabIndex={-1}
                            aria-hidden
                            className="min-w-0 flex-1 border-0 bg-transparent px-1 py-1.5 font-[inherit] text-[13px] text-[#1a1a1a]"
                        />
                        <Mic size={20} className="shrink-0 text-[#0179FF]" />
                        <Send size={20} className="shrink-0 text-[#0179FF]" />
                    </div>
                </div>
            </div>
        </div>
    );
}
