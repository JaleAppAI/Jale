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
    isAnswerableStepKey,
    onboardingFlowReducer,
    questionText,
    trustQuestionIndex,
    type OnboardingAnswerBatch,
    type OnboardingDraft,
} from '@/lib/onboarding-flow';
import { clearPendingReferral, readPendingReferral, validateJobId } from '@/lib/referral-return';
import { tradeLabel } from '@/lib/worker-vocab';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
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
 *   - a 409 means the other door moved first: take the fresh state the body
 *     carries, retry ONCE, and if it conflicts again say so rather than
 *     fighting for the run.
 *
 * WHERE THE RUN ENDS. The engine completes on the THIRD trust answer -- that
 * response already says `lifecycle: 'ready'`. The photo prompt after it is
 * client-side only (there is no photo step to post), so the flow shows it once
 * out of `photoPending` and then moves to the summary.
 *
 * WHEN THE RUN IS SOMEWHERE THIS DOOR CANNOT GO. `run.stepKey` can name a
 * step this flow has no screen for -- the two retired photo steps that older
 * WhatsApp runs are still parked on, or a step a later workflow version adds.
 * The screen table falls back to the first screen so it stays total, but
 * SHOWING that screen would be a trap: its Continue posts a step the engine
 * will refuse, and there is no Back off the first screen. So an unanswerable
 * step gets the exit panel instead -- their answers are saved either way.
 *
 * WHY NOT `usePageData`. That hook's legal-wall handling redirects to
 * `/legal/accept` on a `legal_wall` classification -- and accepting the legal
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
    const tBlocked = useTranslations('worker_onboarding.blocked');
    const tOnboarding = useTranslations('worker_onboarding');
    const [flow, dispatch] = useReducer(onboardingFlowReducer, initialState, initFlowState);
    const [languageBusy, setLanguageBusy] = useState(false);
    const [handoffJobId, setHandoffJobId] = useState<string | null>(null);

    const screen = currentScreen(flow);
    // Parked on a step with no screen behind it (see the header comment).
    // `!== 'ready'` rather than `=== 'onboarding'` so a lifecycle added to the
    // union later still gets the exit rather than the trap screen; `blocked`
    // is checked first below and nothing ever clears it, so suspended runs
    // keep their own message.
    const stuck = flow.server.lifecycle !== 'ready'
        && !flow.photoPending
        && !isAnswerableStepKey(flow.server.run.stepKey);
    const extractionStatus = flow.server.extraction?.status ?? 'pending';

    // A referred stranger who signed up from a shared job link still has that
    // job waiting: `WorkerAuthForm` deliberately leaves the stash in place and
    // this flow finishes the journey. Read in an effect, never during render --
    // `sessionStorage` does not exist while this renders on the server.
    useEffect(() => {
        setHandoffJobId(validateJobId(readPendingReferral()?.jobId));
    }, []);

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
                // The other door moved. The 409 body carries the fresh run, so
                // the retry usually costs no extra round trip; `sync_server`
                // takes it for the lock version ONLY, because the retry is
                // about to re-post the draft the worker just typed.
                const fresh = result.state ?? await getWorkerOnboarding(token);
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
            if (result.kind === 'blocked') {
                dispatch({ type: 'blocked', reason: result.reason });
                return;
            }
            if (result.kind === 'step_mismatch') {
                // This client is behind the run, not in conflict with it:
                // re-read and re-render wherever the engine actually is.
                dispatch({ type: 'hydrate', server: await getWorkerOnboarding(token) });
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

            // The third answer completes the run. Offer the (client-only)
            // photo prompt once before the summary.
            if (screen === 'q3' && result.state.lifecycle === 'ready') {
                dispatch({ type: 'finished', server: result.state });
                return;
            }
            dispatch({ type: 'hydrate', server: result.state });
        } catch (err) {
            dispatch({ type: 'save_failed', errorKind: classifyError(err).kind });
        }
    }

    async function goBack() {
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
            // Non-fatal by contract: the visible language is what the worker
            // just asked for, so the route still changes; only the stored
            // preference missed, and the next toggle carries it.
        } finally {
            setLanguageBusy(false);
            router.replace(pathname, { locale: language });
        }
    }

    function finish() {
        // The job the worker was applying for when they signed up, if any.
        if (handoffJobId) {
            clearPendingReferral();
            router.replace(`/worker/jobs/${handoffJobId}`);
            return;
        }
        router.replace('/worker/profile');
    }

    const onDraftChange = (patch: Partial<OnboardingDraft>) => dispatch({ type: 'set_draft', patch });
    const errorText = flow.errorKind ? tCommon(errorMessageKey(flow.errorKind)) : null;
    // Back walks the ENGINE, so it is only offered where the engine can walk:
    // not on the first screen, and not once the run has completed (the photo
    // prompt and the summary both sit after that point).
    const backHandler = screen === 'terms' || screen === 'photo' || screen === 'done' ? null : goBack;

    return (
        <OnboardingShell
            onSelectLanguage={selectLanguage}
            languageBusy={languageBusy}
            progress={<ProgressSegments current={screen} />}
        >
            {flow.blocked ? exitPanel(tBlocked(flow.blocked))
                : stuck ? exitPanel(tOnboarding('stuck'))
                    : renderScreen()}
        </OnboardingShell>
    );

    /**
     * The one thing every dead end owes the worker: a way out. Suspended,
     * not onboardable, parked on a step we cannot drive -- in all three the
     * data is saved and the profile page is reachable, so say so and open it.
     */
    function exitPanel(text: string) {
        return (
            <div className="anim-fade-in flex flex-1 flex-col items-start gap-4 pt-6">
                <InlineFeedback tone="warning">{text}</InlineFeedback>
                <Button variant="secondary" onClick={() => router.replace('/worker/profile')}>
                    {tOnboarding('common.go_to_profile')}
                </Button>
            </div>
        );
    }

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
                        // Editing a transcribed answer makes it typed again --
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
                return <PhotoStep onSkip={() => dispatch({ type: 'photo_skipped' })} />;
            case 'done':
                return (
                    <DoneStep
                        state={flow.server}
                        hasJobHandoff={handoffJobId !== null}
                        onFinish={finish}
                    />
                );
        }
    }
}
