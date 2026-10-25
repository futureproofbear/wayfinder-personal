import type { NextConfig } from "next";

// Set BASE_PATH when the site is served from a sub-path, e.g.
// BASE_PATH=/wayfinder-personal for GitHub Pages.
const basePath = process.env.BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Plain static files in out/, so it can be hosted anywhere (Vercel,
  // Netlify, GitHub Pages, any web server).
  output: "export",
  images: { unoptimized: true },
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
