import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { appDarkTheme, appLightTheme } from './appThemes';
import { darkPalette, lightPalette, type Palette } from './palette';

const AA = 4.5;

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});

describe.each<[string, Palette]>([
  ['dark', darkPalette],
  ['light', lightPalette],
])('%s palette meets WCAG AA (4.5:1)', (_name, p) => {
  it.each([
    ['text on bg', p.text, p.bg],
    ['text on surface', p.text, p.surface],
    ['muted text on surface', p.textMuted, p.surface],
    ['ink on lime CTA', p.primaryInk, p.primary],
    ['ink on lime CTA hover', p.primaryInk, p.primaryHover],
    ['ink on lime CTA pressed', p.primaryInk, p.primaryPressed],
    ['accent link on bg', p.accent, p.bg],
    ['accent link on surface', p.accent, p.surface],
    ['critical on surface', p.critical, p.surface],
    ['critical on critical tint', p.critical, p.criticalBg],
    ['success on success tint', p.success, p.successBg],
    ['warning on warning tint', p.warning, p.warningBg],
    ['static text on static strip', p.staticText, p.staticBg],
  ])('%s', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA);
  });
});

describe('Fluent theme token wiring', () => {
  it.each([
    ['dark', appDarkTheme, darkPalette],
    ['light', appLightTheme, lightPalette],
  ] as const)('%s: primary buttons are lime with navy ink; links use the accent', (_n, theme, p) => {
    expect(theme.colorBrandBackground.toLowerCase()).toBe('#dcf343');
    expect(theme.colorNeutralForegroundOnBrand.toLowerCase()).toBe('#081833');
    expect(theme.colorBrandForegroundLink).toBe(p.accent);
    expect(contrastRatio(theme.colorNeutralForegroundOnBrand, theme.colorBrandBackground)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(theme.colorBrandForegroundLink, theme.colorNeutralBackground2)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(theme.colorNeutralForeground1, theme.colorNeutralBackground1)).toBeGreaterThanOrEqual(AA);
  });
});
