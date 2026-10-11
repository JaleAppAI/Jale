/**
 * PowerShell's expandable here-strings, rendered the way PowerShell renders
 * them, so a test can see the exact text a .ps1 script builds without a
 * PowerShell runtime (the tests never run .ps1 files; CI only parses them).
 *
 * Only what the scripts under test use is modelled: a backtick before `$`
 * (a literal dollar sign) and `$name` (the variable's value, inserted once,
 * as text: PowerShell never reads an inserted value again). Anything else, a
 * subexpression `$( )`, `${ }`, another escape, or a variable the caller did
 * not supply, throws. A gap in this renderer then fails the test instead of
 * hiding what the script would really produce.
 */

/** The body of the expandable here-string assigned to `$<variable>`, as the file holds it. */
export function hereStringBody(script: string, variable: string): string {
  const match = new RegExp(`^\\$${variable} = @"\\r?\\n([\\s\\S]*?)\\r?\\n"@`, 'm').exec(script);
  if (!match) throw new Error(`no expandable here-string is assigned to $${variable}`);
  return match[1];
}

/** The variables a here-string body inserts, by name, in order of first use. */
export function hereStringVariables(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(/(?<!`)\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** The text PowerShell builds from a here-string body, given its variables' values. */
export function expandHereString(body: string, variables: Record<string, string>): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '`') {
      if (body[i + 1] !== '$') throw new Error(`unmodelled escape at offset ${i}`);
      out += '$';
      i += 1;
    } else if (c === '$') {
      // PowerShell reads the longest name, so $EmailSql is never $Email + "Sql".
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i + 1))?.[0];
      if (name === undefined) throw new Error(`unmodelled $ construct at offset ${i}`);
      // `$name:` starts a scope or drive qualifier, which this renderer does not model.
      if (body[i + 1 + name.length] === ':') throw new Error(`unmodelled qualified variable at offset ${i}`);
      if (!Object.prototype.hasOwnProperty.call(variables, name)) {
        throw new Error(`the here-string inserts $${name}, which the caller did not supply`);
      }
      out += variables[name];
      i += name.length;
    } else {
      out += c;
    }
  }
  return out;
}
