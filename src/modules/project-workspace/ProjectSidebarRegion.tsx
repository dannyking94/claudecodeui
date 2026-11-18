import { memo, useCallback, useDeferredValue, useEffect, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { Sidebar } from '@/modules/sidebar';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import {
  SIDEBAR_WIDTH_KEYBOARD_STEP,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useSidebarWidth,
} from '@/shared/hooks/useSidebarWidth';
import type { ProjectWorkspaceShellProps } from '@/shared/types';

/** Rendered by ProjectWorkspaceShell to host the sidebar module, docked on desktop and as a drawer on mobile. */
function ProjectSidebarRegion({
  isMobile,
}: Pick<ProjectWorkspaceShellProps, 'isMobile'>) {
  const { t } = useTranslation('common');
  const { sidebarOpen, setSidebarOpen, sidebarSharedProps } = useProjectSidebarState();
  const { width: sidebarWidth, setWidth: setSidebarWidth, resetWidth: resetSidebarWidth } = useSidebarWidth();
  // Hide sidebar leaves a 48px icon rail behind, which sizes itself — the stored
  // width and the drag handle only apply while the full sidebar is on screen.
  const { sidebarVisible } = useUiPreferences();
  const isSidebarResizable = !isMobile && sidebarVisible;
  // Drag origin; null while no resize is in progress.
  const resizeOriginRef = useRef<{ pointerX: number; width: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number>(sidebarWidth);

  // The mobile drawer stays mounted while closed so it opens instantly, but
  // nobody can see it then. Its props change on every send, session switch and
  // session_upserted, and re-rendering every project row inside the tap that
  // caused it cost hundreds of milliseconds on a phone. While closed it gets
  // the deferred copy: the urgent render skips it (Sidebar is memoized) and
  // React catches it up in an interruptible background render.
  const deferredSidebarProps = useDeferredValue(sidebarSharedProps);
  const mobileSidebarProps = sidebarOpen ? sidebarSharedProps : deferredSidebarProps;

  // `inert` keeps the closed drawer out of focus and the accessibility tree.
  // Toggling it restyles every row, so it waits out the 150ms slide instead of
  // landing in the same frames. React 18 has no `inert` prop, so it is set on
  // the element directly.
  const mobileDrawerPanelRef = useRef<HTMLDivElement>(null);
  const mobileDrawerMountedRef = useRef(false);
  useEffect(() => {
    const panel = mobileDrawerPanelRef.current;
    if (!panel) {
      mobileDrawerMountedRef.current = false;
      return undefined;
    }
    if (!mobileDrawerMountedRef.current) {
      mobileDrawerMountedRef.current = true;
      panel.inert = !sidebarOpen;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      panel.inert = !sidebarOpen;
    }, 200);
    return () => window.clearTimeout(timer);
  }, [isMobile, sidebarOpen]);

  const handleBackdropClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  const handleBackdropTouch = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  // Sidebar resizing (desktop only). Pointer capture keeps the drag alive when
  // the cursor leaves the 4px handle, and the width is only written to storage
  // once the pointer is released.
  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeOriginRef.current = { pointerX: event.clientX, width: sidebarWidth };
    pendingWidthRef.current = sidebarWidth;
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = resizeOriginRef.current;
    if (!origin) return;

    pendingWidthRef.current = origin.width + (event.clientX - origin.pointerX);
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      setSidebarWidth(pendingWidthRef.current, false);
    });
  }, [setSidebarWidth]);

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeOriginRef.current) return;
    resizeOriginRef.current = null;

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = '';
    setSidebarWidth(pendingWidthRef.current);
  }, [setSidebarWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth - SIDEBAR_WIDTH_KEYBOARD_STEP);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth + SIDEBAR_WIDTH_KEYBOARD_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetSidebarWidth();
    }
  }, [resetSidebarWidth, setSidebarWidth, sidebarWidth]);

  // Going mobile or collapsing mid-drag unmounts the separator, so the pointerup
  // that would have ended the drag never arrives: the body stays unselectable, and
  // the live origin would make a plain hover resize the sidebar once it is back.
  useEffect(() => {
    if (isSidebarResizable) return;
    resizeOriginRef.current = null;
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    document.body.style.userSelect = '';
  }, [isSidebarResizable]);

  // A drag interrupted by an unmount must not leave the page unselectable.
  useEffect(() => () => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
    document.body.style.userSelect = '';
  }, []);

  if (!isMobile) {
    return (
      <div
        className="relative h-full flex-shrink-0 border-r border-border/50"
        style={isSidebarResizable ? { width: sidebarWidth } : undefined}
      >
        <Sidebar {...sidebarSharedProps} />
        {isSidebarResizable && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('versionUpdate.ariaLabels.resizeSidebar')}
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            tabIndex={0}
            className="absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={resetSidebarWidth}
            onKeyDown={handleResizeKeyDown}
          />
        )}
      </div>
    );
  }

  // Opened and closed through inline styles only, never by changing classes:
  // the typography plugin's `[class~=not-prose] *` rules make Chrome restyle
  // the whole subtree of any element whose class changes, which here is every
  // sidebar row. `visibility` on the wrapper would likewise start a transition
  // on every `transition-all` row; instead the panel sits off-screen, the
  // wrapper is always click-through and only the leaf close button hides.
  return (
    <div
      aria-hidden={!sidebarOpen}
      className="pointer-events-none fixed inset-0 z-50 flex transition-opacity duration-150 ease-out"
      style={{ opacity: sidebarOpen ? 1 : 0 }}
    >
      {/* A plain dim, not a backdrop blur: blurring the whole app behind the
          drawer made every frame of the slide expensive on iOS. It is its own
          layer because the touch-device rules strip a hovered button's background. */}
      <div className="fixed inset-0 bg-black/40" />
      <button
        // Hidden on its own: the touch-device rule that forces
        // `pointer-events: auto` on every button would let it swallow taps
        // through the closed drawer.
        className="fixed inset-0 transition-[visibility] duration-150"
        style={{ visibility: sidebarOpen ? 'visible' : 'hidden' }}
        onClick={handleBackdropClick}
        onTouchStart={handleBackdropTouch}
        aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
      />
      <div
        ref={mobileDrawerPanelRef}
        className="pointer-events-auto relative h-full w-[85vw] max-w-sm border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80"
        style={{ transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)' }}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        <Sidebar {...mobileSidebarProps} />
      </div>
    </div>
  );
}

export default memo(ProjectSidebarRegion);
