import { describe, expect, it } from 'vitest';
import es from '@/messages/es.json';

/**
 * Worker-facing Spanish: "tú" throughout, and one noun for an application,
 * "postulación".
 *
 * A NAMED LIST, not a sweep of the catalogue. Employer copy is "usted" on
 * purpose, and plenty of worker sentences legitimately say "su" when the
 * subject is the employer ("cuando te postulas a su trabajo"), so a blanket
 * regex would be noise. Each key below is one a worker reads, checked for the
 * forms that addressed the worker as "usted" or called their application
 * something else. The list grows when a slip is found.
 */
type MessageNode = string | { [key: string]: MessageNode };

function resolve(path: string): string {
    let node: MessageNode = es as MessageNode;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) throw new Error(`No es.json message at "${path}"`);
        node = node[segment];
    }
    if (typeof node !== 'string') throw new Error(`"${path}" is not a leaf message`);
    return node;
}

/**
 * Words that address the reader as "usted": the pronoun and possessives, and
 * the usted forms of the verbs these keys use. Checked only on the keys in
 * `TU_KEYS`, none of which has the employer as a subject.
 */
const USTED_FORMS = /\b(usted|su|sus|suba|toque|agregue|puede|haya|intente|pida|lo contactó|le envíe|postuló|comparta|ayude|vuelva|mantenga|pruebe|recargue|quiere|le lleguen)\b/i;

/** The words this product no longer uses for a worker's application. */
const OTHER_NOUNS = /\b(aplicaci[oó]n|aplicaciones|solicitud|solicitudes|apliques|aplicas)\b/i;

/** Worker keys that address the worker directly. */
const TU_KEYS = [
    // The upload page a worker opens from an employer's document link.
    'upload_page.title',
    'upload_page.explainer',
    'upload_page.tap_to_upload',
    'upload_page.security_notice',
    'upload_page.submit_hint',
    'upload_page.error_upload',
    'upload_page.error_submit',
    'upload_page.error_confirm_required',
    'upload_page.expired_body',
    // The feed.
    'worker_home.other_jobs_header',
    'worker_home.empty.body',
    'worker_home.empty_filtered.body',
    'worker_home.no_city_jobs',
    'worker_home.applications_error',
    // The profile.
    'worker_profile.field_bio',
    'worker_profile.edit.bio',
    'worker_profile.edit.preferred_cities_label',
    // The share panel on the worker job page, its only reader.
    'job_share.title',
    'job_share.subtitle',
    'job_share.error_misconfigured',
    'job_share.error_generic',
    // Copy added this sprint, kept to the same register.
    'auth.worker.phone_hint',
    'worker_onboarding.terms.time',
    'worker_onboarding.question.lock_note',
    'worker_onboarding.question.placeholder',
    'worker_applications.status_hint.pending',
    'worker_applications.status_hint.contacted',
    'worker_applications.status_hint.talking',
    'worker_applications.status_hint.details_requested',
    'worker_applications.status_hint.hired',
    'worker_applications.status_hint.not_interested',
    'worker_job_detail.apply_hint',
    'worker_home.empty.cta',
    'worker_profile.documents.delete_confirm',
    'worker_application_details.terminal.already_complete_note',
];

/** Worker keys that name the worker's application. */
const POSTULACION_KEYS = [
    'upload_page.explainer',
    'worker_home.applications_error',
    // Onboarding, which used the verb "aplicar" for it.
    'worker_onboarding.terms.subtitle',
    'worker_onboarding.terms.info_body',
    'worker_onboarding.about.subtitle',
    // The applications list and the hire celebration.
    'worker_applications.title',
    'worker_applications.hired_celebration.modal.reference',
    'worker_applications.hired_celebration.modal.link',
    'worker_applications.hired_celebration.modal.body_details',
    'worker_applications.hired_celebration.banner.cta',
    // One application's page.
    'worker_application_details.terminal.not_interested',
    'worker_application_details.terminal.view_applications',
    'worker_application_details.hired_card.not_hired',
    // Read only by the worker navigation (`workerPrimaryNav`, and the worker
    // tab bar and sidebar for the badge) and the worker report sheet.
    'header.my_applications',
    'app_shell.applications_attention_badge',
    'report_worker.categories.applying',
];

