// Covers: which mode a visitor starts in (a stored choice wins, anything else follows the device), the
// head script that sets it before first paint, the `dark` class the docs library reads (set exactly when
// the mode is dark), that the switch still works when storage is blocked, and the WCAG AA contrast of the
// colour tokens in both modes, read straight from globals.css and docs.css.
// Does NOT cover: how the page looks in a real browser, or text drawn at partial strength except the
// poster text strengths.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, THEME_SCRIPT, initialTheme, setTheme } from '../src/ui/site/theme.js';

describe('initialTheme', () => {
  it('uses a stored dark whatever the device says', () => {
    expect(initialTheme('dark', false)).toBe('dark');
    expect(initialTheme('dark', true)).toBe('dark');
  });

  it('uses a stored light whatever the device says', () => {
    expect(initialTheme('light', true)).toBe('light');
    expect(initialTheme('light', false)).toBe('light');
  });

  it('follows a dark device when the stored value is junk or missing', () => {
    expect(initialTheme('banana', true)).toBe('dark');
    expect(initialTheme('', true)).toBe('dark');
    expect(initialTheme(null, true)).toBe('dark');
  });

  it('follows a light device when the stored value is junk or missing', () => {
    expect(initialTheme('banana', false)).toBe('light');
    expect(initialTheme('DARK', false)).toBe('light');
    expect(initialTheme(null, false)).toBe('light');
  });
});

type Scenario = { stored: string | null; storageBlocked: boolean; deviceDark: boolean; matchMediaBroken?: boolean };

/** A stand-in for the <html> element that remembers its attributes and its class list. */
function fakeRoot(startClasses: string[] = []) {
  const attributes = new Map<string, string>();
  const classes = new Set(startClasses);
  return {
    attributes,
    classes,
    element: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    },
  };
}

function runHeadScript(scenario: Scenario, startClasses: string[] = []) {
  const root = fakeRoot(startClasses);
  const sandbox = {
    localStorage: {
      getItem(key: string) {
        if (scenario.storageBlocked) throw new Error('storage blocked');
        return key === THEME_KEY ? scenario.stored : null;
      },
    },
    matchMedia() {
      if (scenario.matchMediaBroken) throw new Error('no matchMedia');
      return { matches: scenario.deviceDark };
    },
    document: { documentElement: root.element },
  };
  runInNewContext(THEME_SCRIPT, sandbox);
  return { theme: root.attributes.get('data-theme') ?? null, dark: root.classes.has('dark') };
}

describe('the head script', () => {
  it('gives the same answer as initialTheme for every stored value and device setting', () => {
    for (const stored of ['dark', 'light', 'banana', '', null]) {
      for (const deviceDark of [true, false]) {
        expect(runHeadScript({ stored, storageBlocked: false, deviceDark }).theme).toBe(initialTheme(stored, deviceDark));
      }
    }
  });

  it('sets the dark class exactly when the mode is dark', () => {
    for (const stored of ['dark', 'light', 'banana', '', null]) {
      for (const deviceDark of [true, false]) {
        const result = runHeadScript({ stored, storageBlocked: false, deviceDark });
        expect(result.dark, `stored ${stored}, device dark ${deviceDark}`).toBe(result.theme === 'dark');
      }
    }
  });

  it('removes a leftover dark class when the mode is light', () => {
    expect(runHeadScript({ stored: 'light', storageBlocked: false, deviceDark: true }, ['dark'])).toEqual({ theme: 'light', dark: false });
  });

  it('still follows the device when the browser blocks storage', () => {
    expect(runHeadScript({ stored: 'light', storageBlocked: true, deviceDark: true })).toEqual({ theme: 'dark', dark: true });
    expect(runHeadScript({ stored: 'dark', storageBlocked: true, deviceDark: false })).toEqual({ theme: 'light', dark: false });
  });

  it('falls back to light when the browser cannot answer the device question', () => {
    expect(runHeadScript({ stored: null, storageBlocked: true, deviceDark: true, matchMediaBroken: true })).toEqual({ theme: 'light', dark: false });
  });
});

