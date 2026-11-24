import { Check, Clock, ClipboardList, Copy, ExternalLink, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProjectChatLink } from '@/shared/types';
import { copyTextToClipboard, formatCompactAge, toBrowserReachableUrl } from '@/shared/utils';
import { StatusDot } from '@/modules/project-apps/AppCard';

type ChatLinkCardProps = {
  link: ProjectChatLink;
  /** Used as repo/workdir in the copied registry stub. */
  projectPath: string;
  onOpenSession: (sessionId: string) => void;
};

/**
 * A ready-to-edit `apps.json` entry for an address seen in chat. cloudcli never
 * writes another repo's registry; the owner (or an agent) pastes this there.
 */
function registryStub(link: ProjectChatLink, projectPath: string): string {
  const port = link.port ?? 80;
  return JSON.stringify({
    id: `app-${port}`,
    name: `app on :${port}`,
    purpose: '',
    host: 'local',
    ports: [port],
    health_url: `http://127.0.0.1:${port}/`,
    links: [link.url],
    repo: projectPath,
    workdir: projectPath,
    code_paths: [],
    runs: '',
    started_by: link.sessionName ?? '',
    pid_source: { kind: 'none' },
    commands: {},
    controls: 'status-only',
    controls_reason: 'nothing recorded its PID yet',
  }, null, 2);
}

/** Card for an address an agent wrote in this project's chats that no registered app owns. */
export function ChatLinkCard({ link, projectPath, onOpenSession }: ChatLinkCardProps) {
  const { t } = useTranslation();
  // Which button last copied successfully, for a short confirmation tick.
  const [copied, setCopied] = useState<'url' | 'stub' | null>(null);
  const openUrl = toBrowserReachableUrl(link.url);
  const host = link.origin.replace(/^https?:\/\//, '');
  const age = formatCompactAge(link.mentionedAt ? Date.parse(link.mentionedAt) : null);

  const copy = async (kind: 'url' | 'stub') => {
    if (await copyTextToClipboard(kind === 'url' ? openUrl : registryStub(link, projectPath))) {
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1500);
    }
  };

  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-3.5 shadow-sm" data-testid="chat-link-card">
      <header className="flex min-w-0 items-start gap-2">
        <span className="mt-[7px]"><StatusDot status="unknown" /></span>
        <h3 className="min-w-0 flex-1 truncate font-mono text-[14px] font-semibold leading-6 text-foreground" title={link.url}>
          {host}
        </h3>
        {link.port !== null && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">:{link.port}</span>
        )}
      </header>

      {!(link.paths.length === 1 && link.paths[0] === '/') && link.paths.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {link.paths.map((path) => (
            <a
              key={path}
              href={toBrowserReachableUrl(`${link.origin}${path}`)}
              target="_blank"
              rel="noreferrer"
              className="max-w-full truncate rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-primary hover:bg-primary/5"
            >
              {path}
            </a>
          ))}
        </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => onOpenSession(link.sessionId)}
          className="flex min-w-0 items-center gap-1 hover:text-foreground hover:underline"
          title={t('projectApps.openChat', { defaultValue: 'Open the chat that mentioned it' })}
        >
          <MessageSquare className="h-3 w-3 shrink-0" />
          <span className="truncate">{link.sessionName || t('projectApps.aChat', { defaultValue: `a ${link.provider} chat` })}</span>
        </button>
        {age && (
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{age}</span>
        )}
        {link.mentions > 1 && <span>×{link.mentions}</span>}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        <a
          href={openUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('projectApps.open', { defaultValue: 'Open' })}
        </a>
        <button type="button" onClick={() => void copy('url')} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm hover:bg-muted">
          {copied === 'url' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
          {t('projectApps.copy', { defaultValue: 'Copy' })}
        </button>
        <button
          type="button"
          onClick={() => void copy('stub')}
          title={t('projectApps.copyStubHint', { defaultValue: 'Copy an apps.json entry to register this app' })}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied === 'stub' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <ClipboardList className="h-3.5 w-3.5" />}
          {t('projectApps.register', { defaultValue: 'Register' })}
        </button>
        <span className="ml-auto rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
          {t('projectApps.fromChat', { defaultValue: 'from chat' })}
        </span>
      </div>
    </article>
  );
}
