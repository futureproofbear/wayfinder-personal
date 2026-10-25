import type { Metadata, Viewport } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

// System fonts only: Google Fonts is unreliable from mainland China.

export const metadata: Metadata = {
  title: "Wayfinder",
  description: "Map-first Asia trip planner",
  appleWebApp: { capable: true, title: "Wayfinder", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f766e",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