describe('setTheme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes the mode to the page and to storage', () => {
    const root = fakeRoot();
    const saved = new Map<string, string>();
    vi.stubGlobal('document', { documentElement: root.element });
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => saved.set(key, value) });
    setTheme('dark');
    expect(root.attributes.get('data-theme')).toBe('dark');
    expect(saved.get(THEME_KEY)).toBe('dark');
  });

  it('sets the dark class exactly when the mode is dark, going both ways', () => {
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root.element });
    vi.stubGlobal('localStorage', { setItem() {} });
    setTheme('dark');
    expect(root.classes.has('dark')).toBe(true);
    setTheme('light');
    expect(root.classes.has('dark')).toBe(false);
    setTheme('dark');
    expect(root.classes.has('dark')).toBe(true);
  });

  it('still switches the page when storage is blocked', () => {
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root.element });
    vi.stubGlobal('localStorage', {
      setItem() {
        throw new Error('storage blocked');
      },
    });
    expect(() => setTheme('light')).not.toThrow();
    expect(root.attributes.get('data-theme')).toBe('light');
    expect(root.classes.has('dark')).toBe(false);
  });
});

describe('followDevice and restoreTheme', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The module remembers which mode was picked on this page, so each test loads a fresh copy.
  async function freshTheme() {
    vi.resetModules();
    return import('../src/ui/site/theme.js');
  }

  type Listener = (event: never) => void;

  /** A page whose storage, device setting and window events the test controls. */
  function stubPage({ stored = null, deviceDark = false }: { stored?: string | null; deviceDark?: boolean } = {}) {
    const root = fakeRoot();
    const state = { stored, deviceDark };
    const windowListeners = new Map<string, Listener>();
    let mediaListener: Listener | null = null;
    vi.stubGlobal('document', { documentElement: root.element });
    vi.stubGlobal('localStorage', {
      getItem: () => state.stored,
      setItem: (_: string, value: string) => {
        state.stored = value;
      },
    });
    vi.stubGlobal('window', {
      matchMedia: () => ({
        get matches() {
          return state.deviceDark;
        },
        addEventListener: (_: string, listener: Listener) => {
          mediaListener = listener;
        },
        removeEventListener: (_: string, listener: Listener) => {
          if (mediaListener === listener) mediaListener = null;
        },
      }),
      addEventListener: (name: string, listener: Listener) => {
        windowListeners.set(name, listener);
      },
      removeEventListener: (name: string, listener: Listener) => {
        if (windowListeners.get(name) === listener) windowListeners.delete(name);
      },
    });
    return {
      root,
      state,
      listening: () => ({ window: [...windowListeners.keys()].sort(), media: mediaListener !== null }),
      deviceChanges: (matches: boolean) => {
        state.deviceDark = matches;
        mediaListener?.({ matches } as never);
      },
      storageEvent: (key: string | null) => windowListeners.get('storage')?.({ key } as never),
      pageshow: () => windowListeners.get('pageshow')?.({} as never),
      shown: () => root.attributes.get('data-theme') ?? null,
    };
  }

  it('restoreTheme: a stored mode wins over the choice made on this page and over the device', async () => {
    const { restoreTheme, setTheme: choose } = await freshTheme();
    const page = stubPage({ deviceDark: false });
    choose('light');
    page.state.stored = 'dark';
    restoreTheme();
    expect(page.shown()).toBe('dark');
    expect(page.root.classes.has('dark')).toBe(true);
  });

  it('restoreTheme: with nothing stored, the choice made on this page wins over the device', async () => {
    const { restoreTheme, setTheme: choose } = await freshTheme();
    const page = stubPage({ deviceDark: true });
    choose('light');
    page.state.stored = null;
    restoreTheme();
    expect(page.shown()).toBe('light');
    expect(page.root.classes.has('dark')).toBe(false);
  });

  it('restoreTheme: with neither, the device wins', async () => {
    const { restoreTheme } = await freshTheme();
    const page = stubPage({ deviceDark: true });
    restoreTheme();
    expect(page.shown()).toBe('dark');
    page.state.deviceDark = false;
    restoreTheme();
    expect(page.shown()).toBe('light');
  });

  it('restoreTheme: a junk stored value is not a choice', async () => {
    const { restoreTheme } = await freshTheme();
    const page = stubPage({ stored: 'banana', deviceDark: true });
    restoreTheme();
    expect(page.shown()).toBe('dark');
  });

  it('checks once on start', async () => {
    const { followDevice } = await freshTheme();
    const page = stubPage({ stored: 'dark' });
    followDevice();
    expect(page.shown()).toBe('dark');
    expect(page.root.classes.has('dark')).toBe(true);
  });

  it('follows a device change, and the dark class goes with it, while nothing is stored', async () => {
    const { followDevice } = await freshTheme();
    const page = stubPage();
    followDevice();
    expect(page.shown()).toBe('light');
    page.deviceChanges(true);
    expect(page.shown()).toBe('dark');
    expect(page.root.classes.has('dark')).toBe(true);
    page.deviceChanges(false);
    expect(page.shown()).toBe('light');
    expect(page.root.classes.has('dark')).toBe(false);
  });

  it('ignores the device once a mode is stored', async () => {
    const { followDevice } = await freshTheme();
    const page = stubPage({ stored: 'light' });
    followDevice();
    page.deviceChanges(true);
    expect(page.shown()).toBe('light');
    expect(page.root.classes.has('dark')).toBe(false);
  });

  it('ignores the device once the switch has been used on this page, even if storage is blocked', async () => {
    const { followDevice, setTheme: choose } = await freshTheme();
    const page = stubPage();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem() {
        throw new Error('storage blocked');
      },
    });
    followDevice();
    choose('light');
    page.deviceChanges(true);
    expect(page.shown()).toBe('light');
    expect(page.root.classes.has('dark')).toBe(false);
  });

  it('a storage event for another key does nothing, and one for the mode key follows it', async () => {
    const { followDevice } = await freshTheme();
    const page = stubPage();
    followDevice();
    expect(page.shown()).toBe('light');
    page.state.stored = 'dark';
    page.storageEvent('something-else');
    expect(page.shown()).toBe('light');
    page.storageEvent(THEME_KEY);
    expect(page.shown()).toBe('dark');
    page.state.stored = 'light';
    page.storageEvent(null);
    expect(page.shown()).toBe('light');
  });

  it('a page brought back from the back button goes to the stored mode', async () => {
    const { followDevice } = await freshTheme();
    const page = stubPage({ stored: 'light' });
    followDevice();
    page.root.element.setAttribute('data-theme', 'dark');
    page.root.element.classList.add('dark');
    page.pageshow();
    expect(page.shown()).toBe('light');
    expect(page.root.classes.has('dark')).toBe(false);
  });

  it('the cleanup removes every listener', async () => {
    const { followDevice } = await freshTheme();
    const page = stubPage();
    const stop = followDevice();
    expect(page.listening()).toEqual({ window: ['pageshow', 'storage'], media: true });
    stop();
    expect(page.listening()).toEqual({ window: [], media: false });
  });
});

