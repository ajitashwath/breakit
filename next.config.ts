import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright drives a real browser; it must be required at runtime, never bundled.
  //
  // `npm run build` uses webpack on purpose. Turbopack loads external packages
  // through hashed symlinks (.next/node_modules/playwright-core-<hash>) that point
  // at absolute build-machine paths; in a deployed function the route then fails
  // to load ("Cannot find package 'playwright-core-<hash>'") and every request,
  // even ones that never start a browser, returns an empty 500. Webpack emits a
  // plain require and the traced files are self-contained.
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  // On Vercel there is no installed browser, so the run route ships a compressed
  // Chromium build (@sparticuz/chromium) and unpacks it to /tmp on cold start.
  // Its binaries are loaded by path at runtime, which file tracing can't see,
  // so they are listed explicitly. The same goes for playwright-core: it builds
  // the path to its own browsers.json at runtime, and a deployed function died
  // with "Cannot find module .../playwright-core/browsers.json" when the trace
  // missed it. The whole package is only ~14 MB.
  outputFileTracingIncludes: {
    "/api/run": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      "./node_modules/playwright-core/**/*",
    ],
  },
};

export default nextConfig;
