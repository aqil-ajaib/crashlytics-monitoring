import ignore from 'ignore';

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
}

export function parseCodeowners(content: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;

    entries.push({ pattern, owners });
  }

  return entries;
}

/**
 * CODEOWNERS uses gitignore-style patterns where the LAST matching pattern
 * in the file wins. We walk entries in reverse and return the first hit.
 */
export function findOwners(filePath: string, entries: CodeownersEntry[]): string[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    try {
      if (ignore().add(entry.pattern).ignores(filePath)) {
        return entry.owners;
      }
    } catch {
      // Malformed pattern (e.g. one that only makes sense to git, like a bare "/") — skip it.
      continue;
    }
  }
  return [];
}
