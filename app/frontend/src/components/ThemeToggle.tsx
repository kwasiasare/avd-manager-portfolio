import { Button, Menu, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, Tooltip, type MenuProps } from '@fluentui/react-components';
import { WeatherMoon16Regular, WeatherSunny16Regular } from '@fluentui/react-icons';
import { THEME_MODE_OPTIONS, useThemeMode } from '../theme/themeMode';

/**
 * AM-29 user direction 2026-08-16: the theme toggle lives at the TOP of the
 * page — in the EstateStrip, immediately before the "As of …" segment —
 * not buried in the identity menu (where it originally shipped in W1).
 * Same single useThemeMode state as Settings' Appearance card; this is a
 * relocation, not a second copy of the toggle state. Icon reflects the
 * RESOLVED theme (what's on screen), not the mode — same convention the
 * identity-menu toggle used.
 */
export default function ThemeToggle() {
  const { mode, resolved, setMode } = useThemeMode();
  const activeLabel = THEME_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? 'System';

  const handleCheckedValueChange: MenuProps['onCheckedValueChange'] = (_event, data) => {
    const next = data.checkedItems[0];
    if (next === 'system' || next === 'light' || next === 'dark') {
      setMode(next);
    }
  };

  return (
    <Menu checkedValues={{ theme: [mode] }} onCheckedValueChange={handleCheckedValueChange}>
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content={`Theme: ${activeLabel}`} relationship="label">
          <Button
            appearance="transparent"
            size="small"
            icon={resolved === 'dark' ? <WeatherMoon16Regular /> : <WeatherSunny16Regular />}
            aria-label={`Theme: ${activeLabel} (currently rendering ${resolved})`}
            style={{ color: 'inherit', minWidth: 'auto' }}
          />
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {THEME_MODE_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            return (
              <MenuItemRadio key={option.value} name="theme" value={option.value} icon={<OptionIcon />}>
                {option.label}
              </MenuItemRadio>
            );
          })}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
