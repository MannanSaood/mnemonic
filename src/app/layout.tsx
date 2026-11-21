import type { Metadata } from "next";
import Link from "next/link";
import { Bricolage_Grotesque, Martian_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { PrefsProvider } from "@/components/Prefs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Search } from "@/components/Search";

const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"], variable: "--font-display", display: "swap" });
const text = Newsreader({ subsets: ["latin"], axes: ["opsz"], style: ["normal", "italic"], variable: "--font-text", display: "swap" });
const code = Martian_Mono({ subsets: ["latin"], axes: ["wdth"], variable: "--font-code", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Mnemonic", template: "%s · Mnemonic" },
  description: "Free interactive guides to software design and systems topics, in Go, Python, TypeScript and Rust.",
};

// Runs before paint so the chosen theme never flashes.
const themeScript =
  'try{var t=localStorage.getItem("mn:theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${code.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <PrefsProvider>
          <header className="site-head gutter">
            <div className="wrap">
              <Link href="/" className="brand">Mnemonic<span>.</span></Link>
              <nav className="head-links" aria-label="Site">
                <Link href="/">Tracks</Link>
                <Link href="/glossary/">Glossary</Link>
              </nav>
              <Search />
              <ThemeToggle />
            </div>
          </header>
          <main id="main" className="gutter">{children}</main>
          <footer className="foot gutter">
            <div className="wrap">Mnemonic is free and keeps no data about you. Your progress and settings stay in this browser.</div>
          </footer>
        </PrefsProvider>
      </body>
    </html>
  );
}
