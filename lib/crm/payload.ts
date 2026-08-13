/**
 * What this app WOULD send to HubSpot, built so you can read it before anyone sends anything.
 *
 * THIS MODULE HAS NO NETWORK ACCESS AND NO CREDENTIAL. It is a pure function from a call to a
 * JSON document. That is the entire design: the question worth answering first is not "can we
 * push?" but "what exactly would land in the CRM, and would we be happy for a customer to read
 * it?" — and that question is answerable without a token, without a sandbox portal, and without
 * any risk of writing into a live pipeline.
 *
 * GROUNDED IN THE REAL SCHEMA. Property names, types and units below were read from a live HubSpot
 * portal rather than from documentation:
 *
 *   hs_note_body        string, fieldType "html"  → citations can be real anchors, not bare text
 *   hs_call_body        string, fieldType "html"
 *   hs_call_duration    number, IN MILLISECONDS   → Call.duration_ms maps with no conversion
 *   hs_timestamp        datetime
 *   hs_call_direction   enumeration: INBOUND | OUTBOUND
 *
 * WHY NO `dealstage`. Stage ids are per-portal GUIDs, not labels — the portal checked had four
 * pipelines, in which "Negotiate" is `4a26def2-fe7f-49ef-8a0b-cb73f99f3907`. Our own DealStage
 * vocabulary matches none of them. Writing a label would be rejected; writing a guessed GUID would
 * move somebody's real deal. So stage travels as a SIGNAL for a human to act on, never as a
 * property write, and the payload says so where a reader will see it.
 *
 * WHY UNVERIFIED CLAIMS ARE EXCLUDED. In the app an unverified claim ships with a visible warning,
 * because hiding it would be lying by omission to the person who recorded the call. A CRM is a
 * different audience: the note outlives the context, gets read by people who never saw the badge,
 * and becomes the account's official history. Anything the gate could not stand behind is left out
 * and counted in `omitted`, so the exclusion is itself visible.
 */
import type { CallBundle, CitedClaim, Evidence } from '@/lib/types';
import type { Company } from '@/lib/company-types';
import type { ActionItem, FollowThrough } from '@/lib/action-item-types';
import { followThrough } from '@/lib/action-items';
import { analyseCall } from '@/lib/analytics';

export type HubspotObject = {
  /** The `/crm/v3/objects/{type}` this would POST to. */
  type: 'notes' | 'calls';
  properties: Record<string, string | number>;
  associations: Association[];
};

/**
 * An association we cannot complete.
 *
 * Nothing in this app stores a HubSpot object id — `Company` has no `hs_object_id`, and `Deal.owner`
 * is a display name rather than an owner id. So the target is stated as null with the lookup that
 * would find it, rather than invented. A payload that fabricated ids would look more finished and
 * be less true.
 */
export type Association = {
  to: 'companies' | 'contacts' | 'deals';
  id: string | null;
  resolve_by: string;
};

export type CustomPropertySpec = {
  name: string;
  label: string;
  type: 'string' | 'number' | 'enumeration' | 'datetime';
  fieldType: 'text' | 'number' | 'select' | 'date' | 'textarea';
  groupName: string;
  description: string;
};

export type CrmPayload = {
  target: 'hubspot';
  generated_from: { call_id: string; share_url: string | null; extracted_by: string | null };
  objects: HubspotObject[];
  signals: Record<string, string | number | boolean | null | string[]>;
  requires_custom_properties: CustomPropertySpec[];
  omitted: { unverified_claims: number; reason: string }[];
  notes_for_the_reader: string[];
};

const ts = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** HTML, because `hs_note_body` is an html field and unescaped text would corrupt the note. */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A claim, with its receipt as a link back to the exact moment.
 *
 * This is the whole reason the feature is defensible. HubSpot has no concept of a transcript
 * segment, so a claim written into a note would normally arrive as an assertion with nothing behind
 * it — precisely the thing this product exists to refuse. An anchor to `/s/{share_id}#seg_014` keeps
 * the citation intact for a reader inside the CRM, who can click it and hear the line.
 */
function claimHtml(c: CitedClaim, shareUrl: string | null): string {
  const cites = c.evidence
    .map((e: Evidence) =>
      shareUrl
        ? `<a href="${esc(shareUrl)}#${esc(e.segment_id)}">${esc(e.segment_id)} · ${ts(e.start_ms)}</a>`
        : `${esc(e.segment_id)} · ${ts(e.start_ms)}`,
    )
    .join(', ');
  return `<li>${esc(c.claim)}${cites ? ` <em>(${cites})</em>` : ''}</li>`;
}

