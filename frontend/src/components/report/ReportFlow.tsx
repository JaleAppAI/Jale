'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import {
    createSignedInReport,
    createSignedOutReport,
    deliverReportImage,
    imageMetaFor,
    type CreateResult,
    type ReportAuth,
    type ReportConfig,
    type ReportDraft,
    type ReportFailure,
    type UploadGrant,
} from '@/lib/api/reports';
import type { ReportCategory } from '@/lib/report/categories';
import { collectReportContext, type CaptureSummary, type ReportContextV1 } from './seams/report-context';
import { redrawImage, type CaptureResult } from './seams/report-capture';
import { CategoryStep } from './CategoryStep';
import { DetailsStep } from './DetailsStep';
import { FallbackPanel } from './FallbackPanel';
import { ScreenshotSection, type PhotoState, type ScreenshotView } from './ScreenshotSection';
import { SentStep, type ImageDeliveryState } from './SentStep';
import { WhatWeSend } from './WhatWeSend';
import type { ReportSession } from './types';

/**
 * The report form: category, what happened, sent.
 *
 * Mounted once per open sheet (the sheet is keyed by the session), so one
 * `client_key` is minted per sheet and reused by every retry: a double tap, or
 * a send that failed and is tried again, is one report on the server.
 *
 * Nothing here navigates. A sign-in that ended while the form was open turns it
 * into the signed-out form -- it says so, and waits for another tap -- and every
 * failure keeps what the person wrote and offers the other ways to reach us.
 *
 * The image follows the report: once the number is shown, the image goes to
 * storage and is attached. If that fails the report is still saved, and "Try
 * again" asks for a fresh upload.
 */

