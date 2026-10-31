import type { NextConfig } from 'next';
const config: NextConfig = { serverExternalPackages: ['mongodb'], experimental: { serverActions: { bodySizeLimit: '4mb' } } };
export default config;
