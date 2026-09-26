import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TeamsRelay",
  manifest: "/manifest.webmanifest",
  icons: { apple: "/static/icon-180.png", icon: "/static/icon-192.png" },
  appleWebApp: { capable: true, title: "TeamsRelay", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#5b5fc7",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
