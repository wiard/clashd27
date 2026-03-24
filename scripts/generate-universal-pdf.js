import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const htmlPath = path.resolve(
    __dirname,
    '../data/universal-timing/universal-report.html'
  );

  await page.goto(`file://${htmlPath}`, {
    waitUntil: 'networkidle0'
  });

  const outputPath = path.resolve(
    __dirname,
    '../data/universal-timing/CLASHD27-TimingIsBiology.pdf'
  );

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '0mm',
      bottom: '15mm',
      left: '0mm',
      right: '0mm'
    }
  });

  await browser.close();

  const size = fs.statSync(outputPath);
  console.log('PDF klaar:', Math.round(size.size / 1024), 'KB');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
