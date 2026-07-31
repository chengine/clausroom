// Apply the persisted theme before first paint (no flash). Default is coral,
// except a light-mode OS preference defaults to academic; nothing is persisted
// until the user actually toggles (src/theme.ts).
(function () {
  var theme = null;
  try {
    theme = window.localStorage.getItem('clausroom.theme');
  } catch (e) {
    /* localStorage unavailable: fall through to defaults */
  }
  if (theme !== 'coral' && theme !== 'blueprint' && theme !== 'academic') {
    theme =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'academic'
        : 'coral';
  }
  if (theme !== 'coral') document.documentElement.dataset.theme = theme;
  var meta = {
    coral: ['#0c1220', 'dark'],
    blueprint: ['#0a1620', 'dark'],
    academic: ['#faf6ef', 'light'],
  }[theme];
  var themeColor = document.querySelector('meta[name="theme-color"]');
  var colorScheme = document.querySelector('meta[name="color-scheme"]');
  if (themeColor) themeColor.setAttribute('content', meta[0]);
  if (colorScheme) colorScheme.setAttribute('content', meta[1]);
})();
