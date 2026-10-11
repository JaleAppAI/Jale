import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { EMPLOYER_REPORT_CATEGORIES, WORKER_REPORT_CATEGORIES } from '@/lib/report/categories';

/**
 * "Report a problem" copy: every key the report UI reads exists in BOTH
 * catalogues (the parity test alone would pass a key missing from both), the
 * Spanish register is tú for workers and usted for employers, and the word is
 * always "problem" -- never "bug".
 */

type MessageNode = string | { [key: string]: MessageNode };

function resolve(tree: MessageNode, path: string): string | undefined {
    let node: MessageNode = tree;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) return undefined;
        node = node[segment];
    }
    return typeof node === 'string' ? node : undefined;
}

function leaves(node: MessageNode): string[] {
    return typeof node === 'string' ? [node] : Object.values(node).flatMap(leaves);
}

const COMMON_KEYS = [
    'title',
    'entry_short',
    'entry_link_lead',
    'error_action',
    'close',
    'loading',
    'next',
    'change',
    'send',
    'sending',
    'try_again',
    'done',
    'back',
    'category_legend',
    'description_label',
    'character_count',
    'screenshot_heading',
    'capture_pending',
    'capture_failed_title',
    'attach_photo',
    'attach_photo_instead',
    'continue_without_image',
    'no_image',
    'photo_preparing',
    'editor.hide_area',
    'editor.done',
    'editor.undo',
    'editor.remove',
    'editor.box_label',
    'editor.keyboard_hint',
    'editor.delete_box',
    'what_we_send.toggle',
    'what_we_send.screen',
    'what_we_send.app',
    'what_we_send.device',
    'what_we_send.requests',
    'what_we_send.errors',
    'what_we_send.technical_label',
    'what_we_send.technical_hint',
    'what_we_send.technical_off',
    'what_we_send.never_heading',
    'what_we_send.never_codes',
    'what_we_send.never_content',
    'what_we_send.kept',
    'what_we_send.in_app_browser',
    'what_we_send.other_family',
    'privacy_link',
    'new_tab',
    'language.en',
    'language.es',
    'device_kind.phone',
    'device_kind.tablet',
    'device_kind.desktop',
    'image_sending',
    'image_sent',
    'paused_title',
    'signed_out_paused_title',
    'contact_email_label',
    'contact_whatsapp_label',
    'load_failed',
] as const;

/** Keys both role namespaces carry, each in its own register. */
const ROLE_KEYS = [
    'category_hint',
    'description_hint',
    'description_error',
    'capture_failed_body',
    'masked_note',
    'photo_error',
    'editor.preview_alt',
    'editor.masked_note',
    'what_we_send.with_heading',
    'what_we_send.account',
    'what_we_send.contact',
    'what_we_send.image',
    'what_we_send.never_typed',
    'what_we_send.never_files',
    'notice',
    'contact_label',
    'contact_hint',
    'unverified',
    'session_switched',
    'errors.rate_limited',
    'errors.reporting_paused',
    'errors.signed_out_paused',
    'errors.invalid_request',
    'errors.too_large',
    'errors.offline',
    'errors.timeout',
    'errors.server',
    'fallback_contacts',
    'fallback.body',
    'fallback.whatsapp',
    'fallback.sign_in',
    'sent.title',
    'sent.title_unverified',
    'sent.number_label',
    'sent.body',
    'sent.body_unverified',
    'sent.whatsapp',
    'sent.image_failed',
    'sent.image_failed_final',
    'sent.image_paused',
] as const;

const EMPLOYER_ONLY_KEYS = ['stops_work.legend', 'stops_work.yes', 'stops_work.no'] as const;

const CATALOGUES = { en, es } as const;

