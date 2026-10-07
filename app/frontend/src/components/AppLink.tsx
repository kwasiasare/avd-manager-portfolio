import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  link: {
    // Live contrast review (2026-08-16, dark theme): bare react-router
    // <Link>s rendered with USER-AGENT colors — default blue (#0000EE) and
    // visited purple (#551A8B) — which are near-invisible on the slate dark
    // cards. Every in-content router link goes through this component so it
    // takes the theme's brand link color in BOTH themes, with :visited
    // pinned to the same color (an internal ops tool has no reason to
    // distinguish visited routes).
    color: tokens.colorBrandForegroundLink,
    textDecorationLine: 'none',
    ':visited': {
      color: tokens.colorBrandForegroundLink,
    },
    ':hover': {
      color: tokens.colorBrandForegroundLinkHover,
      textDecorationLine: 'underline',
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '2px',
      borderRadius: tokens.borderRadiusSmall,
    },
  },
});

type AppLinkProps = ComponentPropsWithoutRef<typeof RouterLink>;

/** Theme-styled react-router Link for in-content navigation (card footers, table cells). See the style comment for why bare RouterLinks are banned in page content. */
const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(function AppLink({ className, ...rest }, ref) {
  const styles = useStyles();
  return <RouterLink ref={ref} className={mergeClasses(styles.link, className as string | undefined)} {...rest} />;
});

export default AppLink;
