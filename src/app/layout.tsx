import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LendLoop — Borrow what you need. Lend what you don’t.",
  description:
    "Neighborhood tool-lending board with Clerk authentication, Convex RBAC backend, and HMAC-secured n8n workflow automation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}
