/**
 * The application shell: nav rail on the left, a fixed top bar, one scrolling content region.
 *
 * The shell is a flex column that owns the viewport height, and `<main>` is the only thing that
 * scrolls. That is deliberate: the call workspace needs to fill exactly the space left over, and
 * the previous version computed that with `max-h-[calc(100vh-260px)]` and `top-[57px]` — magic
 * numbers encoding the header height from a different file. Any header change silently broke them,
 * and the stub-extractor banner below would have broken them again. Nothing here measures anything;
 * `min-h-0` + `flex-1` lets the browser do it.
 */
import { Sidebar } from '@/components/shell/Sidebar';
import { StubBanner } from '@/components/shell/StubBanner';
import { TopBar } from '@/components/shell/TopBar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <StubBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
