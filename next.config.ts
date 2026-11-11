import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits `.next/standalone` (a minimal server + traced node_modules) for the Cloud Run image.
  output: 'standalone',
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