/** One UUID per open sheet. `randomUUID` needs a secure context; the fallback does not. */
function newClientKey(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Signed-in failures after which the report may be saved anyway: no answer
 * came back, or one that could not be read. Every other failure is a refusal.
 */
const MAY_HAVE_BEEN_SAVED: ReadonlySet<ReportFailure> = new Set<ReportFailure>(['timeout', 'offline', 'server']);

/** The image the form holds: what the editor was handed, and what it last painted. */
type ImageChoice = {
    source: 'capture' | 'photo' | null;
    /** Handed to the editor. */
    original: Blob | null;
    /** The editor's last output: the image that is sent. */
    outgoing: Blob | null;
    /** The person removed the image, or chose to continue without one. */
    declined: boolean;
    /** Bumped on every new image, so the editor starts fresh for it. */
    version: number;
};

type SentReport = {
    number: string;
    reportId: string;
    attachToken: string;
    verified: boolean;
    image: Blob | null;
};

export function ReportFlow({
    session,
    onClose,
    onDirtyChange,
}: {
    session: ReportSession;
    onClose: () => void;
    onDirtyChange: (dirty: boolean) => void;
}) {
    const { getValidIdTokenOrNull } = useAuth();
    const locale = useLocale() === 'es' ? 'es' : 'en';
    const role = session.role;

    const [clientKey, setClientKey] = useState(newClientKey);
    /**
     * A signed-in create may be saved under `clientKey` even though no answer
     * came back. The signed-out door refuses a key a verified report holds, so
     * if the form then switches to signed out it sends under a fresh key: a
     * possible duplicate is better than a report that can never be sent.
     */
    const signedInMayHaveSaved = useRef(false);
    const [config, setConfig] = useState<ReportConfig | null>(null);
    /** Null while the capture is still drawing. */
    const [capture, setCapture] = useState<CaptureResult | null>(null);

    const [step, setStep] = useState<'category' | 'details'>('category');
    const [detailsOpened, setDetailsOpened] = useState(false);
    const [category, setCategory] = useState<ReportCategory>(session.category);
    const [description, setDescription] = useState('');
    const [descriptionError, setDescriptionError] = useState(false);
    const [stopsWork, setStopsWork] = useState<boolean | null>(null);
    const [contact, setContact] = useState('');
    const [includeTechnical, setIncludeTechnical] = useState(true);
    const [signedIn, setSignedIn] = useState(session.signedIn);
    const [switched, setSwitched] = useState(false);

    const [image, setImage] = useState<ImageChoice>({
        source: null,
        original: null,
        outgoing: null,
        declined: false,
        version: 0,
    });
    const [photo, setPhoto] = useState<PhotoState>('idle');
    /**
     * Bumped by every photo chosen and by every removal of the image on
     * screen. A redraw that finishes after either is dropped, so only the
     * latest choice lands and Remove also cancels a photo still being prepared.
     */
    const photoAttempt = useRef(0);
    /** The image on screen, so an editor callback can tell whether it is about this one. */
    const shownImage = useRef(image);
    useLayoutEffect(() => {
        shownImage.current = image;
    });
    /** The image versions whose editor is mid-repaint. Only the current version's counts. */
    const [busyVersions, setBusyVersions] = useState<ReadonlySet<number>>(() => new Set());

    const [sending, setSending] = useState(false);
    const sendingRef = useRef(false);
    const [failure, setFailure] = useState<ReportFailure | null>(null);
    const [sent, setSent] = useState<SentReport | null>(null);
    const [delivery, setDelivery] = useState<ImageDeliveryState>('none');
    const deliveringRef = useRef(false);

    /**
     * The context read on the tap that found the sign-in ended. Ending a
     * session empties the context buffers, so the signed-out send that
     * follows carries this reading -- the one taken while the problem was
     * still on record -- rather than a fresh, empty one.
     *
     * It belongs to this open sheet only: it is dropped after a successful
     * send and when the sheet closes, and a later sheet reads afresh.
     */
    const heldContext = useRef<{ context: ReportContextV1; includeTechnical: boolean } | null>(null);
    useEffect(
        () => () => {
            heldContext.current = null;
        },
        [],
    );

    const descriptionRef = useRef<HTMLTextAreaElement>(null);
    const categoryGroupRef = useRef<HTMLFieldSetElement>(null);
    const focusAfterStep = useRef<'description' | 'category' | null>(null);

    // The switches and the picture, both started on the tap.
    useEffect(() => {
        let live = true;
        void session.config.then((value) => {
            if (live) setConfig(value);
        });
        void session.capture.then((result) => {
            if (!live) return;
            setCapture(result);
            if (!result.ok) return;
            // A photo chosen while the capture was still drawing wins over it.
            setImage((prev) =>
                prev.source === null && !prev.declined
                    ? { source: 'capture', original: result.image, outgoing: result.image, declined: false, version: prev.version + 1 }
                    : prev,
            );
        });
        return () => {
            live = false;
        };
    }, [session]);

    const dirty = sent === null && (description.trim() !== '' || contact.trim() !== '');
    useEffect(() => {
        onDirtyChange(dirty);
    }, [dirty, onDirtyChange]);

    useEffect(() => {
        const target = focusAfterStep.current;
        focusAfterStep.current = null;
        if (target === 'description') descriptionRef.current?.focus();
        if (target === 'category') categoryGroupRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    }, [step]);

    // An unread config is treated as "on": the server enforces every switch.
    const screenshotsOn = config?.screenshots ?? true;
    const capturePending = screenshotsOn && capture === null && image.source === null && !image.declined;
    const outgoing = screenshotsOn ? image.outgoing : null;
    const editorBusy = image.source !== null && busyVersions.has(image.version);
    const sendBlocked = capturePending || (screenshotsOn && (editorBusy || photo === 'preparing'));

    const captureSummary = (): CaptureSummary => {
        if (!screenshotsOn) return { outcome: 'none', ms: 0 };
        const ms = capture?.ms ?? 0;
        if (image.source === 'photo') return { outcome: 'attached', ms };
        if (image.source === 'capture') return { outcome: 'ok', ms };
        if (capture === null) return { outcome: 'none', ms: 0 };
        if (capture.ok) return { outcome: 'removed', ms };
        return { outcome: capture.reason === 'timeout' ? 'timeout' : 'failed', ms };
    };

    /**
     * The context to send now: the held reading when there is one, else a
     * fresh one. A held reading with technical details is narrowed to what a
     * report without them carries -- the screen pattern, the build and the
     * language -- when the person has turned them off since.
     */
    const contextFor = (technical: boolean): ReportContextV1 => {
        const held = heldContext.current;
        if (held?.includeTechnical && technical) return { ...held.context, capture: captureSummary() };
        if (held && !technical) {
            const { screen, app } = held.context;
            return { v: 1, screen: { pattern: screen.pattern }, app: { build: app.build, locale: app.locale } };
        }
        return collectReportContext({ includeTechnical: technical, capture: captureSummary() });
    };

    const choosePhoto = useCallback((file: File) => {
        const attempt = ++photoAttempt.current;
        setPhoto('preparing');
        redrawImage(file).then(
            (redrawn) => {
                if (attempt !== photoAttempt.current) return;
                setImage((prev) => ({
                    source: 'photo',
                    original: redrawn,
                    outgoing: redrawn,
                    declined: false,
                    version: prev.version + 1,
                }));
                setPhoto('idle');
            },
            () => {
                if (attempt === photoAttempt.current) setPhoto('error');
            },
        );
    }, []);

    /**
     * The editor's output for one image version. An editor whose image has
     * since been replaced or removed may still finish a repaint; what it sends
     * then is ignored, so it can neither swap the image back nor hold Send.
     * Removing the image on screen also drops a photo still being prepared.
     */
    const onEditorChange = useCallback((version: number, painted: Blob | null) => {
        const shown = shownImage.current;
        if (painted === null && shown.version === version && shown.source !== null) {
            photoAttempt.current += 1;
            setPhoto('idle');
        }
        setImage((prev) => {
            if (prev.version !== version || prev.source === null) return prev;
            if (painted) return { ...prev, outgoing: painted };
            return { source: null, original: null, outgoing: null, declined: true, version: prev.version + 1 };
        });
    }, []);
    const onEditorBusyChange = useCallback((version: number, busy: boolean) => {
        setBusyVersions((prev) => {
            if (prev.has(version) === busy) return prev;
            const next = new Set(prev);
            if (busy) next.add(version);
            else next.delete(version);
            return next;
        });
    }, []);

    const switchToSignedOut = () => {
        if (signedInMayHaveSaved.current) {
            signedInMayHaveSaved.current = false;
            setClientKey(newClientKey());
        }
        setSignedIn(false);
        setSwitched(true);
        // Known before sending: tell them now rather than after another tap.
        setFailure(config && !config.signed_out ? 'signed_out_paused' : null);
    };

    /** Storage, then attach. Never throws; the report is saved whatever it answers. */
    const deliverImage = async (report: SentReport, auth: () => Promise<ReportAuth>, grant: UploadGrant | null) => {
        if (!report.image || deliveringRef.current) return;
        deliveringRef.current = true;
        setDelivery('sending');
        try {
            const outcome = await deliverReportImage({
                auth: await auth(),
                reportId: report.reportId,
                attachToken: report.attachToken,
                image: report.image,
                grant,
            });
            setDelivery(outcome.status === 'failed' ? (outcome.retryable ? 'failed' : 'failed_final') : outcome.status);
        } catch {
            setDelivery('failed');
        } finally {
            deliveringRef.current = false;
        }
    };

    const retryImage = () => {
        if (!sent) return;
        void deliverImage(
            sent,
            async () => {
                if (!sent.verified) return { kind: 'signed_out' };
                // The attach token is what proves the report, so a sign-in that
                // has ended since can still finish the image on the public route.
                const idToken = await getValidIdTokenOrNull();
                return idToken ? { kind: 'signed_in', idToken } : { kind: 'signed_out' };
            },
            null,
        );
    };

    const send = async () => {
        if (sendingRef.current || sent) return;
        if (description.trim() === '') {
            setDescriptionError(true);
            descriptionRef.current?.focus();
            return;
        }
        if (sendBlocked) return;

        sendingRef.current = true;
        setSending(true);
        setFailure(null);
        try {
            // Before anything awaits: a renewal refused below ends the session,
            // and ending a session empties the buffers this reads.
            const context = contextFor(includeTechnical);
            const imageToSend = outgoing;
            const draft: ReportDraft = {
                client_key: clientKey,
                category,
                description: description.trim(),
                stops_work: role === 'employer' ? stopsWork : null,
                locale,
                include_technical: includeTechnical,
                context,
                image: imageToSend ? imageMetaFor(imageToSend) : null,
            };

            let auth: ReportAuth;
            let result: CreateResult;
            if (signedIn) {
                const idToken = await getValidIdTokenOrNull();
                if (!idToken) {
                    heldContext.current = { context, includeTechnical };
                    switchToSignedOut();
                    return;
                }
                auth = { kind: 'signed_in', idToken };
                try {
                    result = await createSignedInReport(idToken, draft);
                } catch (err) {
                    signedInMayHaveSaved.current = true;
                    throw err;
                }
                if (!result.ok && MAY_HAVE_BEEN_SAVED.has(result.failure)) signedInMayHaveSaved.current = true;
            } else {
                auth = { kind: 'signed_out' };
                result = await createSignedOutReport({
                    ...draft,
                    role_claimed: role,
                    contact: contact.trim() === '' ? null : contact.trim(),
                });
            }

            if (!result.ok) {
                if (result.failure === 'session_expired') {
                    heldContext.current = { context, includeTechnical };
                    switchToSignedOut();
                } else {
                    setFailure(result.failure);
                }
                return;
            }

            const report: SentReport = {
                number: result.report.number,
                reportId: result.report.reportId,
                attachToken: result.report.attachToken,
                verified: auth.kind === 'signed_in',
                image: imageToSend,
            };
            heldContext.current = null;
            setSent(report);
            if (imageToSend) void deliverImage(report, async () => auth, result.report.upload);
        } catch {
            // Unexpected: keep the words and offer the other ways to reach us.
            setFailure('server');
        } finally {
            sendingRef.current = false;
            setSending(false);
        }
    };

    if (sent) {
        return (
            <SentStep
                role={role}
                verified={sent.verified}
                number={sent.number}
                image={delivery}
                onRetryImage={retryImage}
                onClose={onClose}
            />
        );
    }
    if (config && !config.reporting) {
        return <FallbackPanel reason="paused" role={role} onClose={onClose} />;
    }
    if (config && !session.signedIn && !config.signed_out) {
        return <FallbackPanel reason="signed_out_paused" role={role} onClose={onClose} />;
    }

    let view: ScreenshotView;
    if (image.source && image.original) {
        view = { kind: 'editor', image: image.original, source: image.source, version: image.version };
    } else if (image.declined) {
        view = { kind: 'none' };
    } else if (capture === null) {
        view = { kind: 'pending' };
    } else {
        view = { kind: 'failed' };
    }

    return (
        <>
            <div hidden={step !== 'category'} className="flex min-h-0 flex-1 flex-col">
                <CategoryStep
                    role={role}
                    value={category}
                    initial={session.category}
                    onChange={setCategory}
                    groupRef={categoryGroupRef}
                    onNext={() => {
                        focusAfterStep.current = 'description';
                        setDetailsOpened(true);
                        setStep('details');
                    }}
                />
            </div>
            {detailsOpened ? (
                <div hidden={step !== 'details'} className="flex min-h-0 flex-1 flex-col">
                    <DetailsStep
                        role={role}
                        category={category}
                        onChangeCategory={() => {
                            focusAfterStep.current = 'category';
                            setStep('category');
                        }}
                        signedIn={signedIn}
                        switched={switched}
                        description={description}
                        onDescriptionChange={(value) => {
                            setDescription(value);
                            if (value.trim() !== '') setDescriptionError(false);
                        }}
                        descriptionError={descriptionError}
                        descriptionRef={descriptionRef}
                        stopsWork={stopsWork}
                        onStopsWorkChange={setStopsWork}
                        contact={contact}
                        onContactChange={setContact}
                        screenshot={
                            screenshotsOn ? (
                                <ScreenshotSection
                                    role={role}
                                    view={view}
                                    photo={photo}
                                    onPhotoChosen={choosePhoto}
                                    onContinueWithout={() => setImage((prev) => ({ ...prev, declined: true }))}
                                    onEditorChange={onEditorChange}
                                    onEditorBusyChange={onEditorBusyChange}
                                />
                            ) : null
                        }
                        whatWeSend={
                            <WhatWeSend
                                role={role}
                                signedIn={signedIn}
                                imageIncluded={outgoing !== null}
                                includeTechnical={includeTechnical}
                                onIncludeTechnicalChange={setIncludeTechnical}
                                preview={() => contextFor(true)}
                            />
                        }
                        failure={failure}
                        sending={sending}
                        sendDisabled={sendBlocked}
                        onSend={() => void send()}
                    />
                </div>
            ) : null}
        </>
    );
}
