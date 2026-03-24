import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_PATH = path.resolve(__dirname, '../data/yool-lee/gaps/results.json');
const HTML_PATH = path.resolve(__dirname, '../data/yool-lee/yool-lee-bw-report.html');
const PDF_PATH = path.resolve(__dirname, '../data/yool-lee/CLASHD27-YoolLee-Report-BW.pdf');

const NUM_WORDS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN'];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function splitEvidenceChain(chain) {
  const parts = String(chain || '')
    .split('->')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part.replace(/^[A-C]:\s*/i, '').trim());
  while (parts.length < 3) parts.push('');
  return parts;
}

function renderPapers(papers) {
  return (papers || []).slice(0, 3).map((paper, index) => {
    const authors = Array.isArray(paper.authors) ? paper.authors.join(', ') : '';
    const doiHref = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '#');
    return `
      <li class="paper-item">
        <div class="paper-index">${index + 1}.</div>
        <div class="paper-copy">
          <div class="paper-title">${escapeHtml(paper.title)}</div>
          <div class="paper-authors">${escapeHtml(authors)}${authors ? ' · ' : ''}${escapeHtml(paper.year || '')}</div>
          <div class="paper-doi"><a href="${escapeHtml(doiHref)}">${escapeHtml(paper.doi || doiHref)}</a></div>
        </div>
      </li>
    `;
  }).join('');
}

function renderRisks(risks) {
  return (risks || []).map((risk) => `<li>${escapeHtml(risk)}</li>`).join('');
}

function renderGapPage(gap, index) {
  const score = Math.round(Number(gap.score || 0) * 100);
  const [partA, partB, partC] = splitEvidenceChain(gap.evidenceChain);
  const pageNumber = index + 4;

  return `
    <section class="sheet gap-sheet">
      <div class="sheet-inner">
        <div class="section-bar">
          <div class="section-left">${NUM_WORDS[index] || String(index + 1)}</div>
          <div class="section-right">
            <span class="section-domain">${escapeHtml(String(gap.crossDomainLabel || '').toUpperCase())}</span>
            <span class="section-score">${score}/100</span>
          </div>
        </div>

        <div class="content-block">
          <div class="label">Hypothesis</div>
          <div class="hypothesis">${escapeHtml(gap.hypothesis)}</div>
        </div>

        <div class="three-col">
          <div class="col-card">
            <div class="small-label">Why This Connects</div>
            <p>${escapeHtml(gap.whyThisConnects)}</p>
          </div>
          <div class="col-card">
            <div class="small-label">Cheapest Validation</div>
            <p>${escapeHtml(gap.cheapestValidation)}</p>
          </div>
          <div class="col-card">
            <div class="small-label">Risks</div>
            <ul class="risk-list">${renderRisks(gap.risks)}</ul>
          </div>
        </div>

        <div class="content-block">
          <div class="small-label">Evidence Chain</div>
          <div class="evidence-row">
            <div class="evidence-box">[A] ${escapeHtml(partA)}</div>
            <div class="arrow">→</div>
            <div class="evidence-box">[B] ${escapeHtml(partB)}</div>
            <div class="arrow">→</div>
            <div class="evidence-box">[C] ${escapeHtml(partC)}</div>
          </div>
        </div>

        <div class="content-block papers-block">
          <div class="small-label">Key Papers</div>
          <ol class="paper-list">${renderPapers(gap.papers)}</ol>
        </div>

        <div class="bottom-rule"></div>
      </div>
      <div class="footer-note">
        <span>CLASHD27 — clashd27.com</span>
        <span>${pageNumber}</span>
      </div>
    </section>
  `;
}

