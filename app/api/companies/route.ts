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

export async function GET() {
  return NextResponse.json({ companies: listCompanies() });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
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
    if (input.id && getCompany(input.id)) {
      const updated = updateCompany(input.id, {
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
    upsertCompany(company);
    return NextResponse.json({ company }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
