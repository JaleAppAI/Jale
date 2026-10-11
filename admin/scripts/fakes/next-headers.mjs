// Fake for next/headers in the admin check scripts. Cookies come from
// globalThis.__adminCheck.cookies (a Map of name -> value).
export async function cookies() {
  const jar = globalThis.__adminCheck?.cookies ?? new Map();
  return {
    get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name, value) => { jar.set(name, value); },
  };
}

export async function headers() {
  return new Headers(globalThis.__adminCheck?.headers ?? {});
}
