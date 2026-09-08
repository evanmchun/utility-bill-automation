import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { processUsageAlerts } from './water-usage-alerts.mjs';

const BASE_URL = 'https://my.clevelandwater.com';
const GALLONS_PER_MCF = 7480;

function parseArgs(argv) {
  const args = {
    days: 7,
    hourlyDays: 0,
    account: null,
    unit: 'Gallons',
    output: null,
    html: null,
    headless: (process.env.HEADLESS || 'true').toLowerCase() !== 'false'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--visible') args.headless = false;
    else if (arg === '--account') args.account = argv[++i];
    else if (arg.startsWith('--account=')) args.account = arg.slice('--account='.length);
    else if (arg === '--days') args.days = Number(argv[++i]);
    else if (arg.startsWith('--days=')) args.days = Number(arg.slice('--days='.length));
    else if (arg === '--hourly-days') args.hourlyDays = Number(argv[++i]);
    else if (arg.startsWith('--hourly-days=')) args.hourlyDays = Number(arg.slice('--hourly-days='.length));
    else if (arg === '--unit') args.unit = argv[++i];
    else if (arg.startsWith('--unit=')) args.unit = arg.slice('--unit='.length);
    else if (arg === '--output') args.output = argv[++i];
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
    else if (arg === '--html') args.html = argv[++i];
    else if (arg.startsWith('--html=')) args.html = arg.slice('--html='.length);
  }

  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 31) {
    throw new Error('Use --days with a whole number from 1 to 31.');
  }
  if (!Number.isInteger(args.hourlyDays) || args.hourlyDays < 0 || args.hourlyDays > 7) {
    throw new Error('Use --hourly-days with a whole number from 0 to 7.');
  }

  const normalizedUnit = args.unit.toLowerCase();
  if (normalizedUnit === 'gallon' || normalizedUnit === 'gallons') {
    args.unit = 'Gallons';
  } else if (normalizedUnit === 'mcf') {
    args.unit = 'MCF';
  } else {
    throw new Error('Use --unit Gallons or --unit MCF.');
  }

  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Create .env from .env.example first.`);
  return value;
}

function formatPortalDate(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function dateOnly(readingDate) {
  return readingDate.slice(0, 10);
}

function displayDate(readingDate) {
  const [year, month, day] = dateOnly(readingDate).split('-');
  return `${month}/${day}/${year}`;
}

function convertUsage(mcf, unit) {
  if (mcf < 0) return null;
  if (unit === 'MCF') return Number(mcf.toFixed(3));
  return Number((mcf * GALLONS_PER_MCF).toFixed(1));
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loginToClevelandWater(page, username, password) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#edit-name').fill(username);
  await page.locator('#edit-pass').fill(password);
  await Promise.all([
    page.waitForURL('**/dashboard', { timeout: 30000 }),
    page.getByRole('link', { name: 'Log In' }).click()
  ]);
}

async function usagePageAccounts(page) {
  await page.goto(`${BASE_URL}/water-usage`, { waitUntil: 'networkidle', timeout: 60000 });
  return page.locator('#Accounts1List option').evaluateAll((options) => options
    .map((option) => option.value || option.textContent?.trim())
    .filter(Boolean));
}

async function accountMeters(context, account) {
  const url = `${BASE_URL}/sites/all/themes/recess/php/water-usage-meters.php?q=${encodeURIComponent(account)}`;
  const response = await context.request.get(url);
  if (!response.ok()) {
    throw new Error(`Meter lookup failed for account ${account}: HTTP ${response.status()}`);
  }

  const data = await response.json();
  return data
    .filter((item) => item?.[0] && item?.[1])
    .map((item) => ({
      meter: item[0],
      premiseId: item[1],
      address: [item[2], item[3], item[4], item[5]].filter(Boolean).join(', ')
    }));
}

async function usageReadings(context, account, premiseId, days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days - 7);

  const params = new URLSearchParams({
    q: account,
    s: formatPortalDate(start),
    e: formatPortalDate(end),
    p: premiseId
  });
  const url = `${BASE_URL}/sites/all/themes/recess/php/water-usage-data.php?${params}`;
  const response = await context.request.get(url);
  if (!response.ok()) {
    throw new Error(`Usage lookup failed for account ${account}: HTTP ${response.status()}`);
  }

  return response.json();
}

async function hourlyReadings(context, account, premiseId, days) {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - days - 1);

  const response = await context.request.post(`${BASE_URL}/sites/all/themes/recess/php/water-usage-data-hourly2.php`, {
    form: {
      q: account,
      s: formatPortalDate(start),
      e: formatPortalDate(end),
      p: premiseId
    }
  });
  if (!response.ok()) {
    throw new Error(`Hourly usage lookup failed for account ${account}: HTTP ${response.status()}`);
  }

  return response.json();
}

function dailyUsageRows(account, meter, readings, unit, days) {
  const rows = [];

  for (let i = 1; i < readings.length; i += 1) {
    const current = readings[i];
    const previous = readings[i - 1];
    const currentRead = Number(current.presented_read);
    const previousRead = Number(previous.presented_read);
    let usageMcf = currentRead - previousRead;

    if (previousRead === -99999) {
      const lastRead = Number(previous.last_read || 0);
      if (lastRead !== 0) usageMcf = currentRead - lastRead;
      else if (currentRead === -99999) usageMcf = -1;
      else usageMcf = 0;
    }

    rows.push({
      account,
      meter: meter.meter,
      address: meter.address,
      date: displayDate(current.reading_date),
      rawDate: current.reading_date,
      usage: convertUsage(usageMcf, unit),
      unit
    });
  }

  const lastDataIndex = rows.findLastIndex((row) => row.usage != null);
  if (lastDataIndex === -1) return rows.slice(-days);
  return rows.slice(0, lastDataIndex + 1).slice(-days);
}

function displayHourlyDate(readingDate) {
  const date = new Date(readingDate.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return readingDate;
  return date.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    hour12: true
  }).replace(',', '');
}

function hourlyUsageRows(account, meter, readings, unit, days) {
  const rows = [];

  for (let i = 1; i < readings.length; i += 1) {
    const current = readings[i];
    const previous = readings[i - 1];
    const readingDate = new Date(current.reading_date.replace(' ', 'T'));
    if (Number.isNaN(readingDate.getTime())) continue;

    const currentRead = Number(current.presented_read);
    const previousRead = Number(previous.presented_read);
    let usageMcf = currentRead - previousRead;

    if (previousRead === -99999) {
      const lastRead = Number(previous.last_read || 0);
      if (lastRead !== 0) usageMcf = currentRead - lastRead;
      else if (currentRead === -99999) usageMcf = -1;
      else usageMcf = 0;
    }

    rows.push({
      account,
      meter: meter.meter,
      address: meter.address,
      date: displayHourlyDate(current.reading_date),
      rawDate: current.reading_date,
      usage: convertUsage(usageMcf, unit),
      unit
    });
  }

  const lastDataIndex = rows.findLastIndex((row) => row.usage != null);
  if (lastDataIndex === -1) return rows;
  const rowsThroughLatestData = rows.slice(0, lastDataIndex + 1);
  const latestDate = new Date(rowsThroughLatestData.at(-1).rawDate.replace(' ', 'T'));
  const cutoff = new Date(latestDate);
  cutoff.setDate(cutoff.getDate() - days);
  return rowsThroughLatestData.filter((row) => new Date(row.rawDate.replace(' ', 'T')) > cutoff);
}

function printRows(rows, unit) {
  if (rows.length === 0) {
    console.log('No usage rows found.');
    return;
  }

  let currentKey = '';
  for (const row of rows) {
    const key = `${row.account}|${row.meter}`;
    if (key !== currentKey) {
      currentKey = key;
      console.log('');
      console.log(`${row.account} ${row.address || ''}`.trim());
      console.log(`Meter ${row.meter}`);
    }

    const usageText = row.usage == null ? 'No Data' : `${row.usage} ${unit}`;
    console.log(`  ${row.date.padEnd(10)}  ${usageText}`);
  }
}

function formatUsage(value, unit) {
  if (unit === 'MCF') return `${Number(value.toFixed(3))} ${unit}`;
  return `${Number(value.toFixed(1))} ${unit}`;
}

function trendText(rows, unit) {
  const usableRows = rows.filter((row) => row.usage != null);
  if (usableRows.length < 4) return 'not enough data';

  const midpoint = Math.floor(usableRows.length / 2);
  const earlierRows = usableRows.slice(0, midpoint);
  const recentRows = usableRows.slice(midpoint);
  const earlierAvg = earlierRows.reduce((sum, row) => sum + row.usage, 0) / earlierRows.length;
  const recentAvg = recentRows.reduce((sum, row) => sum + row.usage, 0) / recentRows.length;
  const difference = recentAvg - earlierAvg;

  if (Math.abs(difference) < (unit === 'MCF' ? 0.01 : 10)) return 'about flat';
  const direction = difference > 0 ? 'up' : 'down';
  const percent = earlierAvg > 0 ? ` (${Math.abs((difference / earlierAvg) * 100).toFixed(0)}%)` : '';
  return `${direction} by ${formatUsage(Math.abs(difference), unit)} per day${percent}`;
}

function analyzeAccountRows(rows, unit) {
  const usableRows = rows.filter((row) => row.usage != null);
  const noDataDays = rows.length - usableRows.length;

  if (usableRows.length === 0) {
    return {
      total: null,
      average: null,
      highest: null,
      trend: 'no usable data',
      notes: ['No usage data was available for this period.']
    };
  }

  const total = usableRows.reduce((sum, row) => sum + row.usage, 0);
  const average = total / usableRows.length;
  const highest = usableRows.reduce((max, row) => (row.usage > max.usage ? row : max), usableRows[0]);
  const zeroDays = usableRows.filter((row) => row.usage === 0).length;
  const spikeRows = usableRows.filter((row) => row.usage > average * 2 && row.usage - average > (unit === 'MCF' ? 0.05 : 50));
  const notes = [];

  if (spikeRows.length > 0) {
    notes.push(`Spike: ${spikeRows.map((row) => `${row.date} ${formatUsage(row.usage, unit)}`).join('; ')}`);
  }
  if (zeroDays === usableRows.length) {
    notes.push('All usable days are zero usage.');
  } else if (zeroDays > 0) {
    notes.push(`${zeroDays} zero-usage day${zeroDays === 1 ? '' : 's'}.`);
  }
  if (noDataDays > 0) {
    notes.push(`${noDataDays} day${noDataDays === 1 ? '' : 's'} had no data.`);
  }
  if (notes.length === 0) {
    notes.push('No obvious spike or missing-data issue in this period.');
  }

  return {
    total,
    average,
    highest,
    trend: trendText(usableRows, unit),
    notes
  };
}

function printAnalysis(rows, unit) {
  if (rows.length === 0) return;

  console.log('');
  console.log('Analysis');

  const accountGroups = new Map();
  for (const row of rows) {
    const key = `${row.account}|${row.meter}`;
    if (!accountGroups.has(key)) accountGroups.set(key, []);
    accountGroups.get(key).push(row);
  }

  for (const accountRows of accountGroups.values()) {
    const first = accountRows[0];
    const analysis = analyzeAccountRows(accountRows, unit);
    console.log('');
    console.log(`${first.account} ${first.address || ''}`.trim());
    if (analysis.total == null) {
      console.log('  No usable data to analyze.');
      continue;
    }
    console.log(`  Total: ${formatUsage(analysis.total, unit)}`);
    console.log(`  Average/day: ${formatUsage(analysis.average, unit)}`);
    console.log(`  Highest day: ${analysis.highest.date} at ${formatUsage(analysis.highest.usage, unit)}`);
    console.log(`  Trend: ${analysis.trend}`);
    for (const note of analysis.notes) console.log(`  Note: ${note}`);
  }
}

async function writeCsv(rows, outputPath) {
  const header = ['account', 'meter', 'address', 'date', 'usage', 'unit'];
  const lines = [
    header.join(','),
    ...rows.map((row) => header.map((field) => csvEscape(row[field])).join(','))
  ];
  const resolvedPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${lines.join('\n')}\n`);
  return resolvedPath;
}

