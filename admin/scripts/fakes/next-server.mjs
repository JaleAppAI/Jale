// Fake for next/server in the admin check scripts: enough of NextResponse
// for route handlers to build JSON responses and set cookies, and for the
// proxy to pass a request on (with its forwarded headers) or redirect it.
export class NextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    const cookieSets = [];
    this.cookieSets = cookieSets;
    this.cookies = {
      set: (name, value, options) => { cookieSets.push({ name, value, options }); },
    };
  }

  static json(body, init) {
    return new NextResponse(body, init);
  }

  // `init.request.headers` are the request headers a proxy forwards to the
  // page; the fake keeps them on `requestHeaders`.
  static next(init) {
    const response = new NextResponse(undefined);
    response.requestHeaders = init?.request?.headers;
    return response;
  }

  static redirect(url, status = 307) {
    const response = new NextResponse(undefined, { status });
    response.redirectTo = String(url);
    return response;
  }
}