function buildHtml(gaps) {
  const gapPages = gaps.map((gap, index) => renderGapPage(gap, index)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLASHD27 — Yool Lee BW Report</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #111111;
      --accent: #333333;
      --line: #cccccc;
      --black: #000000;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Arial, Helvetica, sans-serif;
    }
    .sheet {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto;
      background: #ffffff;
      page-break-after: always;
      break-after: page;
      position: relative;
    }
    .sheet:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .sheet-inner {
      padding: 18mm 20mm 22mm;
      min-height: 100%;
      position: relative;
    }
    .cover-top {
      min-height: 118mm;
      background: #000000;
      color: #ffffff;
      padding: 16mm 20mm 18mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .cover-kicker {
      display: flex;
      justify-content: space-between;
      font-size: 11pt;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-variant: small-caps;
    }
    .cover-title {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 33pt;
      line-height: 1.04;
      font-weight: 700;
      color: #ffffff;
      margin: 0;
      white-space: pre-line;
    }
    .cover-subtitle {
      margin-top: 6mm;
      max-width: 126mm;
      color: #efefef;
      font-size: 14pt;
      line-height: 1.5;
    }
    .cover-line {
      margin: 10mm 20mm 0;
      border-top: 1px solid #000000;
    }
    .meta-block {
      padding: 14mm 20mm 0;
      width: 100%;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: 34mm 1fr;
      gap: 3mm 8mm;
      font-size: 12pt;
      line-height: 1.55;
    }
    .meta-label {
      color: var(--accent);
      font-weight: 700;
    }
    .page-title {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 24pt;
      letter-spacing: 0.02em;
      margin: 0 0 10mm;
      color: var(--text);
    }
    .method-copy p,
    .expect-copy p,
    .colophon-copy p {
      font-size: 12.4pt;
      line-height: 1.72;
      margin: 0 0 7mm;
      color: var(--text);
    }
    .section-bar {
      border-top: 3px solid #000000;
      padding-top: 5mm;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-bottom: 8mm;
    }
    .section-left {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 19pt;
      letter-spacing: 0.08em;
      font-weight: 700;
      color: var(--text);
    }
    .section-right {
      display: flex;
      align-items: baseline;
      gap: 8mm;
      text-align: right;
    }
    .section-domain {
      font-size: 10.5pt;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 700;
    }
    .section-score {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 18pt;
      font-weight: 700;
      color: var(--text);
    }
    .content-block {
      margin-bottom: 8mm;
    }
    .label,
    .small-label {
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-weight: 700;
    }
    .label {
      font-size: 10pt;
      margin-bottom: 2.5mm;
    }
    .small-label {
      font-size: 9pt;
      margin-bottom: 2mm;
    }
    .hypothesis {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 14pt;
      font-style: italic;
      font-weight: 700;
      line-height: 1.72;
      color: var(--text);
    }
    .three-col {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 7mm;
      margin-bottom: 8mm;
    }
    .col-card p,
    .col-card li {
      font-size: 10pt;
      line-height: 1.62;
      margin: 0;
    }
    .risk-list {
      margin: 0;
      padding-left: 5mm;
    }
    .risk-list li {
      margin-bottom: 1.6mm;
    }
    .evidence-row {
      display: grid;
      grid-template-columns: 1fr auto 1fr auto 1fr;
      gap: 3mm;
      align-items: center;
      margin-top: 2mm;
    }
    .evidence-box {
      border: 1px solid var(--line);
      background: #f5f5f5;
      padding: 4mm 3.5mm;
      font-size: 9.5pt;
      line-height: 1.45;
      color: var(--text);
      min-height: 22mm;
    }
    .arrow {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 18pt;
      color: var(--accent);
    }
    .paper-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .paper-item {
      display: grid;
      grid-template-columns: 6mm 1fr;
      gap: 4mm;
      margin-bottom: 4.5mm;
      align-items: start;
    }
    .paper-index {
      font-size: 9pt;
      color: var(--accent);
      padding-top: 1mm;
    }
    .paper-title {
      font-weight: 700;
      font-size: 10pt;
      color: var(--text);
      margin-bottom: 1mm;
    }
    .paper-authors {
      font-size: 9pt;
      font-style: italic;
      color: var(--accent);
      margin-bottom: 0.8mm;
      line-height: 1.4;
    }
    .paper-doi,
    .paper-doi a {
      font-size: 9pt;
      color: #666666;
      text-decoration: none;
    }
    .bottom-rule {
      border-top: 1px solid var(--line);
      margin-top: 10mm;
    }
    .footer-note {
      position: absolute;
      left: 20mm;
      right: 20mm;
      bottom: 10mm;
      display: flex;
      justify-content: space-between;
      font-size: 9pt;
      color: #555555;
      border-top: 1px solid var(--line);
      padding-top: 3mm;
    }
    @page {
      size: A4;
      margin: 0;
    }
    @media print {
      html, body {
        background: #ffffff;
      }
      a {
        color: inherit;
        text-decoration: none;
      }
    }
  </style>
</head>
<body>
  <section class="sheet">
    <div class="cover-top">
      <div class="cover-kicker">
        <div>CLASHD27</div>
        <div>Research Intelligence</div>
      </div>
      <div>
        <h1 class="cover-title">CROSS-DOMAIN
RESEARCH OPPORTUNITIES</h1>
        <div class="cover-subtitle">Seven untested hypotheses derived from the published work of Yool Lee, PhD</div>
      </div>
    </div>
    <div class="cover-line"></div>
    <div class="meta-block">
      <div class="meta-grid">
        <div class="meta-label">Prepared for</div><div>Yool Lee, PhD</div>
        <div class="meta-label">Institution</div><div>Washington State University<br>Elson S. Floyd College of Medicine<br>Spokane, Washington</div>
        <div class="meta-label">Generated</div><div>20 March 2026</div>
        <div class="meta-label">System</div><div>CLASHD27 v2.0</div>
        <div class="meta-label">Classification</div><div>Cross-domain collision analysis</div>
        <div class="meta-label">Hypotheses</div><div>7 independent research directions</div>
        <div class="meta-label">Min. Score</div><div>80/100</div>
      </div>
    </div>
    <div class="footer-note">
      <span>CLASHD27 — clashd27.com</span>
      <span>1</span>
    </div>
  </section>

  <section class="sheet">
    <div class="sheet-inner method-copy">
      <h2 class="page-title">THE CLASHD27 METHOD</h2>
      <p>CLASHD27 is an autonomous research gap discovery system that classifies scientific literature into a 3×3×3 knowledge cube. Each axis of the cube represents a different dimension of research: method (how research is conducted), domain (what is being studied), and temporal horizon (whether findings are historical, current, or emerging).</p>
      <p>Papers are placed into one of 27 cells. The system then detects high-value collisions — moments where papers from distant cells share unexpected structural overlap. These collisions suggest that two fields are approaching the same phenomenon from different directions, without either field knowing it.</p>
      <p>Each collision is scored on seven independent components:</p>
      <p>Novelty &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Has this connection been made before?<br>
      Collision &nbsp;&nbsp;&nbsp;&nbsp; How distant are the colliding domains?<br>
      Residue &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Is there prior work that hints at this?<br>
      Gravity &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Is there emerging pressure in this area?<br>
      Evidence &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; How strong is the supporting literature?<br>
      Entropy &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; How diverse are the paper sources?<br>
      Serendipity &nbsp;&nbsp; How unexpected is the structural match?</p>
      <p>The combined score must exceed 80/100 for a hypothesis to be published. This threshold is calibrated to exclude obvious connections and surface only genuinely untested territory.</p>
      <p>This report was generated by running a dedicated analysis seeded with your published work on circadian biology, cancer timing, and chronotherapy. The system searched for structural collisions between your research domain and seven adjacent fields you may not routinely monitor.</p>
      <p>The result is seven falsifiable hypotheses. Each connects a mechanism you have already demonstrated to an application domain where that mechanism has not yet been tested. Each includes a cheapest validation path — the most resource-efficient experimental design to confirm or falsify the claim.</p>
    </div>
    <div class="footer-note">
      <span>CLASHD27 — clashd27.com</span>
      <span>2</span>
    </div>
  </section>

  <section class="sheet">
    <div class="sheet-inner expect-copy">
      <h2 class="page-title">WHAT THIS ANALYSIS SUGGESTS</h2>
      <p>The seven hypotheses in this report share a common structure: they take a biological timing principle established in your lab and ask what happens when that principle is applied in a context your research has not yet addressed.</p>
      <p>This is not a summary of what you already know. It is a map of what your work implies but has not yet tested — drawn by a system with no disciplinary boundaries and no prior assumptions about where your research should go next.</p>
      <p>We expect that at least two or three of these hypotheses will be immediately recognizable as directions you have already considered informally. The value of this report is not in those — it is in the two or three you have not considered, particularly those that cross into domains you rarely read.</p>
      <p>The highest-scoring hypothesis in this report — Legal &amp; Medical AI (82/100) — connects your findings to a domain you have almost certainly never published in. It suggests that AI diagnostic systems that ignore circadian timing create a measurable liability surface. That is not a biological claim. It is a governance claim grounded in your biology.</p>
      <p>That is the kind of connection this system is designed to find.</p>
    </div>
    <div class="footer-note">
      <span>CLASHD27 — clashd27.com</span>
      <span>3</span>
    </div>
  </section>

  ${gapPages}

  <section class="sheet">
    <div class="sheet-inner colophon-copy">
      <h2 class="page-title">METHODOLOGY &amp; LIMITATIONS</h2>
      <p>The hypotheses in this report are generated by autonomous AI collision analysis. They represent structurally significant cross-domain overlaps in the peer-reviewed literature, not validated experimental results.</p>
      <p>Each hypothesis is falsifiable by design. The cheapest validation path represents an estimate of the most efficient experimental approach based on standard methodology in the relevant domain. These estimates have not been reviewed by domain experts.</p>
      <p>Expert validation is required before any hypothesis proceeds to experimental investigation. The authors make no claim about the likelihood of confirmation.</p>

      <h2 class="page-title" style="font-size:20pt; margin-top:12mm;">VERIFICATION &amp; INTEGRITY</h2>
      <p>Each published gap in CLASHD27 is anchored in a Merkle tree at the time of publication. The hash for this report can be verified at:<br>openclashd.com/api/forest/verify</p>
      <p>This means the content of this report can be independently verified as unchanged since generation. No central authority is required for verification.</p>

      <h2 class="page-title" style="font-size:20pt; margin-top:12mm;">ABOUT CLASHD27</h2>
      <p>CLASHD27 is built on a 3×3×3 knowledge cube architecture. 27 agents classify incoming research by method, surprise level, and domain. Collisions between distant cells are scored, hypothesized, and published when they exceed the quality threshold.</p>
      <p>The system runs continuously across five research disciplines: AI &amp; Health, Legal &amp; AI, AI General, Biology &amp; Medicine, and Robotics.</p>
      <p>clashd27.com — live gap discovery<br>
      openclashd.com — governance kernel<br>
      safeclash.com — certification layer</p>
      <p>Built by Wiard Vasen<br>
      wiard.vasen@gmail.com</p>
    </div>
    <div class="footer-note">
      <span>CLASHD27 — clashd27.com</span>
      <span>11</span>
    </div>
  </section>
</body>
</html>`;
}

async function generatePDF() {
  const gaps = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  const html = buildHtml(gaps);
  fs.writeFileSync(HTML_PATH, html, 'utf8');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.goto(`file://${HTML_PATH}`, {
    waitUntil: 'networkidle0'
  });

  await page.pdf({
    path: PDF_PATH,
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
  const stats = fs.statSync(PDF_PATH);
  console.log('HTML klaar:', HTML_PATH);
  console.log('PDF klaar:', Math.round(stats.size / 1024), 'KB');
}

generatePDF().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
