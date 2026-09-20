import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright drives a real browser; it must be required at runtime, never bundled.
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  // On Vercel there is no installed browser, so the run route ships a compressed
  // Chromium build (@sparticuz/chromium) and unpacks it to /tmp on cold start.
  // Its binaries are loaded by path at runtime, which file tracing can't see,
  // so they are listed explicitly.
  outputFileTracingIncludes: {
    "/api/run": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
