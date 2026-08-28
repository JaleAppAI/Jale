'use client';
import { useEffect, useReducer, useRef, useState } from 'react';
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
    itemsFromCursor,
    onboardingFlowReducer,
    questionText,
    screenForState,
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
 * WHAT A BATCH MAY CONTAIN. The engine applies a batch item by item and
 * refuses any item that is not the step it is on at that moment -- it does not
 * skip the ones behind it. Every batch therefore goes through
 * `itemsFromCursor` on the way out, here rather than only in the screens, so
 * the rule holds for the confirm buttons and for whatever screen is added
 * next.
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
    const pollsRef = useRef(0);
    const [pollsSpent, setPollsSpent] = useState(false);

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

    // The draft is parked under the run AND the step it belongs to: a worker
    // who toggles language on `profile.location` and is then moved forward by
    // WhatsApp must not have that text poured into a different question.
    const draftKey = `jale.onboarding.draft.${flow.server.run.id}.${flow.server.run.stepKey}`;

    function stashDraft() {
        try {
            window.sessionStorage.setItem(draftKey, JSON.stringify(flow.draft));
        } catch {
            // Private mode, or a full quota. The language switch still works;
            // the worker just retypes. Never worth failing the toggle for.
        }
    }

    // Restore-once, on mount. Reading in an effect (not during render) because
    // `sessionStorage` does not exist on the server, and clearing immediately
    // because a parked draft is for exactly one remount -- a reload an hour
    // later should show what the server has, not a ghost.
    useEffect(() => {
        let stored: string | null = null;
        try {
            stored = window.sessionStorage.getItem(draftKey);
            window.sessionStorage.removeItem(draftKey);
        } catch {
            return;
        }
        if (!stored) return;
        try {
            const parsed: unknown = JSON.parse(stored);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                dispatch({ type: 'set_draft', patch: parsed as Partial<OnboardingDraft> });
            }
        } catch {
            // Someone else's key, or a half-written value. Ignore it.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
    //
    // The count lives in a ref because the effect RE-RUNS when the status
    // moves `pending` -> `extracting`, which is the single most likely thing
    // to happen while it is running. A local counter would go back to zero
    // there and quietly double the budget.
    useEffect(() => {
        if (screen !== 'done') {
            pollsRef.current = 0;
            setPollsSpent(false);
            return;
        }
        if (extractionStatus === 'completed' || extractionStatus === 'failed') return;
        if (pollsRef.current >= MAX_POLLS) return;

        const controller = new AbortController();
        const timer = window.setInterval(() => {
            pollsRef.current += 1;
            if (pollsRef.current >= MAX_POLLS) {
                window.clearInterval(timer);
                setPollsSpent(true);
            }
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

    async function submit(batch: OnboardingAnswerBatch) {
        // The last word on what leaves this component: never an item the
        // engine is already past. See the header.
        const items = itemsFromCursor(batch, flow.server.run.stepKey);
        if (items.length === 0) return;

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
                // This client is behind the run, not in conflict with it: the
                // other door moved the cursor between our read and our write.
                //
                // Re-read, and then be careful about the draft. If the engine
                // turns out to be on a step this same screen answers, the
                // worker is looking at their own half-typed answer and
                // rebuilding it from the server would delete it in front of
                // them -- keep it and say what happened. Only a move to a
                // DIFFERENT screen rebuilds, because then the draft belongs
                // to a screen that is no longer on the page.
                const fresh = await getWorkerOnboarding(token);
                dispatch({ type: 'step_mismatch', server: fresh, sameScreen: screenForState(fresh) === screen });
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
        // Switching language is a ROUTE change (`/en/...` -> `/es/...`), so
        // this component unmounts and remounts with whatever the server says.
        // Anything typed and not yet saved would die there, which is exactly
        // when a worker switches: they hit a question they would rather answer
        // in their own language. Park the draft first; the remount picks it up.
        stashDraft();
        try {
            // `sync_server`, not `hydrate`: the response is a fresh snapshot of
            // a run that has not moved, and rebuilding the draft from it would
            // undo the same typing the stash above is protecting.
            dispatch({ type: 'sync_server', server: await patchOnboardingLanguage(token, { preferredLanguage: language }) });
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
    // One failed save is a blip and the retry is right there. Two in a row and
    // the flow stops insisting: everything answered so far is already on the
    // server, so offer the way out under the message rather than leaving a
    // worker pressing a button that keeps failing.
    const exitLink = flow.failures >= 2 ? (
        <Button variant="ghost" onClick={() => router.replace('/worker/profile')}>
            {tOnboarding('common.go_to_profile')}
        </Button>
    ) : null;
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
                    : (
                        <>
                            {flow.notice ? (
                                <div className="mb-3.5">
                                    <InlineFeedback tone="info">{tOnboarding(`rejection.${flow.notice}`)}</InlineFeedback>
                                </div>
                            ) : null}
                            {renderScreen()}
                        </>
                    )}
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
            stepKey: flow.server.run.stepKey,
            onDraftChange,
            rejection: flow.rejection,
            saving: flow.saving,
            error: errorText,
            exitLink,
            onBack: backHandler,
            onSubmit: submit,
        };

        switch (screen) {
            case 'terms':
                return <TermsStep saving={flow.saving} error={errorText} exitLink={exitLink} onSubmit={submit} />;
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
                        exitLink={exitLink}
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
                        extractionStalled={pollsSpent}
                        onFinish={finish}
                    />
                );
        }
    }
}
