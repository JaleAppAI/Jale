import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * The sprint-23 application-stage vocabulary (`details_requested`, plus the
 * short worker-facing labels a list row can fit) in both locales.
 *
 * `messages-parity` only catches a key present in ONE locale and missing from
 * the other -- it says nothing when a key is missing from BOTH, which is the
 * exact failure mode of a renamed/typo'd path. This enumerates every path
 * this wave adds and resolves each against both trees.
 */

type MessageNode = string | { [key: string]: MessageNode };

function resolve(tree: MessageNode, path: string): string | undefined {
    const segments = path.split('.');
    let node: MessageNode = tree;
    for (const segment of segments) {
        if (typeof node === 'string') return undefined;
        if (!(segment in node)) return undefined;
        node = node[segment];
    }
    return typeof node === 'string' ? node : undefined;
}

/** Every application status, in `lib/status.ts` order. */
const APPLICATION_STATUSES = [
    'pending',
    'contacted',
    'talking',
    'details_requested',
    'hired',
    'not_interested',
] as const;

/** Every leaf path under `tree`, dotted and prefixed. */
function leafPaths(tree: MessageNode, prefix: string): string[] {
    if (typeof tree === 'string') return [prefix];
    return Object.entries(tree).flatMap(([key, child]) => leafPaths(child, `${prefix}.${key}`));
}

/**
 * The namespaces this wave owns outright, walked rather than hand-listed.
 *
 * The pinned size is the whole point of the pair: without it, deleting a key
 * from `en.json` silently shrinks ADDED_KEY_PATHS and every other assertion
 * in this file still passes.
 */
const WALKED_NAMESPACE_SIZES: Record<string, number> = {
    worker_application_details: 72,
    'worker_applications.details_banner': 9,
    'worker_job_detail.apply_flow': 14,
    'worker_job_detail.what_you_need': 19,
};

const enRoot = en as MessageNode as Record<string, MessageNode>;
const enWorkerApplications = enRoot.worker_applications as Record<string, MessageNode>;
const enWorkerJobDetail = enRoot.worker_job_detail as Record<string, MessageNode>;

const WALKED_NAMESPACES: readonly (readonly [MessageNode, string])[] = [
    [enRoot.worker_application_details, 'worker_application_details'],
    [enWorkerApplications.details_banner, 'worker_applications.details_banner'],
    [enWorkerJobDetail.apply_flow, 'worker_job_detail.apply_flow'],
    [enWorkerJobDetail.what_you_need, 'worker_job_detail.what_you_need'],
];

const ADDED_KEY_PATHS = [
    'employer_dashboard.applicants.status.details_requested',
    'worker_applications.status.details_requested',
    // The whole short block is new, not just the new status: a partially
    // populated `status_short` would fall back to the key path for the five
    // statuses nobody remembered to add.
    ...APPLICATION_STATUSES.map((status) => `worker_applications.status_short.${status}`),

    // Wave 3/4 -- the worker-side stage-1 and stage-2 surfaces. Enumerated by
    // WALKING the English tree rather than by hand: these four namespaces are
    // wholly owned by this sprint, so every leaf in them is a key this wave
    // added, and a hand-written list would drift the first time one is renamed.
    //
    // The walk makes the `en.json` assertion below TAUTOLOGICAL for these four
    // (the list is derived from the tree it is checked against), so it buys
    // nothing on its own -- it earns its keep via the es.json half and via
    // WALKED_NAMESPACE_SIZES, which restores the "a planned key went missing"
    // guard this file exists for. Update a count only alongside the key change
    // that moved it.
    ...WALKED_NAMESPACES.flatMap(([tree, prefix]) => leafPaths(tree, prefix)),
];

describe('application-stage message keys', () => {
    it.each(ADDED_KEY_PATHS)('resolves %s in en.json', (path) => {
        expect(resolve(en as MessageNode, path), `missing en key: ${path}`).toBeTruthy();
    });

    it.each(ADDED_KEY_PATHS)('resolves %s in es.json', (path) => {
        expect(resolve(es as MessageNode, path), `missing es key: ${path}`).toBeTruthy();
    });

    it('has a long and a short worker label for every application status', () => {
        for (const status of APPLICATION_STATUSES) {
            for (const tree of [en, es] as MessageNode[]) {
                expect(resolve(tree, `worker_applications.status.${status}`)).toBeTruthy();
                expect(resolve(tree, `worker_applications.status_short.${status}`)).toBeTruthy();
            }
        }
    });

    it.each(WALKED_NAMESPACES)('%s still has the leaf count this wave added', (tree, prefix) => {
        // Guards the tautology above: ADDED_KEY_PATHS is derived from en.json,
        // so only a pinned count can notice a key that was deleted rather than
        // renamed. A rename keeps the count and is caught by the es.json half.
        expect(leafPaths(tree, prefix)).toHaveLength(WALKED_NAMESPACE_SIZES[prefix]);
    });

    it('has an employer applicant label for every application status', () => {
        for (const status of APPLICATION_STATUSES) {
            for (const tree of [en, es] as MessageNode[]) {
                expect(resolve(tree, `employer_dashboard.applicants.status.${status}`)).toBeTruthy();
            }
        }
    });
});
