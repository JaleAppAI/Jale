// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreApplicationPromptsEditor } from '@/components/employer/PreApplicationPromptsEditor';
import {
    MAX_PROMPTS,
    RECOMMENDED_MAX_PROMPTS,
    SOFT_PROMPT_CHARS,
    type PromptDraft,
} from '@/lib/pre-application-prompts';
import { interpolate, message, renderIntl } from './render-intl';

const rows = (n: number): PromptDraft[] =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, text: `Question ${i + 1}?` }));

describe('PreApplicationPromptsEditor — empty state', () => {
    it('says workers apply with one tap and offers the one way in', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={[]} onChange={() => {}} />);
        expect(screen.getByText(message('job_requirements.prompts.empty'))).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: new RegExp(message('job_requirements.prompts.add')) }),
        ).toBeEnabled();
    });

    it('mints exactly one blank row with an id the backend CHECK accepts', async () => {
        const onChange = vi.fn();
        renderIntl(<PreApplicationPromptsEditor prompts={[]} onChange={onChange} />);

        await userEvent.click(
            screen.getByRole('button', { name: new RegExp(message('job_requirements.prompts.add')) }),
        );

        expect(onChange).toHaveBeenCalledTimes(1);
        const next = onChange.mock.calls[0][0] as PromptDraft[];
        expect(next).toHaveLength(1);
        expect(next[0].text).toBe('');
        expect(next[0].id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    });
});

describe('PreApplicationPromptsEditor — editing', () => {
    it('numbers the rows and shows the SOFT guide in the counter, not the hard bound', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={rows(2)} onChange={() => {}} />);
        expect(
            screen.getByText(interpolate(message('job_requirements.prompts.question_number'), { number: 1 })),
        ).toBeInTheDocument();
        // Both rows carry a counter; the guide denominator is what matters.
        expect(
            screen.getAllByText(interpolate(message('job_requirements.prompts.counter'), {
                count: 'Question 1?'.length,
                max: SOFT_PROMPT_CHARS,
            })),
        ).toHaveLength(2);
    });

    it('lets a question run past the counter guide -- 300 is advice, 500 is the gate', () => {
        const textareas = renderIntl(
            <PreApplicationPromptsEditor prompts={[{ id: 'p1', text: 'x' }]} onChange={() => {}} />,
        ).container.querySelectorAll('textarea');
        expect(textareas[0].getAttribute('maxLength')).toBe('500');
    });

    it('reports a text edit with the row’s id untouched', async () => {
        const onChange = vi.fn();
        renderIntl(
            <PreApplicationPromptsEditor prompts={[{ id: 'keep-me', text: 'a' }]} onChange={onChange} />,
        );
        await userEvent.type(screen.getByRole('textbox'), 'b');
        const next = onChange.mock.calls.at(-1)?.[0] as PromptDraft[];
        expect(next).toEqual([{ id: 'keep-me', text: 'ab' }]);
    });

    it('moves a row without re-minting any id', async () => {
        const onChange = vi.fn();
        const prompts = rows(3);
        renderIntl(<PreApplicationPromptsEditor prompts={prompts} onChange={onChange} />);

        await userEvent.click(
            screen.getByRole('button', {
                name: interpolate(message('job_requirements.prompts.move_down_aria'), { number: 1 }),
            }),
        );
        const next = onChange.mock.calls[0][0] as PromptDraft[];
        expect(next.map((p) => p.id)).toEqual(['p2', 'p1', 'p3']);
    });

    it('disables Move up on the first row and Move down on the last', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={rows(2)} onChange={() => {}} />);
        expect(screen.getByRole('button', {
            name: interpolate(message('job_requirements.prompts.move_up_aria'), { number: 1 }),
        })).toBeDisabled();
        expect(screen.getByRole('button', {
            name: interpolate(message('job_requirements.prompts.move_down_aria'), { number: 2 }),
        })).toBeDisabled();
    });

    it('removes the row it was asked to remove', async () => {
        const onChange = vi.fn();
        renderIntl(<PreApplicationPromptsEditor prompts={rows(3)} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', {
            name: interpolate(message('job_requirements.prompts.remove_aria'), { number: 2 }),
        }));
        expect((onChange.mock.calls[0][0] as PromptDraft[]).map((p) => p.id)).toEqual(['p1', 'p3']);
    });

    it('hides "Add a question" at the cap instead of leaving a dead button', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={rows(MAX_PROMPTS)} onChange={() => {}} />);
        expect(
            screen.queryByRole('button', { name: new RegExp(message('job_requirements.prompts.add')) }),
        ).toBeNull();
    });
});

