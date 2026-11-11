/**
 * Server-Side Request Forgery (SSRF) defences for the image proxy.
 *
 * The proxy fetches URLs that come straight out of a customer's spreadsheet. Without these checks
 * anyone could make our server fetch `http://169.254.169.254/…` (the Cloud Run metadata server,
 * which hands out the service account's access tokens) or probe private networks.
 *
 * Three independent layers, each sufficient for the cases it covers:
 *   1. `assertSafeUrl`        — rejects bad schemes, ports, credentials and obviously internal
 *                               hosts before any network activity.
 *   2. `createGuardedLookup`  — replaces DNS resolution for the outgoing socket. The connection is
 *                               made to the exact addresses that were checked, which defeats DNS
 *                               rebinding (a name that resolves to a public IP when checked and
 *                               to a private one when connected).
 *   3. `safe-fetch.ts` re-checks the socket's real remote address before reading a response and
 *      re-runs layer 1 on every redirect.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { ProxyError } from './errors';

/** IANA special-purpose IPv4 ranges: nothing in here is a legitimate public image host. */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes the cloud metadata server
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // deprecated 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
];

/**
 * Special-purpose ranges INSIDE the IPv6 global unicast block (2000::/3). Everything outside
 * 2000::/3 is rejected wholesale by `isPublicIp`, so loopback, unique-local (fc00::/7),
 * link-local (fe80::/10) and multicast need no entries here.
 */
const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 — embeds an arbitrary IPv4 address
  ['3fff::', 20], // documentation
];

const ipv4Blocklist = new BlockList();
for (const [prefix, bits] of BLOCKED_IPV4) ipv4Blocklist.addSubnet(prefix, bits, 'ipv4');

const ipv6Blocklist = new BlockList();
for (const [prefix, bits] of BLOCKED_IPV6) ipv6Blocklist.addSubnet(prefix, bits, 'ipv6');

/** Expands an IPv6 literal into its eight 16-bit groups, or `null` if it is not valid. */
function expandIpv6(address: string): number[] | null {
  let text = address;

  // A dotted IPv4 tail ("::ffff:192.0.2.1") occupies the last two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => parseInt(g, 16));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...new Array<number>(Math.max(0, missing)).fill(0), ...rest];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * Some IPv6 forms are just an IPv4 address in disguise. Returns that IPv4 address so it can be
 * judged by the IPv4 rules; otherwise `null`.
 */
function embeddedIpv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const dotted = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  const leadingZeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (leadingZeros && g5 === 0xffff) return dotted; // ::ffff:a.b.c.d  (IPv4-mapped)
  if (leadingZeros && g5 === 0) return dotted; // ::a.b.c.d       (IPv4-compatible, incl. :: and ::1)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return dotted; // NAT64
  return null;
}

/**
 * True only for addresses on the public internet. Anything unparseable is treated as not public.
 */
export function isPublicIp(rawAddress: string): boolean {
  // Drop an IPv6 zone id ("fe80::1%eth0"); zoned addresses are link-local and rejected below anyway.
  const address = rawAddress.split('%')[0] ?? '';
  const family = isIP(address);

  if (family === 4) return !ipv4Blocklist.check(address, 'ipv4');
  if (family !== 6) return false;

  const groups = expandIpv6(address);
  if (!groups) return false;

  const ipv4 = embeddedIpv4(groups);
  if (ipv4 !== null) return !ipv4Blocklist.check(ipv4, 'ipv4');

  const isGlobalUnicast = ((groups[0] ?? 0) & 0xe000) === 0x2000; // 2000::/3
  return isGlobalUnicast && !ipv6Blocklist.check(address, 'ipv6');
}

/** Name suffixes that never belong to a public host. DNS checks still apply to everything else. */
const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'corp',
  'home.arpa',
  'onion',
];

function blocked(reason: string): ProxyError {
  return new ProxyError('BLOCKED_DESTINATION', `This image address is not allowed (${reason}).`);
}

/**
 * Validates everything about a URL that can be judged without touching the network. Throws
 * `ProxyError` when the URL must not be fetched. Call it on the initial URL and on every redirect.
 */
export function assertSafeUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError('INVALID_URL', 'Only http and https image links are supported.');
  }
  if (url.username !== '' || url.password !== '') {
    throw blocked('links with embedded credentials');
  }
  // The WHATWG URL parser leaves `port` empty for the scheme's default port.
  if (url.port !== '') {
    throw blocked('non-standard port');
  }

  // `hostname` is already lower-cased and IPv4 shorthand (0x7f.1, 2130706433) is already
  // normalised to dotted form by the URL parser. IPv6 literals keep their brackets.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === '') throw new ProxyError('INVALID_URL', 'The image link has no host name.');

  if (isIP(hostname) !== 0) {
    if (!isPublicIp(hostname)) throw blocked('private or reserved address');
    return;
  }

  if (!hostname.includes('.')) throw blocked('not a public host name');
  if (INTERNAL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw blocked('internal host name');
  }
}

type DnsResolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A drop-in replacement for the `lookup` option of `http(s).request`. It resolves the host name
 * and refuses unless EVERY resolved address is public — a name that answers with one public and
 * one private address is an attack, not a load balancer.
 *
 * Node skips `lookup` entirely for IP-literal hosts; those are covered by `assertSafeUrl`.
 */
export function createGuardedLookup(
  resolve: DnsResolver = dnsLookup as DnsResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (addresses.length === 0 || addresses.some((entry) => !isPublicIp(entry.address))) {
        callback(blocked('host resolves to a private or reserved address'), '', 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        const first = addresses[0] as LookupAddress;
        callback(null, first.address, first.family);
      }
    });
  };
}
