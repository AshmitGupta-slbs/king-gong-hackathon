import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'King Gong — deal notes with receipts',
  description:
    'Upload a sales call. Get a transcript, summary, objections, intent, next steps and a ' +
    'follow-up email — where every claim points at the exact line in the call that proves it.',
};

/**
 * The root layout is now nothing but the document.
 *
 * The application chrome (sidebar, top bar, usage counter) lives in `app/(app)/layout.tsx`, so the
 * public share route can opt out of it: someone who receives a share link should see the call and
 * a read-only header, not the sender's navigation.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-canvas text-fg">{children}</body>
    </html>
  );
}