describe('PreApplicationPromptsEditor — the drop-off tip', () => {
    it('is visible with no questions at all', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={[]} onChange={() => {}} />);
        expect(screen.getByText(message('job_requirements.prompts.tip'))).toBeInTheDocument();
    });

    it('stays advice at the recommended count and announces politely', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={rows(RECOMMENDED_MAX_PROMPTS)} onChange={() => {}} />);
        expect(screen.getByText(message('job_requirements.prompts.tip'))).toBeInTheDocument();
        expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('flips to a warning that names the count once past the recommendation', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={rows(3)} onChange={() => {}} />);
        expect(
            screen.getByText(interpolate(message('job_requirements.prompts.tip_warning'), { count: 3 })),
        ).toBeInTheDocument();
        // Warning tone -> `alert`, so it interrupts rather than waiting its turn.
        expect(screen.getByRole('alert')).toBeInTheDocument();
    });
});

describe('PreApplicationPromptsEditor — locked (the job already has applicants)', () => {
    const locked = (prompts = rows(2)) =>
        renderIntl(<PreApplicationPromptsEditor prompts={prompts} onChange={vi.fn()} locked />);

    it('says WHY the questions are frozen, in the warning voice', () => {
        locked();
        const banner = screen.getByText(message('job_requirements.prompts.locked_title'));
        expect(banner).toBeInTheDocument();
        // Warning tone -> role="alert": this interrupts, because the employer
        // is about to try editing something that cannot be edited.
        expect(banner.closest('[role="alert"]')).not.toBeNull();
    });

    it('says what CAN still be done, in the quiet voice, in place of the tip', () => {
        locked();
        expect(screen.getByText(message('job_requirements.prompts.locked_hint'))).toBeInTheDocument();
        // The how-many-questions advice is noise once none can change.
        expect(screen.queryByText(message('job_requirements.prompts.tip'))).toBeNull();
        expect(
            screen.queryByText(interpolate(message('job_requirements.prompts.tip_warning'), { count: 2 })),
        ).toBeNull();
    });

    it('does NOT borrow the picker’s requirements-flavoured locked note', () => {
        locked();
        expect(screen.queryByText(message('job_requirements.picker.locked_note'))).toBeNull();
    });

    it('still shows every stored question, read-only, exactly as it will be asked', () => {
        locked(rows(3));
        const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
        expect(textareas.map((el) => el.value)).toEqual(['Question 1?', 'Question 2?', 'Question 3?']);
        for (const textarea of textareas) expect(textarea).toBeDisabled();
        // Numbering survives, so the order the worker meets them is visible.
        expect(
            screen.getByText(interpolate(message('job_requirements.prompts.question_number'), { number: 3 })),
        ).toBeInTheDocument();
    });

    it('drops the character counters -- nothing here is being typed', () => {
        locked();
        expect(
            screen.queryByText(interpolate(message('job_requirements.prompts.counter'), {
                count: 'Question 1?'.length, max: SOFT_PROMPT_CHARS,
            })),
        ).toBeNull();
    });

    it('freezes every control, Add included', () => {
        locked();
        expect(
            screen.getByRole('button', { name: new RegExp(message('job_requirements.prompts.add')) }),
        ).toBeDisabled();
        for (const number of [1, 2]) {
            expect(screen.getByRole('button', {
                name: interpolate(message('job_requirements.prompts.remove_aria'), { number }),
            })).toBeDisabled();
        }
        expect(screen.getByRole('button', {
            name: interpolate(message('job_requirements.prompts.move_down_aria'), { number: 1 }),
        })).toBeDisabled();
    });

    it('never emits a change, even if a control is clicked programmatically', async () => {
        const onChange = vi.fn();
        renderIntl(<PreApplicationPromptsEditor prompts={rows(2)} onChange={onChange} locked />);
        await userEvent.click(
            screen.getByRole('button', { name: new RegExp(message('job_requirements.prompts.add')) }),
        );
        expect(onChange).not.toHaveBeenCalled();
    });

    it('a locked job that asks nothing states the fact without inviting an edit', () => {
        locked([]);
        expect(screen.getByText(message('job_requirements.prompts.locked_title'))).toBeInTheDocument();
        expect(screen.queryByText(message('job_requirements.prompts.empty'))).toBeNull();
    });

    it('speaks Spanish', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={rows(2)} onChange={vi.fn()} locked />, 'es');
        expect(
            screen.getByText(message('job_requirements.prompts.locked_title', 'es')),
        ).toBeInTheDocument();
        expect(
            screen.getByText(message('job_requirements.prompts.locked_hint', 'es')),
        ).toBeInTheDocument();
    });
});

describe('PreApplicationPromptsEditor — Spanish', () => {
    it('renders the section and the tip in Spanish', () => {
        renderIntl(<PreApplicationPromptsEditor prompts={rows(3)} onChange={() => {}} />, 'es');
        expect(screen.getByText(message('job_requirements.prompts.section_title', 'es'))).toBeInTheDocument();
        expect(
            screen.getByText(interpolate(message('job_requirements.prompts.tip_warning', 'es'), { count: 3 })),
        ).toBeInTheDocument();
    });
});
