import { isIP } from 'node:net';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { getHeader } from '../../lib/http';
import { hashVisitor } from '../../lib/referral-codes';

/**
 * The viewer address of a signed-out report, and its salted hash.
 *
 * The address comes only from the header the edge's viewer-request function
 * sets from the viewer's own address, overwriting anything the client sent.
 * Nothing here reads X-Forwarded-For or the source address. A request
 * without a well-formed address is refused by the caller.
 *
 * The salt lives in Secrets Manager, never in the environment, and is read
 * with a short cache. Unlike the job page's visitor salt, a missing or
 * unreadable salt THROWS: the rate limits key on this hash, so there is no
 * safe value to fall back to. The address, the salt and the hash are never
 * logged.
 */

export const VIEWER_ADDRESS_HEADER = 'x-jale-viewer-address';

const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

function ipv4Octets(text: string): number[] | undefined {
  if (isIP(text) !== 4) return undefined;
  return text.split('.').map((octet) => Number(octet));
}

/** The eight 16-bit groups of an IPv6 address, from any valid spelling. */
function ipv6Groups(text: string): number[] | undefined {
  let s = text;
  // An IPv4 tail (`::ffff:192.0.2.1`) becomes its two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = ipv4Octets(tail);
    if (!octets) return undefined;
    s = `${s.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;

  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!parts.every((part) => HEX_GROUP.test(part))) return undefined;
  return parts.map((part) => parseInt(part, 16));
}

/**
 * The key the per-address limits count against, from one viewer address:
 * an IPv4 address whole; an IPv4-mapped IPv6 address as its IPv4 address;
 * any other IPv6 address as its /64 prefix, written one way
 * (`2001:db8:0:0::/64`), because one IPv6 subscriber usually holds a whole
 * /64 and could otherwise step through it. Undefined for anything that is not
 * exactly one address. Never logged.
 */
export function viewerAddressKey(raw: string): string | undefined {
  const text = raw.trim();
  const version = isIP(text);
  if (version === 4) return text;
  if (version !== 6) return undefined;

  // A zone (`%eth0`) names a local interface, not part of the address.
  const groups = ipv6Groups(text.split('%')[0]);
  if (!groups) return undefined;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

/**
 * The rate-limit key for the viewer the edge named, or undefined when the
 * header is missing or not one address.
 */
export function readViewerAddress(event: APIGatewayProxyEvent): string | undefined {
  const raw = getHeader(event, VIEWER_ADDRESS_HEADER);
  return raw === undefined ? undefined : viewerAddressKey(raw);
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const smClient = new SecretsManagerClient({});
let cachedSalt: string | undefined;
let cachedAt = 0;

export async function getAddressSalt(): Promise<string> {
  if (cachedSalt !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSalt;

  const secretId = process.env.REPORT_ADDRESS_SALT_SECRET_ARN;
  if (!secretId) throw new Error('report_address_salt_not_configured');

  // A throw propagates without touching the cache, so a passing failure
  // does not stick to a warm container.
  const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = result.SecretString?.trim();
  if (!value) throw new Error('report_address_salt_empty');

  cachedSalt = value;
  cachedAt = Date.now();
  return value;
}

/** Test hook: clears the cached salt. */
export function clearAddressSaltCache(): void {
  cachedSalt = undefined;
  cachedAt = 0;
}

/**
 * The visitor-hash construction with a fixed user-agent slot, so only the
 * address key (from viewerAddressKey) varies.
 */
export function hashAddress(salt: string, addressKey: string): string {
  return hashVisitor(salt, addressKey, 'reports');
}
