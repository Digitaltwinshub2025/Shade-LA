/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_CESIUM_ION_TOKEN: process.env.CESIUM_ION_TOKEN,
    NEXT_PUBLIC_CESIUM_BASE_URL: '/cesium'
  },
  turbopack: {},
  serverExternalPackages: [
    'rhino3dm',
    'ws',
    '@xmldom/xmldom',
    'osmtogeojson',
    'earcut',
    'jszip'
  ]
};

export default nextConfig;
