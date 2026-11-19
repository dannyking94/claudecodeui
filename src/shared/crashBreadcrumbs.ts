/**
 * Crash breadcrumbs: what the page looked like just before the browser killed it.
 *
 * When iOS Safari's web process dies (memory pressure, or a runaway loop) the
 * page gets no event and no chance to log; Safari reloads it, and if that
 * dies too it shows "a problem repeatedly occurred". The phone has no devtools
 * without a tethered Mac, and desktop engines do not hit the phone's limits,
 * so the only way to see the state at death is to have written it down
 * before. Every page life keeps one small record in localStorage, refreshed
 * every few seconds and marked ended on `pagehide`; a record still open at the
 * next boot belonged to a page that was killed, and joins a short crash log.
 *
 * `?crashDebug=1` shows that log on screen (kept for the browser session so it
 * survives the login redirect; `?crashDebug=0` hides it again).
 *
 * Started by the app entry (main.tsx) before React mounts, so a crash during
 * the first render is still recorded.
 */

const LIFE_STORAGE_KEY = 'cloudcli:page-life';
const CRASH_LOG_STORAGE_KEY = 'cloudcli:crash-log';
const OVERLAY_SESSION_KEY = 'cloudcli:crash-debug';
const SAMPLE_INTERVAL_MS = 2000;
const MAX_CRASH_LOG_ENTRIES = 8;

type PageSample = {
  at: number;
  path: string;
  visibility: string;
  domNodes: number;
  transcriptRows: number;
  transcriptScrollHeight: number;
  documentHeight: number;
  images: number;
  /** Width x height x 4 summed over loaded images: a floor for their decoded size. */
  decodedImageMB: number;
  canvases: number;
  /** Chromium only; Safari does not expose it. */
  jsHeapMB: number | null;
};

type PageLife = {
  startedAt: number;
  ended: boolean;
  samples: number;
  last: PageSample | null;
  peakDomNodes: number;
  peakDecodedImageMB: number;
  userAgent: string;
};

type CrashLogEntry = PageLife & { detectedAt: number };

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode: breadcrumbs are best-effort.
  }
}

