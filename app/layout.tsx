import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Tenbin: explainable practice trades on RYO-CHAN",
  description: "A buy-the-dip practice agent that weighs live RYO evidence, lets a free model red-team every pick, and seals each decision in a hash-chained receipt.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="top">
          <a href="/" className="brand" aria-label="Tenbin home">
            <span aria-hidden="true">⚖</span> Tenbin <small>天秤</small>
          </a>
          <nav aria-label="Primary">
            <a href="/">Dashboard</a>
            <a href="/api/health">Health JSON</a>
            <a href="/api/verify">Verify chain</a>
            <a href="https://github.com/dukemawex/tenbin-ryo-agent">Source</a>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="foot">
          Practice trades only. Tenbin never buys, sells or moves assets; RYO&apos;s research tools are read-only. Not financial advice.
        </footer>
      </body>
    </html>
  );
}
