import { Clock, Copy, CornerDownRight, ExternalLink, Info, Loader2, Play, RotateCw, Square, Check } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProjectAppWithOwner, ProjectAppAction, ProjectAppActionResult } from '@/shared/types';
import { cn, copyTextToClipboard, formatCompactAge, toBrowserReachableUrl } from '@/shared/utils';

type AppCardProps = {
  app: ProjectAppWithOwner;
  pendingAction: ProjectAppAction | null;
  /** Another app's action is running; manage buttons wait for it. */
  isBusyElsewhere: boolean;
  lastResult: ProjectAppActionResult | { error: string } | undefined;
  onAction: (action: ProjectAppAction) => void;
  onShowDetails: () => void;
};

/** The URL the Open button uses: the first browser link, else the health URL made reachable from here. */
function primaryUrl(app: ProjectAppWithOwner): string {
  return toBrowserReachableUrl(app.links[0] ?? app.healthUrl);
}

/** Distinct sub-paths across the app's links ("/scene", "/?deploy"); a lone "/" is not worth a chip. */
function subPathLinks(app: ProjectAppWithOwner): Array<{ label: string; url: string }> {
  const seen = new Set<string>();
  const chips: Array<{ label: string; url: string }> = [];
  for (const link of app.links) {
    try {
      const parsed = new URL(link);
      const label = `${parsed.pathname}${parsed.search}`;
      if (seen.has(label)) continue;
      seen.add(label);
      chips.push({ label, url: toBrowserReachableUrl(link) });
    } catch {
      // A malformed registry link gets no chip.
    }
  }
  return chips.length === 1 && chips[0].label === '/' ? [] : chips;
}

/** "secretary dk-ai-1 (serve.sh start …)" → "secretary dk-ai-1": the who, without the how. */
function shortStartedBy(startedBy: string): string {
  return startedBy.split(/[(,;]/)[0].trim();
}

/** Status dot shared by the Apps tab's app cards and chat-link cards (grey for unchecked). */
export function StatusDot({ status }: { status: ProjectAppWithOwner['status'] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        status === 'up' && 'bg-emerald-500',
        status === 'down' && 'bg-red-500',
        status === 'unknown' && 'bg-muted-foreground/50',
      )}
    />
  );
}

