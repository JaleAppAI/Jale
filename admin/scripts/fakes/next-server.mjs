// Fake for next/server in the admin check scripts: enough of NextResponse
// for route handlers to build JSON responses and set cookies.
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

  static next() {
    return new NextResponse(undefined);
  }

  static redirect(url, status = 307) {
    const response = new NextResponse(undefined, { status });
    response.redirectTo = String(url);
    return response;
  }
}
