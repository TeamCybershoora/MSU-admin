import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the dev-mode on-screen indicator.
  devIndicators: false,

  // Restore Default reads the bundled default photographs from
  // public/leadership-defaults at request time. Files under public/ are normally
  // served from the CDN and not traced into a serverless function, so include
  // them explicitly for that route.
  outputFileTracingIncludes: {
    "/api/admin/leadership/restore": ["./public/leadership-defaults/**/*"],
  },
};

export default nextConfig;
