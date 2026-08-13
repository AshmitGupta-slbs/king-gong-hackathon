/**
 * The competitor list, in one place.
 *
 * It was previously a private const inside the keyword extractor. Call analytics needs the same
 * list, and two copies of "who counts as a competitor" would drift the first time anyone added a
 * name to one of them.
 */
export const COMPETITORS = [
  'gong',
  'chorus',
  'fireflies',
  'avoma',
  'outreach',
  'salesloft',
  'koras',
] as const;