// Colour checks. They read the real values out of the stylesheets, so a changed token is caught here.
function stylesheet(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const GLOBALS = stylesheet('../src/app/globals.css');
const APP = stylesheet('../src/ui/app/app.css');
const DOCS = stylesheet('../src/ui/docs/docs.css');

function declarations(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) found[name] = value.trim();
  }
  return found;
}

function blockAfter(css: string, pattern: RegExp): string {
  const match = css.match(pattern);
  if (!match?.[1]) throw new Error(`no block matching ${pattern}`);
  return match[1];
}

// The three blocks every stylesheet that owns colour tokens carries: light, dark, and dark again for a visitor without scripts.
const LIGHT_BLOCK = /\n:root\s*\{([^}]*)\}/;
const DARK_BLOCK = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/;
const NO_SCRIPT_BLOCK = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/;

function blocks(css: string) {
  return {
    light: declarations(blockAfter(css, LIGHT_BLOCK)),
    dark: declarations(blockAfter(css, DARK_BLOCK)),
    noScript: declarations(blockAfter(css, NO_SCRIPT_BLOCK)),
  };
}

const PARTS = { globals: blocks(GLOBALS), app: blocks(APP), docs: blocks(DOCS) };
const LIGHT = { ...PARTS.globals.light, ...PARTS.app.light, ...PARTS.docs.light };
const MODES = {
  light: LIGHT,
  dark: { ...LIGHT, ...PARTS.globals.dark, ...PARTS.app.dark, ...PARTS.docs.dark },
} as const;

