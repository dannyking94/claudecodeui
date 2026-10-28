export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// restampCloudcliClaudeTranscripts: used by the server bootstrap to make Claude
// sessions CloudCLI started before this fix visible in the VS Code extension.
export { restampCloudcliClaudeTranscripts } from './list/claude/claude-transcript-entrypoint.provider.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// findClaudeSessionHolder / describeClaudeSessionHold: used by the server
// bootstrap to stop the shell websocket running `claude --resume` on a session
// another claude process (or a registered secretary) already holds.
export { describeClaudeSessionHold, findClaudeSessionHolder } from './list/claude/claude-session-hold.provider.js';
