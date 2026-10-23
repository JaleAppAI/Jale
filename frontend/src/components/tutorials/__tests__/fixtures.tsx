import { EMPLOYER_TUTORIAL_IDS, WORKER_TUTORIAL_IDS, type TutorialId, type TutorialRole } from '@/lib/api/tutorials';
import type { TutorialDefinition, TutorialSceneProps } from '@/lib/tutorials/types';
import { SceneChip, SceneFrame, SlideIn, TapPulse } from '@/components/tutorials/scene';

/**
 * Fixture tutorials for the framework suites: never the content files, which
 * belong to the content lanes and change under them. Every fixture lives in
 * its own `fixture_tutorials.*` namespace with its own EN and ES messages,
 * merged into the real catalogues by the suites.
 *
 * Not a `.test.` file, so vitest collects it as a helper rather than a suite.
 */

/** Every scene render, in order: what the player passed down. */
export const sceneRenders: TutorialSceneProps[] = [];

export function noteSceneRender(props: TutorialSceneProps) {
    sceneRenders.push(props);
}

function FixtureScene(props: TutorialSceneProps) {
    noteSceneRender(props);
    return (
        <SceneFrame className="w-[260px]">
            <SlideIn>
                <SceneChip tone="blue">Sample chip</SceneChip>
            </SlideIn>
            <TapPulse>
                <SceneChip tone="primary" size="lg">
                    Sample action
                </SceneChip>
            </TapPulse>
        </SceneFrame>
    );
}

export function fixtureDefinition(id: TutorialId, role: TutorialRole, slideCount: number, namespace = `fixture_tutorials.${id}`): TutorialDefinition {
    return {
        id,
        role,
        namespace,
        titleKey: 'title',
        slides: Array.from({ length: slideCount }, (_, index) => ({
            id: `step-${index + 1}`,
            titleKey: `s${index + 1}.title`,
            bodyKey: `s${index + 1}.body`,
            Scene: FixtureScene,
        })),
    };
}

/** A three-slide fixture for every contract id, standing in for the registry's content. */
export const FIXTURE_REGISTRY: Readonly<Record<TutorialId, TutorialDefinition>> = Object.fromEntries([
    ...EMPLOYER_TUTORIAL_IDS.map((id) => [id, fixtureDefinition(id, 'employer', 3)] as const),
    ...WORKER_TUTORIAL_IDS.map((id) => [id, fixtureDefinition(id, 'worker', 3)] as const),
]) as Record<TutorialId, TutorialDefinition>;

const TITLES: Record<TutorialId, [string, string]> = {
    employer_welcome: ['Sample welcome tour', 'Recorrido de bienvenida'],
    employer_post_job: ['Sample posting tour', 'Recorrido de publicación'],
    employer_applicants: ['Sample applicants tour', 'Recorrido de postulantes'],
    employer_messages: ['Sample messages tour', 'Recorrido de mensajes'],
    worker_onboarding: ['Sample onboarding tour', 'Recorrido de registro'],
    worker_apply: ['Sample applying tour', 'Recorrido para postularte'],
    worker_details: ['Sample details tour', 'Recorrido de datos'],
    worker_profile: ['Sample profile tour', 'Recorrido de perfil'],
};

function slideMessages(locale: 'en' | 'es') {
    const step = locale === 'en' ? 'Step' : 'Paso';
    const body = locale === 'en' ? 'What step' : 'Qué explica el paso';
    return {
        s1: { title: `${step} one`, body: `${body} one shows.` },
        s2: { title: `${step} two`, body: `${body} two shows.` },
        s3: { title: `${step} three`, body: `${body} three shows.` },
    };
}

function namespaceMessages(locale: 'en' | 'es') {
    const entries = (Object.keys(TITLES) as TutorialId[]).map((id) => [
        id,
        { title: TITLES[id][locale === 'en' ? 0 : 1], ...slideMessages(locale) },
    ]);
    return Object.fromEntries(entries);
}

/** Merge into a catalogue: `{ ...en, ...FIXTURE_MESSAGES.en }`. */
export const FIXTURE_MESSAGES = {
    en: {
        fixture_tutorials: {
            ...namespaceMessages('en'),
            // A tutorial with its own last-button label (ruling R6) and a var.
            labelled: {
                title: 'Sample labelled tour',
                cta_last: 'Start',
                s1: { title: 'Plan line', body: 'Up to {limit} active jobs.' },
                s2: { title: 'Step two', body: 'What step two shows.' },
                s3: { title: 'Step three', body: 'What step three shows.' },
            },
        },
    },
    es: {
        fixture_tutorials: {
            ...namespaceMessages('es'),
            labelled: {
                title: 'Recorrido con botón propio',
                cta_last: 'Empezar',
                s1: { title: 'Línea del plan', body: 'Hasta {limit} empleos activos.' },
                s2: { title: 'Paso dos', body: 'Qué explica el paso dos.' },
                s3: { title: 'Paso tres', body: 'Qué explica el paso tres.' },
            },
        },
    },
} as const;

/** `employer_welcome` drawn from the `labelled` messages: its own last label and a `{limit}` var. */
export const LABELLED_FIXTURE = fixtureDefinition('employer_welcome', 'employer', 3, 'fixture_tutorials.labelled');

export function titleOf(id: TutorialId, locale: 'en' | 'es' = 'en'): string {
    return TITLES[id][locale === 'en' ? 0 : 1];
}
