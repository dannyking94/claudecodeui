import { memo } from 'react';

import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectQuickSettingsRegion from '@/modules/project-workspace/ProjectQuickSettingsRegion';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';
import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  const shellRef = useVisualViewportKeyboardOffset<HTMLDivElement>();

  return (
    // Edge to edge on purpose: the background fills the rounded corners, the
    // Dynamic Island band and the home-indicator band; the header, composer
    // and sidebar pad their own content by the safe-area insets. The side
    // insets only matter in landscape.
    <div
      ref={shellRef}
      className="fixed inset-0 flex bg-background pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
    >
      <ProjectEffects navigate={navigate} />
      <ProjectSidebarRegion isMobile={isMobile} />

      <div className="flex min-w-0 flex-1 flex-col">
        <ProjectMainRegion
          isMobile={isMobile}
          ws={ws}
          sendMessage={sendMessage}
          navigate={navigate}
        />
      </div>

      <ProjectCommandPalette />
      {/* Last flex child on purpose: when pinned it docks to the right of the main region. */}
      <ProjectQuickSettingsRegion />
    </div>
  );
}

export default memo(ProjectWorkspaceShell);
