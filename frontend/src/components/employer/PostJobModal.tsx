'use client';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import {
  ApiError, createJob, getBilling, listJobTemplates, saveJobTemplate,
  type Job, type JobCreatedOutcome, type JobTemplate,
} from '@/lib/api/employer';
import { planLimitModel, type PlanLimitModel } from '@/lib/plan-limit';
import {
  LANGUAGE_OPTIONS,
  type JobForm, type WorkDay,
  initialForm, jobFormToCreatePayload, jobFormFromTemplatePayload,
  validateStepBasics, validateStepDetails, validateFullJobForm, validateStepRequirements,
  applyLocationToJobForm,
} from '@/lib/job-form';
import { MAX_PROMPT_CHARS } from '@/lib/pre-application-prompts';
import { Button } from '@/components/ui/button';
import { CertificationsPicker } from '@/components/employer/CertificationsPicker';
import { CheckboxCard } from '@/components/ui/checkbox-card';
import { DescriptionHelper } from '@/components/employer/DescriptionHelper';
import { DurationField } from '@/components/employer/DurationField';
import { ExperienceStepper } from '@/components/employer/ExperienceStepper';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Modal } from '@/components/ui/modal';
import { PayFields } from '@/components/employer/PayFields';
import { PlanLimitNotice } from '@/components/employer/PlanLimitDialog';
import { PreApplicationPromptsEditor } from '@/components/employer/PreApplicationPromptsEditor';
import { PayReferenceHint } from '@/components/PayReferenceHint';
import { RequirementsPicker } from '@/components/employer/RequirementsPicker';
import { ScheduleFields } from '@/components/employer/ScheduleFields';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { TradeCategoryField } from '@/components/employer/TradeCategoryField';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * `outcome` reports what the post did NOT achieve. The only member today is
   * `templateNotSaved`: the job posted, the modal closed on that success, and
   * the template hit the plan cap on the way -- a shortfall the caller has to
   * surface because this modal is gone by the time it is known.
   */
  onJobCreated: (job: Job, outcome?: JobCreatedOutcome) => void;
}

type Step = 1 | 2 | 3;

/** The wizard's shape, in one place, so the indicator and the panels agree. */
const STEPS: readonly Step[] = [1, 2, 3];
const STEP_KEYS: Record<Step, 'basics' | 'details' | 'documents'> = {
  1: 'basics',
  2: 'details',
  3: 'documents',
};

/**
 * Three-step "post a job" wizard.
 *
 * The FLOW is unchanged — same three steps, same fields, same
 * `lib/job-form.ts` validation, same payload. What changed is everything
 * around it:
 *
 *  - It sits in the foundation `Modal`, so focus trapping, Escape, the ink
 *    backdrop, the scroll lock and returning focus to the "Post job" button are
 *    handled once, centrally, instead of being missing (the old overlay had a
 *    literal `rgba()` scrim, a bare `x` glyph for a close button, no focus
 *    management at all, and a backdrop that closed the dialog even when a drag
 *    merely ENDED outside the panel).
 *  - "Step 1 of 3" became a real indicator: three named stops, the completed
 *    ones walkable backwards, the current one marked `aria-current="step"`.
 *    A user could previously see a step counter but never the shape of what
 *    they had signed up for.
 *  - Entering a step moves focus to that step's heading, so keyboard and screen
 *    reader users land at the top of the new panel instead of being left on a
 *    "Next" button while the content silently changes behind them.
 *  - Failures render as one `InlineFeedback` immediately above the footer — as
 *    close to the control that caused them as the layout allows — and the copy
 *    is CLASSIFIED (`useErrorMessage`), never `err.message`, which is a backend
 *    error code and not a sentence.
 *
 * The two plan limits (`job_limit_reached`, `template_limit_reached`) are not
 * "something went wrong": they are plan decisions with specific ways out, so
 * they render as `PlanLimitNotice` off `lib/plan-limit`'s model rather than as
 * error sentences. The template one is also checked BEFORE the wire, because
 * the cap is knowable from `getBilling` and the loaded template list -- posting
 * a job and only then admitting the template was dropped is a worse trade than
 * asking first.
 */
