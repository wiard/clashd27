import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const modelId = 'umangagarwal1008/PIMA-Diabetes-Prediction';
  const leakResultsPath = path.resolve(__dirname, '../data/audit/leak-results.json');
  const leakResults = JSON.parse(fs.readFileSync(leakResultsPath, 'utf8'));
  const generatedAt = new Date().toISOString();
  const auditHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      model: modelId,
      finding: leakResults,
      generatedAt
    }))
    .digest('hex');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const htmlPath = path.resolve(__dirname, '../data/audit/audit-report.html');
  const pdfPath = path.resolve(__dirname, '../data/audit/CLASHD27-Audit-umangagarwal1008-pima-diabetes-prediction.pdf');

  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '18mm',
      bottom: '18mm',
      left: '16mm',
      right: '16mm'
    }
  });

  await browser.close();
  const sizeKb = Math.round(fs.statSync(pdfPath).size / 1024);
  let forestHash = null;
  let forestIntervalId = null;
  try {
    const response = await fetch('https://openclashd.com/api/forest/capture', {
      method: 'POST'
    });
    const capture = await response.json();
    forestIntervalId = capture?.intervalId || null;
    forestHash = capture?.hash || null;
  } catch (error) {
    console.warn(`[audit-pdf] Forest capture failed: ${error.message}`);
  }

  const hashPath = path.resolve(__dirname, '../data/audit/audit-hash.txt');
  fs.writeFileSync(
    hashPath,
    [
      `auditHash=${auditHash}`,
      `forestIntervalId=${forestIntervalId || ''}`,
      `forestHash=${forestHash || ''}`
    ].join('\n') + '\n'
  );

  console.log(JSON.stringify({
    success: true,
    path: pdfPath,
    sizeKb,
    auditHash,
    forestIntervalId,
    forestHash
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
