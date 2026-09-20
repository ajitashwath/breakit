import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright drives a real browser and ships native helpers; it must be
  // required at runtime, never bundled.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
