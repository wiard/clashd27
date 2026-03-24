import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_PATH = path.resolve(__dirname, '../data/yool-lee/gaps/results.json');
const HTML_PATH = path.resolve(__dirname, '../data/yool-lee/yool-lee-report.html');
const PDF_PATH = path.resolve(__dirname, '../data/yool-lee/CLASHD27-YoolLee-CrossDomain-Report.pdf');

const COLORS = {
  navy: '#0a1628',
  red: '#c8102e',
  blue: '#1a3a5c',
  border: '#d4dbe4',
  ink: '#1b2230',
  muted: '#5f6876',
  pale: '#eef2f6'
};

const LABEL_COLORS = {
  'AI & Medical Imaging': '#2980B9',
  'Drug Delivery & Nanotechnology': '#27AE60',
  'Robotica & Surgery': '#E67E22',
  'Finance & Healthcare': '#8E44AD',
  'Legal & Medical AI': '#c8102e',
  'Microbiome & Circadian': '#16A085',
  'Wearables & Monitoring': '#2C3E50'
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function splitChain(chain) {
  const parts = String(chain || '')
    .split('->')
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length < 3) parts.push('');
  return parts.slice(0, 3).map((part) => {
    const cleaned = part.replace(/^[A-C]:\s*/i, '').trim();
    return truncateText(cleaned, 40);
  });
}

function wrapSvgText(text, width = 20) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function renderChainSvg(chain) {
  const parts = splitChain(chain);
  const positions = [18, 236, 454];
  const width = 192;
  const labels = ['A', 'B', 'C'];

  const boxes = parts.map((part, index) => {
    const x = positions[index];
    const lines = wrapSvgText(part, 23);
    const tspans = lines.map((line, lineIndex) => (
      `<tspan x="${x + 18}" dy="${lineIndex === 0 ? 0 : 15}">${escapeHtml(line)}</tspan>`
    )).join('');

    return `
      <rect x="${x}" y="10" width="${width}" height="66" rx="10" fill="${COLORS.navy}" />
      <text x="${x + 18}" y="28" fill="#f4f7fb" font-size="10" font-family="Helvetica, Arial, sans-serif" font-weight="700">${labels[index]}</text>
      <text x="${x + 18}" y="46" fill="#ffffff" font-size="10.5" font-family="Helvetica, Arial, sans-serif">${tspans}</text>
    `;
  }).join('');

  return `
    <svg class="chain-svg" viewBox="0 0 664 86" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Evidence chain">
      <defs>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="${COLORS.red}" />
        </marker>
      </defs>
      ${boxes}
      <line x1="210" y1="43" x2="228" y2="43" stroke="${COLORS.red}" stroke-width="2" marker-end="url(#arrowhead)" />
      <line x1="428" y1="43" x2="446" y2="43" stroke="${COLORS.red}" stroke-width="2" marker-end="url(#arrowhead)" />
    </svg>
  `;
}

function renderCubeSvg() {
  const circles = [];
  const lines = [];
  const layers = [24, 100, 176];
  const cols = [22, 88, 154];
  let index = 0;

  for (let layer = 0; layer < 3; layer += 1) {
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        const x = cols[col] + layer * 10;
        const y = layers[row] + layer * 10;
        circles.push(`<circle cx="${x}" cy="${y}" r="5.5" fill="${(index % 4 === 0) ? COLORS.red : COLORS.blue}" opacity="${(index % 4 === 0) ? '0.92' : '0.75'}" />`);
        index += 1;
      }
    }
  }

  const connectors = [
    [[22, 24], [174, 196]],
    [[88, 24], [164, 110]],
    [[42, 120], [164, 34]],
    [[108, 120], [32, 196]],
    [[98, 34], [184, 130]],
    [[42, 206], [184, 54]]
  ];

  for (const [[x1, y1], [x2, y2]] of connectors) {
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.red}" stroke-width="2" opacity="0.4" />`);
  }

  return `
    <svg class="cube-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Abstract CLASHD27 cube">
      <rect x="1" y="1" width="218" height="218" rx="22" fill="#f8fafc" stroke="${COLORS.border}" />
      ${lines.join('')}
      ${circles.join('')}
    </svg>
  `;
}

function renderPaper(paper, index) {
  const authors = Array.isArray(paper.authors) ? paper.authors.join(', ') : '';
  const doi = paper.doi ? escapeHtml(paper.doi) : 'No DOI available';
  const doiHref = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '#');
  return `
    <li class="paper-item">
      <span class="paper-number">${index + 1}.</span>
      <div class="paper-content">
        <div class="paper-title">${escapeHtml(paper.title)}</div>
        <div class="paper-meta">${escapeHtml(authors)} · ${escapeHtml(paper.year || '')}</div>
        <div class="paper-doi"><a href="${escapeHtml(doiHref)}">${doi}</a></div>
      </div>
    </li>
  `;
}

