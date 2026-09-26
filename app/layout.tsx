import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL || "http://localhost:5173"),
  title: "Agent Command Center",
  description:
    "A secure control plane for agent intake, orchestration, approvals and auditability.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Agent Command Center",
    description: "Secure orchestration. Human-controlled execution.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1792,
        height: 1024,
        alt: "Agent Command Center secure orchestration control plane",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Command Center",
    description: "Secure orchestration. Human-controlled execution.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
