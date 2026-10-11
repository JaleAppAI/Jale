/**
 * Helpers for the audit stack tests: render CloudFormation intrinsics as
 * readable strings, so a pinned policy reads like the policy it is.
 *
 *   {"Fn::Join": ["", ["arn:", {"Ref": "AWS::Partition"}, ":iam::", ...]]}
 *     -> "arn:${AWS::Partition}:iam::..."
 *   {"Ref": "SomeLogicalId"}          -> "${SomeLogicalId}"
 *   {"Fn::GetAtt": ["Id", "Arn"]}     -> "${Id.Arn}"
 *   {"Fn::ImportValue": "Stack:Name"} -> "${import:Stack:Name}"
 */

type Json = any;

export function flatten(value: Json): Json {
  if (Array.isArray(value)) return value.map(flatten);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const [key] = keys;
      const arg = value[key];
      if (key === 'Fn::Join') return (arg[1] as Json[]).map((part) => String(flatten(part))).join(arg[0]);
      if (key === 'Ref') return `\${${arg}}`;
      if (key === 'Fn::GetAtt') return `\${${arg[0]}.${arg[1]}}`;
      if (key === 'Fn::ImportValue') return `\${import:${flatten(arg)}}`;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flatten(v)]));
  }
  return value;
}

/** Every resource of `type` in a template, flattened, keyed by logical id. */
export function resourcesOf(template: Json, type: string): Record<string, Json> {
  return Object.fromEntries(
    Object.entries(template.Resources ?? {})
      .filter(([, r]: [string, Json]) => r.Type === type)
      .map(([id, r]) => [id, flatten(r)]),
  );
}

/** The single resource of `type`, flattened. */
export function onlyResource(template: Json, type: string): Json {
  const found = Object.values(resourcesOf(template, type));
  if (found.length !== 1) throw new Error(`expected one ${type}, found ${found.length}`);
  return found[0];
}

/** A statement list as an array, statements' single values normalised to arrays for comparison. */
export function statements(document: Json): Json[] {
  return [document.Statement].flat();
}

/** A policy pattern (`*` and `?` wildcards) as a whole-string match. */
export function wildcard(pattern: string, value: string): boolean {
  const source = pattern.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${source}$`).test(value);
}

export interface S3Request {
  principalArn: string | undefined;
  action: string;
  resource: string;
  secureTransport?: boolean;
  /** Whether the request carries an If-None-Match header (the `s3:if-none-match` key). */
  ifNoneMatch?: boolean;
}

/**
 * Whether a bucket policy explicitly denies the request: the evaluation an
 * explicit Deny gets, for the statement shapes the audit stacks write. Any
 * other condition fails the test rather than being read as not matching.
 */
export function explicitlyDenied(policy: Json, request: S3Request): boolean {
  return statements(policy.Properties.PolicyDocument).some((s: Json) => {
    if (s.Effect !== 'Deny') return false;
    if (JSON.stringify(s.Principal) !== JSON.stringify({ AWS: '*' })) throw new Error(`unexpected principal in ${s.Sid}`);
    if (![s.Action].flat().some((a: string) => wildcard(a, request.action))) return false;
    if (![s.Resource].flat().some((r: string) => wildcard(r, request.resource))) return false;
    return Object.entries(s.Condition ?? {}).every(([operator, block]: [string, Json]) => Object.entries(block).every(([key, value]) => {
      if (operator === 'Bool' && key === 'aws:SecureTransport') return String(request.secureTransport ?? true) === String(value);
      // A negated operator matches when the key is absent.
      if (operator === 'ArnNotEquals' && key === 'aws:PrincipalArn') return request.principalArn === undefined || request.principalArn !== value;
      // Null true matches a request without the key; Null false, one with it.
      if (operator === 'Null' && key === 's3:if-none-match') return String(!request.ifNoneMatch) === String(value);
      throw new Error(`unexpected condition ${operator} ${key} in ${s.Sid}`);
    }));
  });
}
