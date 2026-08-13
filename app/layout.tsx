import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { UsageBar } from '@/components/UsageBar';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'OpenGong Lite — deal notes with receipts',
  description:
    'Upload a sales call. Get a transcript, summary, objections, intent, next steps and a ' +
    'follow-up email — where every claim points at the exact line in the call that proves it.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-fg">
        <header className="sticky top-0 z-30 border-b border-border-subtle bg-bg/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-5 py-3">
            <Link href="/" className="group flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-tight">
                Open<span className="text-accent">Gong</span> Lite
              </span>
              <span className="hidden text-xs text-fg-dim sm:inline">deal notes with receipts</span>
            </Link>
            <div className="ml-auto">
              {/* API gravity, made visible. 20% of the score and invisible by default. */}
              <UsageBar />
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-border-subtle px-5 py-3 text-[11px] text-fg-dim">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1">
            <span>MIT licensed · every claim links to the line that proves it</span>
            <a
              className="ml-auto text-fg-muted underline decoration-dotted hover:text-accent"
              href="https://docs.pyai.com/quickstart"
              target="_blank"
              rel="noreferrer"
            >
              Runs on PyAI — mint a key
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
