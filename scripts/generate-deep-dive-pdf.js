import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generatePDF() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const htmlPath = path.resolve(
    __dirname,
    '../data/yool-lee/deep-dive/deep-report.html'
  );

  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  const outputPath = path.resolve(
    __dirname,
    '../data/yool-lee/deep-dive/CLASHD27-YoolLee-DeepDive.pdf'
  );

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: false,
    margin: {
      top: '20mm',
      bottom: '20mm',
      left: '20mm',
      right: '20mm'
    }
  });

  await browser.close();
  const stats = fs.statSync(outputPath);
  console.log('PDF klaar');
  console.log('Pad:', outputPath);
  console.log('Grootte KB:', Math.round(stats.size / 1024));
}

generatePDF().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
