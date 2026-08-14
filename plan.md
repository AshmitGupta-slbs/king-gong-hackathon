# Plan: connect JustCall and HubSpot

**Status:** design only. This file is the implementation plan. Nothing here has been built.

This app already transcribes a call, gates every claim against the transcript, and *previews* the
exact HubSpot document a push would post. It does not pull recordings from a phone system, and it
does not send anything to a CRM. `check:ship` currently **fails the build** if a HubSpot host or
`HUBSPOT_*` env read appears in `app/`, `lib/`, `components/`, or `scripts/`.

JustCall and HubSpot are two different jobs. Do not treat them as one adapter.

| System | Role in this product | Direction |
|---|---|---|
| **JustCall** | Source of call audio + who was on the phone | **In** — recording lands here after a call ends |
| **HubSpot** | Account / contact / deal context, and the place notes should live | **Read** for the call page, **write** only on an explicit user action |
| **This app** | Transcript, cited notes, citation gate | Unchanged |

JustCall already has a native HubSpot marketplace app that logs calls onto records. If that is
on, do **not** create a second HubSpot Call engagement for the same conversation. This product's
value is the **cited note** (every claim links back to `/s/{share_id}#seg_014`), not a duplicate
call log.

```
JustCall call ends
    │
    ▼
webhook  POST /api/ingest/justcall
    │  verify HMAC, ignore missed/voicemail, wait for recording
    ▼
download MP3  GET /v2.1/calls/{id}/recording/download
    │
    ▼
match account  phone / email → HubSpot contact → company + open deal
    │
    ▼
processCall()   existing harness — STT → extract → citation gate
    │
    ▼
rep reviews notes in this app
    │
    ▼
[Push notes to HubSpot]   never automatic
    │
    ▼
POST HubSpot note (HTML, citations intact) + optional custom properties
```

No UI redesign is required for the read path. `lib/crm/types.ts` already defines `CrmProvider`.
The call page already asks `getCrm().forCall(id)` and renders a `CallContext`. A HubSpot adapter
is one new file on that interface. JustCall is a new **ingest** path that ends by calling the
existing `processCall()` in `lib/harness/loop.ts` — the same function the upload form uses.

---

## 0. What is already true in this repo

Read these before writing code. The plan is shaped by them, not the other way around.

- **CRM contract:** `lib/crm/types.ts` — `CrmProvider.forCall()` returns `CallContext | null`.
  Null is allowed; the UI must degrade, not crash.
- **Provider switch:** `lib/crm/index.ts` — `CRM_PROVIDER` selects the adapter. An unknown value
  **throws**. `hubspot` is already listed as a "real" CRM in `REAL_CRM_PROVIDERS`, but there is
  no adapter yet, so `CRM_PROVIDER=hubspot` will throw today. That is correct.
- **Payload preview:** `lib/crm/payload.ts` + `GET /api/calls/{id}/crm-payload` + the
  **CRM payload** tab. Property names were read from a live portal:
  - `hs_note_body` / `hs_call_body` are **HTML**
  - `hs_call_duration` is **milliseconds**
  - **no `dealstage` write** — stage ids are per-portal GUIDs
  - unverified claims are **omitted** from the note and counted under `omitted`
  - association ids are `null` plus a lookup, because nothing stores a HubSpot object id yet
- **Local companies:** `/setup` writes the `companies` table; `db-crm` projects those rows into
  `CallContext`. That stays as the offline / demo path.
- **Ingest:** `POST /api/calls` accepts a file or an https URL, persists audio under
  `data/uploads`, then runs `processCall()`. JustCall should reuse that, not invent a second
  pipeline.
- **Share page:** `app/s/[shareId]/page.tsx` may pass **participants only** into the client.
  Everything handed to a client component is serialized into the HTML. Real HubSpot deal values
  on a forwarded link would be a disclosure.
- **Ship gate:** `scripts/check-ship.ts` §9 forbids HubSpot egress. Implementing a real client
  means **replacing that check** with a narrower one (credentials only from env, no send except
  behind an explicit push route), not deleting it.

