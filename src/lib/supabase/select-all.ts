/** Supabase's Data API default for Settings > API > Max rows. */
export const PAGE_SIZE = 1000;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Reads every row of a query in pages. PostgREST silently caps a response at
 * "Max rows" (1000 by default), so one plain select would drop rows beyond
 * that. The query must be ordered by a unique column so pages line up.
 * Stops at maxRows as a safety net.
 */
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  maxRows = 20_000,
): Promise<PageResult<T> & { data: T[] }> {
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}
