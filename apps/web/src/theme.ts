/**
 * Theme switching. Three first-class themes live in styles.css: 'coral' is
 * the :root default; 'blueprint' and 'academic' apply via data-theme on
 * <html>. The inline script in index.html applies the persisted (or
 * prefers-color-scheme-derived) theme before first paint; this module owns
 * everything after that. Persisted only when the user explicitly toggles.
 */

export const THEMES = ['coral', 'blueprint', 'academic'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'clausroom.theme';

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'blueprint' || t === 'academic' ? t : 'coral';
}

export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'coral';
}

/** Keep <meta name=theme-color> / <meta name=color-scheme> matching the
 * active theme, reading the resolved values off the stylesheet so palette
 * hexes stay in styles.css. */
function syncMetaTags(theme: Theme): void {
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--bg').trim();
  const scheme = styles.getPropertyValue('color-scheme').trim();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', bg || '');
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute('content', scheme || (theme === 'academic' ? 'light' : 'dark'));
}

export function applyTheme(theme: Theme, persist: boolean): void {
  if (theme === 'coral') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  syncMetaTags(theme);
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private-mode / quota errors: the theme still applies for this tab.
    }
  }
}
