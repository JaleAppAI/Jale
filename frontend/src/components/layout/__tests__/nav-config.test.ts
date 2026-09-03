import { describe, expect, it } from 'vitest';
import {
    employerBillingNav,
    employerMobileNav,
    employerPrimaryNav,
    employerSettingsNav,
    isNavItemActive,
    workerPrimaryNav,
    type NavItem,
} from '@/components/layout/nav-config';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Nav labels resolve through `t(item.labelKey)` — a dynamic key. Nothing in the
 * catalogue, the type system or a grep can tell you that one of these keys was
 * renamed or pruned; the first sign would be a raw key path rendered in the tab
 * bar. So the keys are asserted here, against both real catalogues, in the two
 * namespaces the two roles actually read from (verified split: employer labels
 * come from `employer_dashboard`, worker labels from `header`).
 */

function resolve(tree: unknown, path: string): unknown {
    return path
        .split('.')
        .reduce<unknown>(
            (node, part) =>
                node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
            tree,
        );
}

/** Looks up a nav item by `key` instead of a positional index, so inserting
 *  a new primary-nav entry doesn't silently shift what an existing assertion
 *  is actually testing. */
function requireNavItem(items: NavItem[], key: string): NavItem {
    const item = items.find((candidate) => candidate.key === key);
    if (!item) throw new Error(`no nav item with key "${key}"`);
    return item;
}

function expectLabelsResolve(items: NavItem[], namespace: string) {
    for (const [locale, tree] of [
        ['en', en],
        ['es', es],
    ] as const) {
        for (const item of items) {
            const value = resolve(tree, `${namespace}.${item.labelKey}`);
            expect(
                typeof value === 'string' && value.length > 0,
                `${locale}: ${namespace}.${item.labelKey} (nav item "${item.key}")`,
            ).toBe(true);
        }
    }
}

describe('nav label keys', () => {
    it('resolves every employer sidebar label under employer_dashboard', () => {
        expectLabelsResolve(
            [...employerPrimaryNav, employerBillingNav, employerSettingsNav],
            'employer_dashboard',
        );
    });

    it('resolves every employer tab-bar label under employer_dashboard', () => {
        expectLabelsResolve(employerMobileNav, 'employer_dashboard');
    });

    it('resolves every worker label under header', () => {
        expectLabelsResolve(workerPrimaryNav, 'header');
    });
});

describe('employerMobileNav', () => {
    it('is the sidebar items minus sidebar-only entries, reused rather than re-declared', () => {
        // Templates is a management surface, not a daily destination, and
        // applicants is a deep-dive view of data the dashboard/messages tabs
        // already surface day to day -- both stay sidebar-only so the bar
        // keeps to its four-tab ceiling.
        expect(employerMobileNav).toEqual([
            ...employerPrimaryNav.filter((item) => item.key !== 'templates' && item.key !== 'applicants'),
            employerBillingNav,
            employerSettingsNav,
        ]);
    });

    it('gives an employer on a phone a route to dashboard, messages, billing and settings', () => {
        expect(employerMobileNav.map((item) => item.key)).toEqual([
            'dashboard',
            'messages',
            'billing',
            'settings',
        ]);
    });

    it('points settings at the employer profile page', () => {
        expect(employerSettingsNav.href).toBe('/employer/profile');
    });

    it('stays inside the employer area', () => {
        for (const item of employerMobileNav) {
            expect(item.href.startsWith('/employer/')).toBe(true);
        }
    });
});

describe('isNavItemActive on the employer tabs', () => {
    it('marks dashboard active only on an exact match', () => {
        expect(isNavItemActive(employerPrimaryNav[0], '/employer/dashboard')).toBe(true);
        expect(isNavItemActive(employerPrimaryNav[0], '/employer/dashboard/anything')).toBe(false);
    });

    it('marks messages active on its own subtree', () => {
        const messagesTab = requireNavItem(employerPrimaryNav, 'messages');
        expect(isNavItemActive(messagesTab, '/employer/conversations')).toBe(true);
        expect(isNavItemActive(messagesTab, '/employer/conversations/abc')).toBe(true);
        expect(isNavItemActive(messagesTab, '/employer/dashboard')).toBe(false);
    });

    it('does not mark settings active on an unrelated employer page', () => {
        expect(isNavItemActive(employerSettingsNav, '/employer/profile')).toBe(true);
        expect(isNavItemActive(employerSettingsNav, '/employer/billing')).toBe(false);
        expect(isNavItemActive(employerBillingNav, '/employer/billing')).toBe(true);
    });

    it('never marks two tabs active on the same path', () => {
        const paths = [
            '/employer/dashboard',
            '/employer/conversations',
            '/employer/billing',
            '/employer/profile',
        ];
        for (const path of paths) {
            const active = employerMobileNav.filter((item) => isNavItemActive(item, path));
            expect(active.length, `${path} -> ${active.map((i) => i.key).join(', ')}`).toBe(1);
        }
    });
});