Full HubSpot design notes already live in [`docs/crm-integration.md`](docs/crm-integration.md).
This plan adds JustCall and the join between the two.

---

## 1. Probe first — do not guess shapes

Before writing adapters, confirm the live objects. The HubSpot payload already exists because
someone did this for HubSpot; JustCall has not been probed from this repo.

### JustCall (sandbox / your account)

| Check | How | Why it matters |
|---|---|---|
| Auth header | `Authorization: {api_key}:{api_secret}` against `GET https://api.justcall.io/v2.1/calls?page=1` | Confirm the header form; docs say colon-joined, not Bearer |
| Call object | One completed answered call | Confirm `id` vs `call_sid`, `contact_number`, `contact_email`, `recording`, `call_info.direction`, `call_info.type` |
| Recording readiness | Hit `GET /v2.1/calls/{id}/recording/download` immediately after `call.completed` | Recordings are generated **after** hangup. The webhook often fires before the file exists. You will need a short poll (e.g. 5 / 15 / 30s), not a single download |
| Webhook validation | JustCall POSTs a probe with `type` and almost no `data` when you save a URL | The route must return **200** on that probe or JustCall refuses to save the webhook |
| Signature | `x-justcall-signature` = HMAC-SHA256 of `secret\|encoded_url\|type\|timestamp` | Reject unsigned or stale requests. Use the **API secret**, not the key |
| History window | List calls older than 90 days | API history is **last 3 months**. Backfill is a one-shot export via JustCall support, not a pagination trick |

Do not use JustCall AI's own `call_summary` / `call_transcription` as our notes. Those have no
citation gate. We transcribe with PyAI Hear and extract through the existing harness.

### HubSpot (sandbox portal)

Already partly done — see `docs/crm-integration.md`. Still confirm on **your** portal:

| Check | Why |
|---|---|
| Search contact by phone (`phone`, `mobilephone`) | JustCall's join key is usually a number, not an email |
| Search contact by email | Fallback when JustCall sends `contact_email` |
| Associations: contact → company → open deals | This is how `forCall()` gets `CallContext` |
| Whether JustCall's HubSpot app is already logging Calls | Decides if we write a **Note only**, or a Note + Call |
| Custom properties `kg_*` from `lib/crm/payload.ts` | They do not exist in a stock portal. Create them before any write, or the signals silently drop |

---

## 2. Authentication and secrets

All credentials live in the environment. Document every new name in `.env.example` with an empty
placeholder. `check:ship` already fails if `lib/**` reads an env var the example file does not
name.

```bash
# JustCall — Profile → APIs and Webhooks. Never commit these.
JUSTCALL_API_KEY=
JUSTCALL_API_SECRET=
# Optional override if you point at a mock.
# JUSTCALL_BASE_URL=https://api.justcall.io

# HubSpot — Settings → Integrations → Private Apps. Sandbox first.
HUBSPOT_ACCESS_TOKEN=
# HUBSPOT_BASE_URL=https://api.hubapi.com

# Public origin for webhook registration and citation links in HubSpot notes.
# Locally this is an ngrok / Cloudflare Tunnel URL, not localhost.
APP_PUBLIC_URL=
```

**JustCall:** API key + secret. Sent as `Authorization: api_key:api_secret`. Regenerating the
secret also invalidates webhook signatures — treat rotation as a paired change.

**HubSpot, v1:** a **private app token** against a sandbox portal. Bearer token, no OAuth dance.
Right for an internal tool. Scopes, minimum:

- Read: `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`,
  `crm.objects.owners.read`
- Write (only when push ships): `crm.objects.notes.write`, and `crm.objects.calls.write` only if
  you decide to create Call engagements
- Do **not** request deal-write / pipeline scopes. This app must not move `dealstage`.

**HubSpot, later:** OAuth public app, only if other companies will install this. That is a
different product (per-portal tokens, refresh, install lifecycle). Do not start there.

