// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { RequirementsTotals } from '@/lib/application-requirements-flow';
import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import { RequirementsProgress } from '../RequirementsProgress';

/*
 * The line over the details-request progress bar: "3 left" over "1 detail ·
 * 1 document · 1 certification". Every number on it is a count of something,
 * so each word has to agree with its own number, one included.
 */

/** Totals with `left` of each kind still to do (and one of each already done). */
function totals(left: { fields: number; docs: number; certs: number }): RequirementsTotals {
    const remainingCount = left.fields + left.docs + left.certs;
    return {
        prompts: { done: 0, total: 0 },
        fields: { done: 1, total: 1 + left.fields },
        docs: { done: 1, total: 1 + left.docs },
        certifications: { done: 1, total: 1 + left.certs },
        remainingCount,
        total: 3 + remainingCount,
        done: 3,
    };
}

describe('RequirementsProgress — counts that agree with their numbers', () => {
    it('says each kind in the singular when one of it is left', () => {
        renderIntl(<RequirementsProgress totals={totals({ fields: 1, docs: 1, certs: 1 })} />);
        expect(screen.getByText('3 left')).toBeInTheDocument();
        expect(screen.getByText('1 detail · 1 document · 1 certification')).toBeInTheDocument();
    });

    it('keeps the plural for zero and for more than one', () => {
        renderIntl(<RequirementsProgress totals={totals({ fields: 2, docs: 0, certs: 3 })} />);
        expect(screen.getByText('5 left')).toBeInTheDocument();
        expect(screen.getByText('2 details · 0 documents · 3 certifications')).toBeInTheDocument();
    });

    it('says one left as one left', () => {
        renderIntl(<RequirementsProgress totals={totals({ fields: 1, docs: 0, certs: 0 })} />);
        expect(screen.getByText('1 left')).toBeInTheDocument();
        expect(screen.getByText('1 detail · 0 documents · 0 certifications')).toBeInTheDocument();
    });

    it('agrees in Spanish: "Falta 1", "1 dato"', () => {
        renderIntl(<RequirementsProgress totals={totals({ fields: 1, docs: 0, certs: 0 })} />, 'es');
        expect(screen.getByText('Falta 1')).toBeInTheDocument();
        expect(screen.getByText('1 dato · 0 documentos · 0 certificaciones')).toBeInTheDocument();
    });

    it('keeps the Spanish plural for more than one', () => {
        renderIntl(<RequirementsProgress totals={totals({ fields: 2, docs: 1, certs: 1 })} />, 'es');
        expect(screen.getByText('Faltan 4')).toBeInTheDocument();
        expect(screen.getByText('2 datos · 1 documento · 1 certificación')).toBeInTheDocument();
    });
});
