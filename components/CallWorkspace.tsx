'use client';

/**
 * The product. Transcript on the left, notes on the right, and every claim in the notes carries
 * citation chips that seek the audio to the exact line that proves it.
 *
 * All of it lives in one client component on purpose: the audio element, the transcript DOM refs
 * and the insights panel have to share state for "click a claim → land on the proof" to work.
 * Splitting them would mean lifting an audio ref through context for no benefit.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { readableFor, renderedSpansFor, type RenderedSpan } from '@/lib/readability';
import type {
  CallBundle,
  CitedClaim,
  Evidence,
  ExtractionResult,
  GateRejection,
  TranscriptSegment,
} from '@/lib/types';

/**
 * Transcript display formatter — casing and terminal punctuation only, guaranteed word-preserving
 * (lib/readability.ts). Held in context because the transcript, the citation tooltips and the
 * evidence blockquotes all need the same one, and drilling it through four components is noise.
 *
 * `segment.text` stays canonical; this is presentation.
 */
const TextFmt = createContext<(s: string) => string>((s) => s);
const useTextFmt = () => useContext(TextFmt);

/**
 * The same rendering, split into spans so the transcript can mark the one transform that changes
 * words — a spoken digit run collapsed to a number. Separate context because only the transcript
 * needs the spans; tooltips and blockquotes want a plain string.
 */
const SpanFmt = createContext<(s: string) => RenderedSpan[]>((s) => [{ text: s, normalized: false }]);
const useSpanFmt = () => useContext(SpanFmt);

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function CallWorkspace({ bundle, readOnly = false }: { bundle: CallBundle; readOnly?: boolean }) {
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

  return (
    <TextFmt.Provider value={displayText}>
    <SpanFmt.Provider value={displaySpans}>
    <div className="mx-auto max-w-[1600px] px-5 py-5">
      <CallHeader
        bundle={bundle}
        onGateDemo={readOnly ? undefined : runGateDemo}
        gateBusy={gateBusy}
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* ── Transcript + player ─────────────────────────────────────────── */}
        <section className="flex min-h-0 flex-col rounded-xl border border-border-subtle bg-bg-raised">
          <div className="sticky top-[57px] z-20 rounded-t-xl border-b border-border-subtle bg-bg-raised/95 p-3 backdrop-blur">
            {/* Native controls are light-themed and cannot be restyled, which looked broken
                against a dark UI. The element stays for playback; the chrome is ours. */}
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

          <div
            ref={scrollerRef}
            className="relative max-h-[calc(100vh-260px)] overflow-y-auto p-2"
          >
            {segments.map((s) => (
              <TranscriptLine
                key={s.id}
                seg={s}
                active={s.id === activeId}
                pulsed={s.id === pulsed}
                onClick={() => seekToSegment(s.id)}
                bindRef={(el) => {
                  if (el) segRefs.current.set(s.id, el);
                  else segRefs.current.delete(s.id);
                }}
              />
            ))}
          </div>
        </section>

        {/* ── Notes ───────────────────────────────────────────────────────── */}
        <section className="min-w-0">
          {extraction ? (
            <Insights ex={extraction} onCite={seekToSegment} gateDemo={gateDemo} />
          ) : (
            <EmptyNotes />
          )}
        </section>
      </div>
    </div>
    </SpanFmt.Provider>
    </TextFmt.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** Minimal dark player: play/pause, a scrubbable track, and flagged moments marked on it. */
function Player({
  playing,
  timeMs,
  durationMs,
  markers,
  onToggle,
  onScrub,
  follow,
  onFollowChange,
}: {
  playing: boolean;
  timeMs: number;
  durationMs: number;
  markers: { id: string; ms: number; type: string }[];
  onToggle: () => void;
  onScrub: (ms: number) => void;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
}) {
  const pct = durationMs > 0 ? Math.min(100, (timeMs / durationMs) * 100) : 0;

  const scrubFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onScrub(ratio * durationMs);
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onToggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-[#04150f] transition hover:brightness-110"
      >
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="1.5" y="1" width="3" height="10" rx="1" />
            <rect x="7.5" y="1" width="3" height="10" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M2.5 1.2v9.6a.6.6 0 0 0 .92.5l7.2-4.8a.6.6 0 0 0 0-1l-7.2-4.8a.6.6 0 0 0-.92.5Z" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          onClick={scrubFromEvent}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(timeMs / 1000)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') onScrub(Math.min(durationMs, timeMs + 5000));
            if (e.key === 'ArrowLeft') onScrub(Math.max(0, timeMs - 5000));
          }}
          className="group relative h-6 cursor-pointer"
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-bg-inset">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          {markers.map((m) => (
            <span
              key={`${m.id}-${m.ms}`}
              title={m.type.replace('_', ' ')}
              className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-warn ring-1 ring-bg-raised"
              style={{ left: `${durationMs ? (m.ms / durationMs) * 100 : 0}%` }}
            />
          ))}
          <span
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: `${pct}%` }}
          />
        </div>
        <div className="flex items-center gap-3 text-[11px] text-fg-dim">
          <span className="font-mono">
            {fmt(timeMs)} / {fmt(durationMs)}
          </span>
          {markers.length > 0 && (
            <span className="hidden sm:inline">
              <span className="mr-1 inline-block size-1.5 translate-y-[-1px] rounded-full bg-warn" />
              flagged moments
            </span>
          )}
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 select-none">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => onFollowChange(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            follow transcript
          </label>
        </div>
      </div>
    </div>
  );
}

