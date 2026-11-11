/**
 * Test support: a throwaway HTTP origin on localhost, and a network policy that allows exactly
 * that origin while applying the real SSRF rules to everything else. (Test-only; never imported
 * by application code.)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { STRICT_NETWORK_POLICY, type NetworkPolicy } from '@/lib/image-proxy/safe-fetch';

/** A valid 1×1 PNG. */
export const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void;

export interface TestOrigin {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** Allows this origin only; everything else is judged by the production rules. */
  policy: NetworkPolicy;
  /** Paths requested so far, in order. */
  requests: string[];
  close(): Promise<void>;
}

export async function startTestOrigin(routes: Record<string, RouteHandler>): Promise<TestOrigin> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    requests.push(path);
    const handler = routes[path];
    if (handler) handler(request, response);
    else response.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;

  const policy: NetworkPolicy = {
    assertUrl(url) {
      if (url.host !== host) STRICT_NETWORK_POLICY.assertUrl(url);
    },
    lookup: STRICT_NETWORK_POLICY.lookup,
    isAllowedAddress: (address) =>
      address === '127.0.0.1' || STRICT_NETWORK_POLICY.isAllowedAddress(address),
  };

  return {
    url: `http://${host}`,
    policy,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
