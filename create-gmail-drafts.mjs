import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

function parseArgs(argv) {
  const args = {
    month: new Date().toISOString().slice(0, 7)
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--month') args.month = argv[++i];
    else if (arg.startsWith('--month=')) args.month = arg.slice('--month='.length);
  }

  if (!/^\d{4}-\d{2}$/.test(args.month)) {
    throw new Error('Use --month YYYY-MM, for example --month 2026-05');
  }

  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Create .env from .env.example first.`);
  return value;
}

function gmailAppPassword() {
  return requireEnv('GMAIL_APP_PASSWORD').replace(/\s+/g, '');
}

async function withTimeout(label, promise, timeoutMs = 60000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function pdfAttachments(folder, utilityLabel) {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  return entries
    .filter((entry) =>
      entry.isFile() &&
      entry.name.toLowerCase().endsWith('.pdf') &&
      entry.name.includes(` - ${utilityLabel} - `)
    )
    .map((entry) => ({
      filename: entry.name,
      path: path.join(folder, entry.name)
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

async function buildMessage({ from, to, subject, text, attachments }) {
  const transport = nodemailer.createTransport({
    buffer: true,
    newline: 'unix',
    streamTransport: true
  });

  const info = await transport.sendMail({
    attachments,
    from,
    subject,
    text,
    to
  });

  return info.message;
}

async function appendDraft(client, rawMessage) {
  await withTimeout('Appending Gmail draft', client.append('[Gmail]/Drafts', rawMessage, ['\\Draft'], new Date()));
}

async function createDraft(client, options) {
  if (options.attachments.length !== 5) {
    throw new Error(`${options.subject}: expected 5 PDFs, found ${options.attachments.length}.`);
  }

  const rawMessage = await buildMessage(options);
  await appendDraft(client, rawMessage);
  console.log(`Created draft: ${options.subject} (${options.attachments.length} attachment(s))`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gmailAddress = requireEnv('GMAIL_ADDRESS');
  const gmailPassword = gmailAppPassword();
  const recipient = requireEnv('UTILITY_BILLS_RECIPIENT');

  const root = process.cwd();
  const jobs = [
    {
      bodyName: 'water',
      folder: path.join(root, 'Water Bill', args.month),
      subject: `Water Bills - ${args.month}`,
      utilityLabel: 'Water'
    },
    {
      bodyName: 'sewer',
      folder: path.join(root, 'Sewer Bill', args.month),
      subject: `Sewer Bills - ${args.month}`,
      utilityLabel: 'Sewer'
    }
  ];

  const client = new ImapFlow({
    auth: {
      pass: gmailPassword,
      user: gmailAddress
    },
    authTimeout: 30000,
    connectionTimeout: 30000,
    host: 'imap.gmail.com',
    logger: false,
    port: 993,
    secure: true
  });

  console.log(`Connecting to Gmail as ${gmailAddress}...`);
  await withTimeout('Connecting to Gmail', client.connect());
  console.log('Connected. Creating drafts...');
  try {
    for (const job of jobs) {
      const attachments = await pdfAttachments(job.folder, job.utilityLabel);
      console.log(`${job.subject}: found ${attachments.length} attachment(s).`);
      await createDraft(client, {
        attachments,
        from: gmailAddress,
        subject: job.subject,
        text: `Attached are the ${job.bodyName} bills for ${args.month}.`,
        to: recipient
      });
    }
  } finally {
    await withTimeout('Logging out of Gmail', client.logout(), 15000).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.responseText || error.response || error.message);
  process.exit(1);
});