function channel(hex: string, start: number): number {
  const value = parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a six digit colour: ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

function over(foreground: string, alpha: number, background: string): string {
  const mixed = [1, 3, 5].map((start) => {
    const top = parseInt(foreground.slice(start, start + 2), 16);
    const bottom = parseInt(background.slice(start, start + 2), 16);
    return Math.round(top * alpha + bottom * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  });
  return `#${mixed.join('')}`;
}

function token(mode: keyof typeof MODES, name: string): string {
  const value = MODES[mode][name];
  if (!value) throw new Error(`${mode} mode has no ${name}`);
  return value;
}

const AA = 4.5;

// Each pair is text on the surface it sits on.
const PAIRS: ReadonlyArray<readonly [text: string, surface: string]> = [
  ['--fg', '--bg'],
  ['--fg', '--panel'],
  ['--ink', '--bg'],
  ['--ink', '--panel'],
  ['--ink-soft', '--bg'],
  ['--ink-soft', '--panel'],
  ['--accent-text', '--bg'],
  ['--accent-text', '--panel'],
  ['--accent-ink', '--accent'],
  ['--night-fg', '--night'],
  ['--paid', '--panel'],
  ['--asked', '--panel'],
  ['--refused', '--panel'],
  // The surfaces the landing page and /proof actually put text on.
  ['--ink', '--paper'],
  ['--ink-soft', '--paper'],
  ['--ink', '--bone'],
  ['--ink-soft', '--bone'],
  ['--accent-text', '--paper'],
  ['--accent-text', '--accent-wash'],
  ['--refused', '--refused-wash'],
  // The wells and panels the app draws.
  ['--ink', '--app-soft'],
  ['--ink-soft', '--app-soft'],
  ['--ink', '--app-softer'],
  ['--ink-soft', '--app-softer'],
  ['--fg', '--app-soft'],
  ['--fg', '--app-softer'],
  ['--muted', '--bg'],
  ['--muted', '--panel'],
  ['--faint', '--panel'],
  ['--accent-text', '--app-soft'],
  // The docs: text on the page, on a code block, on the open sidebar item and in the search box; links on the page.
  ['--color-fd-foreground', '--color-fd-background'],
  ['--color-fd-muted-foreground', '--color-fd-background'],
  ['--color-fd-foreground', '--color-fd-card'],
  ['--color-fd-muted-foreground', '--color-fd-card'],
  ['--color-fd-foreground', '--color-fd-muted'],
  ['--color-fd-foreground', '--color-fd-popover'],
  ['--color-fd-muted-foreground', '--color-fd-popover'],
  ['--color-fd-primary', '--color-fd-background'],
  ['--color-fd-primary-foreground', '--color-fd-primary'],
];

describe('colour contrast', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const [text, surface] of PAIRS) {
      it(`${mode}: ${text} on ${surface} is at least ${AA}:1`, () => {
        expect(contrast(token(mode, text), token(mode, surface))).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  it('the quieter poster text is at least as readable in light as it is in dark', () => {
    for (const name of ['--poster-text-strong', '--poster-text-mid', '--poster-text-soft', '--poster-text-faint']) {
      const dark = contrast(
        over(token('dark', '--night-fg'), parseFloat(token('dark', name)) / 100, token('dark', '--night')),
        token('dark', '--night'),
      );
      const light = contrast(
        over(token('light', '--night-fg'), parseFloat(token('light', name)) / 100, token('light', '--night')),
        token('light', '--night'),
      );
      expect(light, name).toBeGreaterThanOrEqual(dark - 0.05);
    }
  });

  // The docs build colours code with a light and a dark theme. These are the colours of each that its pages use.
  const LIGHT_CODE_COLOURS_ON_PAGES = ['#24292e', '#6f42c1', '#032f62', '#005cc5'];
  const GITHUB_DARK_CODE_COLOURS = ['#e1e4e8', '#b392f0', '#9ecbff', '#79b8ff', '#f97583', '#85e89d', '#ffab70', '#fdaeb7'];

  it('light: the code colours the docs pages use read on a code block', () => {
    for (const colour of LIGHT_CODE_COLOURS_ON_PAGES) {
      expect(contrast(colour, token('light', '--color-fd-card')), colour).toBeGreaterThanOrEqual(AA);
    }
  });

  it('the build uses a real dark theme for code, not the light one twice', () => {
    const config = stylesheet('../source.config.ts');
    expect(config).toContain("light: 'github-light'");
    expect(config).toContain("dark: 'github-dark'");
  });

  it('dark: the comment colour the docs swap in reads on a code block', () => {
    expect(contrast(token('dark', '--docs-code-comment'), token('dark', '--color-fd-card'))).toBeGreaterThanOrEqual(AA);
  });

  it('dark: the github-dark colours the docs use read on a code block', () => {
    for (const colour of GITHUB_DARK_CODE_COLOURS) {
      expect(contrast(colour, token('dark', '--color-fd-card')), colour).toBeGreaterThanOrEqual(AA);
    }
  });

  it('docs.css swaps no code colour except the comment grey', () => {
    const swapped = [...DOCS.toLowerCase().matchAll(/--shiki-dark:(#[0-9a-f]{6})'/g)].map((match) => match[1]);
    expect(swapped.length).toBeGreaterThan(0);
    for (const colour of swapped) expect(colour).toBe('#6a737d');
  });

  it('a dark device with scripts off still gets the dark code colours', () => {
    const noScript = DOCS.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\r?\n\}\r?\n/)?.[1] ?? '';
    expect(noScript).toMatch(/:root:not\(\[data-theme\]\) \.ellai-docs figure\.shiki code span\s*\{\s*color: var\(--shiki-dark\);/);
    expect(noScript).toContain("--shiki-dark:#6a737d' i]");
  });
});

describe('the poster text strengths', () => {
  const STRENGTHS = ['--poster-text-strong', '--poster-text-mid', '--poster-text-soft', '--poster-text-faint'];
  const PERCENT = /^\d+(\.\d+)?%$/;

  // color-mix takes a percentage and drops the whole rule for a bare number, so a bare number draws the text at full strength.
  it('every strength is a percentage in all three blocks', () => {
    const blocksOfGlobals = { light: PARTS.globals.light, dark: PARTS.globals.dark, noScript: PARTS.globals.noScript };
    for (const [block, values] of Object.entries(blocksOfGlobals)) {
      for (const name of STRENGTHS) expect(values[name], `${block} ${name}`).toMatch(PERCENT);
    }
  });

  function sourceFiles(): Array<{ file: string; text: string }> {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
      .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
  }

  it('every /(--token) colour class in the source names a token that is a percentage in both modes', () => {
    const used = new Set<string>();
    for (const { text } of sourceFiles()) for (const match of text.matchAll(/\/\((--[a-z0-9-]+)\)/g)) if (match[1]) used.add(match[1]);
    for (const name of STRENGTHS) expect(used.has(name), `${name} is used by a class`).toBe(true);
    for (const name of used) {
      expect(token('light', name), `light ${name}`).toMatch(PERCENT);
      expect(token('dark', name), `dark ${name}`).toMatch(PERCENT);
    }
  });

  it('the faint strength is used only in a border class', () => {
    const uses: string[] = [];
    for (const { file, text } of sourceFiles()) {
      for (const match of text.matchAll(/([^\s'"`]+)\/\(--poster-text-faint\)/g)) uses.push(`${file}: ${match[1]}`);
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use, use).toMatch(/: (?:[a-z-]+:)*border-/);
  });

  it('the soft strength reads at AA over the poster surface in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const text = over(token(mode, '--night-fg'), parseFloat(token(mode, '--poster-text-soft')) / 100, token(mode, '--night'));
      expect(contrast(text, token(mode, '--night')), mode).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('the mode tokens', () => {
  for (const [name, parts] of Object.entries(PARTS)) {
    it(`${name}: the no-script dark block repeats the dark block exactly`, () => {
      expect(parts.noScript).toEqual(parts.dark);
    });

    it(`${name}: the dark block sets every colour token the light block sets, so no light value leaks into dark`, () => {
      const colourNames = Object.keys(parts.light).filter(
        (key) => !key.startsWith('--r-') && !key.startsWith('--font-') && !key.startsWith('--docs-code-'),
      );
      for (const key of colourNames) expect(parts.dark[key], `${name} ${key}`).toBeDefined();
    });
  }
});