function CallHeader({
  bundle,
  onGateDemo,
  gateBusy,
}: {
  bundle: CallBundle;
  onGateDemo?: () => void;
  gateBusy: boolean;
}) {
  const { call, segments, extraction } = bundle;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight">{call.title}</h1>
        <p className="mt-0.5 font-mono text-[11px] text-fg-dim">
          {fmt(call.duration_ms)} · {segments.length} segments · separation:{' '}
          <span className="text-fg-muted">{call.separation}</span>
          {extraction?.extracted_by && (
            <>
              {' '}· extracted by <span className="text-fg-muted">{extraction.extracted_by}</span>
            </>
          )}
        </p>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {extraction && <RunStatusPill status={extraction.run_status} />}
        <a
          href={`/api/calls/${call.id}/export?format=md`}
          className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-fg-muted transition hover:border-accent hover:text-accent"
        >
          Export .md
        </a>
        <a
          href={`/api/calls/${call.id}/export?format=json`}
          className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-fg-muted transition hover:border-accent hover:text-accent"
        >
          .json
        </a>
        {call.share_id && (
          <a
            href={`/s/${call.share_id}`}
            className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-fg-muted transition hover:border-accent hover:text-accent"
          >
            Share link
          </a>
        )}
        {onGateDemo && (
          <button
            onClick={onGateDemo}
            disabled={gateBusy}
            title="Feed hand-written claims — some citing segments that do not exist — through the real citation gate"
            className="rounded-md border border-bad-dim bg-bad-dim/25 px-2.5 py-1.5 text-xs font-medium text-bad transition hover:bg-bad-dim/40 disabled:opacity-50"
          >
            {gateBusy ? 'Testing gate…' : 'Test the gate'}
          </button>
        )}
      </div>
    </div>
  );
}

function RunStatusPill({ status }: { status: ExtractionResult['run_status'] }) {
  const map = {
    shipped: ['text-accent', 'border-accent-dim', 'bg-accent-dim/25', 'all claims verified'],
    partial: ['text-warn', 'border-warn-dim', 'bg-warn-dim/25', 'some claims dropped or flagged'],
    failed: ['text-bad', 'border-bad-dim', 'bg-bad-dim/25', 'nothing survived the gate'],
    deadline: ['text-bad', 'border-bad-dim', 'bg-bad-dim/25', 'stopped by the budget governor'],
  } as const;
  const [fg, border, bg, title] = map[status];
  return (
    <span
      title={title}
      className={`rounded-md border px-2.5 py-1.5 font-mono text-xs ${fg} ${border} ${bg}`}
    >
      {status}
    </span>
  );
}

function TranscriptLine({
  seg,
  active,
  pulsed,
  onClick,
  bindRef,
}: {
  seg: TranscriptSegment;
  active: boolean;
  pulsed: boolean;
  onClick: () => void;
  bindRef: (el: HTMLDivElement | null) => void;
}) {
  const isRep = seg.speaker === 'rep';
  const spans = useSpanFmt();
  return (
    <div
      ref={bindRef}
      onClick={onClick}
      className={`group grid cursor-pointer grid-cols-[54px_66px_minmax(0,1fr)] gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-relaxed transition-colors ${
        active ? 'bg-accent/10' : 'hover:bg-bg-inset'
      } ${pulsed ? 'cite-pulse' : ''}`}
    >
      <span className="font-mono text-[11px] text-fg-dim group-hover:text-accent">
        {fmt(seg.start_ms)}
      </span>
      <span
        className={`font-mono text-[11px] font-medium ${isRep ? 'text-rep' : 'text-prospect'}`}
      >
        {seg.speaker}
      </span>
      <span className={active ? 'text-fg' : 'text-fg-muted'}>
        <SegmentText spans={spans(seg.text)} />
        <span className="ml-1.5 font-mono text-[10px] text-border-strong opacity-0 transition-opacity group-hover:opacity-100">
          {seg.id}
        </span>
      </span>
    </div>
  );
}