Server-side only. No token in client bundles, logs, NDJSON progress, or API error bodies.

---

## 3. Data you must persist (new, small)

Nothing in this app stores a vendor object id today. Matching will be wrong and writes will
duplicate without these.

Add columns / fields (SQLite + Mongo — both `Store` implementations):

**On `calls` (or a sibling `call_sources` table):**

| Field | Purpose |
|---|---|
| `justcall_id` | Numeric JustCall call id. Unique. Dedupes webhooks and retries |
| `justcall_sid` | `call_sid` — some webhook events omit `id` |
| `source` | `'upload' \| 'justcall' \| 'sample'` |
| `hubspot_note_id` | Set after a successful push, so a second push updates rather than duplicates |
| `hubspot_call_id` | Only if you create Call engagements |

**On `companies`:**

| Field | Purpose |
|---|---|
| `hubspot_company_id` | Stable join after the first resolve |
| `hubspot_deal_id` | The open deal we attached, or null |

**On company `detail.participants` / a `contacts` map:**

| Field | Purpose |
|---|---|
| `hubspot_contact_id` | So the next call does not re-search by phone |
| `phone` | Already optional on `Person` — make sure JustCall's `contact_number` is stored E.164 |

Keep vendor ids **out** of `lib/types.ts` Call if you can: a `call_sources` table leaves the
citation contract untouched and avoids `check:ship` fights about what a Call is.

Idempotency rule: a webhook for a `justcall_id` that already has a call row is a no-op (200),
not a second `processCall()`.

---

## 4. Matching: JustCall person → HubSpot record → our company

This is the join. Get it wrong and notes land on the wrong deal.

Order of lookup, first hit wins:

1. **Stored id** — if we have seen this JustCall contact / HubSpot contact before.
2. **Email** — `contact_email` from JustCall → HubSpot contact search
   `POST /crm/v3/objects/contacts/search` on `email`.
3. **Phone** — normalise `contact_number` to E.164, search HubSpot `phone` and `mobilephone`.
   Phone matching is messy (leading `+`, country code, extensions). Log the raw and the
   normalised form; never invent a contact because the number was close.
4. **No match** — still ingest the call. Link no company. The UI already allows "analyse
   without context". A Setup picker (or a later "Link to HubSpot record" action) attaches it.
   Do **not** auto-create HubSpot contacts from a phone number. That is how junk records get
   into a live portal.

Then walk associations:

```
contact ──associations──▶ company ──associations──▶ deals
```

Pick the **most recently updated open deal** on that company. If there are several, show the
choice on the call page rather than guessing. Persist `hubspot_deal_id` only after a human
confirms, or when there is exactly one open deal.

Map into existing `CallContext` / `Company`:

| Our field | Source |
|---|---|
| `account` | HubSpot company: `name`, `domain`, `industry`, `numberofemployees`, `city`/`country` |
| `deal` | HubSpot deal: `dealname`, `amount`, `closedate`, owner name. **Stage label** is display-only — map their pipeline label into our `DealStage` enum when it is an obvious synonym, otherwise keep their label in `detail` and do not force it into `DealStageSchema` |
| `participants` | JustCall `agent_*` → `side: 'internal'`, `speaker: 'rep'`; JustCall `contact_*` → `side: 'external'`, `speaker: 'prospect'` |
| `associated` | Other contacts on the company, not on this call |
| `history` | Recent HubSpot engagements (calls, notes, meetings) |
| `next_meeting` | Future meeting engagement, or null |

HubSpot properties are **opt-in**. A bare object read returns almost nothing. Name every
property. Batch reads (`/crm/v3/objects/{type}/batch/read`, 100 at a time). Handle `429` with
backoff. Cache `forCall()` briefly (deal-id key, 60–120s) so the call page does not live-read
the portal on every render.

---

## 5. JustCall ingest (build this first)

JustCall without HubSpot is still useful: recordings arrive and get analysed. HubSpot without
JustCall is a nicer call page for **manual** uploads. Do JustCall first.

