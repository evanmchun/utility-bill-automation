import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const MONTHS = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12'
};

function parseArgs(argv) {
  const args = {
    month: new Date().toISOString().slice(0, 7),
    all: false,
    debug: false,
    outputDir: process.env.OUTPUT_DIR || '.',
    headless: (process.env.HEADLESS || 'true').toLowerCase() !== 'false'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') args.all = true;
    else if (arg === '--debug') args.debug = true;
    else if (arg === '--visible') args.headless = false;
    else if (arg === '--month') args.month = argv[++i];
    else if (arg.startsWith('--month=')) args.month = arg.slice('--month='.length);
    else if (arg === '--output') args.outputDir = argv[++i];
    else if (arg.startsWith('--output=')) args.outputDir = arg.slice('--output='.length);
  }

  if (!args.all && !/^\d{4}-\d{2}$/.test(args.month)) {
    throw new Error('Use --month YYYY-MM, for example --month 2026-05');
  }

  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Create .env from .env.example first.`);
  return value;
}

function billMonth(dateText) {
  const match = dateText.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match || !MONTHS[match[1]]) {
    throw new Error(`Could not parse bill date: ${dateText}`);
  }
  return `${match[3]}-${MONTHS[match[1]]}`;
}

function safePart(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBillLink(text, id) {
  const match = text.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*Bill\s*(\d{10})\s*(\$[\d,.]+)/);
  if (!match) return null;
  return {
    id,
    text,
    dateText: match[1],
    month: billMonth(match[1]),
    account: match[2],
    amount: match[3]
  };
}

async function loginToClevelandWater(page, username, password) {
  await page.goto('https://my.clevelandwater.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#edit-name').fill(username);
  await page.locator('#edit-pass').fill(password);
  await Promise.all([
    page.waitForURL('**/dashboard', { timeout: 30000 }),
    page.getByRole('link', { name: 'Log In' }).click()
  ]);
}

async function openKubra(page) {
  await page.waitForFunction(() => typeof window.kubraLogin === 'function');
  await page.evaluate(() => window.kubraLogin());
  await page.waitForURL('https://secure8.i-doxs.net/BDX/Secure/Home.aspx', { timeout: 45000 });
  await page.waitForLoadState('domcontentloaded');
}

async function currentBillLinks(page) {
  return page.locator('a').evaluateAll((links) => links
    .map((link) => ({
      id: link.id,
      text: (link.textContent || '').replace(/\s+/g, ' ').trim()
    }))
    .filter((link) => link.id && /Bill\s*\d{10}\s*\$/.test(link.text)));
}

async function downloadBill(page, bill, outputRoot) {
  await page.locator(`a[id="${bill.id}"]`).click();
  await page.waitForURL('**/ViewBill.aspx', { timeout: 45000 });
  await page.waitForLoadState('domcontentloaded');

  const downloadControl = page.locator('img[alt="Download PDF"]');
  const onclick = await downloadControl.getAttribute('onclick');
  const match = onclick?.match(/document\.location\.href='([^']+)'/);
  if (!match) throw new Error(`Could not find PDF URL for account ${bill.account}`);

  const pdfUrl = new URL(match[1], page.url()).href;
  const response = await page.context().request.get(pdfUrl);
  if (!response.ok()) {
    throw new Error(`PDF request failed for account ${bill.account}: HTTP ${response.status()}`);
  }

  const folder = path.resolve(outputRoot, bill.month);
  await fs.mkdir(folder, { recursive: true });

  const filename = safePart(`${bill.dateText} - ${bill.account} - Cleveland Water - ${bill.amount}.pdf`);
  const filePath = path.join(folder, filename);
  await fs.writeFile(filePath, await response.body());

  await page.goto('https://secure8.i-doxs.net/BDX/Secure/Home.aspx', { waitUntil: 'domcontentloaded' });
  return filePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = requireEnv('CLEVELANDWATER_USERNAME');
  const password = requireEnv('CLEVELANDWATER_PASSWORD');

  const browser = await chromium.launch({ headless: args.headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await loginToClevelandWater(page, username, password);
    await openKubra(page);

    const rawLinks = await currentBillLinks(page);
    const bills = rawLinks
      .map((link) => parseBillLink(link.text, link.id))
      .filter(Boolean)
      .filter((bill) => args.all || bill.month === args.month);

    if (bills.length === 0) {
      if (args.debug) {
        console.log('Debug bill-ish links:');
        for (const link of rawLinks) console.log(JSON.stringify(link));
        console.log('Page URL:', page.url());
        console.log((await page.locator('body').innerText()).slice(0, 4000));
      }
      console.log(args.all ? 'No bill links found.' : `No bill links found for ${args.month}.`);
      return;
    }

    console.log(`Found ${bills.length} bill(s) to download.`);
    for (const bill of bills) {
      const filePath = await downloadBill(page, bill, args.outputDir);
      console.log(`Downloaded ${bill.account} ${bill.dateText}: ${filePath}`);
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
