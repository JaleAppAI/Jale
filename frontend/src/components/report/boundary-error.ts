/**
 * How a route error boundary describes what it caught, for the report
 * context's error list. The context module scrubs and shortens it; the digest
 * is the opaque id Next.js gives a server-side failure.
 */
export function describeBoundaryError(error: Error & { digest?: string }): string {
    const text = error.message || error.name || 'render error';
    return error.digest ? `${text} (digest ${error.digest})` : text;
}
