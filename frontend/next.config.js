/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow @babel/standalone (large ESM bundle) without issues
  webpack: (config) => {
    config.resolve.fallback = { fs: false, path: false };
    return config;
  },
};

module.exports = nextConfig;
