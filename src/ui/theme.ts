/**
 * Shared UI theme — the single source of truth for SwarmX page styling.
 *
 * Consumed by the four server-rendered pages in server.ts:
 * gallery, report, benchmark, and the landing page.
 *
 * Direction: a trading terminal for tokenized real-world assets.
 * Green is the brand *and* "up"; red is "down / risk". They are the native
 * semantic pair of every ticker, which is why both live here without fighting.
 * Every neutral carries a green cast — phosphor bleed, not plain grey.
 */

/** Google Fonts links. Goes in <head> before the <style> block. */
export const THEME_FONTS = `  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">`;

/**
 * The `:root` custom-property block. Replaces the per-page `:root` in every
 * page, so the var names below are the union of what all four pages reference —
 * renaming one silently unstyles a page.
 */
export const THEME_TOKENS = `    :root {
      /* Ground — cold blue-black, not pure black */
      --bg: #05070A;
      --surface: #0A0F0C;
      --surface-2: #0F1512;
      --surface-3: #141B17;

      /* Hairlines */
      --border: #17251C;
      --border-hover: #1F3527;
      --border-focus: #2A4633;

      /* Text — green-cast neutrals */
      --text: #B8C6BC;
      --text-muted: #6B7A72;
      --text-dim: #44514A;
      --heading: #E6EDE8;

      /* Brand / bullish */
      --accent: #00C805;
      --accent-2: #00873D;
      --accent-glow: rgba(0, 200, 5, 0.12);
      --green: #00C805;
      --green-bg: rgba(0, 200, 5, 0.10);

      /* Bearish / risk — Swarms red, semantic only */
      --red: #EF4444;
      --red-bg: rgba(239, 68, 68, 0.10);

      /* Category chips — desaturated to sit inside the green world */
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
