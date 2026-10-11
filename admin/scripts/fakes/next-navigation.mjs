// Fake for next/navigation in the admin check scripts: redirect() and
// notFound() throw marked errors, as the real ones do. The client hooks
// return stand-ins, so a client component renders with react-dom/server; the
// router records what it was asked to do in globalThis.__adminCheck.navigation.
export function redirect(url) {
  throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { redirectTo: url });
}

export function permanentRedirect(url) {
  throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { redirectTo: url, permanent: true });
}

export function notFound() {
  throw Object.assign(new Error('NEXT_NOT_FOUND'), { notFound: true });
}

export function useRouter() {
  const check = (globalThis.__adminCheck ??= {});
  const calls = (check.navigation ??= []);
  return {
    push: (href) => { calls.push(['push', href]); },
    replace: (href) => { calls.push(['replace', href]); },
    refresh: () => { calls.push(['refresh']); },
    back: () => { calls.push(['back']); },
    forward: () => { calls.push(['forward']); },
    prefetch: () => {},
  };
}

export function usePathname() {
  return globalThis.__adminCheck?.pathname ?? '/';
}
