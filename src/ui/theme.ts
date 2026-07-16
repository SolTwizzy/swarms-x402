/**
 * Shared UI theme — the single source of truth for SwarmX page styling.
 *
 * Consumed by the four server-rendered pages in server.ts:
 * gallery, report, benchmark, and the landing page.
 *
 * Direction: a trading terminal in SwarmX brand red (the logo's hot red X
 * on black). Red is the BRAND — chrome, CTAs, focus states. Green stays
 * strictly SEMANTIC: bullish / up / success, which also carries the RWA
 * identity. Bearish/down uses a softer rose so brand chrome and loss
 * numbers don't read as the same signal. Neutrals are warm near-blacks.
 */

/** Google Fonts links. Goes in <head> before the <style> block. */
export const THEME_FONTS = `  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">`;

/** Favicon links (embedded PNG served by the app — see src/ui/logo.ts). */
export const THEME_FAVICON = `  <link rel="icon" type="image/png" sizes="64x64" href="/favicon.png">
  <link rel="apple-touch-icon" href="/logo.png">`;

/**
 * The `:root` custom-property block. Replaces the per-page `:root` in every
 * page, so the var names below are the union of what all four pages reference —
 * renaming one silently unstyles a page.
 */
export const THEME_TOKENS = `    :root {
      /* Ground — warm near-black, not pure black */
      --bg: #070505;
      --surface: #0D0A0A;
      --surface-2: #131010;
      --surface-3: #1A1515;

      /* Hairlines — red-cast */
      --border: #251A1A;
      --border-hover: #3A2424;
      --border-focus: #522B2B;

      /* Text — warm neutrals */
      --text: #C6BCBC;
      --text-muted: #7A6F6F;
      --text-dim: #514747;
      --heading: #EDE7E7;

      /* Brand — SwarmX logo red (chrome, CTAs, focus) */
      --accent: #FF2E2E;
      --accent-2: #C40D0D;
      --accent-glow: rgba(255, 46, 46, 0.12);
      --brand: #FF2E2E;
      --brand-bg: rgba(255, 46, 46, 0.10);

      /* Bullish / up / success — semantic green (also the RWA identity) */
      --green: #00C805;
      --green-bg: rgba(0, 200, 5, 0.10);

      /* Bearish / down / risk — rose, deliberately softer than brand red */
      --red: #F87171;
      --red-bg: rgba(248, 113, 113, 0.10);

      /* Category chips — desaturated to sit inside the dark-red world */
      --blue: #5B9FD4;
      --blue-bg: rgba(91, 159, 212, 0.10);
      --yellow: #D4A93C;
      --yellow-bg: rgba(212, 169, 60, 0.10);
      --purple: #9887C4;
      --purple-bg: rgba(152, 135, 196, 0.10);
      --orange: #D4823C;
      --orange-bg: rgba(212, 130, 60, 0.10);

      /* Type */
      --display: 'Chakra Petch', 'IBM Plex Sans', system-ui, sans-serif;
      --sans: 'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --font: 'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --mono: 'IBM Plex Mono', 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
    }`;
