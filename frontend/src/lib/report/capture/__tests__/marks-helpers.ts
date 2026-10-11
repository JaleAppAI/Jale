import { classifyNode } from '../mask';

/** True when a report screenshot hides this element: it or an ancestor is masked or excluded. */
export function isMaskedForCapture(el: Element): boolean {
    for (let node: Element | null = el; node; node = node.parentElement) {
        const kind = classifyNode(node);
        if (kind === 'private' || kind === 'exclude' || kind === 'field' || kind === 'media') return true;
    }
    return false;
}
