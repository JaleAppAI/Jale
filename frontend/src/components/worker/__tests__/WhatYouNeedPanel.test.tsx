// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { JobDetail } from '@/lib/api/worker';
import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import { WhatYouNeedPanel } from '../WhatYouNeedPanel';

/*
 * The counted lines of the job page's "What you'll need" panel: the questions
 * asked to apply, and the details asked later. Each count has to agree with its
 * noun, one included ("1 detail", not "1 details").
 */

function job(over: Partial<JobDetail> = {}): JobDetail {
    return {
        id: 'job-1',
        title: 'Concrete Finisher',
        company_name: 'Sample Employer',
        location: 'El Paso, TX',
        job_type: 'full-time',
        required_docs: [],
        created_at: '2026-10-01T00:00:00Z',
        description: null,
        already_applied: false,
        application_status: null,
        missing_docs: [],
        ...over,
    } as JobDetail;
}

const ONE_PROMPT = [{ id: 'p1', text: 'What tools do you bring to a job?' }];
const TWO_PROMPTS = [...ONE_PROMPT, { id: 'p2', text: 'Tell me about a pour you finished.' }];

describe('WhatYouNeedPanel — the field questions row', () => {
    it('says one detail when the job asks one, required', () => {
        renderIntl(<WhatYouNeedPanel job={job({ required_fields: ['home_address'] })} vaultDocs={[]} />);
        expect(screen.getByText('1 detail (1 required)')).toBeInTheDocument();
    });

    it('says one detail when the job asks one, optional', () => {
        renderIntl(<WhatYouNeedPanel job={job({ optional_fields: ['home_address'] })} vaultDocs={[]} />);
        expect(screen.getByText('1 detail (0 required)')).toBeInTheDocument();
    });

    it('keeps the plural for more than one', () => {
        renderIntl(
            <WhatYouNeedPanel
                job={job({ required_fields: ['home_address'], optional_fields: ['desired_pay'] })}
                vaultDocs={[]}
            />,
        );
        expect(screen.getByText('2 details (1 required)')).toBeInTheDocument();
    });

    it('agrees in Spanish, the "obligatorio" count included', () => {
        const { unmount } = renderIntl(
            <WhatYouNeedPanel job={job({ required_fields: ['home_address'] })} vaultDocs={[]} />,
            'es',
        );
        expect(screen.getByText('1 dato (1 obligatorio)')).toBeInTheDocument();
        unmount();
        const second = renderIntl(
            <WhatYouNeedPanel job={job({ optional_fields: ['home_address'] })} vaultDocs={[]} />,
            'es',
        );
        expect(screen.getByText('1 dato (0 obligatorios)')).toBeInTheDocument();
        second.unmount();
        renderIntl(
            <WhatYouNeedPanel
                job={job({ required_fields: ['home_address', 'desired_pay'] })}
                vaultDocs={[]}
            />,
            'es',
        );
        expect(screen.getByText('2 datos (2 obligatorios)')).toBeInTheDocument();
    });
});

describe('WhatYouNeedPanel — the questions asked to apply', () => {
    it('says one short question when the job asks one', () => {
        renderIntl(<WhatYouNeedPanel job={job({ pre_application_prompts: ONE_PROMPT })} vaultDocs={[]} />);
        expect(screen.getByText('To apply: 1 short question · about 2 min')).toBeInTheDocument();
    });

    it('keeps the plural for more than one', () => {
        renderIntl(<WhatYouNeedPanel job={job({ pre_application_prompts: TWO_PROMPTS })} vaultDocs={[]} />);
        expect(screen.getByText('To apply: 2 short questions · about 2 min')).toBeInTheDocument();
    });

    it('agrees in Spanish', () => {
        const { unmount } = renderIntl(
            <WhatYouNeedPanel job={job({ pre_application_prompts: ONE_PROMPT })} vaultDocs={[]} />,
            'es',
        );
        expect(screen.getByText('Para postularte: 1 pregunta corta · unos 2 min')).toBeInTheDocument();
        unmount();
        renderIntl(<WhatYouNeedPanel job={job({ pre_application_prompts: TWO_PROMPTS })} vaultDocs={[]} />, 'es');
        expect(screen.getByText('Para postularte: 2 preguntas cortas · unos 2 min')).toBeInTheDocument();
    });
});