/** Card for one registered app on the Apps tab: status, links, who started it, and manage buttons. */
export function AppCard({ app, pendingAction, isBusyElsewhere, lastResult, onAction, onShowDetails }: AppCardProps) {
  const { t } = useTranslation();
  // Brief "copied" tick on the Copy button so a tap on a phone has visible feedback.
  const [copied, setCopied] = useState(false);
  const chips = subPathLinks(app);
  const openedAge = formatCompactAge(app.lastOpened !== null ? app.lastOpened * 1000 : null);
  // With status unknown the dashboard is down, so an action could only fail.
  const canManage = app.controls === 'full' && app.status !== 'unknown';
  const manageDisabled = pendingAction !== null || isBusyElsewhere;

  const handleCopy = async () => {
    if (await copyTextToClipboard(primaryUrl(app))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const confirmAndRun = (action: ProjectAppAction) => {
    if (action !== 'start') {
      const question = t('projectApps.confirmAction', {
        defaultValue: '{{action}} {{name}}? Anyone using it will be disconnected.',
        action: action === 'stop' ? 'Stop' : 'Restart',
        name: app.name,
      });
      if (!window.confirm(question)) return;
    }
    onAction(action);
  };

  const statusLabel = app.status === 'up'
    ? `live${app.latencyMs !== null ? ` · ${Math.round(app.latencyMs)}ms` : ''}`
    : app.status;

  return (
    <article
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3.5 shadow-sm',
        app.status === 'down' ? 'border-red-300/70 bg-red-50/40 dark:border-red-900/60 dark:bg-red-950/20' : 'border-border',
      )}
      data-testid={`app-card-${app.id}`}
    >
      <header className="flex min-w-0 items-start gap-2">
        <span className="mt-[7px]"><StatusDot status={app.status} /></span>
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-6 text-foreground" title={app.name}>
          {app.name}
        </h3>
        {app.ports.length > 0 && (
          // Only the main port; an app with a port range would otherwise squeeze its name to nothing.
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground" title={app.ports.map((port) => `:${port}`).join(' ')}>
            :{app.ports[0]}{app.ports.length > 1 ? ` +${app.ports.length - 1}` : ''}
          </span>
        )}
      </header>

      {app.purpose && <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">{app.purpose}</p>}

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <a
              key={chip.label}
              href={chip.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-primary hover:bg-primary/5"
            >
              {chip.label}
            </a>
          ))}
        </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {app.startedBy && (
          <span className="flex min-w-0 items-center gap-1" title={app.startedBy}>
            <CornerDownRight className="h-3 w-3 shrink-0" />
            <span className="truncate">{shortStartedBy(app.startedBy)}</span>
          </span>
        )}
        <span className="flex items-center gap-1" title={t('projectApps.lastOpened', { defaultValue: 'Last opened' })}>
          <Clock className="h-3 w-3" />
          {openedAge ?? t('projectApps.never', { defaultValue: 'never' })}
        </span>
        {app.git?.stale && (
          <span className="rounded bg-amber-100 px-1.5 py-px font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" title={app.git.reasons.join('\n')}>
            {t('projectApps.staleCode', { defaultValue: 'stale code' })}
          </span>
        )}
        {app.matchedBy === 'started-by' && (
          <span title={t('projectApps.matchedByStarter', { defaultValue: 'No project path matched; shown here because this project started it' })}>
            {t('projectApps.viaStarter', { defaultValue: 'via starter' })}
          </span>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        <a
          href={primaryUrl(app)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('projectApps.open', { defaultValue: 'Open' })}
        </a>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm hover:bg-muted"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
          {t('projectApps.copy', { defaultValue: 'Copy' })}
        </button>
        {canManage && (
          <div className="flex items-center gap-1" role="group" aria-label={t('projectApps.manage', { defaultValue: 'Manage' })}>
            {app.status !== 'up' && (
              <ManageButton label={t('projectApps.start', { defaultValue: 'Start' })} icon={Play} pending={pendingAction === 'start'} disabled={manageDisabled} onClick={() => confirmAndRun('start')} />
            )}
            {app.status !== 'down' && (
              <ManageButton label={t('projectApps.stop', { defaultValue: 'Stop' })} icon={Square} pending={pendingAction === 'stop'} disabled={manageDisabled} onClick={() => confirmAndRun('stop')} />
            )}
            {app.status === 'up' && (
              <ManageButton label={t('projectApps.restart', { defaultValue: 'Restart' })} icon={RotateCw} pending={pendingAction === 'restart'} disabled={manageDisabled} onClick={() => confirmAndRun('restart')} />
            )}
          </div>
        )}
        <button
          type="button"
          onClick={onShowDetails}
          aria-label={t('projectApps.details', { defaultValue: 'Details and log' })}
          title={t('projectApps.details', { defaultValue: 'Details and log' })}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Info className="h-4 w-4" />
        </button>
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-0.5 text-xs font-medium',
            app.status === 'up' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
            app.status === 'down' && 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400',
            app.status === 'unknown' && 'bg-muted text-muted-foreground',
          )}
          title={app.error ?? undefined}
        >
          {statusLabel}
        </span>
      </div>

      {lastResult && <ActionOutcome result={lastResult} />}
    </article>
  );
}

function ManageButton({ label, icon: Icon, pending, disabled, onClick }: {
  label: string;
  icon: typeof Play;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ActionOutcome({ result }: { result: ProjectAppActionResult | { error: string } }) {
  if ('error' in result) {
    return <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{result.error}</p>;
  }
  if (result.refused) {
    return <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{result.action} refused: {result.refused}</p>;
  }
  const ok = result.exit === 0 && (result.action === 'stop' ? result.upAfter === false : result.upAfter === true);
  return (
    <p className={cn('rounded-md px-2 py-1 text-xs', ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300')}>
      {result.action}: {result.steps[result.steps.length - 1] ?? `exit ${result.exit}`}
    </p>
  );
}
