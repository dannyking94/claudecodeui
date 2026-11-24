import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProjectApp, ProjectAppLogEntry } from '@/shared/types';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { formatCompactAge } from '@/shared/utils';
import { fetchProjectAppLog } from '@/modules/project-apps/hooks/useProjectApps';

type AppDetailsDialogProps = {
  app: ProjectApp;
  onClose: () => void;
};

function formatUptime(seconds: number | null): string | null {
  if (seconds === null) return null;
  return formatCompactAge(Date.now() - seconds * 1000);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** Details and start/stop history for one app, opened from its card's info button (keyed by app id). */
export function AppDetailsDialog({ app, onClose }: AppDetailsDialogProps) {
  const { t } = useTranslation();
  // The dashboard's action history for this app; null while loading.
  const [log, setLog] = useState<ProjectAppLogEntry[] | null>(null);
  // Why the history could not be loaded (dashboard down), shown in place of it.
  const [logError, setLogError] = useState<string | null>(null);

  // The parent keys this dialog by app id, so state starts fresh per app; polls
  // replace the app object but must not refetch the history.
  const appId = app.id;
  useEffect(() => {
    let cancelled = false;
    fetchProjectAppLog(appId).then(
      (entries) => { if (!cancelled) setLog(entries); },
      (error: unknown) => { if (!cancelled) setLogError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { cancelled = true; };
  }, [appId]);

  const commands = Object.entries(app.commands);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border-border bg-popover p-0 shadow-2xl">
        <DialogTitle>{app.name}</DialogTitle>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-foreground">{app.name}</p>
            <p className="text-xs text-muted-foreground">{app.id} · {app.host} · {app.ports.map((p) => `:${p}`).join(' ')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('projectApps.close', { defaultValue: 'Close' })} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <dl>
            {app.purpose && <Row label="Purpose">{app.purpose}</Row>}
            {app.note && <Row label="Note">{app.note}</Row>}
            <Row label="Status">
              {app.status}{app.latencyMs !== null ? ` · ${Math.round(app.latencyMs)}ms` : ''}{app.error ? ` · ${app.error}` : ''}
            </Row>
            {app.pids.length > 0 && <Row label="PIDs">{app.pids.join(', ')}{formatUptime(app.uptimeSeconds) ? ` · up ${formatUptime(app.uptimeSeconds)}` : ''}</Row>}
            {app.ownershipDetail && <Row label="Ownership">{app.ownershipDetail}</Row>}
            <Row label="Controls">{app.controls} — {app.controlsReason}</Row>
            {app.startedBy && <Row label="Started by">{app.startedBy}</Row>}
            {app.runs && <Row label="Runs">{app.runs}</Row>}
            <Row label="Workdir"><span className="font-mono text-xs">{app.workdir}</span></Row>
            {app.git && (
              <Row label="Code">
                <span className="font-mono text-xs">{app.git.branch ?? '?'} @ {app.git.head ?? '?'}</span>
                {app.git.stale && <span className="ml-2 text-amber-700 dark:text-amber-400">stale: {app.git.reasons.join('; ')}</span>}
              </Row>
            )}
            {app.missingScripts.length > 0 && <Row label="Missing">{app.missingScripts.join(', ')}</Row>}
            {app.links.length > 0 && (
              <Row label="Links">
                {app.links.map((link) => <div key={link} className="truncate font-mono text-xs">{link}</div>)}
              </Row>
            )}
            {commands.length > 0 && (
              <Row label="Commands">
                {commands.map(([name, argv]) => (
                  <div key={name} className="font-mono text-xs"><span className="text-muted-foreground">{name}:</span> {argv.join(' ')}</div>
                ))}
              </Row>
            )}
          </dl>

          <h4 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('projectApps.history', { defaultValue: 'Start / stop history' })}
          </h4>
          {logError && <p className="text-sm text-muted-foreground">{logError}</p>}
          {!logError && log === null && <p className="text-sm text-muted-foreground">{t('projectApps.loading', { defaultValue: 'Loading…' })}</p>}
          {log?.length === 0 && <p className="text-sm text-muted-foreground">{t('projectApps.noHistory', { defaultValue: 'No actions recorded.' })}</p>}
          <ul className="space-y-2">
            {log?.map((entry, index) => (
              <li key={`${entry.ts}-${index}`} className="rounded-lg border border-border p-2 text-xs">
                <div className="flex flex-wrap gap-x-2 font-medium text-foreground">
                  <span>{entry.ts}</span><span>{entry.action}</span>
                  <span className="text-muted-foreground">{entry.who}</span>
                  {entry.refused ? <span className="text-amber-700 dark:text-amber-400">refused</span> : <span className="text-muted-foreground">exit {entry.exit ?? '—'}</span>}
                </div>
                {entry.refused && <p className="mt-1 text-muted-foreground">{entry.refused}</p>}
                {entry.steps.length > 0 && <p className="mt-1 text-muted-foreground">{entry.steps.join(' → ')}</p>}
                {entry.outputTail && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 font-mono text-[11px]">{entry.outputTail}</pre>}
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
