export const THEME_KEY = 'ellai-theme';

export type Theme = 'dark' | 'light';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** A stored 'dark' or 'light' wins. Anything else, including nothing stored, follows the device. */
export function initialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored;
  return prefersDark ? 'dark' : 'light';
}

/**
 * Runs in the page head before anything paints, so the first frame is already in the right mode. It
 * does what initialTheme does, with each browser call in its own try block: a browser that blocks
 * storage still follows the device. Besides data-theme it sets the `dark` class, which the docs
 * library and its code colours read.
 */
export const THEME_SCRIPT = `(function(){var s=null;try{s=localStorage.getItem('${THEME_KEY}')}catch(e){}var t=s==='dark'||s==='light'?s:null;if(!t){try{t=matchMedia('${DARK_QUERY}').matches?'dark':'light'}catch(e){t='light'}}var h=document.documentElement;h.setAttribute('data-theme',t);if(t==='dark')h.classList.add('dark');else h.classList.remove('dark')})()`;

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function prefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** The mode the page is showing right now. The head script has set it before any code here runs. */
export function currentTheme(): Theme {
  const attribute = document.documentElement.getAttribute('data-theme');
  return attribute === 'dark' || attribute === 'light' ? attribute : initialTheme(readStored(), prefersDark());
}

/** Puts the page in a mode: the data-theme attribute for our own styles and the `dark` class for the docs library. */
function showTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

// The mode the visitor picked with the switch on this page, so a blocked storage still keeps their choice.
let chosen: Theme | null = null;

/** Shows the mode and remembers it. A browser that blocks storage still switches the page. */
export function setTheme(theme: Theme): void {
  chosen = theme;
  showTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The page is already switched; only the memory for next time is lost.
  }
}

/** Calls back whenever the page changes mode, whoever changed it. Returns the way to stop listening. */
export function subscribeTheme(notify: () => void): () => void {
  const watcher = new MutationObserver(notify);
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => watcher.disconnect();
}

/** Puts the page back on the mode it should be in: a stored choice wins, then the choice made on this page, then the device. */
export function restoreTheme(): void {
  const stored = readStored();
  const theme = stored === 'dark' || stored === 'light' ? stored : (chosen ?? initialTheme(null, prefersDark()));
  showTheme(theme);
}

/**
 * Keeps the page on the right mode. It checks once on start. A change to the device's setting changes
 * the page only while nothing is stored and the switch has not been used. A change to the stored mode
 * in another tab, and a page brought back from the browser's back button, put the page on the stored
 * mode. Returns the way to stop listening.
 */
export function followDevice(): () => void {
  const list = window.matchMedia(DARK_QUERY);
  const onChange = (event: MediaQueryListEvent) => {
    const stored = readStored();
    if (chosen !== null || stored === 'dark' || stored === 'light') return;
    showTheme(initialTheme(stored, event.matches));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) restoreTheme();
  };
  const onPageShow = () => restoreTheme();
  restoreTheme();
  list.addEventListener('change', onChange);
  window.addEventListener('storage', onStorage);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    list.removeEventListener('change', onChange);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pageshow', onPageShow);
  };
}
