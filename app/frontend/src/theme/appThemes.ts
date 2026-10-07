import { createDarkTheme, createLightTheme, type BrandVariants, type Theme } from '@fluentui/react-components';
import { darkPalette, lightPalette, type Palette } from './palette';

/*
 * Navy/lime application themes (DEIG palette — see palette.ts).
 *
 * Built on Fluent UI v9's createLightTheme/createDarkTheme (blue brand ramp) with token overrides:
 *
 *   - Lime (#DCF343) is a CTA fill only: colorBrandBackground* map to lime
 *     and colorNeutralForegroundOnBrand to navy ink (#081833), so button
 *     text on lime passes WCAG AA in both themes (lime has poor contrast
 *     on white, so it is never used as text or a thin stroke).
 *   - The blue accent (#1450C8 light / #7FA8F0 dark) carries everything
 *     that must read as text or an outline on the canvas: links, brand
 *     foreground, focus rings, selected nav/compound-brand states.
 *   - Neutral canvas/surface/stroke/foreground and the status palette
 *     (success / warning / danger) come straight from the palette.
 *
 * The BrandVariants ramp is therefore a BLUE ramp (so any stock Fluent token
 * not overridden below, e.g. Slider/Checkbox glyph colours, stays on-brand
 * and legible); lime is applied by explicit overrides.
 */
export const brandRamp: BrandVariants = {
  10: '#030A1C',
  20: '#05122E',
  30: '#071A42',
  40: '#092257',
  50: '#0B2B6C',
  60: '#0D3482',
  70: '#0F3E9C',
  80: '#1450C8',
  90: '#3B6FD6',
  100: '#5F8AE0',
  110: '#7FA8F0',
  120: '#9DBDF6',
  130: '#B9D0F9',
  140: '#D2E1FB',
  150: '#E6EEFC',
  160: '#F3F7FE',
};