export function toHubspotPayload(input: {
  bundle: CallBundle;
  company: Company | null;
  actionItems: ActionItem[];
  /** Absolute origin of this instance, so citation links resolve for a reader inside HubSpot. */
  baseUrl: string | null;
}): CrmPayload {
  const { bundle, company, actionItems, baseUrl } = input;
  const { call, segments, extraction: ex } = bundle;

  const shareUrl = call.share_id && baseUrl ? `${baseUrl}/s/${call.share_id}` : null;
  const verified = (claims: CitedClaim[]) => claims.filter((c) => c.verdict === 'verified');
  const objections = verified(ex?.objections ?? []);
  const nextSteps = verified(ex?.next_steps ?? []);
  const omittedCount =
    (ex?.objections.length ?? 0) - objections.length + ((ex?.next_steps.length ?? 0) - nextSteps.length);

  const stats: FollowThrough = followThrough(actionItems);
  const analytics = analyseCall(segments);

  const section = (title: string, items: string[]) =>
    items.length ? `<h3>${title}</h3><ul>${items.join('')}</ul>` : '';

  const body =
    `<p>${esc(ex?.summary ?? 'No notes were produced for this call.')}</p>` +
    section('Objections', objections.map((c) => claimHtml(c, shareUrl))) +
    section('Next steps', nextSteps.map((c) => claimHtml(c, shareUrl))) +
    (shareUrl
      ? `<p><a href="${esc(shareUrl)}">Full transcript with every claim linked to its moment</a></p>`
      : '') +
    `<p><em>Produced by King Gong. Every claim above cites the line that proves it; claims the ` +
    `citation gate could not stand behind were left out rather than softened.</em></p>`;

  const associations: Association[] = [
    { to: 'companies', id: null, resolve_by: company?.website ? `domain = ${company.website}` : 'company name search' },
    { to: 'deals', id: null, resolve_by: 'most recent open deal on the associated company' },
    ...(company?.detail?.participants ?? [])
      .filter((p) => p.side === 'external' && p.email)
      .map((p): Association => ({ to: 'contacts', id: null, resolve_by: `email = ${p.email}` })),
  ];

  const objects: HubspotObject[] = [
    {
      type: 'notes',
      properties: { hs_timestamp: new Date(call.created_at).toISOString(), hs_note_body: body },
      associations,
    },
    {
      type: 'calls',
      properties: {
        hs_timestamp: new Date(call.created_at).toISOString(),
        hs_call_title: call.title,
        hs_call_body: body,
        // Already milliseconds on both sides — verified against the live property definition.
        hs_call_duration: call.duration_ms,
        hs_call_direction: 'OUTBOUND',
        ...(shareUrl ? { hs_call_recording_url: shareUrl } : {}),
      },
      associations,
    },
  ];

  return {
    target: 'hubspot',
    generated_from: {
      call_id: call.id,
      share_url: shareUrl,
      extracted_by: ex?.extracted_by ?? null,
    },
    objects,
    signals: {
      intent: ex?.intent.label ?? null,
      intent_is_verified: ex?.intent.verdict === 'verified',
      objections_verified: objections.length,
      next_steps_verified: nextSteps.length,
      competitors_named: (ex?.key_moments ?? [])
        .filter((m) => m.type === 'competitor_mention')
        .map((m) => m.note),
      commitments_kept: stats.done,
      commitments_total: stats.total,
      commitments_kept_pct: stats.pct,
      claims_dropped_by_gate: (ex?.rejections ?? []).filter((r) => r.dropped).length,
      claims_flagged_by_gate: (ex?.rejections ?? []).filter((r) => !r.dropped).length,
      talk_ratio_rep_pct: analytics.shares.find((s) => s.speaker === 'rep')?.pct ?? null,
      questions_asked: analytics.questions,
      run_status: ex?.run_status ?? null,
      // Sent as a signal, never as `dealstage` — see the note at the top of this file.
      deal_stage_observed: company?.stage ?? null,
    },
    requires_custom_properties: SIGNAL_PROPERTIES,
    omitted: omittedCount
      ? [
          {
            unverified_claims: omittedCount,
            reason:
              'The citation gate could not confirm the cited line supports these. They are visible ' +
              'in the app with a warning; they are withheld here because a CRM note outlives its ' +
              'context and becomes the account record.',
          },
        ]
      : [],
    notes_for_the_reader: [
      'Nothing here has been sent. This app has no HubSpot client and no credential; this is the ' +
        'document a push would post.',
      'Association ids are null because no HubSpot object id is stored anywhere in this app. Each ' +
        'carries the lookup that would resolve it rather than an invented id.',
      'No `dealstage` is written. Stage ids are per-portal GUIDs and this app holds its own ' +
        'vocabulary, so a stage write would either be rejected or move the wrong deal. Stage ' +
        'travels as `deal_stage_observed` for a human to act on.',
      'Both note bodies are HTML because hs_note_body and hs_call_body are html fields, which is ' +
        'what lets each claim keep a working link back to the moment that proves it.',
    ],
  };
}

/**
 * The properties somebody would create in HubSpot for the signals to land in fields rather than
 * prose. Shaped exactly like the live API's own property definitions, so this block can be read
 * straight across into a `/crm/v3/properties/{objectType}` call.
 *
 * Listed rather than assumed: none of these exist in a stock portal, and a payload that wrote to
 * them without saying so would silently drop every signal it claims to carry.
 */
export const SIGNAL_PROPERTIES: CustomPropertySpec[] = [
  {
    name: 'kg_intent',
    label: 'Call intent (King Gong)',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation',
    description: 'Read on the deal from the most recent analysed call, e.g. "price-sensitive".',
  },
  {
    name: 'kg_commitments_kept_pct',
    label: 'Commitments kept %',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation',
    description:
      'Share of commitments made on earlier calls that a later call evidenced as done. Empty ' +
      'when nothing has been agreed yet — which is not the same as zero.',
  },
  {
    name: 'kg_open_commitments',
    label: 'Open commitments',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation',
    description: 'Commitments agreed on a call and not yet evidenced as done.',
  },
  {
    name: 'kg_competitors_named',
    label: 'Competitors named on calls',
    type: 'string',
    fieldType: 'textarea',
    groupName: 'dealinformation',
    description: 'Competitors mentioned on analysed calls, each traceable to the line naming them.',
  },
  {
    name: 'kg_claims_dropped',
    label: 'Claims dropped by the citation gate',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation',
    description:
      'How many claims were deleted for citing a line that does not exist or does not support ' +
      'them. A quality signal about the notes, not about the deal.',
  },
];
