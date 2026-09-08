import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';

const GALLONS_PER_MCF = 7480;
const DEFAULT_DAILY_LIMIT_GALLONS = 200;
const DEFAULT_HOURLY_LIMIT_GALLONS = 150;
const DEFAULT_ALERT_INCREMENT_GALLONS = 100;
const DEFAULT_BASELINE_DAYS = 14;

function numberFromEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim() === '') return fallback;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a number greater than zero.`);
  }
  return value;
}

function requiredEmailEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Email alerts are enabled, but ${name} is missing from .env.`);
  return value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function formatUsage(value, unit) {
  if (unit === 'MCF') return `${Number(value.toFixed(3))} MCF`;
  return `${Number(value.toFixed(1)).toLocaleString()} gallons`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function detectDailyUsageAlerts(rows, unit, options = {}) {
  const baselineDays = options.baselineDays ?? DEFAULT_BASELINE_DAYS;
  const gallonsScale = unit === 'MCF' ? 1 / GALLONS_PER_MCF : 1;
  const dailyLimitGallons = options.dailyLimitGallons ?? DEFAULT_DAILY_LIMIT_GALLONS;
  const alertIncrementGallons = options.alertIncrementGallons ?? DEFAULT_ALERT_INCREMENT_GALLONS;
  const groups = new Map();

  for (const row of rows) {
    const key = `${row.account}|${row.meter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const alerts = [];
  for (const accountRows of groups.values()) {
    const usableRows = accountRows
      .filter((row) => row.usage != null)
      .sort((a, b) => String(a.rawDate || a.date).localeCompare(String(b.rawDate || b.date)));
    if (usableRows.length === 0) continue;

    const latest = usableRows[usableRows.length - 1];
    const baselineRows = usableRows.slice(-(baselineDays + 1), -1);
    const baseline = baselineRows.length > 0
      ? median(baselineRows.map((row) => row.usage))
      : null;
    const usageGallons = latest.usage / gallonsScale;
    if (usageGallons <= dailyLimitGallons) continue;

    const crossedThresholds = [dailyLimitGallons];
    for (
      let thresholdGallons = dailyLimitGallons + alertIncrementGallons;
      thresholdGallons <= usageGallons;
      thresholdGallons += alertIncrementGallons
    ) {
      crossedThresholds.push(thresholdGallons);
    }

    for (const thresholdGallons of crossedThresholds) {
      alerts.push({
        type: 'daily-tier',
        key: `${latest.account}|${latest.meter}|daily-tier|${latest.rawDate || latest.date}|${thresholdGallons}`,
        account: latest.account,
        meter: latest.meter,
        address: latest.address || latest.account,
        date: latest.date,
        usage: latest.usage,
        baseline,
        threshold: thresholdGallons * gallonsScale,
        thresholdGallons,
        alertIncrementGallons,
        ratio: baseline != null && baseline > 0 ? latest.usage / baseline : null,
        unit
      });
    }
  }

  return alerts;
}

export function detectHourlyUsageAlerts(rows, unit, options = {}) {
  const gallonsScale = unit === 'MCF' ? 1 / GALLONS_PER_MCF : 1;
  const hourlyLimitGallons = options.hourlyLimitGallons ?? DEFAULT_HOURLY_LIMIT_GALLONS;
  const groups = new Map();

  for (const row of rows) {
    const key = `${row.account}|${row.meter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const alerts = [];
  for (const accountRows of groups.values()) {
    const usableRows = accountRows
      .filter((row) => row.usage != null)
      .sort((a, b) => String(a.rawDate || a.date).localeCompare(String(b.rawDate || b.date)));
    if (usableRows.length === 0) continue;

    const latest = usableRows.at(-1);
    const usageGallons = latest.usage / gallonsScale;
    if (usageGallons < hourlyLimitGallons) continue;

    alerts.push({
      type: 'hourly-limit',
      key: `${latest.account}|${latest.meter}|hourly-limit|${latest.rawDate || latest.date}|${hourlyLimitGallons}`,
      account: latest.account,
      meter: latest.meter,
      address: latest.address || latest.account,
      date: latest.date,
      usage: latest.usage,
      baseline: null,
      threshold: hourlyLimitGallons * gallonsScale,
      thresholdGallons: hourlyLimitGallons,
      unit
    });
  }

  return alerts;
}

async function loadAlertState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return state && typeof state.sent === 'object' ? state : { sent: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { sent: {} };
    throw new Error(`Could not read alert history: ${error.message}`);
  }
}

async function saveAlertState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function sendAlertEmail(alerts, config) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.from,
      pass: config.appPassword.replace(/\s/g, '')
    }
  });
  const groups = new Map();
  for (const alert of alerts.filter((item) => item.type === 'daily-tier')) {
    const groupKey = `${alert.account}|${alert.meter}|${alert.date}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { ...alert, thresholds: [] });
    groups.get(groupKey).thresholds.push(alert.threshold);
  }
  const groupedAlerts = [...groups.values()].map((alert) => ({
    ...alert,
    thresholds: alert.thresholds.sort((a, b) => a - b),
    nextThreshold: Math.max(...alert.thresholds) + alert.alertIncrementGallons * (alert.unit === 'MCF' ? 1 / GALLONS_PER_MCF : 1)
  }));
  const hourlyAlerts = alerts
    .filter((alert) => alert.type === 'hourly-limit')
    .map((alert) => ({ ...alert, thresholds: [alert.threshold], nextThreshold: null }));
  const emailAlerts = [...hourlyAlerts, ...groupedAlerts];
  const subject = emailAlerts.length === 1
    ? `${emailAlerts[0].type === 'hourly-limit' ? 'Hourly water usage alert' : 'Water usage alert'}: ${emailAlerts[0].address}`
    : `Water usage alerts: ${emailAlerts.length} readings need attention`;
  const textLines = emailAlerts.flatMap((alert) => [
    alert.address,
    `${alert.date}: ${formatUsage(alert.usage, alert.unit)}`,
    alert.type === 'hourly-limit'
      ? `Hourly limit reached: ${formatUsage(alert.threshold, alert.unit)}`
      : `New daily alert level${alert.thresholds.length === 1 ? '' : 's'} crossed: ${alert.thresholds.map((threshold) => formatUsage(threshold, alert.unit)).join(', ')}`,
    ...(alert.nextThreshold == null ? [] : [`Next daily alert level: ${formatUsage(alert.nextThreshold, alert.unit)}`]),
    ...(alert.baseline == null ? [] : [`Recent normal daily usage: ${formatUsage(alert.baseline, alert.unit)}`]),
    ''
  ]);
  const alertHtml = emailAlerts.map((alert) => `
    <section style="margin-bottom:20px">
      <h2 style="margin:0 0 8px;font-size:18px">${escapeHtml(alert.address)}</h2>
      <p style="margin:4px 0"><strong>${escapeHtml(alert.date)}:</strong> ${escapeHtml(formatUsage(alert.usage, alert.unit))}</p>
      ${alert.type === 'hourly-limit'
        ? `<p style="margin:4px 0">Hourly limit reached: ${escapeHtml(formatUsage(alert.threshold, alert.unit))}</p>`
        : `<p style="margin:4px 0">New daily alert level${alert.thresholds.length === 1 ? '' : 's'} crossed: ${escapeHtml(alert.thresholds.map((threshold) => formatUsage(threshold, alert.unit)).join(', '))}</p>`}
      ${alert.nextThreshold == null ? '' : `<p style="margin:4px 0">Next daily alert level: ${escapeHtml(formatUsage(alert.nextThreshold, alert.unit))}</p>`}
      ${alert.baseline == null ? '' : `<p style="margin:4px 0">Recent normal daily usage: ${escapeHtml(formatUsage(alert.baseline, alert.unit))}</p>`}
      <p style="margin:4px 0;color:#657286">Account ${escapeHtml(alert.account)} | Meter ${escapeHtml(alert.meter)}</p>
    </section>`).join('');

  await transporter.sendMail({
    from: config.from,
    to: config.to,
    subject,
    text: `Cleveland Water usage may be unusually high.\n\n${textLines.join('\n')}Review the water usage report for details.`,
    html: `<p>Cleveland Water usage may be unusually high.</p>${alertHtml}<p>Review the water usage report for details.</p>`
  });
}

export async function processUsageAlerts(rows, hourlyRows, unit, workingDirectory = process.cwd()) {
  const enabled = (process.env.WATER_ALERTS_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) return { enabled: false, detected: 0, sent: 0 };
  const repeatEveryRun = (process.env.WATER_ALERT_REPEAT_EVERY_RUN || 'false').toLowerCase() === 'true';

  const config = {
    from: requiredEmailEnv('ALERT_EMAIL_FROM'),
    to: requiredEmailEnv('ALERT_EMAIL_TO'),
    appPassword: requiredEmailEnv('GMAIL_APP_PASSWORD')
  };
  const options = {
    dailyLimitGallons: numberFromEnv('WATER_ALERT_DAILY_LIMIT_GALLONS', DEFAULT_DAILY_LIMIT_GALLONS),
    hourlyLimitGallons: numberFromEnv('WATER_ALERT_HOURLY_LIMIT_GALLONS', DEFAULT_HOURLY_LIMIT_GALLONS),
    alertIncrementGallons: numberFromEnv('WATER_ALERT_INCREMENT_GALLONS', DEFAULT_ALERT_INCREMENT_GALLONS),
    baselineDays: numberFromEnv('WATER_ALERT_BASELINE_DAYS', DEFAULT_BASELINE_DAYS)
  };
  const statePath = path.resolve(
    workingDirectory,
    process.env.WATER_ALERT_STATE_FILE || '.water-usage-alert-state.json'
  );
  const alerts = [
    ...detectDailyUsageAlerts(rows, unit, options),
    ...detectHourlyUsageAlerts(hourlyRows, unit, options)
  ];
  const state = await loadAlertState(statePath);
  const unsentAlerts = repeatEveryRun
    ? alerts
    : alerts.filter((alert) => !state.sent[alert.key]);

  if (unsentAlerts.length === 0) {
    return { enabled: true, detected: alerts.length, sent: 0, repeatEveryRun };
  }

  await sendAlertEmail(unsentAlerts, config);
  const sentAt = new Date().toISOString();
  for (const alert of unsentAlerts) state.sent[alert.key] = sentAt;
  await saveAlertState(statePath, state);
  return { enabled: true, detected: alerts.length, sent: 1, levelsSent: unsentAlerts.length, repeatEveryRun };
}