function renderGapPage(gap, index) {
  const score = Math.round(Number(gap.score || 0) * 100);
  const badgeColor = LABEL_COLORS[gap.crossDomainLabel] || COLORS.blue;
  const risks = (gap.risks || []).map((risk) => `<li>${escapeHtml(risk)}</li>`).join('');
  const papers = (gap.papers || []).slice(0, 3).map((paper, paperIndex) => renderPaper(paper, paperIndex)).join('');

  return `
    <section class="sheet gap-sheet">
      <div class="sheet-inner">
        <div class="gap-top">
          <div class="gap-number">${String(index + 1).padStart(2, '0')}</div>
          <div class="gap-header-right">
            <div class="gap-meta-top">
              <span class="gap-badge" style="background:${badgeColor};">${escapeHtml(gap.crossDomainLabel)}</span>
              <div class="gap-score">${score}<span>/100</span></div>
            </div>
            <div class="red-rule"></div>
          </div>
        </div>

        <div class="hypothesis-block">
          <div class="eyebrow">Hypothesis</div>
          <div class="hypothesis-text">${escapeHtml(gap.hypothesis)}</div>
        </div>

        <div class="three-col">
          <div class="info-card">
            <div class="info-label">Why this connects</div>
            <p>${escapeHtml(gap.whyThisConnects)}</p>
          </div>
          <div class="info-card">
            <div class="info-label">Cheapest validation</div>
            <p>${escapeHtml(gap.cheapestValidation)}</p>
          </div>
          <div class="info-card">
            <div class="info-label">Risks</div>
            <ul class="risk-list">${risks}</ul>
          </div>
        </div>

        <div class="evidence-block">
          <div class="info-label">Evidence chain</div>
          ${renderChainSvg(gap.evidenceChain)}
        </div>

        <div class="papers-block">
          <div class="info-label">Key papers</div>
          <ol class="paper-list">${papers}</ol>
        </div>
      </div>
    </section>
  `;
}

