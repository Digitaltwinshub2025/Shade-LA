import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_CESIUM_ION_TOKEN: process.env.CESIUM_ION_TOKEN,
    NEXT_PUBLIC_CESIUM_BASE_URL: "/cesium",
  },
  turbopack: {},
  // Ensure these packages are resolved at runtime in Node, not bundled by Turbopack
  serverExternalPackages: [
    "rhino3dm",
    "ws",
    "@xmldom/xmldom",
    "osmtogeojson",
    "earcut",
    "jszip"
  ],
};

export default nextConfig;
