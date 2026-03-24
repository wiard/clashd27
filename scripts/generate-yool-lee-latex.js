import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_PATH = path.resolve(__dirname, '../data/yool-lee/gaps/results.json');
const TEX_PATH = path.resolve(__dirname, '../data/yool-lee/yool-lee-report.tex');

const DOMAIN_COLORS = {
  'AI & Medical Imaging': 'domainblue',
  'Drug Delivery & Nanotechnology': 'domaingreen',
  'Robotica & Surgery': 'domainorange',
  'Finance & Healthcare': 'domainpurple',
  'Legal & Medical AI': 'clashred',
  'Microbiome & Circadian': 'domainteal',
  'Wearables & Monitoring': 'domainnavy'
};

function escapeLaTeX(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/→/g, '$\\rightarrow$')
    .replace(/×/g, '$\\times$')
    .replace(/≥/g, '$\\geq$')
    .replace(/≤/g, '$\\leq$')
    .replace(/β/g, '$\\beta$')
    .replace(/α/g, '$\\alpha$')
    .replace(/γ/g, '$\\gamma$')
    .replace(/Δ/g, '$\\Delta$')
    .replace(/δ/g, '$\\delta$')
    .replace(/μ/g, '$\\mu$')
    .replace(/θ/g, '$\\theta$')
    .replace(/±/g, '$\\pm$')
    .replace(/°/g, '$^\\circ$')
    .replace(/–/g, '--')
    .replace(/—/g, '---')
    .replace(/’/g, "'")
    .replace(/‘/g, "'")
    .replace(/“/g, '``')
    .replace(/”/g, "''")
    .replace(/…/g, '\\ldots{}');
}

function authorLine(authors) {
  return escapeLaTeX((authors || []).join(', '));
}

function splitEvidenceChain(chain) {
  const fallback = ['Source A', 'Source B', 'Source C'];
  const parts = String(chain || '')
    .split('->')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part.replace(/^[A-C]:\s*/i, '').trim());
  while (parts.length < 3) parts.push(fallback[parts.length]);
  return parts.map((part) => escapeLaTeX(part));
}

function renderRiskItems(risks) {
  return (risks || [])
    .map((risk) => `\\item ${escapeLaTeX(risk)}`)
    .join('\n');
}

function renderPaperItems(papers) {
  return (papers || []).slice(0, 3).map((paper) => {
    const title = escapeLaTeX(paper.title || 'Untitled paper');
    const authors = authorLine(paper.authors || []);
    const year = escapeLaTeX(String(paper.year || ''));
    const doi = escapeLaTeX(paper.doi || '');
    const url = escapeLaTeX(paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : ''));
    return `\\item \\textbf{${title}}\\\\
{\\color{medgray}${authors}${authors ? ' --- ' : ''}${year}}\\\\
\\href{${url}}{${doi || url}}`;
  }).join('\n');
}

function renderGapSection(gap, index) {
  const color = DOMAIN_COLORS[gap.crossDomainLabel] || 'darkblue';
  const score = Math.round(Number(gap.score || 0) * 100);
  const [chainA, chainB, chainC] = splitEvidenceChain(gap.evidenceChain);

  return `
\\section*{}
\\noindent\\begin{minipage}{\\linewidth}
  \\colorbox{navyblue}{\\parbox[c][12mm][c]{16mm}{\\centering\\color{white}\\fontsize{22}{22}\\selectfont\\textbf{${String(index + 1).padStart(2, '0')}}}}
  \\hspace{5pt}
  \\colorbox{${color}}{\\parbox[c][8mm][c]{82mm}{\\centering\\color{white}\\small\\textbf{${escapeLaTeX(gap.crossDomainLabel)}}}}
  \\hfill
  \\colorbox{lightgray}{\\parbox[c][10mm][c]{28mm}{\\centering\\color{navyblue}\\large\\textbf{${score}/100}}}
\\end{minipage}

\\vspace{3mm}
\\noindent{\\color{clashred}\\small\\textbf{HYPOTHESIS}}

\\vspace{1.5mm}
\\noindent{\\fontsize{16}{21}\\selectfont\\color{navyblue}\\textit{${escapeLaTeX(gap.hypothesis)}}}

\\vspace{5mm}
\\begin{multicols}{3}
{\\color{clashred}\\small\\textbf{WHY THIS CONNECTS}}\\\\[1mm]
{\\small ${escapeLaTeX(gap.whyThisConnects)}}\\columnbreak

{\\color{clashred}\\small\\textbf{CHEAPEST VALIDATION}}\\\\[1mm]
{\\small ${escapeLaTeX(gap.cheapestValidation)}}\\columnbreak

{\\color{clashred}\\small\\textbf{RISKS}}\\\\[1mm]
\\begin{itemize}[leftmargin=*, itemsep=1mm, topsep=1mm]
${renderRiskItems(gap.risks)}
\\end{itemize}
\\end{multicols}

\\vspace{1mm}
{\\color{clashred}\\small\\textbf{EVIDENCE CHAIN}}\\\\[2mm]
\\begin{center}
\\begin{tikzpicture}[node distance=2.2cm, every node/.style={font=\\small}]
  \\node[draw, fill=navyblue, text=white, rounded corners=3pt, minimum width=4.0cm, minimum height=1.5cm, align=center, text width=3.5cm] (A) {${chainA}};
  \\node[draw, fill=navyblue, text=white, rounded corners=3pt, minimum width=4.0cm, minimum height=1.5cm, align=center, text width=3.5cm, right=1.0cm of A] (B) {${chainB}};
  \\node[draw, fill=navyblue, text=white, rounded corners=3pt, minimum width=4.0cm, minimum height=1.5cm, align=center, text width=3.5cm, right=1.0cm of B] (C) {${chainC}};
  \\draw[->, very thick, clashred] (A) -- (B);
  \\draw[->, very thick, clashred] (B) -- (C);
\\end{tikzpicture}
\\end{center}

\\vspace{1mm}
{\\color{clashred}\\small\\textbf{KEY PAPERS}}\\\\[2mm]
\\begin{enumerate}[leftmargin=*, label=\\arabic*., itemsep=2mm]
${renderPaperItems(gap.papers)}
\\end{enumerate}

\\vspace{4mm}
\\hrule
\\vspace{2mm}
`;
}

