// Celo brand-aligned theme for Agent 06 demo video.
// Colors: Celo Gold (#FCFF52) primary, black background, white text.

export const colors = {
  bg: "#0A0A0A",         // near-black
  surface: "#1A1A1A",    // card background
  border: "#2A2A2A",     // subtle borders
  text: "#FFFFFF",       // primary text
  textDim: "#A1A1AA",    // secondary text
  accent: "#FCFF52",     // Celo Gold
  accentDim: "#A8AB29",  // dimmed gold
  success: "#4ADE80",    // green
  warn: "#F59E0B",       // amber
  danger: "#EF4444",     // red
  code: "#E4E4E7",       // code text
  codeBg: "#0F0F0F",     // code background
} as const;

export const fonts = {
  display: "'Inter', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', 'Menlo', 'Consolas', monospace",
} as const;

export const sizes = {
  hero: 88,
  title: 56,
  subtitle: 32,
  body: 24,
  small: 18,
  tiny: 14,
} as const;

export const radius = {
  sm: 6,
  md: 12,
  lg: 20,
} as const;
