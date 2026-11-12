import 'server-only';

import { cache } from 'react';

/**
 * The time the current request started being rendered, the same for every component of the
 * request (memoised per request). Only call after dynamic data (cookies) has been accessed.
 */
export const requestTime = cache((): number => Date.now());
