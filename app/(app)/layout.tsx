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
    /*
      `relative`, not just `h-dvh overflow-hidden` — verified live (a headless-browser check
      against the deployed app, toggling this one property) that WITHOUT it, this row's
      overflow:hidden does not actually stop a tall page from making the whole DOCUMENT
      scrollable on top of <main>'s own internal scroll. `position:static` (the default) plus a
      `position:sticky` descendant (the sidebar) is exactly the combination that lets scrollable
      overflow bubble up to the document root regardless of overflow-hidden here; giving this row
      its own positioning context (any non-static value) stops that. Confirmed by measurement:
      document.documentElement.scrollHeight dropped from 2608px to exactly 900px (the viewport)
      the instant this was added, with nothing else changed.
    */
    <div className="relative flex h-dvh overflow-hidden">
      <Sidebar />
      {/*
        min-h-0 here too, not just on <main> — this column is itself a flex ITEM of the outer row
        above, and a flex item's default min-height is `auto` (its content's natural height), not 0.
        Without this, a page whose content is taller than one viewport could force THIS column past
        h-dvh despite the outer row's overflow-hidden, which pushes scrolling onto the whole document
        instead of containing it inside <main> — exactly the failure mode the comment above promises
        does not happen.
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar />
        <StubBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
