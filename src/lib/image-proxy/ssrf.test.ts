import type { LookupAddress } from 'node:dns';

import { describe, expect, it } from 'vitest';

import { ProxyError } from './errors';
import { assertSafeUrl, createGuardedLookup, isPublicIp } from './ssrf';

describe('isPublicIp', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '142.250.183.14',
    '172.15.255.255', // just below the 172.16/12 private block
    '172.32.0.1', // just above it
    '100.63.255.255', // just below carrier-grade NAT
    '2001:4860:4860::8888', // Google DNS
    '2404:6800:4009:80a::200e',
    '::ffff:8.8.8.8', // IPv4-mapped public address
    '64:ff9b::808:808', // NAT64 of 8.8.8.8
  ])('allows public address %s', (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  it.each([
    ['0.0.0.0', 'unspecified'],
    ['10.1.2.3', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'cloud metadata server'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata server'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['64:ff9b::7f00:1', 'NAT64 of loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of the metadata server'],
    ['fc00::1', 'unique local'],
    ['fd20:ce::254', 'GCP metadata server over IPv6'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone id'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::', '6to4 wrapping loopback'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['100::1', 'discard-only'],
  ])('blocks %s (%s)', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it('treats anything that is not an IP address as not public', () => {
    expect(isPublicIp('')).toBe(false);
    expect(isPublicIp('example.com')).toBe(false);
    expect(isPublicIp('1.2.3')).toBe(false);
    expect(isPublicIp('::ffff:999.1.1.1')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  const check = (url: string) => () => assertSafeUrl(new URL(url));

  it('allows ordinary public image URLs', () => {
    expect(check('https://example.com/photos/a.jpg')).not.toThrow();
    expect(check('http://cdn.school.edu.in/img.png?x=1')).not.toThrow();
    expect(check('https://8.8.8.8/a.png')).not.toThrow();
    expect(check('https://[2001:4860:4860::8888]/a.png')).not.toThrow();
  });

  it.each([
    'ftp://example.com/a.jpg',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'gopher://example.com/',
  ])('rejects the scheme of %s', (url) => {
    expect(check(url)).toThrow(ProxyError);
  });

  it.each([
    ['http://127.0.0.1/', 'loopback'],
    ['http://localhost/', 'localhost'],
    ['http://LOCALHOST/', 'localhost, upper case'],
    ['http://app.localhost/', 'localhost subdomain'],
    ['http://169.254.169.254/computeMetadata/v1/', 'metadata IP'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'metadata host name'],
    ['http://metadata/', 'single-label host'],
    ['http://printer.local/', 'mDNS name'],
    ['http://192.168.0.10/photo.jpg', 'private network'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[fd00::1]/', 'unique local'],
    // Alternative spellings of 127.0.0.1 that the URL parser normalises:
    ['http://2130706433/', 'decimal integer'],
    ['http://0x7f000001/', 'hex integer'],
    ['http://0177.0.0.1/', 'octal'],
    ['http://127.1/', 'shorthand'],
    ['http://example.com:8080/a.jpg', 'non-standard port'],
    ['https://example.com:22/', 'ssh port'],
    ['https://user:pass@example.com/a.jpg', 'embedded credentials'],
  ])('blocks %s (%s)', (url) => {
    expect(check(url)).toThrow(ProxyError);
  });

  it('reports blocked destinations with the BLOCKED_DESTINATION code', () => {
    try {
      assertSafeUrl(new URL('http://10.0.0.1/'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProxyError);
      expect((error as ProxyError).code).toBe('BLOCKED_DESTINATION');
      expect((error as ProxyError).status).toBe(403);
    }
  });

  it('accepts a fully-qualified host name written with a trailing dot', () => {
    expect(check('https://example.com./a.jpg')).not.toThrow();
    expect(check('http://localhost./')).toThrow(ProxyError);
  });
});

describe('createGuardedLookup', () => {
  function lookupWith(addresses: LookupAddress[]) {
    const lookup = createGuardedLookup((_hostname, _options, callback) =>
      callback(null, addresses),
    );
    return (all: boolean) =>
      new Promise<{ error: Error | null; address: unknown }>((resolve) => {
        lookup('images.example.com', { all }, (error, address) => resolve({ error, address }));
      });
  }

  it('passes through names that resolve only to public addresses', async () => {
    const run = lookupWith([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    expect((await run(true)).address).toHaveLength(2);
    expect((await run(false)).address).toBe('93.184.216.34');
  });

  it('blocks a name that resolves to a private address (DNS rebinding)', async () => {
    const { error } = await lookupWith([{ address: '169.254.169.254', family: 4 }])(true);
    expect(error).toBeInstanceOf(ProxyError);
    expect((error as ProxyError).code).toBe('BLOCKED_DESTINATION');
  });

  it('blocks when even one of several addresses is private', async () => {
    const { error } = await lookupWith([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])(true);
    expect(error).toBeInstanceOf(ProxyError);
  });

  it('blocks an empty answer', async () => {
    const { error } = await lookupWith([])(true);
    expect(error).toBeInstanceOf(ProxyError);
  });

  it('forwards resolver failures unchanged', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const lookup = createGuardedLookup((_h, _o, callback) => callback(failure, []));
    const error = await new Promise((resolve) =>
      lookup('nope.example.com', { all: true }, resolve),
    );
    expect(error).toBe(failure);
  });
});
