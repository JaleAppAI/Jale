import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Counted copy, formatted through next-intl's REAL translator over the real
 * catalogues, at one and at more than one.
 *
 * A count is followed by a word that agrees with it -- a noun ("1 item"), an
 * adjective ("1 pausado") or a verb ("Falta 1") -- so a string that pastes the
 * number into a fixed plural reads "1 items left" the moment there is one.
 * Each of these is an ICU plural now; this formats every one of them in both
 * locales and compares the whole sentence, so a branch with a typo, or an ICU
 * string next-intl cannot parse (its `onError` is collected, not swallowed),
 * fails here rather than in a screenshot.
 *
 * Fraction forms ("1/3 open", "Active jobs 1/15") and invariant words ("min",
 * "avg") are not here: they have nothing that agrees with the number.
 */

const catalogues = { en, es } as const;
type Locale = keyof typeof catalogues;
type Values = Record<string, string | number>;

/** Same cast as `j/[code]/__tests__/facts-card.test.tsx`: the options are typed per catalogue. */
type CreateTranslatorOptions = Parameters<typeof createTranslator>[0];

function format(locale: Locale, path: string, values: Values): { text: string; errors: string[] } {
    const errors: string[] = [];
    const t = createTranslator({
        locale,
        messages: catalogues[locale],
        onError: (error: Error) => errors.push(error.message),
    } as unknown as CreateTranslatorOptions) as unknown as (key: string, values?: Values) => string;
    return { text: t(path, values), errors };
}

type Case = { path: string; values: Values; en: string; es: string };