/**
 * The four worker tutorials. Every string in them is read by a worker, so here
 * the whole namespace is checked rather than a list of keys, and copy added
 * later is covered without anyone remembering to list it.
 */
const TUTORIAL_NAMESPACES = [
    'tutorial.worker_onboarding',
    'tutorial.worker_apply',
    'tutorial.worker_details',
    'tutorial.worker_profile',
];

/**
 * Tutorial strings that match `USTED_FORMS` without addressing the worker as
 * "usted", each with the reason. Anything else that matches fails.
 */
const TUTORIAL_TU_EXCEPTIONS: Record<string, string> = {
    'tutorial.worker_onboarding.slides.jobs.body': '"con un toque" is the noun (a tap), not the usted verb',
    'tutorial.worker_apply.slides.documents.body': '"quiere" has the employer as its subject',
    'tutorial.worker_apply.slides.next.body': '"te pida" has the employer as its subject',
    'tutorial.worker_apply.scene.docs_note': '"quiere" has the employer as its subject',
    'tutorial.worker_details.slides.request.title': '"quiere" has the employer as its subject',
};

/** Every leaf message under a namespace, as `[path, value]`. */
function leaves(path: string): Array<[string, string]> {
    let node: MessageNode = es as MessageNode;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) throw new Error(`No es.json namespace at "${path}"`);
        node = node[segment];
    }
    const out: Array<[string, string]> = [];
    const walk = (at: string, value: MessageNode) => {
        if (typeof value === 'string') out.push([at, value]);
        else for (const [key, child] of Object.entries(value)) walk(`${at}.${key}`, child);
    };
    walk(path, node);
    return out;
}

const TUTORIAL_LEAVES = TUTORIAL_NAMESPACES.flatMap(leaves);

/**
 * "Aplicado" stays the STATUS word, as on every approved board: it names the
 * state, and the noun for the thing itself is still "postulación".
 */
const STATUS_KEYS = [
    'worker_applications.applied',
    'worker_applications.status.pending',
    'worker_applications.status_short.pending',
];

describe('worker Spanish copy', () => {
    it.each(TU_KEYS)('%s speaks to the worker as tú', (path) => {
        expect(resolve(path)).not.toMatch(USTED_FORMS);
    });

    it.each(POSTULACION_KEYS)('%s calls the application a postulación', (path) => {
        const value = resolve(path);
        expect(value).not.toMatch(OTHER_NOUNS);
        expect(value).toMatch(/postul/i);
    });

    it.each(STATUS_KEYS)('%s keeps "Aplicado" as the status word', (path) => {
        expect(resolve(path)).toBe('Aplicado');
    });

    it('walks every worker tutorial string', () => {
        expect(TUTORIAL_LEAVES.length).toBeGreaterThan(0);
        for (const namespace of TUTORIAL_NAMESPACES) {
            expect(TUTORIAL_LEAVES.some(([path]) => path.startsWith(`${namespace}.`))).toBe(true);
        }
        // An exception for a string that is gone would hide nothing; keep the list true.
        const paths = new Set(TUTORIAL_LEAVES.map(([path]) => path));
        for (const path of Object.keys(TUTORIAL_TU_EXCEPTIONS)) expect(paths.has(path)).toBe(true);
    });

    it.each(TUTORIAL_LEAVES)('%s speaks to the worker as tú', (path, value) => {
        if (path in TUTORIAL_TU_EXCEPTIONS) return;
        expect(value).not.toMatch(USTED_FORMS);
    });

    it.each(TUTORIAL_LEAVES)('%s never calls the application anything but a postulación', (_path, value) => {
        expect(value).not.toMatch(OTHER_NOUNS);
    });
});