function roundMB(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

function takeSample(): PageSample {
  let decodedImageBytes = 0;
  let images = 0;
  for (const image of Array.from(document.images)) {
    images += 1;
    decodedImageBytes += image.naturalWidth * image.naturalHeight * 4;
  }
  let transcriptScrollHeight = 0;
  document.querySelectorAll('.chat-messages-pane').forEach((pane) => {
    transcriptScrollHeight = Math.max(transcriptScrollHeight, pane.scrollHeight);
  });
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;

  return {
    at: Date.now(),
    path: window.location.pathname,
    visibility: document.visibilityState,
    domNodes: document.getElementsByTagName('*').length,
    transcriptRows: document.querySelectorAll('.chat-message').length,
    transcriptScrollHeight,
    documentHeight: document.documentElement.scrollHeight,
    images,
    decodedImageMB: roundMB(decodedImageBytes),
    canvases: document.getElementsByTagName('canvas').length,
    jsHeapMB: memory ? roundMB(memory.usedJSHeapSize) : null,
  };
}

/**
 * Moves a previous page life that never ended into the crash log. Exported for
 * the tests; the app calls it only through `startCrashBreadcrumbs`.
 */
export function collectUnendedLife(now: number): CrashLogEntry | null {
  const previous = readJson<PageLife>(LIFE_STORAGE_KEY);
  if (!previous || previous.ended) {
    return null;
  }
  const entry: CrashLogEntry = { ...previous, detectedAt: now };
  const log = readJson<CrashLogEntry[]>(CRASH_LOG_STORAGE_KEY) ?? [];
  writeJson(CRASH_LOG_STORAGE_KEY, [entry, ...log].slice(0, MAX_CRASH_LOG_ENTRIES));
  return entry;
}

/** Recorded crashes, newest first. */
export function readCrashLog(): CrashLogEntry[] {
  return readJson<CrashLogEntry[]>(CRASH_LOG_STORAGE_KEY) ?? [];
}

function isOverlayRequested(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get('crashDebug');
    if (param !== null) {
      if (param === '0' || param === 'false' || param === 'off') {
        window.sessionStorage.removeItem(OVERLAY_SESSION_KEY);
      } else {
        window.sessionStorage.setItem(OVERLAY_SESSION_KEY, '1');
      }
    }
    return window.sessionStorage.getItem(OVERLAY_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function describeEntry(entry: CrashLogEntry | PageLife, label: string): string {
  const sample = entry.last;
  const time = (value: number) => new Date(value).toLocaleTimeString();
  if (!sample) {
    return `${label}: started ${time(entry.startedAt)}, died before the first sample`;
  }
  const lived = Math.round((sample.at - entry.startedAt) / 1000);
  return [
    `${label}: started ${time(entry.startedAt)}, last seen ${time(sample.at)} (${lived}s, ${entry.samples} samples)`,
    `  ${sample.path} [${sample.visibility}]`,
    `  dom=${sample.domNodes} (peak ${entry.peakDomNodes}) rows=${sample.transcriptRows}`
      + ` paneH=${sample.transcriptScrollHeight} docH=${sample.documentHeight}`,
    `  img=${sample.images} ~${sample.decodedImageMB}MB (peak ${entry.peakDecodedImageMB}MB)`
      + ` canvas=${sample.canvases} heap=${sample.jsHeapMB ?? 'n/a'}`,
  ].join('\n');
}

function mountOverlay(getLife: () => PageLife): void {
  const panel = document.createElement('pre');
  panel.setAttribute('data-crash-debug', '');
  panel.style.cssText = [
    'position:fixed', 'left:4px', 'right:4px', 'top:calc(env(safe-area-inset-top) + 4px)',
    'z-index:2147483647', 'max-height:45vh', 'overflow:auto', 'margin:0', 'padding:6px',
    'font:10px/1.35 ui-monospace,monospace', 'white-space:pre-wrap', 'color:#fff',
    'background:rgba(0,0,0,0.82)', 'border-radius:6px', 'pointer-events:auto',
  ].join(';');
  const render = () => {
    const log = readCrashLog();
    panel.textContent = [
      `crash log (${log.length}) — ?crashDebug=0 to hide; tap to clear`,
      ...log.map((entry, index) => describeEntry(entry, `#${index + 1}`)),
      describeEntry(getLife(), 'this page'),
    ].join('\n');
  };
  panel.addEventListener('click', () => {
    writeJson(CRASH_LOG_STORAGE_KEY, []);
    render();
  });
  document.body.appendChild(panel);
  render();
  window.setInterval(render, SAMPLE_INTERVAL_MS);
}

/** Starts recording this page life. Call once, from the app entry. */
export function startCrashBreadcrumbs(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const detected = collectUnendedLife(Date.now());
  if (detected) {
    console.warn('[crash-breadcrumbs] the previous page was killed without unloading', detected);
  }

  const life: PageLife = {
    startedAt: Date.now(),
    ended: false,
    samples: 0,
    last: null,
    peakDomNodes: 0,
    peakDecodedImageMB: 0,
    userAgent: navigator.userAgent,
  };
  const persist = () => writeJson(LIFE_STORAGE_KEY, life);
  const sample = () => {
    // Cheap enough to run unconditionally: one live-collection length and a
    // few selector counts, no layout reads beyond scrollHeight.
    const next = takeSample();
    life.samples += 1;
    life.last = next;
    life.peakDomNodes = Math.max(life.peakDomNodes, next.domNodes);
    life.peakDecodedImageMB = Math.max(life.peakDecodedImageMB, next.decodedImageMB);
    life.ended = false;
    persist();
  };

  persist();
  window.setInterval(sample, SAMPLE_INTERVAL_MS);
  // A page that unloads normally (navigation, reload, tab closed) is not a crash.
  // bfcache restores re-open the life via the next sample.
  window.addEventListener('pagehide', () => {
    life.ended = true;
    persist();
  });

  if (isOverlayRequested()) {
    const mount = () => mountOverlay(() => life);
    if (document.body) {
      mount();
    } else {
      window.addEventListener('DOMContentLoaded', mount, { once: true });
    }
  }
}
