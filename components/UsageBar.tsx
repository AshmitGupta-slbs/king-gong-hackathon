'use client';

/**
 * The API-gravity counter, in the top bar where a judge cannot miss it.
 *
 * Everything here is real recorded work — PyAI audio seconds and model tokens — plus the number of
 * claims the citation gate has blocked. Replaying a committed sample deliberately records nothing,
 * so the number only moves when work actually happens. That is the point: a usage counter that
 * inflates itself would undercut the one thing this product is selling.
 *
 * Presentation note: these used to be four 11px monospace pairs joined by `·` separators rendered
 * in a BORDER colour — about 1.4:1 against the header, i.e. invisible. They are stat tiles now.
 */
import { useEffect, useState } from 'react';
import { StatTile } from '@/components/ui/StatTile';

type Usage = {
  minutes: number;
  input_tokens: number;
  output_tokens: number;
  calls_processed: number;
  claims_blocked: number;
};

type Payload = {
  usage: Usage;
  registry: { extract: string; extractDetail: string; extractIsRealModel: boolean; stt: string };
};

export function UsageStats() {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/usage')
        .then((r) => r.json())
        .then((d: Payload) => alive && setData(d))
        .catch(() => {});
    load();
    // Slow poll: the counter has to visibly move when a second call is processed, but this is a
    // header widget, not a dashboard.
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!data) {
    return (
      <div className="flex items-center gap-6" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-end gap-1.5">
            <div className="h-3.5 w-8 animate-pulse rounded bg-surface-inset" />
            <div className="h-2.5 w-16 animate-pulse rounded bg-surface-inset" />
          </div>
        ))}
      </div>
    );
  }

  const u = data.usage;
  const tokens = u.input_tokens + u.output_tokens;

  return (
    <div className="flex items-center gap-5 sm:gap-7">
      <StatTile value={u.minutes.toFixed(1)} label="min transcribed" tone="brand" />
      <div className="hidden sm:block">
        <StatTile value={String(u.calls_processed)} label="calls" />
      </div>
      <div className="hidden md:block">
        <StatTile
          value={tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)}
          label="tokens"
        />
      </div>
      <StatTile
        value={String(u.claims_blocked)}
        label="claims blocked"
        tone={u.claims_blocked > 0 ? 'bad' : 'default'}
      />
    </div>
  );
}
