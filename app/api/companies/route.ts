/**
 * GET  /api/companies — list the accounts.
 * POST /api/companies — create one, or patch an existing one.
 *
 * `node:sqlite` means this must run on the Node runtime, not Edge.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCompany, listCompanies, updateCompany, upsertCompany } from '@/lib/companies';
import { learningsForCompany, markLearningPromoted } from '@/lib/learnings';
import type { Company } from '@/lib/companies';
import { DealStageSchema } from '@/lib/crm/types';

export const runtime = 'nodejs';

/**
 * Validated, never cast.
 *
 * The same rule the upload route follows, and for the same reason recorded there: an unchecked cast
 * of a form value is how a typo becomes indistinguishable from a deliberate choice. `stage` in
 * particular reaches a badge-tone lookup and a kanban grouping, so an arbitrary string would render
 * as an unstyled column rather than fail.
 */
const CompanyInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, 'A company needs a name.'),
  industry: z.string().trim().optional(),
  size_band: z.string().trim().optional(),
  website: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  stage: DealStageSchema.optional(),
});

/** '' from an untouched form field means "no value", not "the empty string". */
const orNull = (v: string | undefined) => (v && v.length > 0 ? v : null);

/**
 * Learning ids, as a JSON array in a form field.
 *
 * Kept as strings OR numbers because the two backends key them differently — SQLite autoincrements
 * an integer, Mongo assigns a UUID — and coercing to one of those is the bug this endpoint used to
 * have. Malformed input yields no ids rather than an error: the notes still save, and an unmarked
 * learning simply appears in the next suggestion.
 */
function parseIds(raw: string | undefined): (number | string)[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is number | string => typeof x === 'number' || typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function GET() {
  return NextResponse.json({ companies: await listCompanies() });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    /**
     * Accept the suggested addition to an account's notes.
     *
     * ONE action for the whole draft, replacing a per-learning promote endpoint that asked the same
     * question once per row — and that could never have worked on the Mongo backend anyway, where a
     * learning id is a UUID string and the old `Number.isInteger` guard was always false.
     *
     * The text is whatever the user submitted, not what the server proposed: they read the draft and
     * may have rewritten it, and that edit is precisely what makes the notes theirs. `notes` is
     * presented to the model as something a person asserted, so a human has to have passed through
     * here for that to stay true.
     */
    const suggestionFor = form.get('suggestionFor')?.toString();
    if (suggestionFor) {
      const company = await getCompany(suggestionFor);
      if (!company) return NextResponse.json({ error: 'No such company.' }, { status: 404 });

      const text = (form.get('suggestionText')?.toString() ?? '').trim();
      if (!text) return NextResponse.json({ error: 'Nothing to add.' }, { status: 400 });

      /*
        The ids arrive from the client, so membership is checked against this account's own ledger
        before anything is marked. Marking a learning promoted removes it from the block fed to the
        next extraction, so an unchecked id would let one request quietly strip another account's
        context. One read answers it for every id.
      */
      const ids = parseIds(form.get('suggestionIds')?.toString());
      const own = new Set(
        (await learningsForCompany(company.id, 500)).map((l) => String(l.id)),
      );

      const merged = [company.notes?.trim(), text].filter(Boolean).join('\n');
      const updated = await updateCompany(company.id, { notes: merged });
      await Promise.all(
        ids.filter((id) => own.has(String(id))).map((id) => markLearningPromoted(id)),
      );
      return NextResponse.json({ company: updated });
    }
    const parsed = CompanyInput.safeParse({
      id: form.get('id')?.toString() || undefined,
      name: form.get('name')?.toString() ?? '',
      industry: form.get('industry')?.toString() || undefined,
      size_band: form.get('size_band')?.toString() || undefined,
      website: form.get('website')?.toString() || undefined,
      notes: form.get('notes')?.toString() || undefined,
      stage: form.get('stage')?.toString() || undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join(' ') },
        { status: 400 },
      );
    }
    const input = parsed.data;

    // An id that already exists is an edit; an id that does not is a client-chosen key.
    if (input.id && (await getCompany(input.id))) {
      const updated = await updateCompany(input.id, {
        name: input.name,
        industry: orNull(input.industry),
        size_band: orNull(input.size_band),
        website: orNull(input.website),
        notes: orNull(input.notes),
        ...(input.stage ? { stage: input.stage } : {}),
      });
      return NextResponse.json({ company: updated });
    }

    const company: Company = {
      id: input.id ?? `co-${randomUUID().slice(0, 8)}`,
      name: input.name,
      industry: orNull(input.industry),
      size_band: orNull(input.size_band),
      website: orNull(input.website),
      notes: orNull(input.notes),
      stage: input.stage ?? 'Discovery',
      created_at: Date.now(),
      detail: null,
    };
    await upsertCompany(company);
    return NextResponse.json({ company }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
