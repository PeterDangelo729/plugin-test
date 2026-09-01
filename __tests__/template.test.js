import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { PRODUCT } from '../adapter.js';

const DEVICE_ID = 'synthetic:1';
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const POINT_COUNT = 451;

// the template boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test.after(() => handle.close());

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, 'template');
  assert.equal(handle.manifest.products[0].deviceTypeId, PRODUCT);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

test('the synthetic device is discovered, not host-added', async () => {
  const { status, body } = await request('GET', '/devices');
  assert.equal(status, 200);
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  assert.ok(device, JSON.stringify(body.devices));
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
});

test('config, start and trace produce a plausible spectrum', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, START_HZ);
  assert.equal(applied.body.stopHz, STOP_HZ);
  assert.equal(applied.body.pointCount, POINT_COUNT);
  assert.equal(applied.body.rbwHz, 100_000);

  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.sweeping, true);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.pointCount, POINT_COUNT);
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, START_HZ);
  assert.equal(trace.body.stopHz, STOP_HZ);
  assert.equal(trace.body.stepHz, (STOP_HZ - START_HZ) / (POINT_COUNT - 1));
  assert.equal(trace.body.unit, 'dBm');
  assert.ok(trace.body.sweepId >= 1);

  const amps = trace.body.amplitudesDbm;
  // carriers sit at 33% and 66% of the span; the once-in-seven transient at 50%
  const bins = (from, to) => amps.slice(from, to);
  const floorBins = [...bins(10, 100), ...bins(360, 440)];
  const floorMin = Math.min(...floorBins);
  const floorMax = Math.max(...floorBins);
  assert.ok(floorMin >= -106, `noise floor dipped to ${floorMin}`);
  assert.ok(floorMax <= -94, `noise floor rose to ${floorMax}`);

  const floorMean = floorBins.reduce((a, b) => a + b, 0) / floorBins.length;
  const carrierA = Math.max(...bins(140, 160));
  const carrierB = Math.max(...bins(290, 306));
  assert.ok(carrierA >= floorMean + 20, `carrier A only reached ${carrierA}`);
  assert.ok(carrierB >= floorMean + 20, `carrier B only reached ${carrierB}`);
});

test('successive polls see successive sweeps', async (t) => {
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  const first = await request('GET', `${DEVICE_PATH}/trace`);
  const startedAt = Date.now();
  const second = await request('GET', `${DEVICE_PATH}/trace`);
  const elapsed = Date.now() - startedAt;

  assert.ok(second.body.sweepId > first.body.sweepId);
  // the long poll returns on the next sweep rather than after the hold cap
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);
});

test('max-hold keeps the peak of every sweep, including the transient', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    traceMode: 'max-hold',
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  // ten consecutive sweeps always contain one of the every-seventh transients
  let trace = await request('GET', `${DEVICE_PATH}/trace`);
  const target = trace.body.sweepId + 10;
  const deadline = Date.now() + 5_000;
  while (trace.body.sweepId < target && Date.now() < deadline) {
    trace = await request('GET', `${DEVICE_PATH}/trace`);
  }

  assert.ok(
    trace.body.sweepId >= target,
    `only reached sweep ${trace.body.sweepId}`
  );
  const midband = Math.max(...trace.body.amplitudesDbm.slice(220, 232));
  assert.ok(midband >= -70, `transient never accumulated (peak ${midband})`);
});
