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
];

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
        expect(value).toMatch(/postulaci[oó]n|postul(es|as)\b/i);
    });

    it.each(STATUS_KEYS)('%s keeps "Aplicado" as the status word', (path) => {
        expect(resolve(path)).toBe('Aplicado');
    });
});
