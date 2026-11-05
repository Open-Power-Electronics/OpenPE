import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  devIndicators: false,
  logging: {
    incomingRequests: process.env.OPENPE_DEV_VERBOSE !== '0',
    browserToTerminal: 'warn',
  },
};
export default async function nextConfig(phase: string): Promise<NextConfig> {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return config;
  const { browserPreviewServer } = await import('./server/browser-previews.mjs');
  const previews = await browserPreviewServer();
  return {
    ...config,
    output: undefined,
    rewrites: async () => [
      {
        source: '/api/browser-preview/:path*',
        destination: `${previews.base}/api/browser-preview/:path*`,
      },
    ],
  };
}