describe('report copy: coverage', () => {
    for (const [locale, tree] of Object.entries(CATALOGUES)) {
        it(`${locale}: has every report_common key`, () => {
            const missing = COMMON_KEYS.filter((key) => !resolve(tree as MessageNode, `report_common.${key}`));
            expect(missing).toEqual([]);
        });

        it(`${locale}: has every role key, in both role namespaces`, () => {
            const missing = ['report_worker', 'report_employer'].flatMap((ns) =>
                ROLE_KEYS.filter((key) => !resolve(tree as MessageNode, `${ns}.${key}`)).map((key) => `${ns}.${key}`),
            );
            expect(missing).toEqual([]);
        });

        it(`${locale}: labels every category code for its role`, () => {
            const missing = [
                ...WORKER_REPORT_CATEGORIES.map((code) => `report_worker.categories.${code}`),
                ...EMPLOYER_REPORT_CATEGORIES.map((code) => `report_employer.categories.${code}`),
                ...EMPLOYER_ONLY_KEYS.map((key) => `report_employer.${key}`),
            ].filter((path) => !resolve(tree as MessageNode, path));
            expect(missing).toEqual([]);
        });

        it(`${locale}: says "problem", never "bug"`, () => {
            const texts = ['report_common', 'report_worker', 'report_employer'].flatMap((ns) =>
                leaves((tree as Record<string, MessageNode>)[ns] ?? {}),
            );
            expect(texts.length).toBeGreaterThan(50);
            expect(texts.filter((text) => /\bbugs?\b/i.test(text))).toEqual([]);
        });
    }
});

describe('report copy: the approved strings', () => {
    const at = (tree: MessageNode, path: string) => resolve(tree, path);

    it('uses the design wording in both languages', () => {
        expect(at(en, 'report_common.title')).toBe('Report a problem');
        expect(at(es, 'report_common.title')).toBe('Reportar un problema');
        expect(at(en, 'report_common.entry_short')).toBe('Report');
        expect(at(es, 'report_common.entry_short')).toBe('Reportar');
        expect(at(es, 'report_common.entry_link_lead')).toBe('¿Problemas?');
        expect(at(en, 'report_common.error_action')).toBe('Report this problem');
        expect(at(es, 'report_common.error_action')).toBe('Reportar este problema');
        expect(at(es, 'report_common.category_legend')).toBe('¿De qué se trata?');
        expect(at(es, 'report_common.description_label')).toBe('¿Qué pasó?');
        expect(at(es, 'report_common.what_we_send.toggle')).toBe('Lo que enviaremos');
        expect(at(es, 'report_common.attach_photo')).toBe('Adjuntar una foto');
        expect(at(es, 'report_common.editor.hide_area')).toBe('Ocultar un área');
        expect(at(es, 'report_common.editor.remove')).toBe('Quitar');
    });

    it('speaks tú to workers and usted to employers', () => {
        expect(at(es, 'report_worker.description_hint')).toBe('¿Qué intentabas hacer y qué pasó?');
        expect(at(es, 'report_employer.description_hint')).toBe('¿Qué intentaba hacer y qué pasó?');
        expect(at(es, 'report_worker.sent.title')).toBe('¡Gracias! Recibimos tu reporte');
        expect(at(es, 'report_employer.sent.title')).toBe('Gracias. Recibimos su reporte');
        expect(at(es, 'report_worker.unverified')).toBe('No has iniciado sesión, así que no podemos confirmar quién eres.');
        expect(at(es, 'report_employer.unverified')).toBe('No ha iniciado sesión, así que no podemos confirmar quién es.');
        expect(at(en, 'report_worker.unverified')).toBe("You're not signed in, so we can't confirm who you are.");
        expect(at(en, 'report_worker.description_hint')).toBe('What were you trying to do, and what happened instead?');
        expect(at(en, 'report_worker.sent.title')).toBe('Thanks, we got your report');
    });

    it('names the worker and employer categories as the design does', () => {
        expect(at(es, 'report_worker.categories.sign_in')).toBe('No puedo entrar / no me llegó el código');
        expect(at(es, 'report_worker.categories.whatsapp')).toBe('Mensajes de WhatsApp');
        expect(at(en, 'report_worker.categories.uploads')).toBe('Uploading documents or photos');
        expect(at(es, 'report_employer.categories.account')).toBe('Inicio de sesión, cuenta o correo de verificación');
        expect(at(es, 'report_employer.categories.company_profile')).toBe('Perfil de la empresa y configuración');
        expect(at(en, 'report_employer.stops_work.legend')).toBe('Does this stop your work?');
        expect(at(en, 'report_employer.stops_work.yes')).toBe("Yes, I can't continue");
        expect(at(en, 'report_employer.stops_work.no')).toBe('No, I can keep working');
    });

    it('promises no reply after sending', () => {
        for (const tree of [en, es]) {
            for (const ns of ['report_worker', 'report_employer']) {
                const body = at(tree, `${ns}.sent.body`) ?? '';
                expect(body).not.toMatch(/we will (reply|answer|get back)|te responderemos|le responderemos/i);
            }
        }
    });
});