function overrides(p: Palette, isDark: boolean): Partial<Theme> {
  return {
    // Canvas / surfaces. Background2 is the page canvas, Background1 cards.
    colorNeutralBackground1: p.surface,
    colorNeutralBackground1Hover: p.surfaceAlt,
    colorNeutralBackground1Pressed: p.surfaceSunken,
    colorNeutralBackground1Selected: p.accentSoft,
    colorNeutralBackground2: p.bg,
    colorNeutralBackground2Hover: p.surfaceAlt,
    colorNeutralBackground2Pressed: p.surfaceSunken,
    colorNeutralBackground2Selected: p.accentSoft,
    colorNeutralBackground3: p.surfaceAlt,
    colorNeutralBackground3Hover: p.surfaceSunken,
    colorNeutralBackground3Pressed: p.surfaceSunken,
    colorNeutralBackground3Selected: p.accentSoft,
    colorNeutralBackground4: p.surfaceSunken,
    colorNeutralBackground5: p.surfaceSunken,
    colorNeutralBackground6: p.surfaceSunken,
    colorSubtleBackgroundHover: p.surfaceAlt,
    colorSubtleBackgroundPressed: p.surfaceSunken,
    colorSubtleBackgroundSelected: p.accentSoft,
    colorNeutralBackgroundStatic: p.staticBg,
    colorNeutralForegroundStaticInverted: p.staticText,

    // Foregrounds.
    colorNeutralForeground1: p.text,
    colorNeutralForeground1Hover: p.text,
    colorNeutralForeground1Pressed: p.text,
    colorNeutralForeground1Selected: p.text,
    colorNeutralForeground2: p.textMuted,
    colorNeutralForeground2Hover: p.text,
    colorNeutralForeground2Pressed: p.text,
    colorNeutralForeground2Selected: p.text,
    colorNeutralForeground2BrandHover: p.accentHover,
    colorNeutralForeground2BrandPressed: p.accentPressed,
    colorNeutralForeground2BrandSelected: p.accent,
    colorNeutralForeground3: p.textMuted,
    colorNeutralForeground4: p.textFaint,

    // Strokes.
    colorNeutralStroke1: p.borderStrong,
    colorNeutralStroke1Hover: p.borderStrong,
    colorNeutralStroke1Pressed: p.borderStrong,
    colorNeutralStroke1Selected: p.borderStrong,
    colorNeutralStroke2: p.border,
    colorNeutralStroke3: p.border,
    colorNeutralStrokeSubtle: p.border,
    colorNeutralStrokeAccessible: p.borderStrong,
    colorNeutralStrokeAccessibleHover: p.accentHover,
    colorNeutralStrokeAccessiblePressed: p.accentPressed,
    colorNeutralStrokeAccessibleSelected: p.accent,

    // Lime CTA fill with navy ink.
    colorBrandBackground: p.primary,
    colorBrandBackgroundHover: p.primaryHover,
    colorBrandBackgroundPressed: p.primaryPressed,
    colorBrandBackgroundSelected: p.primaryPressed,
    colorNeutralForegroundOnBrand: p.primaryInk,
    // Checkbox/radio/switch fills: their glyph is the stock "inverted"
    // foreground (white in light, near-black in dark), so light uses the
    // blue accent (white-on-blue) and dark uses lime (dark-on-lime).
    colorCompoundBrandBackground: isDark ? p.primary : p.accent,
    colorCompoundBrandBackgroundHover: isDark ? p.primaryHover : p.accentHover,
    colorCompoundBrandBackgroundPressed: isDark ? p.primaryPressed : p.accentPressed,
    colorBrandBackground2: p.accentSoft,
    colorBrandBackground2Hover: p.accentSoft,
    colorBrandBackground2Pressed: p.accentSoft,
    colorBrandBackgroundInverted: p.surface,
    colorBrandBackgroundInvertedHover: p.accentSoft,
    colorBrandBackgroundInvertedPressed: p.accentSoft,
    colorBrandBackgroundInvertedSelected: p.accentSoft,
    colorCompoundBrandStroke: p.accent,
    colorCompoundBrandStrokeHover: p.accentHover,
    colorCompoundBrandStrokePressed: p.accentPressed,

    // Blue accent for text-ish brand roles, links and focus.
    colorBrandForeground1: p.accent,
    colorBrandForeground2: p.accent,
    colorBrandForeground2Hover: p.accentHover,
    colorBrandForeground2Pressed: p.accentPressed,
    colorBrandForegroundLink: p.accent,
    colorBrandForegroundLinkHover: p.accentHover,
    colorBrandForegroundLinkPressed: p.accentPressed,
    colorBrandForegroundLinkSelected: p.accent,
    colorCompoundBrandForeground1: p.accent,
    colorCompoundBrandForeground1Hover: p.accentHover,
    colorCompoundBrandForeground1Pressed: p.accentPressed,
    colorBrandStroke1: p.accent,
    colorBrandStroke2: p.accentSoft,
    colorBrandStroke2Hover: p.accentSoft,
    colorBrandStroke2Pressed: p.accentSoft,
    colorBrandStroke2Contrast: p.accentSoft,
    colorStrokeFocus2: isDark ? p.text : p.accent,

    // Status palette.
    colorStatusSuccessBackground1: p.successBg,
    colorStatusSuccessForeground1: p.success,
    colorStatusSuccessForeground3: p.success,
    colorStatusWarningBackground1: p.warningBg,
    colorStatusWarningForeground1: p.warning,
    colorStatusWarningForeground3: p.warning,
    colorStatusWarningBorder1: p.warningBorder,
    colorStatusDangerBackground1: p.criticalBg,
    colorStatusDangerForeground1: p.critical,
    colorStatusDangerForeground3: p.critical,
    colorStatusDangerBorder1: p.criticalBorder,
    colorPaletteGreenBackground1: p.successBg,
    colorPaletteGreenForeground1: p.success,
    colorPaletteGreenForeground2: p.success,
    colorPaletteGreenForeground3: p.success,
    colorPaletteRedBackground1: p.criticalBg,
    colorPaletteRedForeground1: p.critical,
    colorPaletteRedForeground3: p.critical,
    colorPaletteRedBorder1: p.criticalBorder,
    colorPaletteRedBorder2: p.critical,
    // Warning-tint pairing (Yellow + Marigold both used by the app).
    colorPaletteYellowBackground1: p.warningBg,
    colorPaletteYellowForeground1: p.warning,
    colorPaletteYellowForeground2: p.warning,
    colorPaletteYellowBorder1: p.warningBorder,
    colorPaletteMarigoldBackground1: p.warningBg,
    colorPaletteMarigoldBackground2: p.warningBg,
    colorPaletteMarigoldForeground1: p.warning,
    colorPaletteMarigoldForeground2: p.warning,
    colorPaletteMarigoldBorder1: p.warningBorder,
    // AM-68 review fix (Fable, MAJOR): BlueBackground2 is the scaling
    // day-timeline's Ramp-up segment fill (lib/phaseColor.ts). accentSoft
    // is a hover/selection tint (~1.2:1 against the card and ~1.0:1 against
    // the Off-peak segment in light) and rendered the segment invisible —
    // use a mid ramp blue that is a distinct hue from the neutral Off-peak
    // fill in both themes.
    colorPaletteBlueBackground2: isDark ? brandRamp[80] : brandRamp[120],
    colorPaletteBlueForeground2: p.accent,
    colorPaletteBlueBorderActive: p.accent,
  };
}

/** Light: cool off-white canvas, white cards, blue accent, lime CTA. */
export const appLightTheme: Theme = {
  ...createLightTheme(brandRamp),
  ...overrides(lightPalette, false),
};

/** Dark (DEFAULT): navy canvas, deeper-navy cards, light-blue accent, lime CTA. */
export const appDarkTheme: Theme = {
  ...createDarkTheme(brandRamp),
  ...overrides(darkPalette, true),
};
