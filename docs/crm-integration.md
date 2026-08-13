# Connecting a real CRM (HubSpot)

**Status: design only. Nothing in this document is implemented.**

The account context on the call page currently comes from `lib/crm/fixture.ts` — fabricated records
for the five bundled sample calls, labelled as demo data everywhere they are rendered. This document
describes what replacing that with HubSpot would actually involve.

The important structural point is that **no UI would change**. `lib/crm/types.ts` defines a
`CrmProvider` interface, and `getCrm()` selects an implementation from `CRM_PROVIDER`. A HubSpot
adapter is one new file implementing the same interface:

```ts
// lib/crm/hubspot.ts
export const hubspotCrm: CrmProvider = {
  name: 'hubspot',
  forCall(callId) { /* … */ },
};
```

That is the whole reason the fixture was built as a provider rather than as hardcoded JSX.

---

## 1. Authentication

Two options, and the choice depends on who runs the app.

**Private app token** — one HubSpot account, a long-lived bearer token from
*Settings → Integrations → Private Apps*. Simplest, no OAuth dance, right for an internal tool or a
demo against a sandbox. Sent as `Authorization: Bearer <token>`.

**OAuth 2.0 public app** — needed if OpenGong is installed by other companies. Standard
authorization-code flow, refresh tokens stored per portal, `hub_id` becomes a tenant key. Materially
more work: token refresh, per-tenant storage, an install/uninstall lifecycle.

Either way the credential belongs in the environment, resolved server-side only, and documented in
`.env.example` — the `check:ship` gate scans `lib/**` for `process.env.X` and fails on anything it
finds that the example file does not document.

**Scopes.** Read-only to populate the call page:
`crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`,
`crm.objects.owners.read`. Writing notes back additionally needs the corresponding `.write` scopes.
Request the minimum — a token that can write to deals is a token that can damage a pipeline.

## 2. Reading the context the call page needs

Each field the UI already renders maps onto a HubSpot object:

| `CallContext` field | HubSpot source |
|---|---|
| `account` | Company object — `name`, `domain`, `industry`, `numberofemployees`, `city`/`country` |
| `deal` | Deal object — `dealname`, `dealstage`, `amount`, `closedate`, `hubspot_owner_id` |
| `participants` / `associated` | Contact objects — `firstname`, `lastname`, `jobtitle`, `email`, `phone` |
| `history` | Engagements — calls, meetings, emails, notes |
| `next_meeting` | Meeting engagement with a future `hs_timestamp` |

The joins come from the **associations API** (`/crm/v4/objects/{fromType}/{fromId}/associations/{toType}`),
which is how you walk contact → company → deals, or fetch every contact associated with a deal.
Individual objects come from `/crm/v3/objects/{type}/{id}?properties=…&associations=…`; lookups by
email or domain use `/crm/v3/objects/{type}/search`.

Two practical notes:

- **Properties are opt-in.** A bare object read returns almost nothing useful; you must name every
  property you want in `?properties=`. Forgetting this is the most common "why is it empty" moment.
- **Batch, don't loop.** `/crm/v3/objects/{type}/batch/read` fetches up to a hundred records in one
  call. Fetching contacts one at a time will hit the rate limit and be slow.

**Rate limits** apply per portal and vary by subscription tier — check the current published limits
rather than assuming, handle `429` with backoff, and cache. A call page does not need live CRM reads
on every render; a short-lived cache keyed by deal id is plenty.

## 3. The direction that actually creates value: writing back

Reading context makes a nicer page. Writing the notes back into HubSpot is what would make anyone
adopt this, because it puts cited notes where the deal already lives.

- **Create a Call engagement** — `POST /crm/v3/objects/calls` with `hs_timestamp`,
  `hs_call_title`, `hs_call_body` (the summary), `hs_call_duration`, and `hs_call_recording_url`
  pointing at the stored audio. Then associate it to the contact, company and deal.
- **Or a Note** — `POST /crm/v3/objects/notes` with `hs_note_body`, associated the same way. Simpler,
  and often the better fit for "here are the objections and next steps".
- **Timeline events** — a custom event type lets an app write its own branded entries onto a record's
  timeline, which is the natural home for "call analysed — 3 claims dropped by the citation gate".

**The citation problem is the interesting design question here.** HubSpot renders a note as HTML with
no concept of a segment id, so the receipts have to survive the trip. The honest option is to make
every claim a link back to `/{share_id}#seg_014` on the OpenGong instance, so a reader in HubSpot can
still click through to the moment that proves it. Writing the claims into HubSpot *without* their
citations would strip out precisely the property this product exists to provide — it should be
treated as a non-option rather than a v1 simplification.

## 4. Surfacing OpenGong inside HubSpot

A **CRM card / UI extension** renders custom content directly on a deal or contact record. That is
where cited notes belong for a rep who lives in HubSpot: the record page shows the latest analysed
call, its objections and next steps, each linking back to the audio.

This requires a public app built with HubSpot's developer projects tooling, not a private app.

## 5. Keeping it current

- **Webhooks** for `deal.propertyChange`, `contact.creation` and similar, so cached context does not
  go stale. Requires a public app and a publicly reachable endpoint.
- **Workflow actions** — a HubSpot workflow could call OpenGong when a call recording is attached,
  making analysis automatic rather than an upload someone remembers to do.

## 6. A sensible order of work

1. Private app token against a **sandbox portal**, read-only. Implement `forCall()` by looking up the
   deal, walking associations, and mapping into `CallContext`. No UI changes, no writes.
2. Add caching and `429` handling.
3. Write-back behind an explicit user action ("Push notes to HubSpot"), never automatic — a tool that
   silently writes into a CRM will be uninstalled the first time it writes something wrong.
4. Only then consider OAuth, webhooks and a UI extension.

Before writing any of it, the real object and property shapes can be explored read-only — this
workspace already has HubSpot MCP tooling available, so the schema can be checked against an actual
portal rather than guessed from documentation.

## 7. What must not regress

- `CRM_PROVIDER=hubspot` on a build without the adapter **throws** rather than falling back to the
  fixture. That is deliberate (`lib/crm/index.ts`): a silent fallback would render fabricated
  contacts under a real customer's name, which is indistinguishable from the real thing.
- The **public share route must never receive CRM context.** `app/s/[shareId]/page.tsx` passes only
  `participants`, because everything handed to a client component is serialized into the page — a
  forwarded link would otherwise carry deal values in its HTML. Real customer data makes that a
  genuine disclosure rather than a demo-data curiosity.
- Anything fabricated stays labelled. If a provider ever returns partial or inferred data, it must be
  marked in the UI the way the fixture is today.
