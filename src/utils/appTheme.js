export const THEME_STORAGE_KEY = 'vienna-rail-theme';

export function getSavedTheme() {
  try {
    return globalThis.localStorage?.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme, { persist = false } = {}) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  globalThis.document?.documentElement.setAttribute('data-theme', selected);
  globalThis.document?.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content', selected === 'dark' ? '#1c2119' : '#f7f4eb',
  );
  if (persist) {
    try { globalThis.localStorage?.setItem(THEME_STORAGE_KEY, selected); } catch { /* Private browsing can block storage. */ }
  }
  return selected;
}
