const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function exportGapToPDF(gapId, outputPath, options = {}) {
  if (!gapId) {
    throw new Error('gapId is required');
  }
  if (!outputPath) {
    throw new Error('outputPath is required');
  }

  const port = Number(options.port || process.env.PUBLIC_PORT || 3028);
  const baseUrl = String(options.baseUrl || `http://localhost:${port}`).replace(/\/$/, '');
  const routePath = String(options.routePath || `/gaps/${encodeURIComponent(gapId)}`);
  const targetUrl = `${baseUrl}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
  let browser = null;

  ensureDir(outputPath);

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(targetUrl, {
      waitUntil: 'networkidle0',
      timeout: Number(options.timeoutMs || 60000)
    });
    await page.emulateMediaType('screen');
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '12mm',
        right: '10mm',
        bottom: '12mm',
        left: '10mm'
      }
    });

    const stats = fs.statSync(outputPath);
    return {
      success: true,
      path: outputPath,
      sizeKb: Math.round((stats.size / 1024) * 10) / 10
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  exportGapToPDF
};