function buildHtml(results) {
  const gapPages = results.map((gap, index) => renderGapPage(gap, index)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLASHD27 — Cross-Domain Research Opportunities</title>
  <style>
    :root {
      --navy: ${COLORS.navy};
      --red: ${COLORS.red};
      --blue: ${COLORS.blue};
      --ink: ${COLORS.ink};
      --muted: ${COLORS.muted};
      --line: ${COLORS.border};
      --pale: ${COLORS.pale};
      --page-width: 210mm;
      --page-height: 297mm;
      --page-pad-x: 18mm;
      --page-pad-y: 16mm;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #d7dde6;
      color: var(--ink);
      font-family: Helvetica, Arial, sans-serif;
    }
    .sheet {
      width: var(--page-width);
      min-height: var(--page-height);
      margin: 0 auto 8mm;
      background: #ffffff;
      position: relative;
      break-after: page;
      page-break-after: always;
      overflow: hidden;
    }
    .sheet:last-child {
      break-after: auto;
      page-break-after: auto;
    }
    .sheet-inner {
      padding: var(--page-pad-y) var(--page-pad-x) calc(var(--page-pad-y) + 8mm);
      min-height: 100%;
    }
    .cover-top {
      background: var(--navy);
      color: #ffffff;
      min-height: 144mm;
      padding: 14mm 18mm 18mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .cover-kicker {
      display: flex;
      justify-content: space-between;
      font-size: 11pt;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .cover-title-wrap {
      max-width: 136mm;
    }
    .cover-title {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 34pt;
      line-height: 1.02;
      font-weight: 700;
      letter-spacing: 0.02em;
      margin: 0 0 8mm;
      white-space: pre-line;
    }
    .cover-subtitle {
      color: #c7d0dc;
      font-size: 14pt;
      line-height: 1.45;
      max-width: 122mm;
      margin: 0 0 8mm;
    }
    .cover-rule {
      width: 100%;
      height: 2px;
      background: var(--red);
      margin-top: 8mm;
    }
    .cover-bottom {
      padding: 14mm 18mm 0;
      display: grid;
      grid-template-columns: 1.25fr 0.75fr;
      gap: 14mm;
      align-items: start;
    }
    .cover-card {
      border: 1px solid var(--line);
      padding: 10mm 10mm 9mm;
      background: #fff;
    }
    .meta-row {
      margin-bottom: 7mm;
    }
    .meta-row:last-child {
      margin-bottom: 0;
    }
    .meta-label {
      color: var(--muted);
      font-size: 9pt;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      margin-bottom: 1.5mm;
    }
    .meta-value {
      font-size: 12.5pt;
      line-height: 1.45;
      color: var(--ink);
    }
    .cube-wrap {
      display: flex;
      justify-content: flex-end;
      padding-top: 4mm;
    }
    .cube-svg {
      width: 200px;
      height: 200px;
    }
    .section-heading {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 24pt;
      color: var(--navy);
      margin: 0 0 10mm;
      letter-spacing: 0.02em;
    }
    .intro-grid {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 10mm;
    }
    .intro-copy p,
    .colophon-copy p {
      font-size: 12.5pt;
      line-height: 1.72;
      margin: 0 0 7mm;
    }
    .scoring-box {
      border: 1px solid var(--line);
      background: var(--pale);
      padding: 9mm 8mm;
    }
    .box-title {
      font-size: 11pt;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--navy);
      margin-bottom: 6mm;
    }
    .score-table {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 3mm 6mm;
      font-size: 11pt;
      line-height: 1.45;
    }
    .score-table strong {
      color: var(--navy);
    }
    .threshold {
      margin-top: 7mm;
      padding-top: 5mm;
      border-top: 1px solid var(--line);
      font-size: 11pt;
      font-weight: 700;
      color: var(--red);
    }
    .gap-top {
      display: grid;
      grid-template-columns: 26mm 1fr;
      gap: 8mm;
      align-items: start;
      margin-bottom: 8mm;
    }
    .gap-number {
      font-family: Georgia, "Times New Roman", serif;
      color: var(--navy);
      font-size: 48pt;
      line-height: 1;
      font-weight: 700;
    }
    .gap-header-right {
      padding-top: 2mm;
    }
    .gap-meta-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8mm;
      margin-bottom: 5mm;
    }
    .gap-badge {
      color: #fff;
      font-size: 10pt;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-weight: 700;
      padding: 3.5mm 5.5mm;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
    }
    .gap-score {
      color: var(--navy);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 32pt;
      font-weight: 700;
      white-space: nowrap;
    }
    .gap-score span {
      font-size: 16pt;
      color: var(--muted);
      margin-left: 1.5mm;
    }
    .red-rule {
      width: 100%;
      height: 1.5px;
      background: var(--red);
    }
    .eyebrow,
    .info-label {
      color: var(--red);
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-weight: 700;
    }
    .hypothesis-block {
      margin-bottom: 9mm;
    }
    .hypothesis-text {
      margin-top: 3mm;
      color: var(--navy);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 18pt;
      font-weight: 700;
      line-height: 1.48;
    }
    .three-col {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6mm;
      margin-bottom: 8mm;
    }
    .info-card {
      border-top: 1px solid var(--line);
      padding-top: 3mm;
      min-height: 42mm;
    }
    .info-card p,
    .info-card li {
      font-size: 10pt;
      line-height: 1.6;
      color: var(--ink);
    }
    .risk-list {
      margin: 3mm 0 0;
      padding-left: 5mm;
    }
    .risk-list li {
      margin-bottom: 2mm;
    }
    .evidence-block,
    .papers-block {
      margin-bottom: 7mm;
    }
    .chain-svg {
      width: 100%;
      height: auto;
      margin-top: 3mm;
    }
    .paper-list {
      margin: 4mm 0 0;
      padding: 0;
      list-style: none;
    }
    .paper-item {
      display: grid;
      grid-template-columns: 7mm 1fr;
      gap: 3mm;
      margin-bottom: 4mm;
      align-items: start;
    }
    .paper-number {
      font-size: 9pt;
      color: var(--muted);
      padding-top: 0.6mm;
    }
    .paper-title {
      color: var(--navy);
      font-size: 10pt;
      line-height: 1.4;
      font-weight: 700;
      margin-bottom: 1mm;
    }
    .paper-meta {
      color: var(--muted);
      font-size: 9pt;
      line-height: 1.45;
      margin-bottom: 0.8mm;
    }
    .paper-doi a {
      color: var(--blue);
      font-size: 9pt;
      text-decoration: none;
    }
    .colophon-copy {
      max-width: 150mm;
    }
    .colophon-copy .section-heading {
      margin-bottom: 9mm;
    }
    .colophon-copy h3 {
      margin: 0 0 4mm;
      color: var(--navy);
      font-size: 12pt;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-family: Helvetica, Arial, sans-serif;
    }
    @page {
      size: A4;
      margin: 0;
    }
    @media print {
      html, body {
        background: #fff;
      }
      .sheet {
        margin: 0;
        box-shadow: none;
      }
      a {
        color: inherit;
        text-decoration: none;
      }
    }
  </style>
</head>
<body>
  <section class="sheet cover-sheet">
    <div class="cover-top">
      <div class="cover-kicker">
        <div>CLASHD27</div>
        <div>Research Intelligence</div>
      </div>
      <div class="cover-title-wrap">
        <h1 class="cover-title">CROSS-DOMAIN
RESEARCH OPPORTUNITIES</h1>
        <p class="cover-subtitle">Seven untested hypotheses at the intersection of chronobiology and adjacent research frontiers</p>
        <div class="cover-rule"></div>
      </div>
    </div>
    <div class="cover-bottom">
      <div class="cover-card">
        <div class="meta-row">
          <div class="meta-label">Prepared for</div>
          <div class="meta-value">Yool Lee, PhD</div>
        </div>
        <div class="meta-row">
          <div class="meta-label">Institution</div>
          <div class="meta-value">Washington State University<br>Elson S. Floyd College of Medicine, Spokane WA</div>
        </div>
        <div class="meta-row">
          <div class="meta-label">Generated</div>
          <div class="meta-value">20 March 2026</div>
        </div>
        <div class="meta-row">
          <div class="meta-label">System</div>
          <div class="meta-value">CLASHD27 v2.0 — Autonomous Cross-Domain Research Gap Discovery</div>
        </div>
        <div class="meta-row">
          <div class="meta-label">Scope</div>
          <div class="meta-value">7 hypotheses across 7 domains</div>
        </div>
      </div>
      <div class="cube-wrap">${renderCubeSvg()}</div>
    </div>
  </section>

  <section class="sheet intro-sheet">
    <div class="sheet-inner">
      <h2 class="section-heading">ABOUT THIS REPORT</h2>
      <div class="intro-grid">
        <div class="intro-copy">
          <p>This report was generated by CLASHD27, an autonomous research gap discovery system that classifies scientific literature into a 3×3×3 knowledge cube and detects high-value collisions between distant domains.</p>
          <p>Each hypothesis in this report emerges from a collision between your published work on circadian biology and a domain outside your primary field. The system does not summarize what you already know — it identifies what your research implies but has not yet tested.</p>
        </div>
        <aside class="scoring-box">
          <div class="box-title">How gaps are scored</div>
          <div class="score-table">
            <strong>Novelty</strong><span>Is this connection new?</span>
            <strong>Collision</strong><span>How distant are the domains?</span>
            <strong>Residue</strong><span>Does prior work support this?</span>
            <strong>Gravity</strong><span>Is there emerging pressure here?</span>
            <strong>Evidence</strong><span>How strong is the paper trail?</span>
            <strong>Entropy</strong><span>How diverse are the sources?</span>
            <strong>Serendipity</strong><span>How unexpected is the link?</span>
          </div>
          <div class="threshold">Threshold for publication: 80/100</div>
        </aside>
      </div>
    </div>
  </section>

  ${gapPages}

  <section class="sheet colophon-sheet">
    <div class="sheet-inner">
      <div class="colophon-copy">
        <h2 class="section-heading">METHODOLOGY NOTE</h2>
        <p>Hypotheses in this report are generated by autonomous AI collision analysis. They represent statistically significant cross-domain overlaps in the scientific literature, not validated experimental results.</p>
        <p>Each hypothesis is designed to be falsifiable. The cheapest validation path is an estimate based on standard research methodology in the relevant domain.</p>
        <p>Expert validation is required before any hypothesis proceeds to experimental investigation.</p>

        <h3>About CLASHD27</h3>
        <p>CLASHD27 is an autonomous research gap discovery system built on a 3×3×3 knowledge cube architecture. It classifies papers by method, surprise level, and domain, then detects high-value collisions between distant cells. Each published gap is anchored in a Merkle tree for verification and integrity.</p>
        <p>Built by Wiard Vasen — wiard.vasen@gmail.com<br>clashd27.com | openclashd.com</p>
      </div>
    </div>
  </section>
</body>
</html>`;
}

async function generatePDF() {
  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  const html = buildHtml(results);
  fs.writeFileSync(HTML_PATH, html, 'utf8');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.goto(`file://${HTML_PATH}`, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: PDF_PATH,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `
      <div style="width:100%; font-family: Helvetica, Arial, sans-serif; font-size:9px; color:#5f6876; padding:0 18mm 6mm;">
        <div style="border-top:1px solid #d4dbe4; width:100%; margin-bottom:4px;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
          <span>CLASHD27 — clashd27.com</span>
          <span><span class="pageNumber"></span></span>
        </div>
      </div>
    `,
    margin: {
      top: '0mm',
      bottom: '15mm',
      left: '0mm',
      right: '0mm'
    }
  });

  await browser.close();
  const stats = fs.statSync(PDF_PATH);
  console.log('HTML klaar:', HTML_PATH);
  console.log('PDF klaar:', PDF_PATH);
  console.log('PDF klaar:', Math.round(stats.size / 1024), 'KB');
}

generatePDF().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
