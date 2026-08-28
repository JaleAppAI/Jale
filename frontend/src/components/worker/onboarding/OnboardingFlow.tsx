'use client';
import { useEffect, useReducer, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { classifyError, errorMessageKey } from '@/lib/api/errors';
import {
    getWorkerOnboarding,
    patchOnboardingLanguage,
    postOnboardingAnswers,
    postOnboardingBack,
    type OnboardingState,
} from '@/lib/api/worker';
import {
    currentScreen,
    initFlowState,
    onboardingFlowReducer,
    questionText,
    trustQuestionIndex,
    type OnboardingAnswerBatch,
    type OnboardingDraft,
} from '@/lib/onboarding-flow';
import { tradeLabel } from '@/lib/worker-vocab';
import { OnboardingShell, type LanguageChoice } from './OnboardingHeader';
import { ProgressSegments } from './ProgressSegments';
import { TermsStep } from './TermsStep';
import { AboutYouStep } from './AboutYouStep';
import { TradeStep } from './TradeStep';
import { WorkStep } from './WorkStep';
import { TrustQuestionStep } from './TrustQuestionStep';
import { PhotoStep } from './PhotoStep';
import { DoneStep } from './DoneStep';

/**
 * The one stateful component in the flow: it owns the reducer and every
 * network call, and the screens below it are pure props.
 *
 * WHY THE SERVER IS THE SOURCE OF TRUTH FOR "WHERE AM I". This flow is a
 * SECOND DOOR onto the WhatsApp onboarding state machine, not a wizard with
 * its own step counter. The same worker can be answering question 2 on
 * WhatsApp while this tab is open, so:
 *
 *   - the screen comes from `run.stepKey` (see `lib/onboarding-flow.ts`),
 *   - every response re-seeds `lockVersion`, and
 *   - a 409 means the other door moved first: refetch, retry ONCE, and if it
 *     conflicts again say so rather than fighting for the run.
 *
 * WHY NOT `usePageData`. That hook's legal-wall handling redirects to
 * `/legal/accept` on a `legal_wall` classification — and accepting the legal
 * terms is a STEP of this flow (`TermsStep`). Wiring it up here would bounce a
 * worker out of onboarding to accept the very terms they are being shown.
 * The page does its own fetch and this component owns the mutations.
 */

/** The summary polls while the skill extraction runs behind it. */
export const POLL_INTERVAL_MS = 3_000;
/** 20 polls at 3s = one minute, then stop. An attempt count, not a clock. */
export const MAX_POLLS = 20;

export function OnboardingFlow({
    token,
    initialState,
}: {
    token: string;
    initialState: OnboardingState;
}) {
    const locale = useLocale();
    const router = useRouter();
    const pathname = usePathname();
    const tCommon = useTranslations('common');
    const tVocab = useTranslations('worker_vocab');
    const [flow, dispatch] = useReducer(onboardingFlowReducer, initialState, initFlowState);
    const [languageBusy, setLanguageBusy] = useState(false);

    const screen = currentScreen(flow);
    const extractionStatus = flow.server.extraction?.status ?? 'pending';

    // Poll the extraction while the summary is on screen. Capped by ATTEMPTS
    // rather than wall-clock so the stop condition is exact under test and
    // unaffected by a tab that was backgrounded mid-run.
    useEffect(() => {
        if (screen !== 'done') return;
        if (extractionStatus === 'completed' || extractionStatus === 'failed') return;

        let polls = 0;
        const controller = new AbortController();
        const timer = window.setInterval(() => {
            polls += 1;
            if (polls >= MAX_POLLS) window.clearInterval(timer);
            getWorkerOnboarding(token, controller.signal)
                .then((server) => dispatch({ type: 'sync_server', server }))
                // A failed poll is not worth a banner: the answers are saved,
                // the profile is live, and the next tick tries again.
                .catch(() => {});
        }, POLL_INTERVAL_MS);

        return () => {
            window.clearInterval(timer);
            controller.abort();
        };
    }, [screen, extractionStatus, token]);

    async function submit(items: OnboardingAnswerBatch) {
        dispatch({ type: 'saving' });
        try {
            let result = await postOnboardingAnswers(token, {
                lockVersion: flow.server.run.lockVersion,
                answers: items,
            });

            if (result.kind === 'lock_conflict') {
                // The other door moved. Take its state for the lock version
                // only -- `sync_server` deliberately leaves the draft alone,
                // because the retry is about to re-post what was just typed.
                const fresh = await getWorkerOnboarding(token);
                dispatch({ type: 'sync_server', server: fresh });
                result = await postOnboardingAnswers(token, {
                    lockVersion: fresh.run.lockVersion,
                    answers: items,
                });
            }

            if (result.kind === 'lock_conflict') {
                dispatch({ type: 'save_failed', errorKind: 'conflict' });
                return;
            }
            if (result.kind === 'step_rejected') {
                dispatch({
                    type: 'step_rejected',
                    stepKey: result.rejectedStepKey,
                    reason: result.reason,
                    server: result.state,
                });
                return;
            }

            if (flow.improving) {
                dispatch({ type: 'hydrate', server: result.state });
                dispatch({ type: 'improve_next' });
                return;
            }
            if (screen === 'photo') {
                // The last step. `completed` pins the summary locally so it
                // renders even if the run's own lifecycle has not flipped yet.
                dispatch({ type: 'completed', server: result.state });
                return;
            }
            dispatch({ type: 'hydrate', server: result.state });
        } catch (err) {
            dispatch({ type: 'save_failed', errorKind: classifyError(err).kind });
        }
    }

    async function goBack() {
        // Improve-mode is a local re-read of answers the run has already
        // passed, so its Back walks the sub-mode, never the engine.
        if (flow.improving) {
            dispatch({ type: 'improve_back' });
            return;
        }
        dispatch({ type: 'saving' });
        try {
            dispatch({ type: 'hydrate', server: await postOnboardingBack(token, { lockVersion: flow.server.run.lockVersion }) });
        } catch (err) {
            dispatch({ type: 'save_failed', errorKind: classifyError(err).kind });
        }
    }

    async function selectLanguage(language: LanguageChoice) {
        if (language === locale) return;
        setLanguageBusy(true);
        try {
            dispatch({ type: 'hydrate', server: await patchOnboardingLanguage(token, { preferredLanguage: language }) });
        } catch {
            // The visible language is what the worker just asked for, so the
            // route still changes; only the stored preference missed, and the
            // next toggle (or the next screen's save) will carry it.
        } finally {
            setLanguageBusy(false);
            router.replace(pathname, { locale: language });
        }
    }

    const onDraftChange = (patch: Partial<OnboardingDraft>) => dispatch({ type: 'set_draft', patch });
    const errorText = flow.errorKind ? tCommon(errorMessageKey(flow.errorKind)) : null;
    const backHandler = screen === 'terms' || screen === 'done' ? null : goBack;

    return (
        <OnboardingShell
            onSelectLanguage={selectLanguage}
            languageBusy={languageBusy}
            progress={<ProgressSegments current={screen} />}
        >
            {renderScreen()}
        </OnboardingShell>
    );

    function renderScreen() {
        const shared = {
            draft: flow.draft,
            onDraftChange,
            rejection: flow.rejection,
            saving: flow.saving,
            error: errorText,
            onBack: backHandler,
            onSubmit: submit,
        };

        switch (screen) {
            case 'terms':
                return <TermsStep saving={flow.saving} error={errorText} onSubmit={submit} />;
            case 'about':
                return <AboutYouStep {...shared} pendingConfirm={flow.server.pendingLocationConfirm} />;
            case 'trade':
                return <TradeStep {...shared} />;
            case 'work':
                return <WorkStep {...shared} />;
            case 'q1':
            case 'q2':
            case 'q3': {
                const index = trustQuestionIndex(screen) ?? 1;
                const draftAnswer = flow.draft.answers[index - 1];
                const saved = flow.server.trust.answers.find((a) => a.index === index);
                return (
                    <TrustQuestionStep
                        index={index}
                        question={questionText(flow.server, index, locale)}
                        tradeLabel={tradeLabel((key) => tVocab(key), flow.draft.trade, flow.draft.customTrade)}
                        answer={draftAnswer}
                        // Editing a transcribed answer makes it typed again —
                        // the badge must not claim a voice note that no longer
                        // matches what is in the box.
                        source={saved && saved.text === draftAnswer ? saved.source : 'text'}
                        onAnswerChange={(text) => dispatch({ type: 'set_answer', index, text })}
                        rejection={flow.rejection}
                        saving={flow.saving}
                        error={errorText}
                        onBack={backHandler}
                        onSubmit={submit}
                    />
                );
            }
            case 'photo':
                return <PhotoStep saving={flow.saving} error={errorText} onBack={backHandler} onSubmit={submit} />;
            case 'done':
                return (
                    <DoneStep
                        state={flow.server}
                        // A suspended worker has nothing to improve; everyone
                        // else is still standing in the flow and may edit.
                        canImprove={flow.server.lifecycle !== 'suspended'}
                        onImprove={() => dispatch({ type: 'improve_start' })}
                        onGoToProfile={() => router.replace('/worker/profile')}
                    />
                );
        }
    }
}
