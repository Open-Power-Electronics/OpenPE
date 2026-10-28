import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  devIndicators: false,
  logging: {
    incomingRequests: process.env.OPENPE_DEV_VERBOSE !== '0',
    browserToTerminal: 'warn',
  },
};
export default config;
