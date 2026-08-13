'use client';

/**
 * The one thing there is to accept: a draft addition to an account's notes.
 *
 * It replaces a "Promote to notes" button on every individual learning. That version asked the same
 * question once per row, and each answer pasted the model's own sentence, unedited, into the field
 * the extraction prompt describes as "typed by the user". Eight asks producing eight quiet
 * mislabellings.
 *
 * The textarea is editable ON PURPOSE, and it is the whole idea. What gets saved is what the user
 * submits, so by the time the text lands in `notes` a person has read it and made it theirs — which
 * is what the banner in the prompt claims, and what makes it true.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
// The frame, not the labelled Textarea: the heading above already names this field, and a second
// visible label would be the same word twice. `inputStyles` is exported for exactly this.
import { inputStyles } from '@/components/ui/Field';
import { cx } from '@/components/ui/cx';

export function NotesSuggestion({
  companyId,
  suggestion,
}: {
  companyId: string;
  suggestion: { text: string; learningIds: (number | string)[] };
}) {
  const router = useRouter();
  const [text, setText] = useState(suggestion.text);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed) return null;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('suggestionFor', companyId);
      body.set('suggestionText', text);
      body.set('suggestionIds', JSON.stringify(suggestion.learningIds));
      const res = await fetch('/api/companies', { method: 'POST', body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-control border border-brand-border bg-brand-wash/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-caption font-semibold text-fg-muted">
        <Sparkles size={12} aria-hidden className="text-brand" />
        Suggested addition to notes
      </p>
      <p className="mt-1 text-caption leading-relaxed text-fg-dim">
        Drafted from what the calls below established. Edit it into your own words before adding —
        once it is in notes it is given to the model as something you asserted.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(10, text.split('\n').length + 1)}
        aria-label="Suggested addition to notes"
        className={cx(inputStyles, 'mt-2 resize-y leading-relaxed')}
      />

      {error && <p className="mt-1.5 text-caption text-bad">{error}</p>}

      <div className="mt-2 flex items-center gap-2">
        <Button onClick={accept} disabled={busy || !text.trim()}>
          {busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <Check size={13} aria-hidden />
          )}
          Add to notes
        </Button>
        <Button variant="ghost" onClick={() => setDismissed(true)} disabled={busy}>
          <X size={13} aria-hidden />
          Not now
        </Button>
      </div>
    </div>
  );
}
