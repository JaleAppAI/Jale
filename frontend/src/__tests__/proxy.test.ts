import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import proxy from '../proxy';

function requestFor(pathname: string): NextRequest {
  return new NextRequest(new URL(`https://jaleapp.ai${pathname}`));
}

describe('proxy', () => {
  it('passes /whatsapp straight through (NextResponse.next, no locale redirect)', () => {
    const res = proxy(requestFor('/whatsapp'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  // Control case: without the /whatsapp bypass this test itself would fail,
  // proving the assertions above actually distinguish next-intl's redirect
  // from a pass-through instead of passing trivially.
  it('307-redirects an unrelated top-level path to its locale-prefixed URL', () => {
    const res = proxy(requestFor('/some-unmapped-page'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/en\/some-unmapped-page$/);
  });

  it('still bypasses the existing public paths (sms-opt-in)', () => {
    const res = proxy(requestFor('/sms-opt-in'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
