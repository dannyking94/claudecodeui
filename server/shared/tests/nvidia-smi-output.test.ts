import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNvidiaSmiOutput } from '@/shared/utils.js';

test('parses one sample per GPU from nvidia-smi CSV output', () => {
  const gpus = parseNvidiaSmiOutput(
    '0, NVIDIA GeForce RTX 5080, 47, 1423, 16303, 47, 32.09, 360.00\n' +
    '1, NVIDIA GeForce RTX 4090, 3, 512, 24564, 41, 28.50, 450.00\n',
  );

  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], {
    index: 0,
    name: 'NVIDIA GeForce RTX 5080',
    utilization: 47,
    memoryUsedMb: 1423,
    memoryTotalMb: 16303,
    temperatureC: 47,
    powerDrawW: 32.09,
    powerLimitW: 360,
  });
  assert.equal(gpus[1].index, 1);
});

test('keeps GPUs that report N/A for optional fields', () => {
  const gpus = parseNvidiaSmiOutput('0, Tesla T4, 12, 300, 15360, [N/A], [N/A], [N/A]');

  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].utilization, 12);
  assert.equal(gpus[0].temperatureC, null);
  assert.equal(gpus[0].powerDrawW, null);
  assert.equal(gpus[0].powerLimitW, null);
});

test('drops rows that are blank, short, or missing a required field', () => {
  const gpus = parseNvidiaSmiOutput(
    '\n' +
    '0, Broken GPU, 12\n' +
    '1, No Utilization, [N/A], 300, 15360, 40, 20.0, 70.0\n' +
    '2, Good GPU, 55, 900, 8192, 60, 40.0, 120.0\n',
  );

  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].name, 'Good GPU');
});

test('skips a login banner an SSH session prints before the CSV rows', () => {
  const gpus = parseNvidiaSmiOutput(
    'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-51-generic x86_64)\n' +
    'Last login: Mon Aug 10 09:14:22 2026 from 192.168.0.12\n' +
    '0, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 86, 4660, 97887, 79, 520.31, 600.00\n',
  );

  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].temperatureC, 79);
});