function buildTex(gaps) {
  const sections = gaps.map((gap, index) => renderGapSection(gap, index)).join('\n');

  return `
\\documentclass[a4paper,10pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{geometry}
\\usepackage{xcolor}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{array}
\\usepackage{parskip}
\\usepackage{titlesec}
\\usepackage{fancyhdr}
\\usepackage{hyperref}
\\usepackage{microtype}
\\usepackage{enumitem}
\\usepackage{mdframed}
\\usepackage{tikz}
\\usepackage{multicol}
\\usetikzlibrary{positioning}

\\definecolor{navyblue}{RGB}{10,22,40}
\\definecolor{clashred}{RGB}{200,16,46}
\\definecolor{darkblue}{RGB}{26,58,92}
\\definecolor{lightgray}{RGB}{245,245,245}
\\definecolor{medgray}{RGB}{120,120,120}
\\definecolor{domainblue}{RGB}{41,128,185}
\\definecolor{domaingreen}{RGB}{39,174,96}
\\definecolor{domainorange}{RGB}{230,126,34}
\\definecolor{domainpurple}{RGB}{142,68,173}
\\definecolor{domainteal}{RGB}{22,160,133}
\\definecolor{domainnavy}{RGB}{44,62,80}

\\geometry{
  a4paper,
  top=25mm,
  bottom=25mm,
  left=20mm,
  right=20mm
}

\\hypersetup{
  colorlinks=true,
  linkcolor=darkblue,
  urlcolor=darkblue,
  pdftitle={CLASHD27 Yool Lee Report},
  pdfauthor={CLASHD27}
}

\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0.8em}
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\small\\color{medgray}CLASHD27 --- clashd27.com}
\\fancyhead[R]{\\small\\color{medgray}Cross-Domain Research Opportunities}
\\fancyfoot[C]{\\small\\color{medgray}\\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}
\\renewcommand{\\footrulewidth}{0pt}

\\begin{document}
\\thispagestyle{empty}

\\begin{mdframed}[backgroundcolor=navyblue, linewidth=0pt, innertopmargin=18mm, innerbottommargin=18mm, innerleftmargin=10mm, innerrightmargin=10mm]
{\\color{white}\\small\\textsc{CLASHD27}}\\hfill{\\color{white}\\small\\textsc{RESEARCH INTELLIGENCE}}

\\vspace{20mm}
{\\color{white}\\fontsize{28}{32}\\selectfont\\bfseries CROSS-DOMAIN\\\\RESEARCH OPPORTUNITIES}

\\vspace{6mm}
{\\color{lightgray}\\large Seven untested hypotheses at the intersection of chronobiology and adjacent research frontiers}
\\end{mdframed}

\\vspace{7mm}

\\noindent
\\begin{minipage}[t]{0.56\\linewidth}
\\renewcommand{\\arraystretch}{1.25}
\\begin{tabular}{>{\\bfseries}p{32mm}p{72mm}}
Prepared for: & Yool Lee, PhD \\\\
Institution: & Washington State University \\\\
& Elson S. Floyd College of Medicine \\\\
Generated: & 20 March 2026 \\\\
System: & CLASHD27 v2.0 \\\\
Hypotheses: & 7 cross-domain gaps \\\\
Min. Score: & 80/100 \\\\
\\end{tabular}
\\end{minipage}
\\hfill
\\begin{minipage}[t]{0.38\\linewidth}
\\centering
\\begin{tikzpicture}[scale=0.82, every node/.style={circle, minimum size=4.2mm, inner sep=0pt}]
  \\foreach \\x in {0,1,2} {
    \\foreach \\y in {0,1,2} {
      \\node[draw=navyblue, fill=navyblue!15] (a\\x\\y) at (\\x,\\y) {};
      \\node[draw=navyblue, fill=navyblue!15] (b\\x\\y) at (\\x+0.45,\\y+0.45) {};
      \\node[draw=navyblue, fill=navyblue!15] (c\\x\\y) at (\\x+0.9,\\y+0.9) {};
    }
  }
  \\foreach \\x in {0,1,2} {
    \\foreach \\y [evaluate=\\y as \\n using int(\\y+1)] in {0,1} {
      \\draw[navyblue!70] (a\\x\\y) -- (a\\x\\n);
      \\draw[navyblue!70] (b\\x\\y) -- (b\\x\\n);
      \\draw[navyblue!70] (c\\x\\y) -- (c\\x\\n);
      \\draw[navyblue!70] (a\\y\\x) -- (a\\n\\x);
      \\draw[navyblue!70] (b\\y\\x) -- (b\\n\\x);
      \\draw[navyblue!70] (c\\y\\x) -- (c\\n\\x);
    }
  }
  \\draw[clashred, very thick] (a00) -- (c22);
  \\draw[clashred, very thick] (a20) -- (c02);
  \\draw[clashred, very thick] (a01) -- (c21);
  \\draw[clashred, very thick] (b10) -- (c12);
\\end{tikzpicture}
\\end{minipage}

\\clearpage

\\section*{ABOUT THIS REPORT}
\\begin{multicols}{2}
This report was generated by CLASHD27, an autonomous research gap discovery system that classifies scientific literature into a 3$\\times$3$\\times$3 knowledge cube and detects high-value collisions between distant domains.

Each hypothesis in this report emerges from a collision between your published work on circadian biology and a domain outside your primary field. The system does not summarize what you already know --- it identifies what your research implies but has not yet tested.

\\columnbreak
\\begin{mdframed}[backgroundcolor=lightgray, linecolor=lightgray]
{\\color{navyblue}\\textbf{HOW GAPS ARE SCORED}}\\\\[2mm]
\\textbf{Novelty} --- Is this connection new?\\\\
\\textbf{Collision} --- How distant are the domains?\\\\
\\textbf{Residue} --- Does prior work support this?\\\\
\\textbf{Gravity} --- Is there emerging pressure here?\\\\
\\textbf{Evidence} --- How strong is the paper trail?\\\\
\\textbf{Entropy} --- How diverse are the sources?\\\\
\\textbf{Serendipity} --- How unexpected is the link?\\\\[3mm]
\\textbf{Threshold for publication: 80/100}
\\end{mdframed}
\\end{multicols}

\\clearpage

${sections}

\\clearpage
\\section*{METHODOLOGY NOTE}
Hypotheses in this report are generated by autonomous AI collision analysis. They represent statistically significant cross-domain overlaps in the scientific literature, not validated experimental results.

Each hypothesis is designed to be falsifiable. The cheapest validation path is an estimate based on standard research methodology in the relevant domain.

Expert validation is required before any hypothesis proceeds to experimental investigation.

\\section*{ABOUT CLASHD27}
CLASHD27 is an autonomous research gap discovery system built on a 3$\\times$3$\\times$3 knowledge cube architecture. It classifies papers by method, surprise level, and domain, then detects high-value collisions between distant cells. Each published gap is anchored in a Merkle tree for verification and integrity.

Built by Wiard Vasen --- \\href{mailto:wiard.vasen@gmail.com}{wiard.vasen@gmail.com}\\\\
\\href{https://clashd27.com}{clashd27.com} \\textbar{} \\href{https://openclashd.com}{openclashd.com}

\\end{document}
`;
}

const gaps = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const tex = buildTex(gaps);
fs.writeFileSync(TEX_PATH, tex, 'utf8');
console.log(`LaTeX gegenereerd: ${TEX_PATH}`);
console.log(`Gaps: ${gaps.length}`);