/**
 * A transcript line, with the one word-changing transform shown rather than hidden.
 *
 * Hear reads figures out digit by digit ("one four oh oh"), and we collapse a long enough run to
 * "1400" so the line is readable. That is the only place the screen shows characters nobody spoke,
 * so it gets a dotted underline and a tooltip with the spoken words. Hovering tells you the truth;
 * the citation the gate checked is still the verbatim text underneath.
 */
function SegmentText({ spans }: { spans: RenderedSpan[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.normalized ? (
          <span
            key={i}
            title={`spoken as "${s.spoken}" — shown as digits for readability. The citation checks the spoken words.`}
            className="cursor-help underline decoration-fg-dim decoration-dotted underline-offset-2"
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** The receipts. Clicking one moves the audio to the line it cites. */
function CiteChips({ evidence, onCite }: { evidence: Evidence[]; onCite: (id: string) => void }) {
  const display = useTextFmt();
  if (evidence.length === 0) {
    return (
      <span className="rounded border border-bad-dim bg-bad-dim/20 px-1.5 py-0.5 font-mono text-[10px] text-bad">
        no resolvable citation
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {evidence.map((e) => (
        <button
          key={e.segment_id}
          onClick={() => onCite(e.segment_id)}
          title={`${e.speaker} at ${fmt(e.start_ms)} — ${display(e.text)}`}
          className="rounded border border-accent-dim bg-accent-dim/25 px-1.5 py-0.5 font-mono text-[10px] text-accent transition hover:bg-accent-dim/50"
        >
          {e.segment_id} · {fmt(e.start_ms)}
        </button>
      ))}
    </span>
  );
}

function ClaimRow({ c, onCite }: { c: CitedClaim; onCite: (id: string) => void }) {
  const display = useTextFmt();
  return (
    <li className="border-t border-border-subtle py-2.5 first:border-t-0">
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
            c.verdict === 'verified' ? 'bg-accent' : 'bg-warn'
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug text-fg">{display(c.claim)}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <CiteChips evidence={c.evidence} onCite={onCite} />
            {c.verdict === 'unverified' && (
              <span
                title={`Content-overlap support ${c.support.toFixed(2)} is below the threshold. The cited line exists but does not visibly back this claim.`}
                className="rounded border border-warn-dim bg-warn-dim/25 px-1.5 py-0.5 font-mono text-[10px] text-warn"
              >
                unverified · support {c.support.toFixed(2)}
              </span>
            )}
          </div>
          {/* Show the quoted line itself. The claim is a summary; this is the evidence. */}
          {c.evidence.slice(0, 1).map((e) => (
            <blockquote
              key={e.segment_id}
              className="mt-1.5 border-l-2 border-border-strong pl-2 text-[12px] italic leading-snug text-fg-dim"
            >
              {display(e.text)}
            </blockquote>
          ))}
        </div>
      </div>
    </li>
  );
}

function Card({
  title,
  count,
  children,
  tone,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  tone?: 'warn' | 'bad';
}) {
  const border =
    tone === 'bad' ? 'border-bad-dim' : tone === 'warn' ? 'border-warn-dim' : 'border-border-subtle';
  return (
    <div className={`rounded-xl border ${border} bg-bg-raised p-3.5`}>
      <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-dim">
        {title}
        {count !== undefined && (
          <span className="rounded bg-bg-inset px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
            {count}
          </span>
        )}
      </h2>
      {children}
    </div>
  );
}

function Insights({
  ex,
  onCite,
  gateDemo,
}: {
  ex: ExtractionResult;
  onCite: (id: string) => void;
  gateDemo: GateDemoResult | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Card title="Summary">
        <p className="text-[13px] leading-relaxed text-fg-muted">{ex.summary}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2.5">
          <span className="text-[11px] uppercase tracking-wider text-fg-dim">Intent</span>
          <span className="rounded bg-bg-inset px-2 py-0.5 text-[12px] font-medium text-fg">
            {ex.intent.label}
          </span>
          <CiteChips evidence={ex.intent.evidence} onCite={onCite} />
        </div>
      </Card>

      <Card title="Objections" count={ex.objections.length}>
        {ex.objections.length ? (
          <ul>
            {ex.objections.map((c, i) => (
              <ClaimRow key={i} c={c} onCite={onCite} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-dim">None raised on this call.</p>
        )}
      </Card>

      <Card title="Next steps" count={ex.next_steps.length}>
        {ex.next_steps.length ? (
          <ul>
            {ex.next_steps.map((c, i) => (
              <ClaimRow key={i} c={c} onCite={onCite} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-dim">Nothing agreed on this call.</p>
        )}
      </Card>

      {ex.key_moments.length > 0 && (
        <Card title="Flagged moments" count={ex.key_moments.length}>
          <ul className="flex flex-col gap-1.5">
            {ex.key_moments.map((m, i) => (
              <li key={i} className="flex items-center gap-2 text-[12px]">
                <button
                  onClick={() => onCite(m.evidence.segment_id)}
                  className="rounded border border-accent-dim bg-accent-dim/25 px-1.5 py-0.5 font-mono text-[10px] text-accent transition hover:bg-accent-dim/50"
                >
                  {fmt(m.evidence.start_ms)}
                </button>
                <span className="rounded bg-bg-inset px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg-muted">
                  {m.type.replace('_', ' ')}
                </span>
                <span className="min-w-0 truncate text-fg-muted">{m.note}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Follow-up email" tone={ex.follow_up_email.verdict === 'unverified' ? 'warn' : undefined}>
        {ex.follow_up_email.verdict === 'unverified' && (
          <p className="mb-2 rounded border border-warn-dim bg-warn-dim/20 px-2 py-1 text-[11px] text-warn">
            Could not be grounded in a specific line of the call — read it before sending.
          </p>
        )}
        <p className="text-[12px] text-fg-dim">
          <span className="uppercase tracking-wider">Subject</span>{' '}
          <span className="text-fg">{ex.follow_up_email.subject}</span>
        </p>
        <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-muted">
          {ex.follow_up_email.body}
        </p>
        <div className="mt-2">
          <CiteChips evidence={ex.follow_up_email.evidence} onCite={onCite} />
        </div>
      </Card>

      {/* Publishing our own rejections is the argument. Notes you cannot audit are a guess. */}
      {(ex.rejections.length > 0 || gateDemo) && (
        <Card
          title="What the citation gate rejected"
          count={(gateDemo?.rejections.length ?? 0) + ex.rejections.length}
          tone="bad"
        >
          {gateDemo && (
            <p className="mb-2 rounded border border-border-strong bg-bg-inset px-2 py-1.5 text-[11px] leading-snug text-fg-muted">
              {gateDemo.note} Submitted {gateDemo.submitted.objections} objections and{' '}
              {gateDemo.submitted.next_steps} next steps;{' '}
              <span className="text-accent">{gateDemo.survived.objections}</span> and{' '}
              <span className="text-accent">{gateDemo.survived.next_steps}</span> survived. Run
              status: <span className="font-mono text-warn">{gateDemo.run_status}</span>.
            </p>
          )}
          <ul className="flex flex-col gap-1.5">
            {[...(gateDemo?.rejections ?? []), ...ex.rejections].map((r, i) => (
              <RejectionRow key={i} r={r} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function RejectionRow({ r }: { r: GateRejection }) {
  return (
    <li className="flex items-start gap-2 rounded-lg bg-bg-inset px-2 py-1.5 text-[12px]">
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${
          r.dropped ? 'bg-bad-dim/40 text-bad' : 'bg-warn-dim/40 text-warn'
        }`}
      >
        {r.dropped ? 'dropped' : 'flagged'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-fg-muted">{r.claim}</span>
        <span className="mt-0.5 block font-mono text-[10px] text-fg-dim">
          {r.field} — {r.detail}
        </span>
      </span>
    </li>
  );
}

function EmptyNotes() {
  return (
    <div className="rounded-xl border border-warn-dim bg-warn-dim/10 p-5">
      <h2 className="text-sm font-semibold text-warn">Extraction offline</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
        This call has been transcribed and its segments are real, but no notes were produced —
        there is no model credential configured. The transcript, the audio sync and the citation
        gate all work; only the notes are missing.
      </p>
      <p className="mt-2 font-mono text-[11px] text-fg-dim">
        Set ANTHROPIC_API_KEY, or AWS_REGION + AWS credentials for Bedrock, then run{' '}
        <span className="text-fg-muted">npm run extract:samples</span>
      </p>
    </div>
  );
}

type GateDemoResult = {
  note: string;
  submitted: { objections: number; next_steps: number; key_moments: number };
  survived: { objections: number; next_steps: number; key_moments: number };
  run_status: string;
  rejections: GateRejection[];
};
