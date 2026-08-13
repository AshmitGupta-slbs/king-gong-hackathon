'use client';

/**
 * The product. Transcript on the left, notes on the right, and every claim in the notes shows the
 * moments that prove it.
 *
 * The state stays in ONE client component on purpose: the audio element, the transcript DOM refs
 * and the insights panel have to share it for "click a claim → land on the proof" to work.
 * `components/workspace/*` is presentation only.
 *
 * On privacy: `crm` carries deal value and pipeline detail, and the public share route passes
 * `participants` WITHOUT it. That is structural rather than a render-time `if` — anything handed to
 * this component is serialized into the page, so a recipient must never receive the deal object at
 * all, whether or not a component would have drawn it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Building2 } from 'lucide-react';
import { analyseCall } from '@/lib/analytics';
import { readableFor, renderedSpansFor } from '@/lib/readability';
import type { CallContext, Participant } from '@/lib/crm/types';
import type { CallBundle } from '@/lib/types';
import { Tabs } from '@/components/ui/Tabs';
import { CallHeader } from '@/components/workspace/CallHeader';
import { ContextPanel } from '@/components/workspace/ContextPanel';
import { Insights, EmptyNotes } from '@/components/workspace/Insights';
import { Player } from '@/components/workspace/Player';
import { TranscriptLine } from '@/components/workspace/TranscriptPane';
import {
  CallMetaContext,
  SpanFmt,
  TextFmt,
  type GateDemoResult,
} from '@/components/workspace/format-context';

export function CallWorkspace({
  bundle,
  crm = null,
  participants,
  readOnly = false,
}: {
  bundle: CallBundle;
  /** Full account context. Never passed on the public share route. */
  crm?: CallContext | null;
  /** Speaker identities only — enough to name the transcript without exposing the deal. */
  participants?: Participant[];
  readOnly?: boolean;
}) {
  const { call, segments, extraction } = bundle;
  const audioRef = useRef<HTMLAudioElement>(null);
  const segRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pulsed, setPulsed] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [gateDemo, setGateDemo] = useState<GateDemoResult | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  /** Segments backing the claim currently under the cursor. */
  const [cited, setCited] = useState<string[] | null>(null);
  const [tab, setTab] = useState<'notes' | 'context'>('notes');

  /**
   * Memoised because it feeds the context value: the `?? []` fallback allocates a fresh array on
   * every render, which would make `meta` a new object each time and re-render every transcript
   * line on each `timeupdate` — several times a second while audio plays.
   */
  const people = useMemo(
    () => participants ?? crm?.participants ?? [],
    [participants, crm],
  );
  const analytics = useMemo(() => analyseCall(segments), [segments]);

  /** The line currently being spoken. Drives the transcript highlight. */
  const activeId = useMemo(() => {
    let hit: string | null = null;
    for (const s of segments) {
      if (timeMs >= s.start_ms && timeMs < s.end_ms) return s.id;
      if (timeMs >= s.start_ms) hit = s.id; // fall back to the most recent line started
    }
    return hit;
  }, [timeMs, segments]);

  /**
   * Centre a segment inside the transcript pane WITHOUT moving the page.
   *
   * `scrollIntoView` scrolls every scrollable ancestor, window included, which slid the call
   * title up under the sticky header every time a citation was clicked. Scrolling the container
   * directly keeps the page fixed, which is what you want when the whole interaction is
   * "click the claim, watch the transcript move".
   */
  const centreInPane = useCallback((segId: string) => {
    const pane = scrollerRef.current;
    const el = segRefs.current.get(segId);
    if (!pane || !el) return;
    const target = el.offsetTop - pane.clientHeight / 2 + el.offsetHeight / 2;
    pane.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, []);

  /** Click a citation → move the audio there, bring the line into view, pulse it. */
  const seekToSegment = useCallback(
    (segId: string) => {
      const seg = segments.find((s) => s.id === segId);
      if (!seg) return;
      const a = audioRef.current;
      if (a) {
        a.currentTime = seg.start_ms / 1000;
        void a.play().catch(() => {}); // autoplay may be blocked; the seek still happened
      }
      setTimeMs(seg.start_ms);
      centreInPane(segId);
      setPulsed(segId);
      window.setTimeout(() => setPulsed((p) => (p === segId ? null : p)), 1200);
    },
    [segments, centreInPane],
  );

  // Follow the transcript while playing, but never fight a user who has scrolled away manually.
  useEffect(() => {
    if (!follow || !playing || !activeId) return;
    centreInPane(activeId);
  }, [activeId, follow, playing, centreInPane]);

  /** Flagged moments plotted on the scrubber, so the timeline itself shows where the receipts are. */
  const markers = useMemo(
    () =>
      (extraction?.key_moments ?? []).map((m) => ({
        id: m.evidence.segment_id,
        ms: m.evidence.start_ms,
        type: m.type,
      })),
    [extraction],
  );

  const runGateDemo = async () => {
    setGateBusy(true);
    try {
      const res = await fetch('/api/demo/gate-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: call.id }),
      });
      setGateDemo(await res.json());
    } finally {
      setGateBusy(false);
    }
  };

  const displayText = useMemo(() => readableFor(call.title), [call.title]);
  const displaySpans = useMemo(() => renderedSpansFor(call.title), [call.title]);
  const meta = useMemo(
    () => ({ durationMs: call.duration_ms, participants: people }),
    [call.duration_ms, people],
  );

  return (
    <TextFmt.Provider value={displayText}>
      <SpanFmt.Provider value={displaySpans}>
        <CallMetaContext.Provider value={meta}>
          {/*
           * On lg+ the workspace fills the shell exactly and each pane scrolls on its own, so the
           * transcript and the notes stay side by side while you click between them. Below lg it
           * flows normally and the page scrolls. No height is computed anywhere.
           */}
          <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 lg:h-full lg:gap-5 lg:p-6">
            <div className="shrink-0">
              <CallHeader
                bundle={bundle}
                crm={crm}
                participants={people}
                onGateDemo={readOnly ? undefined : runGateDemo}
                gateBusy={gateBusy}
              />
            </div>

            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-5">
              {/* ── Transcript + player ─────────────────────────────────────── */}
              <section className="flex min-h-0 flex-col overflow-hidden rounded-card border border-border-subtle bg-surface shadow-card">
                <div className="shrink-0 border-b border-border-subtle p-3">
                  {/* Native controls are light-themed and cannot be restyled; the element stays for
                      playback, the chrome is ours. */}
                  <audio
                    ref={audioRef}
                    src={call.audio_path}
                    preload="metadata"
                    className="hidden"
                    onTimeUpdate={(e) => setTimeMs(e.currentTarget.currentTime * 1000)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                  />
                  <Player
                    playing={playing}
                    timeMs={timeMs}
                    durationMs={call.duration_ms}
                    markers={markers}
                    onToggle={() => {
                      const a = audioRef.current;
                      if (!a) return;
                      if (a.paused) void a.play().catch(() => {});
                      else a.pause();
                    }}
                    onScrub={(ms) => {
                      const a = audioRef.current;
                      if (a) a.currentTime = ms / 1000;
                      setTimeMs(ms);
                    }}
                    follow={follow}
                    onFollowChange={setFollow}
                  />
                </div>

                {/*
                 * `relative` is load-bearing, not decoration: `centreInPane` positions with
                 * `el.offsetTop`, which is measured from the nearest POSITIONED ancestor. Without
                 * it the offsets resolve against the document and every citation scrolls to the
                 * wrong line — silently, since the pane still scrolls.
                 */}
                <div
                  ref={scrollerRef}
                  className="relative max-h-[55vh] min-h-0 flex-1 overflow-y-auto p-2 lg:max-h-none"
                >
                  {segments.map((s) => (
                    <TranscriptLine
                      key={s.id}
                      seg={s}
                      active={s.id === activeId}
                      pulsed={s.id === pulsed}
                      cited={cited?.includes(s.id) ?? false}
                      onClick={() => seekToSegment(s.id)}
                      bindRef={(el) => {
                        if (el) segRefs.current.set(s.id, el);
                        else segRefs.current.delete(s.id);
                      }}
                    />
                  ))}
                </div>
              </section>

              {/* ── Notes / Context ─────────────────────────────────────────── */}
              <section className="flex min-w-0 flex-col lg:min-h-0">
                {/* The share route gets no account context, so it gets no tab strip either. */}
                {!readOnly && (
                  <Tabs
                    className="mb-4 shrink-0"
                    active={tab}
                    onChange={(id) => setTab(id as 'notes' | 'context')}
                    tabs={[
                      {
                        id: 'notes',
                        label: 'Notes',
                        icon: <FileText size={14} aria-hidden />,
                      },
                      {
                        id: 'context',
                        label: 'Context',
                        icon: <Building2 size={14} aria-hidden />,
                      },
                    ]}
                  />
                )}

                <div className="min-h-0 flex-1 lg:overflow-y-auto lg:pr-1">
                  {tab === 'notes' || readOnly ? (
                    extraction ? (
                      <Insights
                        ex={extraction}
                        onCite={seekToSegment}
                        gateDemo={gateDemo}
                        onHoverSegments={setCited}
                      />
                    ) : (
                      <EmptyNotes />
                    )
                  ) : (
                    <ContextPanel crm={crm} analytics={analytics} />
                  )}
                </div>
              </section>
            </div>
          </div>
        </CallMetaContext.Provider>
      </SpanFmt.Provider>
    </TextFmt.Provider>
  );
}
