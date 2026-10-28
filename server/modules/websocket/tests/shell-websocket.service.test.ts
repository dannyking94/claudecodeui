import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});

/** Lets the async init handler run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function claudeResumeInit(sessionId: string) {
  return JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: true,
    provider: 'claude',
  });
}

test('a claude session held elsewhere is not resumed in a terminal', async () => {
  let spawned = 0;
  const checked: string[] = [];
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => 'provider-held',
    spawnPty: (() => {
      spawned += 1;
      return createFakePty();
    }) as never,
    describeClaudeSessionHold: async (providerSessionId) => {
      checked.push(providerSessionId);
      return 'This session is running elsewhere (pid 42).';
    },
  });

  socket.emit('message', claudeResumeInit(`held-${Date.now()}`));
  await settle();

  assert.deepEqual(checked, ['provider-held']);
  assert.equal(spawned, 0);
  assert.equal(socket.frames.length, 1);
  assert.match(socket.frames[0], /running elsewhere \(pid 42\)/);
});

test('a free claude session still resumes in a terminal', async () => {
  const pty = createFakePty();
  const spawnedArgs: string[][] = [];
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => 'provider-free',
    spawnPty: ((_shell: string, args: string[]) => {
      spawnedArgs.push(args);
      return pty;
    }) as never,
    describeClaudeSessionHold: async () => null,
  });

  socket.emit('message', claudeResumeInit(`free-${Date.now()}`));
  await settle();

  assert.equal(spawnedArgs.length, 1);
  assert.match(spawnedArgs[0].join(' '), /claude --resume "provider-free"/);
  pty.emitExit();
});