function groupedRows(rows) {
  const accountGroups = new Map();
  for (const row of rows) {
    const key = `${row.account}|${row.meter}`;
    if (!accountGroups.has(key)) accountGroups.set(key, []);
    accountGroups.get(key).push(row);
  }
  return [...accountGroups.values()];
}

function renderLineChart(rows, unit, label, compact = false) {
  const usableRows = rows.filter((row) => row.usage != null);
  if (usableRows.length === 0) return '<p class="empty">No usage data available.</p>';

  const width = compact ? 260 : 620;
  const height = compact ? 62 : 164;
  const padding = compact
    ? { top: 5, right: 4, bottom: 5, left: 4 }
    : { top: 22, right: 16, bottom: 28, left: 16 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxUsage = Math.max(...usableRows.map((row) => row.usage), 1);
  const x = (index) => padding.left + (rows.length === 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
  const y = (value) => padding.top + plotHeight - (value / maxUsage) * plotHeight;
  const segments = [];
  let currentSegment = [];

  rows.forEach((row, index) => {
    if (row.usage == null) {
      if (currentSegment.length > 0) segments.push(currentSegment);
      currentSegment = [];
      return;
    }
    currentSegment.push(`${x(index).toFixed(1)},${y(row.usage).toFixed(1)}`);
  });
  if (currentSegment.length > 0) segments.push(currentSegment);

  const lines = segments
    .map((points) => `<polyline class="usage-line" points="${points.join(' ')}"></polyline>`)
    .join('');
  const highest = usableRows.reduce((max, row) => (row.usage > max.usage ? row : max), usableRows[0]);
  const highestIndex = rows.indexOf(highest);
  const chartClass = compact ? 'usage-chart usage-chart-compact' : 'usage-chart';
  const labels = compact ? '' : `
    <text class="chart-label chart-max" x="${padding.left}" y="14">Peak ${htmlEscape(formatUsage(highest.usage, unit))}</text>
    <text class="chart-label" x="${padding.left}" y="${height - 7}">${htmlEscape(rows[0].date)}</text>
    <text class="chart-label chart-label-end" x="${width - padding.right}" y="${height - 7}">${htmlEscape(rows[rows.length - 1].date)}</text>
    <circle class="peak-dot" cx="${x(highestIndex).toFixed(1)}" cy="${y(highest.usage).toFixed(1)}" r="3.5"></circle>`;

  return `
    <svg class="${chartClass}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${htmlEscape(`${label}: daily water usage over ${rows.length} readings. Peak ${formatUsage(highest.usage, unit)} on ${highest.date}.`)}">
      <line class="chart-baseline" x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}"></line>
      ${lines}
      ${labels}
    </svg>`;
}

function renderHourlyRows(rows, unit) {
  if (!rows || rows.length === 0) {
    return '<p class="empty">No hourly rows found for this period.</p>';
  }

  const usableRows = rows.filter((row) => row.usage != null);
  const maxUsage = Math.max(...usableRows.map((row) => row.usage), 1);
  const highest = usableRows.reduce((max, row) => (row.usage > max.usage ? row : max), usableRows[0]);
  const overnightRows = usableRows.filter((row) => {
    const hour = new Date(row.rawDate.replace(' ', 'T')).getHours();
    return hour >= 0 && hour < 6 && row.usage > 0;
  });

  const bars = rows.map((row) => {
    const percent = row.usage == null ? 0 : Math.max(2, (row.usage / maxUsage) * 100);
    const value = row.usage == null ? 'No Data' : formatUsage(row.usage, unit);
    return `
      <div class="hour-row">
        <div class="hour-date">${htmlEscape(row.date)}</div>
        <div class="bar-track"><div class="bar-fill hourly-fill" style="width: ${percent.toFixed(1)}%"></div></div>
        <div class="bar-value">${htmlEscape(value)}</div>
      </div>`;
  }).join('');

  const highestText = highest ? `${highest.date} at ${formatUsage(highest.usage, unit)}` : 'No usable hourly data';
  const overnightText = overnightRows.length > 0
    ? `${overnightRows.length} overnight hour${overnightRows.length === 1 ? '' : 's'} with usage`
    : 'No overnight usage detected';

  return `
    <div class="hourly-summary">
      <span>Highest hour: <strong>${htmlEscape(highestText)}</strong></span>
      <span>${htmlEscape(overnightText)}</span>
    </div>
    <div class="hour-chart">${bars}</div>`;
}

async function writeHtmlReport(rows, hourlyRows, outputPath, unit, days, hourlyDays) {
  const generatedAt = new Date().toLocaleString();
  const properties = groupedRows(rows).map((accountRows, index) => {
    const first = accountRows[0];
    const hourlyForAccount = hourlyRows.filter((row) => row.account === first.account && row.meter === first.meter);
    const analysis = analyzeAccountRows(accountRows, unit);
    const notes = analysis.notes.map((note) => `<li>${htmlEscape(note)}</li>`).join('');
    const total = analysis.total == null ? 'No Data' : formatUsage(analysis.total, unit);
    const average = analysis.average == null ? 'No Data' : formatUsage(analysis.average, unit);
    const highest = analysis.highest == null ? 'No Data' : `${analysis.highest.date} at ${formatUsage(analysis.highest.usage, unit)}`;
    const label = first.address || first.account;
    const needsAttention = analysis.notes.some((note) => !note.startsWith('No obvious'));
    const tableRows = accountRows.map((row) => `
      <tr>
        <td>${htmlEscape(row.date)}</td>
        <td>${htmlEscape(row.usage == null ? 'No Data' : formatUsage(row.usage, unit))}</td>
      </tr>`).join('');

    return {
      analysis,
      needsAttention,
      html: `
      <details class="property" id="property-${index + 1}">
        <summary class="property-summary">
          <span class="property-name">
            <strong>${htmlEscape(label)}</strong>
            <span>Account ${htmlEscape(first.account)} | Meter ${htmlEscape(first.meter)}</span>
          </span>
          <span class="mini-chart">${renderLineChart(accountRows, unit, label, true)}</span>
          <span class="summary-value"><span>Total</span><strong>${htmlEscape(total)}</strong></span>
          <span class="summary-value"><span>Average/day</span><strong>${htmlEscape(average)}</strong></span>
          <span class="summary-trend">
            <span class="trend">${htmlEscape(analysis.trend)}</span>
            ${needsAttention ? '<span class="attention">Review</span>' : '<span class="normal">No major alert</span>'}
          </span>
        </summary>
        <div class="property-body">
          <div class="metrics">
          <div><span>Total</span><strong>${htmlEscape(total)}</strong></div>
          <div><span>Average/day</span><strong>${htmlEscape(average)}</strong></div>
          <div><span>Highest day</span><strong>${htmlEscape(highest)}</strong></div>
          </div>
          <div class="chart-large">${renderLineChart(accountRows, unit, label)}</div>
          <ul class="notes">${notes}</ul>
          <details class="reading-detail">
            <summary>Daily readings</summary>
            <table>
              <thead><tr><th>Date</th><th>Usage</th></tr></thead>
              <tbody>${tableRows}</tbody>
            </table>
          </details>
          ${hourlyDays > 0 ? `
          <details class="reading-detail hourly-detail">
            <summary>Hourly usage, last ${hourlyDays} days</summary>
            ${renderHourlyRows(hourlyForAccount, unit)}
          </details>` : ''}
        </div>
      </details>`
    };
  });
  const portfolioTotal = properties.reduce((sum, property) => sum + (property.analysis.total || 0), 0);
  const attentionCount = properties.filter((property) => property.needsAttention).length;
  const propertyRows = properties.map((property) => property.html).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Water Usage Report</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #18212f;
      --muted: #657286;
      --line: #d9e1ea;
      --page: #f5f7fa;
      --panel: #ffffff;
      --accent: #0f7b8f;
      --accent-soft: #d9f0f3;
      --warn: #9a4f00;
      --good: #2f6f4e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--ink);
      background: var(--page);
    }
    header {
      padding: 28px 32px 18px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0 0 8px; font-size: 28px; }
    header p { margin: 0; color: var(--muted); }
    main {
      width: min(1440px, calc(100% - 32px));
      margin: 20px auto 40px;
    }
    .portfolio-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 24px;
      margin-bottom: 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .portfolio-stats strong { color: var(--ink); }
    .portfolio-hint {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .portfolio-columns {
      display: grid;
      grid-template-columns: minmax(260px, 1.55fr) minmax(220px, 1fr) minmax(120px, .65fr) minmax(120px, .65fr) minmax(190px, 1fr);
      gap: 14px;
      padding: 0 34px 7px 18px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .property {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .property-summary {
      display: grid;
      grid-template-columns: minmax(260px, 1.55fr) minmax(220px, 1fr) minmax(120px, .65fr) minmax(120px, .65fr) minmax(190px, 1fr);
      gap: 14px;
      align-items: center;
      min-height: 88px;
      padding: 10px 16px;
      cursor: pointer;
    }
    .property-summary:hover { background: #f9fbfc; }
    .property[open] > .property-summary { border-bottom: 1px solid var(--line); }
    .property-name { min-width: 0; }
    .property-name strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
    }
    .property-name span, .summary-value span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-top: 4px;
    }
    .summary-value strong { font-size: 14px; font-variant-numeric: tabular-nums; }
    .summary-trend { display: grid; gap: 6px; justify-items: start; }
    .trend {
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
    }
    .attention, .normal {
      display: inline-block;
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 11px;
      font-weight: 700;
    }
    .attention { color: var(--warn); background: #fff0de; }
    .normal { color: var(--good); background: #e6f3eb; }
    .property-body {
      padding: 18px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metrics div {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      background: #fbfcfe;
    }
    .metrics span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .metrics strong { font-size: 18px; }
    .mini-chart { min-width: 0; }
    .usage-chart { display: block; width: 100%; height: auto; }
    .usage-chart-compact { max-height: 62px; }
    .usage-chart .chart-baseline { stroke: var(--line); stroke-width: 1; }
    .usage-chart .usage-line {
      fill: none;
      stroke: var(--accent);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    .usage-chart .peak-dot { fill: var(--accent); }
    .usage-chart .chart-label {
      fill: var(--muted);
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
    }
    .usage-chart .chart-label-end { text-anchor: end; }
    .chart-large { max-width: 980px; margin: 0 auto 10px; }
    .bar-track {
      height: 14px;
      background: var(--accent-soft);
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 4px;
    }
    .bar-value { text-align: right; font-variant-numeric: tabular-nums; }
    .hourly-detail { margin-top: 14px; }
    .hourly-summary {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
      margin: 12px 0;
    }
    .hour-chart {
      display: grid;
      gap: 5px;
      max-height: 360px;
      overflow: auto;
      padding-right: 8px;
    }
    .hour-row {
      display: grid;
      grid-template-columns: 150px 1fr 110px;
      gap: 10px;
      align-items: center;
      font-size: 12px;
    }
    .hour-date { color: var(--muted); }
    .hourly-fill { background: #6856a8; }
    .empty { color: var(--muted); }
    .notes {
      margin: 12px 0 16px;
      padding-left: 20px;
      color: var(--warn);
    }
    .reading-detail {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      margin-top: 12px;
    }
    .reading-detail > summary { cursor: pointer; color: var(--accent); font-weight: 700; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 13px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 8px;
      text-align: left;
    }
    th { color: var(--muted); font-weight: 700; }
    @media (max-width: 1120px) {
      .portfolio-columns { display: none; }
      .property-summary {
        grid-template-columns: minmax(220px, 1.35fr) minmax(190px, 1fr) minmax(110px, .7fr) minmax(170px, 1fr);
      }
      .property-summary .summary-value:nth-of-type(4) { display: none; }
    }
    @media (max-width: 820px) {
      header { padding: 22px 16px 14px; }
      main { width: min(100% - 20px, 1440px); margin-top: 12px; }
      .property-summary {
        grid-template-columns: 1fr 1fr;
        gap: 8px 12px;
      }
      .property-name { grid-column: 1 / -1; }
      .mini-chart { grid-column: 1 / -1; }
      .property-summary .summary-value:nth-of-type(4) { display: block; }
      .summary-trend { justify-items: end; text-align: right; }
      .property-body { padding: 14px; }
      .metrics { display: block; }
      .metrics div { margin-bottom: 10px; }
      .hour-row { grid-template-columns: 108px 1fr; }
      .bar-value { grid-column: 2; text-align: left; }
      .hourly-summary { display: block; }
      .hourly-summary span { display: block; margin-bottom: 6px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Water Usage Report</h1>
    <p>Last ${days} available daily readings in ${htmlEscape(unit)}. Generated ${htmlEscape(generatedAt)}.</p>
  </header>
  <main>
    <div class="portfolio-stats">
      <span><strong>${properties.length}</strong> properties</span>
      <span><strong>${htmlEscape(formatUsage(portfolioTotal, unit))}</strong> portfolio total</span>
      <span><strong>${attentionCount}</strong> to review</span>
    </div>
    <p class="portfolio-hint">Each mini-chart is scaled to its own property. Select a property to open its full chart and readings.</p>
    ${properties.length > 0 ? `
    <div class="portfolio-columns" aria-hidden="true">
      <span>Property</span><span>Daily trend</span><span>Total</span><span>Average/day</span><span>Trend & status</span>
    </div>
    <section class="portfolio" aria-label="Water usage by property">
      ${propertyRows}
    </section>` : '<p>No usage rows found.</p>'}
  </main>
</body>
</html>`;

  const resolvedPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, html);
  return resolvedPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = requireEnv('CLEVELANDWATER_USERNAME');
  const password = requireEnv('CLEVELANDWATER_PASSWORD');

  const browser = await chromium.launch({ headless: args.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await loginToClevelandWater(page, username, password);
    const accounts = (await usagePageAccounts(page))
      .filter((account) => !args.account || account === args.account);

    if (args.account && accounts.length === 0) {
      throw new Error(`Account ${args.account} was not found on the Water Usage page.`);
    }

    const rows = [];
    const hourlyRows = [];
    for (const account of accounts) {
      const meters = await accountMeters(context, account);
      for (const meter of meters) {
        const readings = await usageReadings(context, account, meter.premiseId, args.days);
        rows.push(...dailyUsageRows(account, meter, readings, args.unit, args.days));
        if (args.hourlyDays > 0) {
          const hourly = await hourlyReadings(context, account, meter.premiseId, args.hourlyDays);
          hourlyRows.push(...hourlyUsageRows(account, meter, hourly, args.unit, args.hourlyDays));
        }
      }
    }

    printRows(rows, args.unit);
    printAnalysis(rows, args.unit);

    const alertResult = await processUsageAlerts(rows, hourlyRows, args.unit);
    console.log('');
    if (!alertResult.enabled) {
      console.log('Email alerts are disabled. Set WATER_ALERTS_ENABLED=true in .env to enable them.');
    } else if (alertResult.sent > 0) {
      console.log(`Sent ${alertResult.sent} water usage alert email${alertResult.sent === 1 ? '' : 's'}.`);
    } else {
      console.log('No new water usage alert email was needed.');
    }

    if (args.output) {
      const filePath = await writeCsv(rows, args.output);
      console.log('');
      console.log(`Saved CSV: ${filePath}`);
    }

    if (args.html) {
      const filePath = await writeHtmlReport(rows, hourlyRows, args.html, args.unit, args.days, args.hourlyDays);
      console.log('');
      console.log(`Saved HTML report: ${filePath}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
