import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, getSavedTheme, THEME_STORAGE_KEY } from './appTheme';

afterEach(() => vi.unstubAllGlobals());

describe('Vienna Secession theme preference', () => {
  it('defaults to ivory when no preference exists or storage is invalid', () => {
    for (const value of [null, 'light', 'other']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(getSavedTheme()).toBe('light');
    }
  });

  it('retains an explicit dark preference', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'dark' });
    expect(getSavedTheme()).toBe('dark');
  });

  it('keeps the document, browser chrome and stored choice in sync', () => {
    const rootAttribute = vi.fn();
    const metaAttribute = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('document', { documentElement: { setAttribute: rootAttribute }, querySelector: () => ({ setAttribute: metaAttribute }) });
    vi.stubGlobal('localStorage', { setItem });
    expect(applyTheme('dark', { persist: true })).toBe('dark');
    expect(rootAttribute).toHaveBeenLastCalledWith('data-theme', 'dark');
    expect(metaAttribute).toHaveBeenLastCalledWith('content', '#1c2119');
    expect(setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, 'dark');
    applyTheme('light', { persist: true });
    expect(metaAttribute).toHaveBeenLastCalledWith('content', '#f7f4eb');
    expect(setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, 'light');
  });

  it('works when private browsing rejects persistence', () => {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(getSavedTheme()).toBe('light');
    expect(() => applyTheme('dark', { persist: true })).not.toThrow();
  });
});
