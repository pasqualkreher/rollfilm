// "1 photo", "3 photos", "1,204 photos": a count and its noun, the noun in
// the form the count asks for. Instead of "3 photo(s)", which reads like a
// form to fill in.
export function plural(n: number, word: string, many?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many ?? `${word}s`}`;
}
