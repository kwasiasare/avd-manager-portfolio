import { makeStyles, tokens } from '@fluentui/react-components';

/**
 * AM-29 item 14 — the single `card` padding rule every page's top-level
 * `<Card>` wrapper used, replacing 12 files' worth of an identical
 * `padding: tokens.spacingHorizontalL` (horizontal only — no vertical
 * padding token, so a Card's content sat flush against its top/bottom
 * edges) with a proper two-axis padding (`spacingVerticalL` on top/bottom,
 * `spacingHorizontalL` on left/right).
 *
 * A single shared hook (rather than each page re-declaring the same rule in
 * its own makeStyles call) means the padding value only needs to change in
 * one place, and Fluent's Griffel runtime de-dupes the generated atomic CSS
 * across every caller.
 */
export const useCardStyles = makeStyles({
  card: {
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
  },
});

/**
 * AM-29 item 14 — the standard "visually hidden but still in the
 * accessibility tree" pattern (a screen-reader-only table header label, an
 * icon-only button's accessible name, etc.), previously copy-pasted
 * identically into HostPool.tsx, Sessions.tsx, Profiles.tsx, and
 * RolloutWizard.tsx. Shape verified against the WebAIM/a11y-project
 * "visually hidden" recipe: absolutely positioned out of flow, clipped to
 * 1x1px, overflow hidden, no wrap — content stays readable by assistive
 * tech while never occupying visible layout space.
 */
export const useVisuallyHiddenStyles = makeStyles({
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    border: 0,
  },
});
