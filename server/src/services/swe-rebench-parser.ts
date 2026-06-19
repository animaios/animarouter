/**
 * SWE-rebench leaderboard HTML parser.
 *
 * Fetches https://swe-rebench.com/ and extracts model names + resolved-rate %
 * from the server-rendered HTML table. No external dependencies — uses regex
 * on the raw HTML (the page is SSR via Next.js).
 *
 * Usage:
 *   import { fetchSWERebenchLeaderboard } from './swe-rebench-parser.js';
 *   const entries = await fetchSWERebenchLeaderboard();
 *   // [{ model: 'gpt-5.5-2026-04-23-xhigh', resolvedRate: 62.7 }, ...]
 */

const LEADERBOARD_URL = 'https://swe-rebench.com/';
const FETCH_TIMEOUT_MS = 15_000;

export interface SWERebenchEntry {
  /** Raw model name from the leaderboard (e.g. "gpt-5.5-2026-04-23-xhigh") */
  model: string;
  /** Resolved rate as a percentage in [0, 100] */
  resolvedRate: number;
  /** Standard error of the mean (±), or null if N/A */
  sem: number | null;
  /** Pass@5 percentage, or null if N/A */
  passAt5: number | null;
  /** Cost per problem in USD, or null if N/A */
  costPerProblem: number | null;
  /** Rank position on the leaderboard */
  rank: number;
}

/**
 * Parse the SWE-rebench leaderboard HTML and return model scores.
 * Only rows with a numeric resolved rate are included (N/A rows are skipped).
 */
export function parseSWERebenchHTML(html: string): SWERebenchEntry[] {
  const entries: SWERebenchEntry[] = [];

  // Match each <tr> that contains a model-name div
  const rowRegex =
    /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  // Inside a row: rank is the first <td>, model name is in rank-table__model-name div,
  // then resolved rate, SEM, pass@5, cost, tokens, cached tokens follow in <td> cells.
  const modelRegex =
    /<div\s+class="rank-table__model-name">(.*?)<\/div>/i;
  const cellRegex =
    /<td\s+class="g-table__cell[^"]*">(.*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHTML = rowMatch[1];

    // Extract model name
    const modelNameMatch = modelRegex.exec(rowHTML);
    if (!modelNameMatch) continue;
    const model = modelNameMatch[1].trim();
    if (!model) continue;

    // Extract all cell values
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    // Reset regex for each row
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowHTML)) !== null) {
      cells.push(cellMatch[1].trim());
    }

    // Expected cells: [rank, model-cell, resolvedRate, sem, passAt5, cost, tokens, cached]
    if (cells.length < 5) continue;

    const rank = parseInt(cells[0], 10);
    const resolvedRateStr = cells[2]; // e.g. "62.7%" or "N/A"
    const semStr = cells[3];          // e.g. "0.91%" or "N/A"
    const passAt5Str = cells[4];      // e.g. "70.0%" or "N/A"
    const costStr = cells.length > 5 ? cells[5] : ''; // e.g. "$2.25" or "N/A"

    // Skip rows where resolved rate is N/A
    if (!resolvedRateStr || resolvedRateStr === 'N/A') continue;

    const resolvedRate = parseFloat(resolvedRateStr.replace('%', ''));
    if (isNaN(resolvedRate)) continue;

    entries.push({
      model,
      resolvedRate,
      sem: parsePercent(semStr),
      passAt5: parsePercent(passAt5Str),
      costPerProblem: parseDollar(costStr),
      rank: isNaN(rank) ? entries.length + 1 : rank,
    });
  }

  return entries;
}

/** Parse a percentage string like "0.91%" or "N/A" into a number or null */
function parsePercent(s: string): number | null {
  if (!s || s === 'N/A') return null;
  const v = parseFloat(s.replace('%', ''));
  return isNaN(v) ? null : v;
}

/** Parse a dollar string like "$2.25" or "N/A" into a number or null */
function parseDollar(s: string): number | null {
  if (!s || s === 'N/A') return null;
  const v = parseFloat(s.replace(/[$,]/g, ''));
  return isNaN(v) ? null : v;
}

/**
 * Fetch the SWE-rebench leaderboard and parse it.
 * Throws on network failure — caller should catch and fall back to hardcoded scores.
 */
export async function fetchSWERebenchLeaderboard(): Promise<SWERebenchEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(LEADERBOARD_URL, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'FreeLLMApi-Gateway/1.0 (SWE-rebench sync)',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const html = await res.text();
    const entries = parseSWERebenchHTML(html);

    if (entries.length === 0) {
      throw new Error('No leaderboard entries found in HTML');
    }

    console.log(`[SWE-rebench] Parsed ${entries.length} models from leaderboard`);
    return entries;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Map a raw SWE-rebench model name to a shorter canonical ID that matches
 * the LIKE patterns in benchmark-scores.ts.
 *
 * Examples:
 *   "gpt-5.5-2026-04-23-xhigh"     → "gpt-5.5"
 *   "claude-opus-4.8-xhigh"        → "claude-opus-4.8"
 *   "Claude Opus 4.6-high"         → "claude-opus-4.6"
 *   "Gemini 3.1 Pro Preview"       → "gemini-3.1-pro"
 */
export function normalizeModelName(raw: string): string {
  // Strip date suffixes like "-2026-04-23"
  let name = raw.replace(/-\d{4}-\d{2}-\d{2}/g, '');
  // Strip effort/reasoning suffixes: -xhigh, -high, -medium, -minimal, -low, __tools
  name = name.replace(/[-_](xhigh|high|medium|minimal|low|tools)$/i, '');
  // Strip trailing whitespace
  name = name.trim();
  // Lowercase and collapse spaces to hyphens
  name = name.toLowerCase().replace(/\s+/g, '-');
  // Remove "preview" suffix
  name = name.replace(/-preview$/, '');
  return name;
}
