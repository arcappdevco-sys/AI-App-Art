import type { NextConfig } from "next";

const desktopBuild = process.env.FAL_FLOW_DESKTOP === "1";

const nextConfig: NextConfig = {
  output: desktopBuild ? "standalone" : undefined,
  env: {
    NEXT_PUBLIC_FAL_FLOW_DESKTOP: desktopBuild ? "1" : "0",
  },
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    proxyClientMaxBodySize: "512mb",
  },
};

export default nextConfig;