/** Counted copy on the worker's screens and the employer dashboard. */
const COUNT_CASES: Case[] = [
    // The details banner (applications list, home, job page).
    { path: 'worker_applications.details_banner.row_left', values: { count: 1 }, en: '1 item left', es: 'Falta 1 cosa' },
    { path: 'worker_applications.details_banner.row_left', values: { count: 2 }, en: '2 items left', es: 'Faltan 2 cosas' },
    {
        path: 'worker_applications.details_banner.many_head',
        values: { count: 1 },
        en: '1 application needs your details',
        es: '1 postulación necesita tus datos',
    },
    {
        path: 'worker_applications.details_banner.many_head',
        values: { count: 2 },
        en: '2 applications need your details',
        es: '2 postulaciones necesitan tus datos',
    },
    {
        path: 'worker_applications.details_banner.many_body',
        values: { count: 1 },
        en: '1 employer wants to move forward with you.',
        es: '1 empleador quiere seguir adelante contigo.',
    },
    {
        path: 'worker_applications.details_banner.many_body',
        values: { count: 2 },
        en: '2 employers want to move forward with you.',
        es: '2 empleadores quieren seguir adelante contigo.',
    },

    // One application's details page.
    { path: 'worker_application_details.progress.left', values: { count: 1 }, en: '1 left', es: 'Falta 1' },
    { path: 'worker_application_details.progress.left', values: { count: 2 }, en: '2 left', es: 'Faltan 2' },
    {
        path: 'worker_application_details.progress.bits',
        values: { fields: 1, docs: 1, certs: 1 },
        en: '1 detail · 1 document · 1 certification',
        es: '1 dato · 1 documento · 1 certificación',
    },
    {
        path: 'worker_application_details.progress.bits',
        values: { fields: 2, docs: 0, certs: 3 },
        en: '2 details · 0 documents · 3 certifications',
        es: '2 datos · 0 documentos · 3 certificaciones',
    },
    {
        path: 'worker_application_details.errors.required_questions',
        values: { count: 1 },
        en: 'Answer the required questions to continue (1 left).',
        es: 'Contesta las preguntas obligatorias para seguir (falta 1).',
    },
    {
        path: 'worker_application_details.errors.required_questions',
        values: { count: 2 },
        en: 'Answer the required questions to continue (2 left).',
        es: 'Contesta las preguntas obligatorias para seguir (faltan 2).',
    },

    // The worker job page.
    {
        path: 'worker_job_detail.openings_value',
        values: { open: 1, total: 1 },
        en: '1 of 1 spot open',
        es: '1 de 1 lugar disponible',
    },
    {
        path: 'worker_job_detail.openings_value',
        values: { open: 1, total: 3 },
        en: '1 of 3 spots open',
        es: '1 de 3 lugares disponibles',
    },
    {
        path: 'worker_job_detail.what_you_need.to_apply_prompts',
        values: { count: 1, minutes: 2 },
        en: 'To apply: 1 short question · about 2 min',
        es: 'Para postularte: 1 pregunta corta · unos 2 min',
    },
    {
        path: 'worker_job_detail.what_you_need.to_apply_prompts',
        values: { count: 3, minutes: 2 },
        en: 'To apply: 3 short questions · about 2 min',
        es: 'Para postularte: 3 preguntas cortas · unos 2 min',
    },
    {
        path: 'worker_job_detail.what_you_need.fields_row',
        values: { count: 1, required: 1 },
        en: '1 detail (1 required)',
        es: '1 dato (1 obligatorio)',
    },
    {
        path: 'worker_job_detail.what_you_need.fields_row',
        values: { count: 1, required: 0 },
        en: '1 detail (0 required)',
        es: '1 dato (0 obligatorios)',
    },
    {
        path: 'worker_job_detail.what_you_need.fields_row',
        values: { count: 3, required: 2 },
        en: '3 details (2 required)',
        es: '3 datos (2 obligatorios)',
    },
    {
        path: 'worker_job_detail.apply_flow.intro_prompts',
        values: { company: 'Sample Employer', count: 1 },
        en: 'Sample Employer asks 1 quick question. Answer in your own words.',
        es: 'Sample Employer hace 1 pregunta rápida. Contesta con tus propias palabras.',
    },
    {
        path: 'worker_job_detail.apply_flow.intro_prompts',
        values: { company: 'Sample Employer', count: 2 },
        en: 'Sample Employer asks 2 quick questions. Answer in your own words.',
        es: 'Sample Employer hace 2 preguntas rápidas. Contesta con tus propias palabras.',
    },
    {
        path: 'worker_job_detail.apply_flow.errors.missing_prompt_answers',
        values: { count: 1 },
        en: 'Answer every question before you send this (1 left).',
        es: 'Contesta todas las preguntas antes de enviar (falta 1).',
    },
    {
        path: 'worker_job_detail.apply_flow.errors.missing_prompt_answers',
        values: { count: 2 },
        en: 'Answer every question before you send this (2 left).',
        es: 'Contesta todas las preguntas antes de enviar (faltan 2).',
    },

    // The employer dashboard.
    {
        path: 'employer_dashboard.stats.active_hint',
        values: { count: 1 },
        en: '1 opening still available',
        es: '1 puesto aún disponible',
    },
    {
        path: 'employer_dashboard.stats.active_hint',
        values: { count: 4 },
        en: '4 openings still available',
        es: '4 puestos aún disponibles',
    },
    {
        path: 'employer_dashboard.stats.hired_hint',
        values: { hired: 0, needed: 1 },
        en: '0 of 1 position filled',
        es: '0 de 1 puesto cubierto',
    },
    {
        path: 'employer_dashboard.stats.hired_hint',
        values: { hired: 1, needed: 5 },
        en: '1 of 5 positions filled',
        es: '1 de 5 puestos cubiertos',
    },
    {
        path: 'employer_dashboard.stats.paused_closed_hint',
        values: { paused: 1, filled: 1, closed: 1 },
        en: '1 paused, 1 filled, 1 closed',
        es: '1 pausado, 1 lleno, 1 cerrado',
    },
    {
        path: 'employer_dashboard.stats.paused_closed_hint',
        values: { paused: 2, filled: 0, closed: 3 },
        en: '2 paused, 0 filled, 3 closed',
        es: '2 pausados, 0 llenos, 3 cerrados',
    },
    {
        path: 'employer_dashboard.templates.meter',
        values: { count: 1, limit: 1 },
        en: '1 saved · 1 allowed on your plan',
        es: '1 guardada · 1 permitida en su plan',
    },
    {
        path: 'employer_dashboard.templates.meter',
        values: { count: 2, limit: 20 },
        en: '2 saved · 20 allowed on your plan',
        es: '2 guardadas · 20 permitidas en su plan',
    },
    {
        path: 'employer_dashboard.templates.meter_empty',
        values: { limit: 1 },
        en: 'No templates yet · 1 allowed on your plan',
        es: 'Aún no hay plantillas · 1 permitida en su plan',
    },
    {
        path: 'employer_dashboard.templates.meter_empty',
        values: { limit: 2 },
        en: 'No templates yet · 2 allowed on your plan',
        es: 'Aún no hay plantillas · 2 permitidas en su plan',
    },
    { path: 'employer_dashboard.templates.meter_count', values: { count: 1 }, en: '1 template', es: '1 plantilla' },
    { path: 'employer_dashboard.templates.meter_count', values: { count: 2 }, en: '2 templates', es: '2 plantillas' },
    { path: 'employer_dashboard.usage.jobs_plain', values: { used: 1 }, en: '1 active job', es: '1 empleo activo' },
    { path: 'employer_dashboard.usage.jobs_plain', values: { used: 3 }, en: '3 active jobs', es: '3 empleos activos' },
];

describe('counted copy agrees with its number', () => {
    for (const locale of ['en', 'es'] as const) {
        it.each(COUNT_CASES)(`${locale}: $path $values`, (entry) => {
            const { text, errors } = format(locale, entry.path, entry.values);
            expect(errors).toEqual([]);
            expect(text).toBe(entry[locale]);
        });
    }
});
