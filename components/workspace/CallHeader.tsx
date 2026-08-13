'use client';

/**
 * Call title, provenance, and the actions.
 *
 * The three export links were three verbatim copies of one class string; they are `ButtonLink`s
 * now. The status pill used to share its geometry with those buttons, so a non-interactive label
 * looked exactly like three clickable controls sitting beside it — it is a `Badge` now, visibly a
 * different kind of thing.
 */
import { Download, ShieldAlert, Share2 } from 'lucide-react';
import type { CallBundle } from '@/lib/types';
import { Button, ButtonLink } from '@/components/ui/Button';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { fmt } from './format-context';

export function CallHeader({
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
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="min-w-0 truncate text-title font-semibold text-fg">{call.title}</h1>
          {extraction && <RunStatusBadge status={extraction.run_status} />}
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-micro text-fg-dim">
          <span className="font-mono tabular-nums">{fmt(call.duration_ms)}</span>
          <Dot />
          <span>{segments.length} segments</span>
          <Dot />
          <span>
            {call.separation} separation
          </span>
          {extraction?.extracted_by && (
            <>
              <Dot />
              <span>
                extracted by <span className="font-mono">{extraction.extracted_by}</span>
              </span>
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink href={`/api/calls/${call.id}/export?format=md`}>
          <Download size={14} aria-hidden />
          Export .md
        </ButtonLink>
        <ButtonLink href={`/api/calls/${call.id}/export?format=json`}>.json</ButtonLink>
        {call.share_id && (
          <ButtonLink href={`/s/${call.share_id}`}>
            <Share2 size={14} aria-hidden />
            Share link
          </ButtonLink>
        )}
        {onGateDemo && (
          <Button
            variant="danger"
            onClick={onGateDemo}
            disabled={gateBusy}
            title="Feed hand-written claims — some citing segments that do not exist — through the real citation gate"
          >
            <ShieldAlert size={14} aria-hidden />
            {gateBusy ? 'Testing gate…' : 'Test the gate'}
          </Button>
        )}
      </div>
    </div>
  );
}

const Dot = () => (
  <span aria-hidden className="text-border-strong">
    •
  </span>
);
