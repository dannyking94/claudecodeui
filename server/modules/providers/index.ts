export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerCapabilitiesService } from './services/provider-capabilities.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// restampCloudcliClaudeTranscripts: used by the server bootstrap to make Claude
// sessions CloudCLI started before this fix visible in the VS Code extension.
export { restampCloudcliClaudeTranscripts } from './list/claude/claude-transcript-entrypoint.provider.js';
// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';

// reapOrphanedOpenCodeServers: used by the server entrypoint at startup to stop
// OpenCode turn servers a killed CloudCLI process left running.
export { reapOrphanedOpenCodeServers } from './list/opencode/opencode-runtime.provider.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// findClaudeSessionHolder / describeClaudeSessionHold: used by the server
// bootstrap to stop the shell websocket running `claude --resume` on a session
// another claude process (or a registered secretary) already holds.
export { describeClaudeSessionHold, findClaudeSessionHolder } from './list/claude/claude-session-hold.provider.js';

// claudeSecretaryActivity: used by the chat websocket so a `chat.subscribe` ack
// reports a registered secretary that is mid-turn as processing — its row has
// no cloudcli run, so the run registry alone would always say idle.
export { claudeSecretaryActivity } from './list/claude/claude-secretary-activity.provider.js';
// sideQuestionsService: used by the websocket module's `chat.side_question` handler and
// the provider routes' side-question endpoints. State is in memory; a new
// service instance starts empty, as after a CloudCLI restart.
export {
  createSideQuestionsService,
  MAX_CONCURRENT_SIDE_QUESTIONS_PER_SESSION,
  MAX_SIDE_QUESTIONS_PER_SESSION,
  sideQuestionsService,
} from './services/side-questions.service.js';
