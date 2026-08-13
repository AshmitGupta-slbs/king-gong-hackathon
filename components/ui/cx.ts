/**
 * Class joiner. Drops falsy entries so conditional classes read as `cond && 'class'`.
 *
 * Deliberately not `clsx`: the conditional logic in this app is a handful of variant lookups, and
 * a dependency for twelve lines would be the same instinct that produced four hand-copied versions
 * of the citation-chip class string.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
