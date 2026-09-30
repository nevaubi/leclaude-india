import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Heavy document libraries run on the Node runtime and must not be bundled by webpack.
  serverExternalPackages: ["pdfjs-dist", "mammoth", "docx", "pptxgenjs", "jszip", "hyperformula", "xlsx"],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
  // LeClaude India hides e-discovery (src/lib/features.ts): its links land on the matter's document sets. The query
  // string (?matter=…) is carried over by Next.
  async redirects() {
    if (process.env.NEXT_PUBLIC_ENABLE_EDISCOVERY === "1") return [];
    return [{ source: "/ediscovery", destination: "/documents", permanent: false }];
  },
  webpack: (config) => {
    // pdf.js / mermaid ship optional node-only deps that webpack should ignore on the client.
    config.resolve.fallback = { ...(config.resolve.fallback ?? {}), canvas: false, fs: false, path: false };
    return config;
  },
};

export default nextConfig;
