import { useState } from 'react';
import { applyTheme, currentTheme, nextTheme, type Theme } from '../theme.js';

/**
 * Compact theme cycle button: a swatch (the active theme's primary gradient)
 * plus the theme name. Clicking cycles coral → blueprint → academic and
 * persists the choice to localStorage ('clausroom.theme').
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  function cycle() {
    const next = nextTheme(theme);
    applyTheme(next, true);
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm theme-toggle"
      aria-label={`Switch theme (current: ${theme})`}
      title={`Theme: ${theme} — click to switch`}
      onClick={cycle}
    >
      <span className="theme-toggle__swatch" aria-hidden="true" />
      <span className="theme-toggle__name">{theme}</span>
    </button>
  );
}
