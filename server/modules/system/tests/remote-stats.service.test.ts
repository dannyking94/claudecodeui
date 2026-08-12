import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  getRemoteHostSamples,
  parseRemoteHostSpecs,
  parseRemoteSampleOutput,
  resetRemoteStatsForTests,
} from '../remote-stats.service.js';

const SAMPLE_OUTPUT =
  '0, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 86, 4660, 97887, 79, 520.31, 600.00\n' +
  '1, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 82, 4811, 97887, 88, 531.23, 600.00\n' +
  '@@cloudcli-cpu@@\n' +
  'cpu  1516768 231 20243 38452710 3119 0 144 0 0 0\n' +
  '@@cloudcli-mem@@\n' +
  'MemTotal:       131218916 kB\n' +
  'MemFree:        62513084 kB\n';

afterEach(() => {
  delete process.env.CLOUDCLI_REMOTE_HOSTS;
  resetRemoteStatsForTests();
});

test('parses a labelled host spec', () => {
  const configs = parseRemoteHostSpecs('GPU Node=dk@192.168.0.100');

  assert.equal(configs.length, 1);
  assert.deepEqual(configs[0], {
    id: 'dk@192.168.0.100',
    label: 'GPU Node',
    sshTarget: 'dk@192.168.0.100',
    port: null,
  });
});

test('labels an unlabelled host with its ssh target and reads a port suffix', () => {
  const configs = parseRemoteHostSpecs(' gpu-node , trainer=user@10.0.0.5:2222 ');

  assert.deepEqual(configs.map((config) => config.label), ['gpu-node', 'trainer']);
  assert.equal(configs[0].port, null);
  assert.equal(configs[1].sshTarget, 'user@10.0.0.5');
  assert.equal(configs[1].port, 2222);
  // The id carries the port so two ports on one host stay distinct cards.
  assert.equal(configs[1].id, 'user@10.0.0.5:2222');
});

test('ignores blank entries and repeats of the same target', () => {
  // "A=gpu" repeats the first entry's target, so it is dropped label and all.
  const configs = parseRemoteHostSpecs('gpu,,  ,A=gpu,B=other');

  assert.deepEqual(configs.map((config) => config.label), ['gpu', 'B']);
  assert.deepEqual(configs.map((config) => config.sshTarget), ['gpu', 'other']);
});

test('an unset or empty variable configures no hosts', () => {
  assert.deepEqual(parseRemoteHostSpecs(undefined), []);
  assert.deepEqual(parseRemoteHostSpecs('   '), []);
});

test('splits a remote reply into GPU, CPU and memory readings', () => {
  const reading = parseRemoteSampleOutput(SAMPLE_OUTPUT, 1_000);

  assert.equal(reading.gpus.length, 2);
  assert.equal(reading.gpus[1].temperatureC, 88);
  assert.deepEqual(reading.cpuTimes, { idle: 38455829, total: 39993215, timestamp: 1_000 });
  assert.equal(reading.memory?.totalBytes, 131218916 * 1024);
  // Used counts page cache, matching what the local card reports.
  assert.equal(reading.memory?.usedBytes, (131218916 - 62513084) * 1024);
});

test('a host without nvidia-smi still reports CPU and memory', () => {
  const reading = parseRemoteSampleOutput(
    '@@cloudcli-cpu@@\ncpu  100 0 50 850 0 0 0 0 0 0\n@@cloudcli-mem@@\nMemTotal: 1024 kB\nMemFree: 512 kB\n',
    1_000,
  );

  assert.deepEqual(reading.gpus, []);
  assert.equal(reading.memory?.totalBytes, 1024 * 1024);
});

test('a truncated reply yields no reading at all', () => {
  const reading = parseRemoteSampleOutput('0, Some GPU, 10, 100, 200, 40, 20.0, 70.0\n', 1_000);

  assert.equal(reading.cpuTimes, null);
  assert.equal(reading.memory, null);
  // Without the markers the GPU rows cannot be trusted to be complete either.
  assert.deepEqual(reading.gpus, []);
});

test('a configured host that has never answered is reported offline, not omitted', () => {
  process.env.CLOUDCLI_REMOTE_HOSTS = 'GPU Node=dk@192.168.0.100';

  const samples = getRemoteHostSamples();

  assert.equal(samples.length, 1);
  assert.equal(samples[0].id, 'dk@192.168.0.100');
  assert.equal(samples[0].label, 'GPU Node');
  assert.equal(samples[0].online, false);
  assert.equal(samples[0].cpuUtilization, null);
  assert.deepEqual(samples[0].gpus, []);
});

test('no configured hosts means no remote entries in a sample', () => {
  assert.deepEqual(getRemoteHostSamples(), []);
});
