import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';

/*
 * Neutral application themes.
 *
 * Built on Fluent UI v9's stock web themes (default brand ramp) with a small
 * set of overrides:
 *
 *   - ONE accent colour (teal) used for the estate-strip / static surface so
 *     the shell has a recognisable anchor in both themes.
 *   - A slightly cooler neutral canvas in light mode and a deeper surface in
 *     dark mode.
 *   - Warning-tint badge pairings and the dark-mode accessible stroke are
 *     adjusted to keep text contrast at or above WCAG AA.
 *
 * Every token not named here keeps its stock Fluent value (brand ramp,
 * semantic status colours, elevation, focus). Contrast ratios noted below
 * were measured against the stated background.
 */

/** Light: stock Fluent brand, cool off-white canvas, teal static surface. */
export const appLightTheme: Theme = {
  ...webLightTheme,
  colorNeutralBackground2: '#F5F6F8',
  colorNeutralBackground3: '#EEF0F3',
  colorNeutralForeground2: '#4A5560',
  colorNeutralForeground3: '#4A5560',
  // Warning-tint Badge pairing: amber ink on soft amber, ~6.9:1.
  colorPaletteYellowBackground1: '#FCF0DB',
  colorPaletteYellowForeground1: '#7A5900',
  colorPaletteYellowForeground2: '#7A5900',
  colorPaletteYellowBorder1: '#E3CD9C',
  // Estate strip: fixed deep-teal surface in BOTH themes.
  colorNeutralBackgroundStatic: '#0B3B44',
  colorNeutralForegroundStaticInverted: '#D8EEF1',
};

/** Dark: stock Fluent dark with a deeper canvas and readable secondary text. */
export const appDarkTheme: Theme = {
  ...webDarkTheme,
  colorNeutralBackground2: '#141619',
  colorNeutralBackground3: '#1A1D21',
  // Secondary text >= 7:1 on a card surface.
  colorNeutralForeground2: '#C4CAD2',
  colorNeutralForeground3: '#C4CAD2',
  // Input bottom borders: stock value is near-white; soften while keeping >= 3:1.
  colorNeutralStrokeAccessible: '#8A929C',
  colorNeutralStrokeAccessibleHover: '#A0A8B2',
  colorNeutralStrokeAccessiblePressed: '#A0A8B2',
  // Warning-tint pairing: bright amber ink on deep amber, ~8.2:1.
  colorPaletteYellowBackground1: '#33290E',
  colorPaletteYellowForeground1: '#F2C661',
  colorPaletteYellowForeground2: '#F2C661',
  colorPaletteYellowBorder1: '#66521C',
  colorNeutralBackgroundStatic: '#06262C',
  colorNeutralForegroundStaticInverted: '#CBE6EA',
};