export function PostJobModal({ open, onClose, onJobCreated }: Props) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const tReq = useTranslations('job_requirements');
  const { idToken } = useAuth();
  // `enabled: false` — the DASHBOARD owns the sign-in redirect for this route.
  // All this call wants is the legal-wall router, so a create that trips the
  // wall goes to /legal/accept instead of showing an error nobody can act on.
  const { handleLegalWall } = useRequireAuth({ enabled: false });
  const errorMessage = useErrorMessage();

  const [step, setStep] = useState<Step>(1);
  // The furthest step this run of the wizard has successfully validated into
  // -- drives which step chips render as "completed" (see `goToStep` below).
  // Free navigation means every chip is clickable regardless of this value;
  // it only affects the checkmark, never whether a click does anything.
  const [maxVisitedStep, setMaxVisitedStep] = useState<Step>(1);
  const [form, setForm] = useState<JobForm>(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // The active-job cap, as a model rather than a sentence. Rendered beside
  // `error` (never instead of it) because the two can only ever be set by
  // different branches of the same catch.
  const [jobLimit, setJobLimit] = useState<PlanLimitModel | null>(null);
  // Freezes the description Textarea while `DescriptionHelper`'s Generate
  // call is in flight -- otherwise a manual edit made mid-flight would be
  // silently overwritten seconds later by the eventual success response.
  const [descriptionGenerating, setDescriptionGenerating] = useState(false);

  // Template state. Templates are a convenience layer on top of job
  // creation: a failure to load or save one must never block posting a job.
  const [templates, setTemplates] = useState<JobTemplate[]>([]);
  const [checkCity, setCheckCity] = useState(false);
  /*
   * "This location is text, not a city."
   *
   * `checkCity`'s quieter sibling, and the one that was missing. `checkCity`
   * fires when a template DID carry a city and only asks the employer to
   * confirm it. This fires when the applied template carried none: the picker
   * prefills the location TEXT either way, so without it the field looked
   * settled while `form.city_key` was null underneath, and the employer found
   * out only when Next refused at the bottom of step 1. Set from a template
   * apply and from any `location_pick_required` verdict; cleared by an actual
   * pick.
   */
  const [cityMissing, setCityMissing] = useState(false);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateNotice, setTemplateNotice] = useState<'' | 'limit' | 'name_taken'>('');
  const [templateLimit, setTemplateLimit] = useState<number | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  /*
   * One `<form>` for whichever step is mounted, and the footer's primary
   * button reaches it by `form={formId}` rather than by containment.
   *
   * That indirection is not a style choice: `ui/modal.tsx` renders `footer` as
   * a SIBLING of `children`, so Next/Publish cannot sit inside the form
   * element the fields live in. The `form` attribute is the standard way to
   * associate a submit button with a form it is not descended from, and it is
   * what makes Enter-in-a-field do the step's primary action -- which the
   * wizard simply did not have before (Enter did nothing at all, three steps
   * deep).
   */
  const formId = useId();
  const cityHelperId = useId();
  // Once the template save succeeds, later submits of the SAME wizard run
  // (e.g. after a failed job post) carry this id so the backend overwrites
  // that template instead of 409ing against our own first save.
  const savedTemplateIdRef = useRef<string | null>(null);

  // Silent background load whenever the modal opens -- the wizard must work
  // exactly the same with zero templates, so any failure here is swallowed.
  useEffect(() => {
    if (!open || !idToken) return;
    let cancelled = false;
    listJobTemplates(idToken)
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => {
        // Templates are an enhancement; the modal must work without them.
      });
    // The cap the pre-check compares the loaded list against. Without it the
    // wizard only learns the number from a 403 -- that is, after the save the
    // pre-check exists to prevent. Swallowed for the same reason: a billing
    // read that fails costs the pre-check, never the post.
    getBilling(idToken)
      .then((billing) => {
        if (!cancelled) setTemplateLimit(billing.templateLimit);
      })
      .catch(() => {
        // No cap known; the server 403 remains the backstop.
      });
    return () => {
      cancelled = true;
    };
  }, [open, idToken]);

  // Entering a step hands focus to its heading. The heading is `tabIndex={-1}`
  // (focusable programmatically, not in the tab order), which is the standard
  // way to move a reader to a newly revealed region without inventing a stop.
  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus();
  }, [open, step]);

  // A failure below the fold is a failure the user does not know about. The
  // banner has `role="alert"` for screen readers; this is the visual half.
  // `jobLimit` shares the slot, so it has to share the scroll.
  useEffect(() => {
    if (!error && !jobLimit) return;
    feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error, jobLimit]);

  /**
   * The template cap as a plan-limit model.
   *
   * Synthesised rather than stored: both routes into `templateNotice === 'limit'`
   * (the pre-check, and the server's 403 during the save) leave the cap in
   * `templateLimit`, so one derivation covers both. No `plan_code` -- the
   * pre-check has none to give, and `planLimitModel` renders the copy without
   * a plan name rather than guessing one.
   */
  const templateLimitModel = useMemo(
    () =>
      templateNotice === 'limit'
        ? planLimitModel(
            new ApiError(403, 'template_limit_reached', { template_limit: templateLimit ?? 0 }),
          )
        : null,
    [templateNotice, templateLimit],
  );

  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleClose = () => {
    setStep(1);
    setMaxVisitedStep(1);
    setForm(initialForm);
    setError('');
    setJobLimit(null);
    setCheckCity(false);
    setCityMissing(false);
    setSaveAsTemplate(false);
    setTemplateName('');
    setTemplateNotice('');
    setTemplateLimit(null);
    setDescriptionGenerating(false);
    savedTemplateIdRef.current = null;
    onClose();
  };

  const applyTemplate = (template: JobTemplate) => {
    const { form: prefilled, cityPrefilled } = jobFormFromTemplatePayload(template.payload);
    setForm(prefilled);
    setCheckCity(cityPrefilled);
    // Asked of the VALIDATOR rather than of `!cityPrefilled`, so the two can
    // never disagree about what step 1 will accept: it also answers "no" when
    // the location dataset failed to load (free text is then allowed) and when
    // the template has no location at all (a different error owns that).
    setCityMissing(validateStepBasics(prefilled) === 'location_pick_required');
    // A template apply replaces the whole form; a stale verdict about the
    // previous one must not survive it.
    setError('');
  };

  const toggleLanguage = (value: 'any' | 'en' | 'es') => {
    setForm((current) => {
      if (value === 'any') return { ...current, language_preference: ['any'] };
      const withoutAny = current.language_preference.filter((item) => item !== 'any');
      const next = withoutAny.includes(value)
        ? withoutAny.filter((item) => item !== value)
        : [...withoutAny, value];
      return { ...current, language_preference: next.length > 0 ? next : ['any'] };
    });
  };

  const toggleWorkDay = (day: WorkDay) => {
    setForm((current) => ({
      ...current,
      work_days: current.work_days.includes(day)
        ? current.work_days.filter((d) => d !== day)
        : [...current.work_days, day],
    }));
  };

  const setCertificationTier = (name: string, tier: 'required' | 'optional') => {
    setForm((current) => ({
      ...current,
      certification_requirements: current.certification_requirements.map((cert) =>
        cert.name === name ? { ...cert, tier } : cert),
    }));
  };

  const toggleCertificationProof = (name: string) => {
    setForm((current) => ({
      ...current,
      certification_requirements: current.certification_requirements.map((cert) =>
        cert.name === name ? { ...cert, proof_required: !cert.proof_required } : cert),
    }));
  };

  /**
   * Maps `validateStepBasics`/`validateStepDetails`/`validateFullJobForm`'s
   * error codes onto this modal's existing i18n keys. `trade_category_other_required`
   * and `shift_incomplete` both fall back onto `validation_required` per
   * those functions' own doc comments -- there is no dedicated key for
   * either yet.
   */
  const validationMessage = (
    code: ReturnType<typeof validateFullJobForm>,
  ): string | null => {
    switch (code) {
      case null:
        return null;
      case 'required':
      case 'trade_category_other_required':
      case 'shift_incomplete':
        return t('modal.validation_required');
      case 'location_pick_required':
        return t('modal.location_pick_required');
      case 'state_region':
        return t('modal.validation_state_region');
      case 'number':
        return t('modal.validation_number');
      case 'pay_range':
        return t('modal.validation_pay_range');
      case 'headcount':
        return t('modal.validation_headcount');
      // Step 3's two, from the prompts editor. Unlike the codes above these
      // DO get their own sentences: the employer has to know which of the two
      // things is wrong with a question before they can fix it.
      case 'prompt_blank':
        return tReq('prompts.validation_blank');
      case 'prompt_too_long':
        return tReq('prompts.validation_too_long', { max: MAX_PROMPT_CHARS });
      default:
        return null;
    }
  };

  /**
   * Step 1 -> `validateStepBasics`, step 2 -> `validateStepDetails`, step 3 ->
   * the prompts editor. Returns the CODE, not the sentence: `goToStep` needs to
   * know specifically about `location_pick_required` to light up the picker,
   * and a flattened string cannot say which field failed.
   */
  const validateStepAt = (n: Step): ReturnType<typeof validateFullJobForm> => {
    if (n === 1) return validateStepBasics(form);
    if (n === 2) return validateStepDetails(form);
    return validateStepRequirements(form);
  };

  /**
   * Free step navigation (job-flow redesign, FE-T6): every step chip, plus
   * the footer Back/Next buttons, all funnel through this one function.
   *
   * Backward (`target <= step`) is unconditional -- an employer can always
   * revisit a step they've already filled in. Forward (`target > step`)
   * validates every step in `[step, target)` in order and stops at the FIRST
   * one that fails, landing on it with its error shown, so the employer sees
   * exactly what still needs attention rather than being bounced back to
   * wherever they started. `maxVisitedStep` only tracks how far navigation
   * has successfully reached, for the step indicator's checkmarks -- it is
   * never itself a gate on which chip can be clicked.
   */
  const goToStep = (target: Step) => {
    if (target === step) return;
    if (target < step) {
      setError('');
      setJobLimit(null);
      setStep(target);
      return;
    }
    for (let n: number = step; n < target; n++) {
      const code = validateStepAt(n as Step);
      const message = validationMessage(code);
      if (message) {
        setError(message);
        // The sentence names the problem; the ring says WHERE. Without this the
        // employer reads "select a city from the suggestions" under the footer
        // with nothing on the field it is talking about.
        if (code === 'location_pick_required') setCityMissing(true);
        setStep(n as Step);
        return;
      }
    }
    setError('');
    setJobLimit(null);
    setStep(target);
    setMaxVisitedStep((current) => (current > target ? current : target));
  };

  /**
   * `skipTemplate` is the "Post without saving template" escape hatch.
   *
   * It cannot be expressed as `setSaveAsTemplate(false)` before a re-submit:
   * this closure captures the CURRENT render's `saveAsTemplate`, so the
   * pre-check would fire again on the stale `true` and nothing would ever post.
   * The flag overrides the state for this one call instead.
   */
  const handleSubmit = async (opts?: { skipTemplate?: boolean }) => {
    const wantsTemplate = opts?.skipTemplate ? false : saveAsTemplate;

    setJobLimit(null);
    const validationCode = validateFullJobForm(form);
    const validationError = validationMessage(validationCode);
    if (validationError) {
      setError(validationError);
      if (validationCode === 'location_pick_required') setCityMissing(true);
      // Land on whichever step actually owns the failing field, same as a
      // blocked forward jump, so the employer isn't left on step 3 staring
      // at a message about step 1 -- or, now, on step 1 staring at one about
      // a question they typed on step 3.
      const promptFailure = validationCode === 'prompt_blank' || validationCode === 'prompt_too_long';
      setStep(promptFailure ? 3 : validateStepBasics(form) ? 1 : 2);
      return;
    }

    const name = templateName.trim();
    // Pre-check the template name against the loaded list BEFORE any network
    // call: once the job posts, the modal closes and a failed template save
    // has nowhere left to surface. Catching the collision here keeps it
    // fixable; the server 409 below remains the backstop for stale lists.
    if (
      wantsTemplate && name &&
      templates.some((tpl) => tpl.name === name && tpl.id !== savedTemplateIdRef.current)
    ) {
      setTemplateNotice('name_taken');
      return;
    }
    // And pre-check the CAP the same way, for the same reason: the template
    // save runs before the post, so hitting the cap on the wire means the job
    // goes out with the template silently dropped. Nothing is submitted until
    // the employer has decided which they want.
    //
    // Skipped once this run has already saved a template: that save is an
    // upsert by id and the row is already in `templates`, so counting it again
    // would refuse a resubmit (after a failed post) that costs no new slot.
    if (
      wantsTemplate && name &&
      savedTemplateIdRef.current === null &&
      templateLimit !== null && templates.length >= templateLimit
    ) {
      setTemplateNotice('limit');
      return;
    }
    setLoading(true);
    setError('');
    setTemplateNotice('');

    // What the post did not achieve, carried past `handleClose` to the caller:
    // the modal is gone by the time the dashboard can say anything about it.
    let templateShortfall: JobCreatedOutcome['templateNotSaved'];
    let templateSavedNew = false;

    if (wantsTemplate && name) {
      try {
        const saved = await saveJobTemplate(idToken!, {
          ...(savedTemplateIdRef.current ? { id: savedTemplateIdRef.current } : {}),
          name,
          payload: jobFormToCreatePayload(form),
        });
        // A new id means a new row on the templates list; a resubmit after a
        // failed post overwrites the same template and adds nothing.
        templateSavedNew = savedTemplateIdRef.current === null;
        savedTemplateIdRef.current = saved.id;
        setTemplates((current) => [saved, ...current.filter((tpl) => tpl.id !== saved.id)]);
      } catch (err) {
        // Template failures never block the job post -- surface the notice
        // and keep going.
        if (err instanceof ApiError && err.code === 'template_limit_reached') {
          // The backstop for a cap the pre-check could not know (billing read
          // failed, or the list went stale under a second tab).
          const limit = err.payload.template_limit ?? templateLimit ?? 0;
          setTemplateNotice('limit');
          setTemplateLimit(limit);
          templateShortfall = { templateLimit: limit };
        } else if (err instanceof ApiError && err.code === 'template_name_taken') {
          setTemplateNotice('name_taken');
        }
      }
    }

    try {
      const job = await createJob(idToken!, jobFormToCreatePayload(form));
      const outcome: JobCreatedOutcome = {};
      if (templateShortfall) outcome.templateNotSaved = templateShortfall;
      if (templateSavedNew) outcome.templateSaved = true;
      onJobCreated(job, templateShortfall || templateSavedNew ? outcome : undefined);
      handleClose();
    } catch (err) {
      try {
        handleLegalWall(err, '/employer/dashboard');
        // Redirected to the legal wall; there is no error to render here.
        return;
      } catch {
        // Not a legal wall — fall through to the normal failure paths.
      }

      // The typed `job_limit_reached` code is the one failure with its own
      // story: the plan's ceiling, the jobs holding the slots, and the two ways
      // out -- all of which `lib/plan-limit` models, so it renders as a notice
      // rather than as an error sentence with a link stapled on. `city_required`
      // and `requirements_tier_overlap` are the two create-time 400s the
      // requirements picker can provoke (a create with no picked city; a key
      // landing in both a required and an optional array -- should not
      // happen through the picker's own UI, but is the backend's own
      // validation, not a generic "something went wrong"). Everything else is
      // classified into the app's shared, bilingual failure sentences —
      // `modal.error` stays as the override for the genuinely unclassifiable.
      if (err instanceof ApiError && err.code === 'job_limit_reached') {
        setJobLimit(planLimitModel(err));
      } else if (err instanceof ApiError && err.code === 'city_required') {
        setError(tReq('errors.city_required'));
      } else if (err instanceof ApiError && err.code === 'requirements_tier_overlap') {
        setError(tReq('errors.tier_overlap'));
      } else if (err instanceof ApiError && err.code === 'invalid_pre_application_prompts') {
        // The backend's own bound check on the prompt list. Reachable despite
        // `validateStepRequirements` above -- the two agree on today's rules,
        // and this is what says so honestly when a future one diverges.
        setError(tReq('prompts.invalid_rejected'));
      } else {
        setError(errorMessage(err, { unknown: t('modal.error') }));
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * The current step's primary action, reached by Enter or by the footer's
   * submit button -- the two are the same event now.
   *
   * One form dispatching on `step` rather than three identical forms: only one
   * step is ever mounted, so three would be three copies of this switch with
   * three chances to drift. Textareas keep native Enter=newline (a textarea
   * never implicitly submits), which is what the description field and every
   * pre-application question need.
   */
  const handleStepSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    if (step < 3) {
      goToStep((step + 1) as Step);
      return;
    }
    void handleSubmit();
  };

  const stepHint =
    step === 1
      ? t('modal.steps.basics_hint')
      : step === 2
        ? t('modal.steps.details_hint')
        // Step 3's sentence already lives with the rest of the docs-step copy.
        : t('post_job_docs.subtitle');

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('modal.title')}
      size="md"
      // A half-filled three-step wizard must not evaporate on a stray backdrop
      // click -- the same guard TemplateEditModal and EditJobModal already
      // carry, and the one this modal most needed: Escape and the header X are
      // deliberate, a mis-aimed click is not.
      closeOnOverlay={false}
      footer={
        <div className="flex w-full items-center gap-2">
          {/* Every non-submit button here is EXPLICITLY type="button". They sit
              outside the step form, so the native submit default cannot reach
              them today -- but the primary ones below are wired into it by
              `form={formId}`, and one of these losing its type later would
              silently join them. */}
          {step === 1 ? (
            <Button type="button" variant="ghost" onClick={handleClose} className="flex-1">
              {t('modal.cancel')}
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => goToStep((step - 1) as Step)} disabled={loading} className="flex-1">
              {t('post_job_docs.back')}
            </Button>
          )}
          {/* This was the first call site to move off the old `deep` variant,
              which rendered navy on the dark card and all but disappeared. That
              variant has since been retired outright (see `ui/button`), so
              `primary` is now simply the only CTA fill there is. */}
          {/* `type="submit" form={formId}`, not `onClick`: that is what makes
              the button the step form's DEFAULT submitter, so Enter in any
              field does what pressing it does -- one code path, not two. */}
          {step < 3 ? (
            <Button type="submit" form={formId} variant="primary" className="flex-1">
              {t('modal.next')}
            </Button>
          ) : (
            <Button
              type="submit"
              form={formId}
              variant="primary"
              loading={loading}
              loadingLabel={tCommon('loading')}
              className="flex-1"
            >
              {t('post_job_docs.submit')}
            </Button>
          )}
        </div>
      }
    >
      <nav aria-label={t('modal.steps.aria_label')} className="mb-5">
        <p className="sr-only">{t('modal.step_label', { current: step, total: STEPS.length })}</p>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {STEPS.map((n) => {
            const label = t(`modal.steps.${STEP_KEYS[n]}`);
            const current = n === step;
            // "Done" (checkmark) tracks the furthest step this run has
            // validated into, not just "before the current one" -- free
            // navigation means a completed later step can be visited while
            // sitting on an earlier one. Every chip below is clickable
            // regardless of this value; see `goToStep`.
            const done = !current && n <= maxVisitedStep;

            return (
              <li key={n} className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  onClick={() => goToStep(n)}
                  className={[
                    'inline-flex min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-xs transition-colors',
                    'hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                    current ? 'font-extrabold text-[var(--jale-ink)]' : 'font-semibold',
                    !current && done ? 'text-[var(--jale-ink)]' : '',
                    !current && !done ? 'text-[var(--jale-ink-2)]' : '',
                  ].join(' ')}
                >
                  <span
                    aria-hidden
                    className={[
                      'size-[7px] shrink-0 rounded-full',
                      done ? 'bg-[var(--jale-success)]' : current ? 'bg-[var(--jale-blue-500)]' : 'bg-[var(--jale-divider)]',
                    ].join(' ')}
                  />
                  <span className="truncate">{label}</span>
                  {done ? <span className="sr-only"> — {t('modal.steps.completed')}</span> : null}
                </button>

                {n < STEPS.length ? (
                  <span aria-hidden className="h-px w-4 shrink-0 bg-[var(--jale-divider)]" />
                ) : null}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="mb-4">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-extrabold text-[var(--jale-ink)] outline-none"
        >
          {t(`modal.steps.${STEP_KEYS[step]}`)}
        </h3>
        <p className="mt-1 text-sm text-[var(--jale-ink-2)]">{stepHint}</p>
      </div>

      <form id={formId} onSubmit={handleStepSubmit}>
      {/*
        The form's DEFAULT BUTTON, and the reason Enter works at all.

        The footer's Next/Publish is associated by `form={formId}` and submits
        on click, but it is not a DESCENDANT of the form -- `ui/modal.tsx`
        renders `footer` as a sibling of `children`. Implicit submission
        (Enter in a field) is specified against the form's default button,
        which is form-OWNERSHIP based, so per spec the footer button would
        qualify; in practice the DOM implementations that matter here look for
        a descendant submit button and find none. This hidden one is that
        descendant, which makes Enter behave the same everywhere instead of
        depending on which reading of the spec the host implements.

        `hidden` (not `sr-only`) so it is invisible to sight and to screen
        readers alike, and `tabIndex={-1}` so it never becomes a tab stop: the
        visible footer button is the only control a user should ever reach.
      */}
      <button type="submit" hidden aria-hidden tabIndex={-1} />
      {step === 1 && (
        <div className="grid gap-4">
          {templates.length > 0 ? (
            <Field label={t('modal.template_select_label')}>
              <div className="flex items-center gap-2">
                <Select
                  value=""
                  onChange={(e) => {
                    const picked = templates.find((tpl) => tpl.id === e.target.value);
                    if (picked) applyTemplate(picked);
                  }}
                >
                  <option value="">{t('modal.template_select_placeholder')}</option>
                  {templates.map((tpl) => (<option key={tpl.id} value={tpl.id}>{tpl.name}</option>))}
                </Select>
                <Link href="/employer/templates" className="shrink-0 text-xs font-semibold text-[var(--jale-blue-700)] hover:underline">
                  {t('templates.manage_link')}
                </Link>
              </div>
            </Field>
          ) : (
            // No templates yet: the picker would be empty, but the page link
            // stays discoverable from the wizard, not just the sidebar.
            <div className="flex justify-end">
              <Link href="/employer/templates" className="text-xs font-semibold text-[var(--jale-blue-700)] hover:underline">
                {t('templates.manage_link')}
              </Link>
            </div>
          )}
          <Field label={t('modal.job_title')} required>
            <Input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder={t('modal.job_title_placeholder')} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.location')} required>
              <div className={checkCity || cityMissing ? 'rounded-[10px] ring-2 ring-[var(--jale-warning)]' : undefined}>
                <LocationPicker
                  value={form.location}
                  placeholder={t('modal.location_placeholder')}
                  invalid={cityMissing}
                  describedBy={cityMissing ? cityHelperId : undefined}
                  onChange={(v) => {
                    setForm((c) => applyLocationToJobForm(c, v));
                    // Any location edit resolves the "verify the
                    // prefilled city" nudge, same as clearing the error.
                    setCheckCity(false);
                    // A real pick resolves the "pick a city" error; drop it
                    // immediately instead of waiting for the next step.
                    // Typing does NOT: free text still leaves `city_key` null,
                    // which is the whole thing the ring is reporting.
                    if (v.cityKey) {
                      setCityMissing(false);
                      setError('');
                    }
                  }}
                />
              </div>
              {checkCity && (
                <p className="mt-1 rounded-md bg-[var(--jale-warning-bg)] px-2 py-1 text-xs font-semibold text-[var(--jale-warning)]">{t('modal.template_check_city')}</p>
              )}
              {cityMissing && (
                <p id={cityHelperId} className="mt-1 rounded-md bg-[var(--jale-warning-bg)] px-2 py-1 text-xs font-semibold text-[var(--jale-warning)]">{t('modal.location_pick_helper')}</p>
              )}
            </Field>
            <Field label={t('modal.job_type')}>
              <Select value={form.job_type} onChange={(e) => update('job_type', e.target.value as JobForm['job_type'])}>
                <option value="full-time">{t('modal.job_type_fulltime')}</option>
                <option value="part-time">{t('modal.job_type_parttime')}</option>
                <option value="contract">{t('modal.job_type_contract')}</option>
              </Select>
            </Field>
          </div>
          <TradeCategoryField
            tradeCategory={form.trade_category}
            tradeCategoryOther={form.trade_category_other}
            onTradeCategoryChange={(value) => update('trade_category', value)}
            onTradeCategoryOtherChange={(value) => update('trade_category_other', value)}
          />
          <Field label={t('modal.job_description')}>
            <Textarea
              rows={4}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              // Locked decision (job-flow redesign): "Generate-with-AI
              // enables for Other once custom trade typed." Once the
              // employer has actually named their custom trade, notes fed
              // into this field become exactly as useful to AI generation as
              // for any other trade, so the placeholder swaps to the same
              // "jot brief notes" invitation the redesign uses everywhere
              // else. (`DescriptionHelper`'s `canGenerate` still hard-excludes
              // `trade_category === 'other'` today -- closing that gap is the
              // parallel description-helper task's work, not this one's --
              // but the placeholder copy here is written for the intended end
              // state, not today's temporary restriction.)
              placeholder={
                form.trade_category === 'other' && form.trade_category_other.trim()
                  ? t('modal.description_placeholder_notes')
                  : t('modal.description_placeholder')
              }
              disabled={descriptionGenerating}
            />
            <DescriptionHelper
              form={form}
              onDescriptionChange={(value) => update('description', value)}
              onGeneratingChange={setDescriptionGenerating}
            />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-4">
          <PayFields
            payMin={form.pay_min}
            payMax={form.pay_max}
            payInterval={form.pay_interval}
            onPayMinChange={(value) => update('pay_min', value)}
            onPayMaxChange={(value) => update('pay_max', value)}
            onPayIntervalChange={(value) => update('pay_interval', value)}
          />
          <PayReferenceHint trade={form.trade_category} cityKey={form.city_key} variant="employer" />
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.start_date')}>
              <Input type="date" value={form.start_date} onChange={(e) => update('start_date', e.target.value)} />
            </Field>
            <Field label={t('modal.number_of_workers_needed')} required>
              <Input type="number" min={1} value={form.number_of_workers_needed} onChange={(e) => update('number_of_workers_needed', e.target.value)} />
            </Field>
          </div>
          <DurationField
            value={form.expected_duration_bucket}
            legacyExpectedDuration={form.expected_duration}
            onChange={(value) => update('expected_duration_bucket', value)}
          />
          <ScheduleFields
            workDays={form.work_days}
            shiftStart={form.shift_start}
            shiftEnd={form.shift_end}
            legacyShiftSchedule={form.shift_schedule}
            onToggleDay={toggleWorkDay}
            onShiftStartChange={(value) => update('shift_start', value)}
            onShiftEndChange={(value) => update('shift_end', value)}
          />
          <ExperienceStepper
            value={form.required_experience_years}
            onChange={(value) => update('required_experience_years', value)}
          />
          <Field label={t('modal.language_preference')}>
            <div className="flex flex-wrap gap-2">
              {LANGUAGE_OPTIONS.map((lang) => {
                const selected = form.language_preference.includes(lang);
                return (
                  <button
                    key={lang}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleLanguage(lang)}
                    className={[
                      'rounded-full border px-3.5 py-2 text-xs font-bold transition-colors',
                      'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                      selected
                        ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                        : 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
                    ].join(' ')}
                  >
                    {t(`modal.language.${lang}`)}
                  </button>
                );
              })}
            </div>
          </Field>
          {/* `CheckboxCard` is the app's boolean toggle (employer signup and
              the employer profile both use it). Work authorization moved off
              this raw checkbox onto the requirements picker's own
              `work_authorization` row (step 3) -- see `jobFormToBasePayload`,
              which derives the legacy boolean from that row's state. */}
          <div className="grid gap-2">
            <CheckboxCard
              checked={form.transportation_required}
              label={t('modal.transportation_required')}
              onChange={() => update('transportation_required', !form.transportation_required)}
            />
          </div>
          <CertificationsPicker
            certificationRequirements={form.certification_requirements}
            legacyCertifications={form.certifications}
            // Clearing the legacy free-text `certifications` alongside every
            // picker edit (not just non-empty ones) matters specifically for
            // the empty case: `jobFormToBasePayload` falls back to
            // `splitDedupe(form.certifications)` whenever
            // `certification_requirements` is empty, so an employer who
            // deletes every chip here would otherwise have the legacy names
            // silently resurrected on save. The picker is the one authoritative
            // editor for certifications once it's in play, so it owns retiring
            // the legacy field the moment it's touched.
            onChange={(next) => setForm((current) => ({ ...current, certification_requirements: next, certifications: '' }))}
          />
        </div>
      )}

      {step === 3 && (
        <div className="grid gap-5">
        {/* ABOVE the picker, deliberately: these are the only questions an
            applicant meets while applying. Everything the picker configures
            below now waits for "Request details". */}
        <PreApplicationPromptsEditor
          prompts={form.pre_application_prompts}
          onChange={(next) => setForm((current) => ({ ...current, pre_application_prompts: next }))}
        />

        <RequirementsPicker
          requirements={form.requirements}
          onChange={(next) => setForm((current) => ({ ...current, requirements: next }))}
          certifications={form.certifications}
          certificationRequirements={form.certification_requirements}
          onCertificationTierChange={setCertificationTier}
          onCertificationProofToggle={toggleCertificationProof}
        />

        <div className="rounded-[10px] border border-[var(--jale-divider)] p-4">
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
            <input
              type="checkbox"
              checked={saveAsTemplate}
              onChange={(e) => setSaveAsTemplate(e.target.checked)}
            />
            {t('modal.template_save_toggle')}
          </label>
          {saveAsTemplate && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder={t('modal.template_name_placeholder')}
                className="flex-1"
              />
            </div>
          )}
          {templateNotice === 'name_taken' && (
            <p className="mt-2 text-xs font-semibold text-[var(--jale-danger)]">{t('modal.template_name_taken')}</p>
          )}
          {/* Deliberately NOT "Plan limit reached": the job still posts. The
              only thing at stake is the template, and the button beside the
              CTAs is the one-click way to accept that and carry on. */}
          <PlanLimitNotice
            model={templateLimitModel}
            className="mt-2"
            title={t('modal.template_not_saved', { limit: templateLimit ?? 0 })}
            onNavigate={handleClose}
            actions={
              <Button
                // Explicitly not a submitter: this one DOES sit inside the
                // step-3 form, where the native default would make it publish
                // the job rather than post it without the template.
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setTemplateNotice('');
                  setSaveAsTemplate(false);
                  void handleSubmit({ skipTemplate: true });
                }}
              >
                {t('modal.post_without_template')}
              </Button>
            }
          />
        </div>
        </div>
      )}
      </form>

      {error || jobLimit ? (
        <div ref={feedbackRef} className="mt-5 flex flex-col gap-2">
          {error ? (
            <InlineFeedback tone="danger">
              <span className="block">{error}</span>
            </InlineFeedback>
          ) : null}
          <PlanLimitNotice model={jobLimit} onNavigate={handleClose} />
        </div>
      ) : null}
    </Modal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {label}{required ? ' *' : ''}
      </label>
      {children}
    </div>
  );
}
