import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg — серверная библиотека, в клиентский бандл её тащить не надо.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
