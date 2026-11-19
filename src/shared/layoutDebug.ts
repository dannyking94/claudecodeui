/**
 * Opt-in on-screen dump of the viewport and safe-area geometry.
 *
 * iOS Safari's own bars do not exist in any headless engine, so how the page
 * sits behind them can only be read on the device, which has no devtools
 * without a tethered Mac. Open the app with `?layoutDebug=1` and a small panel
 * lists what Safari reports; screenshot it.
 *
 * Its own chunk, fetched by the app entry (main.tsx) only when asked for.
 */

const REFRESH_INTERVAL_MS = 1000;
/** WebKit hit-tests this far inside each viewport edge when it picks the element that tints its bars. */
const EDGE_SAMPLE_INSET_PX = 4;
const MAX_EDGE_CANDIDATES = 4;

function px(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function describeElement(element: Element): string {
  const classes = Array.from(element.classList).slice(0, 4).join('.');
  const id = element.id ? `#${element.id}` : '';
  return `${element.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ''}`;
}

/** Height in px that a CSS length resolves to, measured on a throwaway element. */
function measureCssLength(length: string): string {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:0;height:${length}`;
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return px(height);
}

/**
 * The fixed or sticky elements covering the midpoint of the top or bottom
 * viewport edge, front to back. Safari 26 colours the band behind its status
 * bar and toolbar from the first one it accepts there, in preference to the
 * body background, and hidden ones can still be picked.
 */
function describeEdgeCandidates(edge: 'top' | 'bottom'): string[] {
  const x = window.innerWidth / 2;
  const y = edge === 'top' ? EDGE_SAMPLE_INSET_PX : window.innerHeight - EDGE_SAMPLE_INSET_PX;
  const candidates: string[] = [];
  document.querySelectorAll('body *').forEach((element) => {
    if (element.closest('[data-layout-debug]')) {
      return;
    }
    const style = getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') {
      return;
    }
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || x < box.left || x > box.right || y < box.top || y > box.bottom) {
      return;
    }
    candidates.push(
      `${describeElement(element)} ${style.position} bg=${style.backgroundColor} op=${style.opacity}` +
        `${style.visibility === 'visible' ? '' : ` vis=${style.visibility}`} z=${style.zIndex} ${px(box.width)}x${px(box.height)}`,
    );
  });
  // Later in document order is usually painted on top, which is what gets hit first.
  return candidates.reverse().slice(0, MAX_EDGE_CANDIDATES);
}

function collectLayoutLines(): string[] {
  const root = document.documentElement;
  const visualViewport = window.visualViewport;
  const shell = document.querySelector<HTMLElement>('.workspace-shell');
  const rootStyle = getComputedStyle(root);
  const bodyStyle = getComputedStyle(document.body);

  const insetProbe = document.createElement('div');
  insetProbe.style.cssText =
    'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(insetProbe);
  const insetStyle = getComputedStyle(insetProbe);
  const insets = [insetStyle.paddingTop, insetStyle.paddingRight, insetStyle.paddingBottom, insetStyle.paddingLeft].join(' ');
  const fixedBottom = insetProbe.getBoundingClientRect().bottom;
  insetProbe.remove();

  const entryScript = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;

  const lines = [
    `ua ${navigator.userAgent}`,
    `touch=${navigator.maxTouchPoints} standalone=${String(standalone)} secure=${String(window.isSecureContext)}` +
      ` sw=${'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'controlling' : 'none') : 'unsupported'}`,
    `build ${entryScript ? entryScript.src.split('/').pop() : '?'}`,
    `html.class "${root.className}"`,
    `inner ${window.innerWidth}x${window.innerHeight} client ${root.clientWidth}x${root.clientHeight}` +
      ` screen ${window.screen.width}x${window.screen.height} dpr=${window.devicePixelRatio} scrollY=${px(window.scrollY)}`,
    visualViewport
      ? `vv ${px(visualViewport.width)}x${px(visualViewport.height)} offTop=${px(visualViewport.offsetTop)}` +
        ` pageTop=${px(visualViewport.pageTop)} scale=${px(visualViewport.scale)}`
      : 'vv none',
    `svh=${measureCssLength('100svh')} lvh=${measureCssLength('100lvh')} dvh=${measureCssLength('100dvh')} vh=${measureCssLength('100vh')}`,
    `safe-area t r b l: ${insets}`,
    `fixed bottom:0 at y=${px(fixedBottom)}`,
  ];

  if (shell) {
    const shellStyle = getComputedStyle(shell);
    const box = shell.getBoundingClientRect();
    lines.push(
      `shell ${shellStyle.position} top=${px(box.top)} bottom=${px(box.bottom)} h=${px(box.height)}` +
        ` overlap=${shell.style.getPropertyValue('--browser-toolbar-overlap') || 'unset'}` +
        ` kb=${String(shell.hasAttribute('data-keyboard-open'))} bg=${shellStyle.backgroundColor}`,
    );
  } else {
    lines.push('shell not mounted');
  }

  lines.push(
    `html ${px(root.getBoundingClientRect().height)}h bg=${rootStyle.backgroundColor} overflow=${rootStyle.overflowY}`,
    `body ${px(document.body.getBoundingClientRect().height)}h bg=${bodyStyle.backgroundColor}`,
    `theme-color ${document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? 'none'}` +
      ` scheme=${window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}`,
  );

  (['top', 'bottom'] as const).forEach((edge) => {
    const candidates = describeEdgeCandidates(edge);
    lines.push(`${edge} edge tint candidates: ${candidates.length === 0 ? 'none (body colour is used)' : ''}`);
    candidates.forEach((candidate) => lines.push(`  ${candidate}`));
  });

  return lines;
}

/**
 * Mounts the panel and keeps it current. Used by main.tsx when
 * layout debugging is requested.
 *
 * The panel is deliberately narrower than 80% of the viewport and away from
 * every edge: Safari takes its bar colour from wide fixed elements at the
 * edges, and the probe must not change what it measures.
 */
export function mountLayoutDebugOverlay(): void {
  const panel = document.createElement('pre');
  panel.setAttribute('data-layout-debug', '');
  panel.setAttribute('aria-hidden', 'true');
  panel.style.cssText =
    'position:fixed;left:12%;top:24%;width:76%;max-height:60%;margin:0;padding:6px;overflow:hidden;' +
    'z-index:2147483647;pointer-events:none;white-space:pre-wrap;word-break:break-all;border-radius:6px;' +
    'background:rgba(0,0,0,0.82);color:#b6f7c1;font:9px/11px ui-monospace,Menlo,monospace';
  document.body.appendChild(panel);

  const refresh = () => {
    let text: string;
    try {
      text = collectLayoutLines().join('\n');
    } catch (error) {
      text = `layout debug failed: ${String(error)}`;
    }
    if (panel.textContent !== text) {
      panel.textContent = text;
    }
  };

  refresh();
  window.setInterval(refresh, REFRESH_INTERVAL_MS);
  window.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('resize', refresh);
}