### 5.1 Client — `lib/justcall/` (new)

Mirror the PyAI rule: only this folder talks to `api.justcall.io`.

| File | Job |
|---|---|
| `lib/justcall/client.ts` | `justcallGet` / download. Auth header. Never log the secret |
| `lib/justcall/types.ts` | Our mapping of the call object — not the vendor payload leaked upward |
| `lib/justcall/verify.ts` | HMAC check + timestamp skew (e.g. reject if older than 5 minutes) |
| `lib/justcall/ingest.ts` | Dedup → wait for recording → download → `processCall()` |

Endpoints:

- `GET /v2.1/calls/{id}` — full object when the webhook is thin
- `GET /v2.1/calls/{id}/recording/download` — bytes (typically MP3)
- `GET /v2.1/calls` — optional backfill / "Import last 7 days" button

Skip: missed, voicemail, abandoned, unanswered, and any call with no recording. Return 200 so
JustCall does not retry forever; record a skipped-ingest row if you want the audit.

### 5.2 Webhook — `POST /api/ingest/justcall`

Must run on the Node runtime (`export const runtime = 'nodejs'`), `maxDuration` high enough
for download + STT (same 300s as `/api/calls`).

1. If the body is JustCall's URL-validation probe (`type` set, empty `data`) → **200**.
2. Read raw body, verify `x-justcall-signature` with `JUSTCALL_API_SECRET`. Fail closed (401).
3. Accept `call.completed` (and `sd.call_completed` if you use Sales Dialer). Ignore the rest
   with 200.
4. If `justcall_id` / `call_sid` already ingested → 200.
5. If recording URL is empty → enqueue a short poll; do not fail the webhook. JustCall retries
   5 times; a slow poll inside the request is better than a 500 that causes duplicate retries.
6. Persist audio under `uploadDir()` the same way `app/api/calls/route.ts` does. Filename from
   sniffed bytes (`lib/wav.ts` already accepts MP3).
7. Resolve company (HubSpot match if the adapter is on, else leave unlinked).
8. Call `processCall({ title, audio, filename, audioPath, mode: 'auto', companyId })`.
   Title suggestion: `{contact_name or number} — {agent_name} — {date}`.
   `deriveCallTitle()` will replace it after extraction, as it does for uploads.
