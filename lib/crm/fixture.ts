/**
 * Fabricated CRM records for the five committed sample calls.
 *
 * THIS IS DEMO DATA. Nobody here is real. It exists so the call page can show what the product
 * looks like against a CRM without shipping credentials, and it is served through the same
 * `CrmProvider` interface a real HubSpot adapter would implement — so replacing it changes one
 * file and no UI.
 *
 * Two rules were followed, and both matter more than they look:
 *
 * 1. **Every detail is anchored in something actually said on the call.** Marcus really does hand
 *    procurement to "elena"; Priya really is blocked on a privacy office; Bright Harbour's VP
 *    really did come from a company that used Gong. Fabricated context that contradicts the
 *    recording would be visible on screen the moment anyone read both halves.
 * 2. **Dates are fixed strings, never computed from `Date.now()`.** A demo that silently re-dates
 *    itself overnight is a demo that breaks on stage.
 */
import type { CallContext, CrmProvider } from './types';

const REP = {
  id: 'user_sam',
  name: 'Sam Ellis',
  title: 'Account Executive',
  email: 'sam.ellis@opengong.example',
  side: 'internal' as const,
  speaker: 'rep',
};

const CONTEXTS: Record<string, CallContext> = {
  // ── "Northwind Logistics — final call, closed won" ─────────────────────────
  // Security signed off Monday, 40 seats across two sales pods, paper out for signature.
  'clean-close': {
    account: {
      id: 'acc_northwind',
      name: 'Northwind Logistics',
      domain: 'northwind-logistics.example',
      industry: 'Freight & Logistics',
      employees: '1,200',
      location: 'Rotterdam, NL',
    },
    deal: {
      id: 'deal_northwind_1',
      name: 'Northwind Logistics — Revenue Intelligence',
      stage: 'Closed Won',
      amount: 58000,
      currency: 'USD',
      close_date: '2026-08-14',
      owner: 'Sam Ellis',
      days_in_stage: 2,
    },
    participants: [
      REP,
      {
        id: 'con_marcus',
        name: 'Marcus de Vries',
        title: 'VP Revenue Operations',
        email: 'marcus.devries@northwind-logistics.example',
        phone: '+31 10 555 0142',
        side: 'external',
        speaker: 'prospect',
      },
    ],
    associated: [
      {
        // Named on the call: "just cocky elena on it she's handling the vendor forms".
        id: 'con_elena',
        name: 'Elena Kowalski',
        title: 'Procurement Manager',
        email: 'elena.kowalski@northwind-logistics.example',
        side: 'external',
      },
      {
        id: 'con_security',
        name: 'Joris Bakker',
        title: 'Head of Information Security',
        email: 'joris.bakker@northwind-logistics.example',
        side: 'external',
      },
    ],
    history: [
      {
        id: 'act_nw_4',
        date: '2026-08-13',
        title: 'Final call — commercials and signature',
        kind: 'call',
        summary: '40 seats agreed with a pre-agreed 10-seat expansion. Paper to go out same day.',
        call_id: 'clean-close',
      },
      {
        id: 'act_nw_3',
        date: '2026-08-10',
        title: 'Security review returned clean',
        kind: 'note',
        summary: 'InfoSec signed off Monday — the last blocker Marcus had flagged.',
      },
      {
        id: 'act_nw_2',
        date: '2026-07-28',
        title: 'Security review kickoff',
        kind: 'meeting',
        summary: 'Joris took the DPA and deployment options to his team.',
      },
      {
        id: 'act_nw_1',
        date: '2026-07-15',
        title: 'Discovery — two sales pods, ramp time',
        kind: 'call',
        summary: 'Scoped 40 seats across the Rotterdam and Hamburg pods.',
      },
    ],
    next_meeting: null, // Closed Won — nothing to book.
  },

  // ── "Halcyon Health — discovery, heavy objections" ─────────────────────────
  // Prior tool failed on adoption, privacy office is the gate, no bandwidth.
  'heavy-objections': {
    account: {
      id: 'acc_halcyon',
      name: 'Halcyon Health',
      domain: 'halcyonhealth.example',
      industry: 'Healthcare Technology',
      employees: '3,400',
      location: 'Boston, MA',
    },
    deal: {
      id: 'deal_halcyon_1',
      name: 'Halcyon Health — Enablement Pilot',
      stage: 'Discovery',
      amount: 42000,
      currency: 'USD',
      close_date: '2026-11-30',
      owner: 'Sam Ellis',
      days_in_stage: 11,
    },
    participants: [
      REP,
      {
        id: 'con_priya',
        name: 'Priya Raman',
        title: 'Director of Sales Enablement',
        email: 'priya.raman@halcyonhealth.example',
        phone: '+1 617 555 0188',
        side: 'external',
        speaker: 'prospect',
      },
    ],
    associated: [
      {
        // The privacy office Priya says everything must clear.
        id: 'con_privacy',
        name: 'Dr. Alan Whitcombe',
        title: 'Chief Privacy Officer',
        email: 'alan.whitcombe@halcyonhealth.example',
        side: 'external',
      },
      {
        id: 'con_halcyon_vp',
        name: 'Rebecca Lind',
        title: 'VP Sales, East',
        email: 'rebecca.lind@halcyonhealth.example',
        side: 'external',
      },
    ],
    history: [
      {
        id: 'act_hh_2',
        date: '2026-08-13',
        title: 'Discovery — three blockers named',
        kind: 'call',
        summary: 'Rep trust, the privacy review, and no bandwidth to drive a rollout.',
        call_id: 'heavy-objections',
      },
      {
        id: 'act_hh_1',
        date: '2026-08-04',
        title: 'Intro email',
        kind: 'email',
        summary: 'Referred in by Rebecca Lind after a peer recommendation.',
      },
    ],
    next_meeting: null, // Priya explicitly refused to commit to a timeline.
  },

  // ── "Bright Harbour Software — competitive evaluation" ─────────────────────
  // Down to three: us, Gong, Chorus. The VP trusts Gong. Decision meeting on the 20th.
  'competitor-named': {
    account: {
      id: 'acc_brightharbour',
      name: 'Bright Harbour Software',
      domain: 'brightharbour.example',
      industry: 'B2B SaaS',
      employees: '640',
      location: 'Austin, TX',
    },
    deal: {
      id: 'deal_bh_1',
      name: 'Bright Harbour — Conversation Intelligence',
      stage: 'Evaluation',
      amount: 51000,
      currency: 'USD',
      close_date: '2026-09-20',
      owner: 'Sam Ellis',
      days_in_stage: 6,
    },
    participants: [
      REP,
      {
        id: 'con_dana',
        name: 'Dana Osei',
        title: 'Director of Revenue Enablement',
        email: 'dana.osei@brightharbour.example',
        phone: '+1 512 555 0119',
        side: 'external',
        speaker: 'prospect',
      },
    ],
    associated: [
      {
        // "our vp came from a company that used gong and he trusts it" — the real decision-maker.
        id: 'con_bh_vp',
        name: 'Ryan Delacroix',
        title: 'VP Sales',
        email: 'ryan.delacroix@brightharbour.example',
        side: 'external',
      },
      {
        id: 'con_bh_ops',
        name: 'Meera Patel',
        title: 'Sales Operations Lead',
        email: 'meera.patel@brightharbour.example',
        side: 'external',
      },
    ],
    history: [
      {
        id: 'act_bh_3',
        date: '2026-08-13',
        title: 'Competitive evaluation call',
        kind: 'call',
        summary: 'Down to three vendors. Price and suite bloat are the objections to Gong.',
        call_id: 'competitor-named',
      },
      {
        id: 'act_bh_2',
        date: '2026-08-06',
        title: 'Fireflies ruled out',
        kind: 'note',
        summary: 'Dana reported Fireflies lacked the coaching side they needed.',
      },
      {
        id: 'act_bh_1',
        date: '2026-07-22',
        title: 'Initial demo',
        kind: 'meeting',
        summary: 'Dana and Meera attended. Ryan did not.',
      },
    ],
    next_meeting: { date: '2026-08-20', title: 'Internal decision meeting (Ryan attending)' },
  },

  // ── "Cobalt Freight — pricing pushback" ────────────────────────────────────
  // $1,400/seat is the blocker. 25 seats. Finance committee. Under $5k year one and she can self-approve.
  'pricing-pushback': {
    account: {
      id: 'acc_cobalt',
      name: 'Cobalt Freight',
      domain: 'cobaltfreight.example',
      industry: 'Transportation',
      employees: '2,100',
      location: 'Chicago, IL',
    },
    deal: {
      id: 'deal_cobalt_1',
      name: 'Cobalt Freight — 25 seat rollout',
      stage: 'Negotiation',
      amount: 35000,
      currency: 'USD',
      close_date: '2026-09-30',
      owner: 'Sam Ellis',
      days_in_stage: 19,
    },
    participants: [
      REP,
      {
        id: 'con_helen',
        name: 'Helen Marsh',
        title: 'Head of Sales',
        email: 'helen.marsh@cobaltfreight.example',
        phone: '+1 312 555 0176',
        side: 'external',
        speaker: 'prospect',
      },
    ],
    associated: [
      {
        // "our cfo has been very clear this year that anything new has to displace something existing".
        id: 'con_cobalt_cfo',
        name: 'David Ngata',
        title: 'Chief Financial Officer',
        email: 'david.ngata@cobaltfreight.example',
        side: 'external',
      },
      {
        id: 'con_cobalt_proc',
        name: 'Suzanne Okafor',
        title: 'Procurement Lead',
        email: 'suzanne.okafor@cobaltfreight.example',
        side: 'external',
      },
    ],
    history: [
      {
        id: 'act_cf_3',
        date: '2026-08-13',
        title: 'Pricing pushback',
        kind: 'call',
        summary: 'Needs a ~50% gap closed on price or on what the tool retires.',
        call_id: 'pricing-pushback',
      },
      {
        id: 'act_cf_2',
        date: '2026-08-09',
        title: 'Proposal sent',
        kind: 'email',
        summary: '25 seats at list. Helen circulated internally before the finance committee.',
      },
      {
        id: 'act_cf_1',
        date: '2026-07-30',
        title: 'Scoping call',
        kind: 'call',
        summary: 'Sized at 25 seats to start, expanding to the second depot next year.',
      },
    ],
    next_meeting: { date: '2026-08-27', title: 'Revised pricing + displacement comparison' },
  },

  // ── "Verity Partners — no decision, went quiet" ────────────────────────────
  // Hiring paused in August, the champion left in July, revisit in January.
  'no-decision': {
    account: {
      id: 'acc_verity',
      name: 'Verity Partners',
      domain: 'veritypartners.example',
      industry: 'Professional Services',
      employees: '480',
      location: 'Manchester, UK',
    },
    deal: {
      id: 'deal_verity_1',
      name: 'Verity Partners — Ramp Acceleration',
      stage: 'Stalled',
      amount: 24000,
      currency: 'USD',
      close_date: '2027-01-29',
      owner: 'Sam Ellis',
      days_in_stage: 47,
    },
    participants: [
      REP,
      {
        id: 'con_tom',
        name: 'Tom Whitfield',
        title: 'Commercial Director',
        email: 'tom.whitfield@veritypartners.example',
        phone: '+44 161 555 0133',
        side: 'external',
        speaker: 'prospect',
      },
    ],
    associated: [
      {
        // "our enablement lead left in july and nobody has picked that up" — the lost champion.
        id: 'con_verity_former',
        name: 'Claire Bennett',
        title: 'Former Enablement Lead — left July 2026',
        email: 'claire.bennett@veritypartners.example',
        side: 'external',
      },
    ],
    history: [
      {
        id: 'act_vp_3',
        date: '2026-08-13',
        title: 'Re-engagement call — no deal this quarter',
        kind: 'call',
        summary: 'Hiring paused in August. Tom asked to be revisited in January.',
        call_id: 'no-decision',
      },
      {
        id: 'act_vp_2',
        date: '2026-07-18',
        title: 'Champion left the business',
        kind: 'note',
        summary: 'Claire Bennett departed; nobody picked up the initiative.',
      },
      {
        id: 'act_vp_1',
        date: '2026-06-11',
        title: 'Discovery — ramping new reps faster',
        kind: 'call',
        summary: 'Original driver was time-to-productivity for new hires.',
      },
    ],
    next_meeting: null, // Explicitly nothing booked — the point of the call.
  },
};

export const fixtureCrm: CrmProvider = {
  name: 'fixture-crm',
  forCall: (callId) => CONTEXTS[callId] ?? null,
};
