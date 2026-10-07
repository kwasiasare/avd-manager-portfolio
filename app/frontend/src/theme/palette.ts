/*
 * Navy/lime brand palette (the "DEIG" standard theme used across Kwasi's
 * apps; adopted 2026-10-07). Single source of truth for raw hex values —
 * appThemes.ts maps these onto Fluent v9 tokens, and the contrast test
 * asserts the pairs that matter. No other file should hard-code brand hexes.
 */
export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceSunken: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentSoft: string;
  /** Lime CTA fill (same in both themes). */
  primary: string;
  primaryHover: string;
  primaryPressed: string;
  /** Dark ink for text/icons on lime. */
  primaryInk: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  warningBorder: string;
  critical: string;
  criticalBg: string;
  criticalBorder: string;
  /** Fixed deep-navy "static" strip surface + its text. */
  staticBg: string;
  staticText: string;
}

export const LIME = '#DCF343';
export const LIME_HOVER = '#E5F76A';
export const LIME_PRESSED = '#C9DF2A';
export const NAVY_INK = '#081833';

export const darkPalette: Palette = {
  bg: '#081833',
  surface: '#10234A',
  surfaceAlt: '#162C58',
  surfaceSunken: '#0B1D3D',
  border: '#2C4372',
  borderStrong: '#5F7AA8',
  text: '#EFF3FA',
  textMuted: '#B6C6E2',
  textFaint: '#8FA3C4',
  accent: '#7FA8F0',
  accentHover: '#9DBDF6',
  accentPressed: '#B9D0F9',
  accentSoft: '#17305F',
  primary: LIME,
  primaryHover: LIME_HOVER,
  primaryPressed: LIME_PRESSED,
  primaryInk: NAVY_INK,
  success: '#3FD08A',
  successBg: '#0F3524',
  warning: '#F0B84A',
  warningBg: '#3A2B0D',
  warningBorder: '#6B5118',
  critical: '#FF7B88',
  criticalBg: '#3B1519',
  criticalBorder: '#7A2A33',
  staticBg: '#050F26',
  staticText: '#CBDAF2',
};

export const lightPalette: Palette = {
  bg: '#F2F4F3',
  surface: '#FFFFFF',
  surfaceAlt: '#F4F7FB',
  surfaceSunken: '#ECEFEE',
  border: '#DCE1E4',
  borderStrong: '#9AA6B2',
  text: '#101418',
  textMuted: '#4E5A66',
  textFaint: '#6B7683',
  accent: '#1450C8',
  accentHover: '#0F3E9C',
  accentPressed: '#0B2F78',
  accentSoft: '#E6EEFC',
  primary: LIME,
  primaryHover: LIME_HOVER,
  primaryPressed: LIME_PRESSED,
  primaryInk: NAVY_INK,
  success: '#17824F',
  successBg: '#F3FBF7',
  warning: '#7A5900',
  warningBg: '#FCF0DB',
  warningBorder: '#E3CD9C',
  critical: '#B5273A',
  criticalBg: '#FBE7E9',
  criticalBorder: '#E7B1B8',
  staticBg: '#0A1E46',
  staticText: '#D5E1F5',
};
