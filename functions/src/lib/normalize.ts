export function normalizeCommits(raw: unknown): Record<string, number> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, number> = {};
    raw.forEach((value, index) => {
      out[String(index)] = Number((value as any) || 0);
    });
    return out;
  }
  if (typeof raw === 'object') {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[String(key)] = Number((value as any) || 0);
    }
    return out;
  }
  return {};
}

export function sumCommits(commits: Record<string, number> | null | undefined): number {
  if (!commits) return 0;
  return Object.values(commits).reduce((sum, value) => sum + Number((value as any) || 0), 0);
}