9. Respond 200 as soon as the run is **opened** if the work is too long for JustCall's
   timeout; otherwise wait for `processCall()` to finish. Prefer: 200 + run in-process (same
   as today's upload stream), because there is no job queue in this repo yet.

Locally you need a public HTTPS URL (`APP_PUBLIC_URL`) via a tunnel. JustCall will not post to
`localhost`.

### 5.3 Optional: manual import

A Setup button: "Pull last N days from JustCall". Uses the list endpoint, same ingest
function, same dedup. Useful when the webhook was down.

### 5.4 What not to build

- No JustCall dialer embed, SMS, or voicemail transcription product.
- No second STT path. `OPENGONG_STT` stays `pyai-jobs` / `fixture`.
- No writing notes back into JustCall. HubSpot is the system of record for the deal.

---

## 6. HubSpot adapter (build this second)

### 6.1 Read — `lib/crm/hubspot.ts`

```ts
export const hubspotCrm: CrmProvider = {
  name: 'hubspot',
  async forCall(callId) { /* resolve stored ids or search; map to CallContext */ },
};
```

Register it in `lib/crm/index.ts`. `CRM_PROVIDER=hubspot` then works. Leave `db` as the
default so a clone with no token still boots.

`forCall()`:

1. Load our call → company link and any stored HubSpot ids.
2. If ids exist, batch-read those objects.
3. If not, this call has no CRM context (manual upload with no account) → `null`.
4. JustCall-ingested calls should already have been matched at ingest time and linked.

Do not call HubSpot from `app/s/[shareId]/page.tsx` beyond what is needed for participant
names — and even then, prefer ids we already stored on the call rather than a live portal
read on a public URL.

### 6.2 Write — explicit push only

Add `POST /api/calls/[id]/crm-push` (not a GET, not automatic after extract).

- Requires `HUBSPOT_ACCESS_TOKEN`.
- Reuses `toHubspotPayload()` from `lib/crm/payload.ts`.
- Resolves `Association.id` via the stored HubSpot ids (this is why §3 exists). If an id is
  still null, **do not invent one** — skip that association and say so in the response.
- Creates the **Note** (`hs_note_body` HTML with citation `<a>` tags).
- Creates the **Call** engagement only if JustCall is **not** already writing one to this
  portal. Default to Note-only; make Call creation a flag (`HUBSPOT_WRITE_CALLS=0`).
- After success, store `hubspot_note_id`. A second push PATCHes that note.
- Never writes `dealstage`.
- Never includes unverified claims (already true in `toHubspotPayload`).
- Button on the existing CRM payload tab: **Push to HubSpot**, disabled when there is no
  token, no resolved company id, or the run is not `shipped` / `partial`.

Citation links in the note must use `APP_PUBLIC_URL` (or the request origin on a real host),
same as today's payload builder. A `localhost` link inside HubSpot is useless.

### 6.3 Customising and updating HubSpot properties

There are **two different HubSpot operations**. Mixing them up is the usual failure mode:
you write `kg_intent` onto a deal, HubSpot accepts the PATCH, and the value vanishes because
the property was never created.

| Layer | What it is | API | When |
|---|---|---|---|
| **Schema** | Create / rename / retarget the *field itself* | `POST/PATCH /crm/v3/properties/{objectType}` | Once per portal, from Setup or `scripts/check-hubspot.ts` |
| **Values** | Put a number or string *on a record* | `PATCH /crm/v3/objects/{objectType}/{id}` | Every **Push to HubSpot**, never automatically |

`lib/crm/payload.ts` already describes both: `requires_custom_properties` is the schema
block, `signals` is the value block. The push path should consume those two objects rather
than inventing a second mapping.

#### What this app already wants on the deal

These names are the internal HubSpot `name` (lowercase, underscores). The label is what a
rep sees. None of them exist in a stock portal.

| Internal name | Type | Value on push | Source in this app |
|---|---|---|---|
| `kg_intent` | text | e.g. `price-sensitive` | `extraction.intent.label` — only if `verdict === 'verified'` |
| `kg_commitments_kept_pct` | number | 0–100, or empty | `followThrough(actionItems).pct` — empty when `total === 0` (not the same as 0) |
| `kg_open_commitments` | number | count | open action items on that company |
| `kg_competitors_named` | textarea | newline- or semicolon-joined | verified `key_moments` of type `competitor_mention` |
| `kg_claims_dropped` | number | count | `rejections` where `dropped` |

All five sit in the `dealinformation` group so they appear on the deal record, not the
contact. That is deliberate: intent and competitors are deal facts.

#### A. Create the properties (schema) — do this once

**In the HubSpot UI (fine for a sandbox, no code):**

1. Settings → Data Management → Properties → **Deal** properties.
2. Create a group if you want one, e.g. "King Gong".
3. Create each field above. Internal name must match exactly (`kg_intent`, not
   `kgIntent` or `KG Intent`). Type must match the table.
4. Add them to the deal sidebar / a view so a rep can see them without opening the
   property list.

**Via API (what the app should do on Setup → "Ensure HubSpot properties"):**

Scope needed beyond object read/write: `crm.schemas.deals.write` (and
`crm.schemas.companies.write` if you later put fields on the company).

```
GET  /crm/v3/properties/deals
POST /crm/v3/properties/deals          # create one
PATCH /crm/v3/properties/deals/{name}  # change label / description / group — not the type
```

Create body is exactly `CustomPropertySpec` in `lib/crm/payload.ts`:

```json
{
  "name": "kg_intent",
  "label": "Call intent (King Gong)",
  "type": "string",
  "fieldType": "text",
  "groupName": "dealinformation",
  "description": "Read on the deal from the most recent analysed call."
}
```

Rules:

- **Idempotent.** GET first; POST only if missing. A second POST for the same `name` is a
  409, not an update.
- **Do not create properties on every call push.** Schema drift mid-demo is how you get
  two similarly named fields and writes going to the wrong one.
- **You cannot change `type` / `fieldType` after create.** If you picked `string` and
  needed `number`, create a new name and stop writing the old one.
- **`name` is permanent.** Label and description can PATCH; the internal name cannot.
- Verify `groupName` against *this* portal (`GET /crm/v3/properties/deals/groups`).
  `dealinformation` is standard; a renamed portal may not have it.

`scripts/check-hubspot.ts` should print, for each spec: present / missing / type-mismatch.
A `--apply` flag (or a Setup button) creates the missing ones and does nothing else.

#### B. Write values onto the deal (every push)

After the note is created, PATCH the deal you already resolved in §4:

```
PATCH /crm/v3/objects/deals/{hubspot_deal_id}
{
  "properties": {
    "kg_intent": "price-sensitive",
    "kg_commitments_kept_pct": "67",
    "kg_open_commitments": "2",
    "kg_competitors_named": "Gong; Chorus",
    "kg_claims_dropped": "1"
  }
}
```

HubSpot wants property values as **strings** on the wire, including numbers.

If `hubspot_deal_id` is null (no match, or several open deals and nobody picked), skip the
property PATCH and say so. Do not write onto a guessed deal.

Empty vs zero: omit `kg_commitments_kept_pct` when there are no commitments yet. Sending
`"0"` tells a CRO the team is failing; omitting it tells them there is nothing to measure.

A second push overwrites the same fields with the latest analysed call. These properties
mean "as of the last King Gong push", not a history. History lives in the Note.

#### C. Adding your own properties

To customise beyond the five shipped fields:

1. Add a `CustomPropertySpec` to `SIGNAL_PROPERTIES` in `lib/crm/payload.ts`.
2. Add the value to `signals` in `toHubspotPayload()` — derived only from **verified**
   claims or from stored action items, never from an unverified line.
3. Re-run schema ensure (`check-hubspot --apply` or the Setup button).
4. Map that signal into the deal PATCH in `lib/crm/push.ts`.

Keep a single allowlist. The push module must not accept an arbitrary property name from
the client — that is how `dealstage` or `amount` gets overwritten by a crafted request.

Suggested extra fields if you want them later (not v1):

| Name | Type | Value |
|---|---|---|
| `kg_last_call_at` | datetime | `call.created_at` |
| `kg_last_call_url` | text | share URL |
| `kg_run_status` | enumeration | `shipped` / `partial` / `failed` |
| `kg_talk_ratio_rep` | number | analytics `rep` share |

Do **not** add `kg_deal_stage` as a write to HubSpot's `dealstage`. If you want the
observed stage visible, store it as our own text field (`kg_stage_observed`) for a human
to act on.

#### D. Updating stock HubSpot properties (name, phone, amount, …)

Allowed only through an explicit allowlist, default **off**.

Safe, if a human confirms on the call page:

- Contact `phone` / `mobilephone` from JustCall `contact_number` when HubSpot's is empty
- Contact `email` from JustCall when HubSpot's is empty

Never auto-write:

- `dealstage` — per-portal GUIDs; a wrong write moves the deal
- `amount`, `closedate`, `hubspot_owner_id`
- `name` / `firstname` / `lastname` because ASR or JustCall's caller-id guessed them
- Anything the citation gate did not verify

Fill-if-empty is the only default that will not fight a CRM admin. Overwrite requires a
checkbox on the push dialog ("also update contact phone").

#### E. Showing them in HubSpot

Creating a property does not put it on the deal card. After schema ensure:

1. Open a deal → Customize record → add the `kg_*` fields to the about section, **or**
2. Build a deal view / report filtered on `kg_intent`, `kg_open_commitments`.

Without this step the API write succeeds and nobody can see it. That is a HubSpot UI
task, not an API one — mention it in the demo script.

#### F. Scopes

| Action | Scope |
|---|---|
| Read deal/contact/company values | `crm.objects.*.read` |
| PATCH values on a deal | `crm.objects.deals.write` |
| Create / update the `kg_*` field definitions | `crm.schemas.deals.write` |
| Same on companies | `crm.schemas.companies.write` |

A token that can write schemas can also create junk properties. Keep schema ensure on
Setup, behind a button, not on the request path.

### 6.4 Update `check:ship`

Replace "no HubSpot client exists" with:

- Credentials only via `process.env.HUBSPOT_ACCESS_TOKEN` (and documented in `.env.example`).
- The only outbound `hubapi.com` / `hubspot.com` hosts live under `lib/crm/hubspot.ts` (and
  maybe `lib/crm/push.ts`).
- No send from `toHubspotPayload` itself — that module stays a pure function.
- No HubSpot import from `app/s/`.

Same idea for JustCall: only `lib/justcall/**` may mention `api.justcall.io`.

---

## 7. Suggested order of work

Each step should be demoable on its own. Do not start OAuth, CRM cards, or webhooks-from-HubSpot
until 1–6 work against a sandbox.

| # | Work | Done when |
|---|---|---|
| 1 | Probe JustCall + HubSpot sandbox; write findings into `docs/api-truth.md` (or a sibling `docs/justcall-truth.md`) | One real call object and one recording download captured; phone-search result from HubSpot known |
| 2 | Persist source ids (`justcall_id`, HubSpot ids) on both stores | `npm run test:store` still passes; SQLite and Mongo both compile |
| 3 | `lib/justcall` client + signature verify + ingest function | A local MP3 from `recording/download` runs through `processCall()` |
| 4 | `POST /api/ingest/justcall` + tunnel + `call.completed` | Hang up a real JustCall test call → it appears in the call list, analysed |
| 5 | Dedup, skip-without-recording, recording poll | Double-fire webhook does not create two calls |
| 6 | `lib/crm/hubspot.ts` read-only `forCall()` + `CRM_PROVIDER=hubspot` | Call page shows the real company / deal for a matched JustCall ingest; demo fixture still default |
| 7 | Phone / email match + "no match" path | Unknown number still analyses; Setup can attach later |
| 8 | Relax `check:ship`; `POST /api/calls/[id]/crm-push` + button | Pushing a **shipped** call creates one HubSpot note with working citation links; unverified claims absent; no `dealstage` write |
| 8b | Schema ensure for `kg_*` (`check-hubspot --apply` or Setup button) then PATCH deal properties on the same push | Deal record shows intent / commitments / competitors after push; missing property is created once, not per call; type-mismatch is reported not overwritten |
| 9 | Store `hubspot_note_id`; second push updates note **and** the same `kg_*` values | No duplicate notes; properties reflect the latest push |
| 10 | Optional: JustCall "import last 7 days" on Setup | Backfill without the webhook |
| 11 | Later, not v1: OAuth, HubSpot UI card, HubSpot workflow trigger, webhooks for stale cache | Only if this is installed by other companies |

Do **not** auto-push after extraction. A silent CRM write will be uninstalled the first time
the gate is wrong or the match hits the wrong deal.

---

## 8. Files to add or touch

**New**

```
lib/justcall/client.ts
lib/justcall/types.ts
lib/justcall/verify.ts
lib/justcall/ingest.ts
lib/crm/hubspot.ts          # read
lib/crm/push.ts             # write; the only module that POSTs to HubSpot
lib/crm/properties.ts       # ensure SIGNAL_PROPERTIES exist; PATCH values from signals
app/api/ingest/justcall/route.ts
app/api/calls/[id]/crm-push/route.ts
scripts/check-justcall.ts   # like check:key — is the credential alive?
scripts/check-hubspot.ts    # token, scopes, kg_* properties
docs/justcall-truth.md      # probed facts, same standard as docs/api-truth.md
```

**Touch**

```
lib/crm/index.ts            # register hubspot
lib/db-types.ts             # Store methods for source ids
lib/db-sqlite.ts
lib/db-mongo.ts
lib/company-types.ts        # optional hubspot_* on Company
.env.example                # every new env name
scripts/check-ship.ts       # replace the "no HubSpot client" rule
components/workspace/CrmPayload.tsx   # Push button
docs/crm-integration.md     # point at this plan; mark write path as real once shipped
```

**Do not touch for this work**

- `lib/harness/gate.ts` / citation rules
- `lib/types.ts` claim / segment contract
- Public share page's "participants only" rule
- Sample fixtures (they stay offline and need no vendor)

---

## 9. What must not regress

- **`CRM_PROVIDER=hubspot` without the adapter still throws.** Never fall back to fixture
  data under a real customer's name.
- **Share links never serialize deal context.** `app/s/[shareId]/page.tsx` stays participants
  only. Test this with a real HubSpot-backed call before calling the write path done.
- **Unverified claims stay out of HubSpot.** The preview and the push must use the same
  `toHubspotPayload()` function.
- **No `dealstage` write.** Stage is a signal for a human.
- **No secrets in git, logs, or UI.** Masked key prefixes only (the PyAI `describeKey()`
  pattern).
- **Demo path stays zero-setup.** Unset credentials → JustCall ingest disabled, HubSpot
  adapter not selected, five sample calls still work.
- **Citation gate still owns the notes.** JustCall AI summaries are metadata at most, never
  a substitute for `processCall()`.

---

## 10. Risks you will actually hit

| Risk | What to do |
|---|---|
| Recording not ready when `call.completed` fires | Poll download 3–4 times; 200 the webhook; do not mark the run failed on the first empty recording |
| PyAI `stt:` / `diarize:` 500 windows | Already documented in `docs/api-truth.md`. Ingest must tolerate a failed run the same way upload does — the run is recorded, the audio is kept, retry is a button |
| Phone match hits the wrong contact | Require exact E.164; if multiple HubSpot contacts share a number, do not pick — leave unlinked |
| JustCall + HubSpot native app already logged the call | Write a Note only (`HUBSPOT_WRITE_CALLS=0`) |
| `check:ship` goes red the moment you add a client | Update the gate in the same PR as the client, or the PR cannot merge |
| Local webhook | Tunnel + `APP_PUBLIC_URL`. Document the JustCall webhook URL as `{APP_PUBLIC_URL}/api/ingest/justcall` |
| Mongo vs SQLite | Source-id fields must land in **both** stores. `scripts/test-store.ts` is the checklist |
| HTML in HubSpot | Escape claim text (`esc()` already in `payload.ts`). Only our citation `<a>` tags are markup |

---

## 11. Out of scope for v1

- HubSpot public-app OAuth and marketplace listing
- HubSpot CRM card / UI extension
- HubSpot workflow "when recording attached → analyse"
- Writing `dealstage`, amount, or close date
- Creating HubSpot contacts or companies
- JustCall SMS, voicemail product, or Sales Dialer campaign controls
- Replacing PyAI Hear with JustCall AI transcripts
- Multi-tenant / several JustCall accounts in one deploy

---

## 12. How to tell it worked

1. `npm run check:justcall` → key accepted.
2. `npm run check:hubspot` → token accepted, `kg_*` properties present or listed as missing.
3. Place a 30-second JustCall call to a HubSpot contact whose phone is on the record.
4. Within a minute the call appears in this app, transcript + gated notes, company panel
   filled from HubSpot.
5. CRM payload tab shows real association ids (no longer all `null`).
6. **Push to HubSpot** creates one note on that contact/company/deal. Each objection is a
   link; clicking it opens `/s/{share_id}#seg_…` and plays the line.
7. Push again → same note updated, not a second note.
8. A call to an unknown number still analyses, with no HubSpot write enabled.
9. `npm run verify` still passes. Share-page HTML for that call contains no deal amount.
