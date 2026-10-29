/**
 * The two F19/K4.5 email templates: the hire-details nudge and the billing
 * resume notice. Pure renderers; the copy here is the copy Luis signs off.
 */
import {
  hireDetailsNudgeLines,
  hireDetailsNudgeSubject,
  nudgeFirstName,
  renderHireDetailsNudgeEmail,
} from '../../../../lambda/lib/hire-details-nudge-template';
import { BILLING_RESUME_SUBJECT, renderBillingResumeEmail } from '../../../../lambda/lib/billing-resume-template';

const URLS = { englishUrl: 'https://app.example.test/en/employer/applicants', spanishUrl: 'https://app.example.test/es/employer/applicants' };

describe('hire-details nudge template', () => {
  it('uses the first word of the name, and words a nameless hire without one', () => {
    expect(nudgeFirstName('  Ana Maria Ruiz ')).toBe('Ana');
    expect(nudgeFirstName('')).toBeNull();
    expect(nudgeFirstName(null)).toBeNull();
    expect(hireDetailsNudgeLines({ kind: 'auto', workerName: null, jobTitle: 'Glazier', ...URLS })).toEqual({
      en: 'A worker was hired for Glazier. Add a start date and where to report.',
      es: 'Se contrató a un trabajador para Glazier. Agregue una fecha de inicio y el lugar donde debe presentarse.',
    });
    expect(hireDetailsNudgeLines({ kind: 'auto', workerName: 'Ana Ruiz', jobTitle: 'Glazier', ...URLS })).toEqual({
      en: 'Ana was hired for Glazier. Add a start date and where to report.',
      es: 'Se contrató a Ana para Glazier. Agregue una fecha de inicio y el lugar donde debe presentarse.',
    });
  });

  it('is neutral about who hired: after a job moves the reader may not be the hirer', () => {
    const EN_WHY = 'You are receiving this because a worker was hired on one of your jobs on Jale.';
    const ES_WHY = 'Recibe este mensaje porque se contrató a un trabajador en uno de sus trabajos en Jale.';
    for (const kind of ['auto', 'remind'] as const) {
      for (const workerName of [null, 'Ana Ruiz']) {
        const rendered = renderHireDetailsNudgeEmail({ kind, workerName, jobTitle: 'Glazier', ...URLS });
        for (const part of [rendered.subject, rendered.bodyText, rendered.bodyHtml]) {
          expect(part).not.toMatch(/you hired/i);
          expect(part).not.toMatch(/(?<!se )contrató a/i);
          expect(part).not.toMatch(/your new hire/i);
          expect(part).not.toMatch(/su nuevo trabajador/i);
        }
        for (const body of [rendered.bodyText, rendered.bodyHtml]) {
          expect(body).toContain(EN_WHY);
          expect(body).toContain(ES_WHY);
          if (kind === 'auto') {
            expect(body).toContain('was hired for Glazier');
            expect(body).toContain('Se contrató a');
          }
        }
      }
    }
  });

  it('says who asked when the worker pressed the remind button', () => {
    expect(hireDetailsNudgeLines({ kind: 'remind', workerName: 'Ana Ruiz', jobTitle: 'Glazier', ...URLS })).toEqual({
      en: 'Ana asked for their start details for Glazier. Add a start date and where to report.',
      es: 'Ana pidió sus detalles de inicio para Glazier. Agregue una fecha de inicio y el lugar donde debe presentarse.',
    });
    expect(hireDetailsNudgeLines({ kind: 'remind', workerName: null, jobTitle: 'Glazier', ...URLS }).es)
      .toBe('Un nuevo trabajador pidió sus detalles de inicio para Glazier. Agregue una fecha de inicio y el lugar donde debe presentarse.');
    expect(hireDetailsNudgeLines({ kind: 'remind', workerName: null, jobTitle: 'Glazier', ...URLS }).en)
      .toBe('A new hire asked for their start details for Glazier. Add a start date and where to report.');
    expect(hireDetailsNudgeSubject({ kind: 'auto', workerName: null, jobTitle: 'Glazier', ...URLS }))
      .toBe('Add start details for a new hire · Agregue los detalles de inicio de un nuevo trabajador');
  });

  it('escapes user text in the HTML and keeps the subject inside the outbox limit', () => {
    const hostile = { kind: 'auto' as const, workerName: '<b>Ana</b>', jobTitle: `<script>${'x'.repeat(500)}`, ...URLS };
    const rendered = renderHireDetailsNudgeEmail(hostile);
    expect(rendered.bodyHtml).not.toContain('<script>');
    expect(rendered.bodyHtml).not.toContain('<b>Ana</b>');
    expect(rendered.bodyHtml).toContain(URLS.spanishUrl);
    expect(hireDetailsNudgeSubject({ ...hostile, workerName: 'N'.repeat(500) }).length).toBeLessThanOrEqual(200);
  });
});

describe('billing resume template', () => {
  const model = (titles: string[]) => ({
    resumedTitles: titles,
    englishJobsUrl: 'https://app.example.test/en/employer/jobs',
    spanishJobsUrl: 'https://app.example.test/es/employer/jobs',
  });

  it('lists the resumed jobs in both languages with both links', () => {
    const rendered = renderBillingResumeEmail(model(['Older', 'Newer']));
    expect(rendered.subject).toBe(BILLING_RESUME_SUBJECT);
    expect(rendered.bodyText).toMatch(/Your subscription is active again[\s\S]*- Older\n- Newer[\s\S]*\/en\/employer\/jobs[\s\S]*Su suscripción está activa de nuevo[\s\S]*\/es\/employer\/jobs/);
  });

  it('caps a long list with a "+N more" line and escapes titles', () => {
    const rendered = renderBillingResumeEmail(model([...Array.from({ length: 60 }, (_, i) => `Job ${i}`), '<i>x</i>']));
    expect(rendered.bodyText).toContain('+ 11 more job postings');
    expect(rendered.bodyText).toContain('+ 11 empleos más');
    expect(rendered.bodyHtml).not.toContain('<i>x</i>');
  });
});
