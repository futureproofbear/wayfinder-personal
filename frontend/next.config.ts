import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Plain static files in out/, so it can be hosted anywhere (Vercel,
  // Netlify, GitHub Pages, any web server).
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
