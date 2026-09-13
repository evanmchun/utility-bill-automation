import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDailyUsageAlerts, detectHourlyUsageAlerts } from './water-usage-alerts.mjs';

function reading(usage, rawDate = '2026-09-08 12:00:00') {
  return {
    account: '123',
    meter: 'meter-1',
    address: 'Test House',
    date: '09/08/2026 12:00 PM',
    rawDate,
    usage,
    unit: 'Gallons'
  };
}

test('alerts when the latest hourly reading reaches 150 gallons', () => {
  const alerts = detectHourlyUsageAlerts([
    reading(149, '2026-09-08 12:00:00'),
    reading(150, '2026-09-08 13:00:00')
  ], 'Gallons');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].usage, 150);
  assert.equal(alerts[0].type, 'hourly-limit');
});

test('does not alert when the latest hourly reading is below 150 gallons', () => {
  const alerts = detectHourlyUsageAlerts([
    reading(157, '2026-09-08 12:00:00'),
    reading(20, '2026-09-08 13:00:00')
  ], 'Gallons');
  assert.equal(alerts.length, 0);
});

test('creates one alert per property using each latest reading', () => {
  const alerts = detectHourlyUsageAlerts([
    reading(157),
    { ...reading(200), account: '456', meter: 'meter-2', address: 'Second House' }
  ], 'Gallons');
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((alert) => alert.account), ['123', '456']);
});

test('daily usage alerts only when the latest reading is over 350 gallons', () => {
  const atLimit = detectDailyUsageAlerts([reading(350)], 'Gallons');
  const overLimit = detectDailyUsageAlerts([reading(350.1)], 'Gallons');

  assert.equal(atLimit.length, 0);
  assert.equal(overLimit.length, 1);
  assert.equal(overLimit[0].thresholdGallons, 350);
});
