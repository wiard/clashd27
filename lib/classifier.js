/**
 * CLASHD-27 Paper Classifier — Anomaly Magnet
 *
 * Classifies papers along three axes:
 *   X-axis (Method DNA):    0=imaging/observation, 1=computational, 2=experimental
 *   Y-axis (Surprise Index): 0=confirmatory, 1=deviation, 2=anomalous
 *   Z-axis (Semantic Orbit): 0|1|2 via TF-IDF + k-means clustering
 *
 * All classification is keyword-based — NO LLM calls.
 */

const natural = require('natural');
const { kmeans } = require('ml-kmeans');

// ─────────────────────────────────────────────────────────────
// X-AXIS: Method DNA (0=imaging/observation, 1=computational, 2=experimental)
// ─────────────────────────────────────────────────────────────

const METHOD_KEYWORDS = {
  0: { // imaging / spectroscopy / observation
    fields: ['Medicine', 'Biology', 'Environmental Science', 'Psychology', 'Sociology'],
    terms: [
      'microscopy', 'imaging', 'mri', 'ct scan', 'pet scan', 'radiograph',
      'ultrasound', 'fluorescence', 'staining', 'biopsy', 'histology',
      'pathology', 'spectroscopy', 'crystallography', 'observation',
      'observational', 'survey', 'epidemiolog', 'cohort study', 'case-control',
      'longitudinal', 'cross-sectional', 'retrospective study', 'prospective study',
      'population-based', 'prevalence', 'incidence', 'surveillance',
      'x-ray', 'tomography', 'endoscopy', 'immunohistochemistry', 'ihc',
      'flow cytometry', 'electron microscopy', 'confocal', 'mass spectrometry'
    ]
  },
  1: { // computational / simulation / modeling
    fields: ['Computer Science', 'Mathematics', 'Physics'],
    terms: [
      'algorithm', 'computational', 'machine learning', 'deep learning',
      'neural network', 'bioinformatics', 'in silico', 'in-silico',
      'simulation', 'modeling', 'modelling', 'statistical model',
      'bayesian', 'regression analysis', 'classifier', 'natural language',
      'genomic analysis', 'transcriptomic', 'proteomic analysis',
      'sequencing analysis', 'pipeline', 'database', 'data mining',
      'network analysis', 'pathway analysis', 'gene expression analysis',
      'random forest', 'support vector', 'convolutional', 'recurrent',
      'transformer model', 'artificial intelligence', 'prediction model',
      'prognostic model', 'risk prediction', 'meta-analysis',
      'systematic review', 'genome-wide', 'gwas', 'single-cell rna'
    ]
  },
  2: { // experimental / wet-lab / intervention
    fields: ['Chemistry', 'Materials Science'],
    terms: [
      'experiment', 'in vivo', 'in-vivo', 'in vitro', 'in-vitro',
      'clinical trial', 'randomized', 'randomised', 'placebo',
      'intervention', 'knockout', 'crispr', 'cas9', 'gene editing',
      'assay', 'western blot', 'pcr', 'qpcr', 'rt-pcr',
      'transfection', 'cell culture', 'cell line', 'mouse model',
      'xenograft', 'dose-response', 'pharmacokinetic', 'pharmacodynamic',
      'synthesis', 'compound', 'inhibitor', 'agonist', 'antagonist',
      'ic50', 'ec50', 'cytotoxicity', 'apoptosis assay',
      'colony formation', 'wound healing assay', 'migration assay',
      'invasion assay', 'tumor model', 'orthotopic', 'subcutaneous',
      'elisa', 'immunoprecipitation', 'chip-seq', 'sirna', 'shrna',
      'overexpression', 'knockdown', 'mutagenesis', 'cloning'
    ]
  }
};

function classifyMethod(paper) {
  const abstract = (paper.abstract || '').toLowerCase();
  const fields = (paper.fieldsOfStudy || []).map(f => f.toLowerCase());
  const title = (paper.title || '').toLowerCase();
  const text = `${title} ${abstract}`;

  const scores = [0, 0, 0]; // [imaging, computational, experimental]

  for (const [bucket, config] of Object.entries(METHOD_KEYWORDS)) {
    const idx = parseInt(bucket);
    // fieldsOfStudy match: +3 each
    for (const f of config.fields) {
      if (fields.some(pf => pf.includes(f.toLowerCase()))) {
        scores[idx] += 3;
      }
    }
    // Abstract + title keyword match: +1 each
    for (const term of config.terms) {
      if (text.includes(term)) {
        scores[idx] += 1;
      }
    }
  }

  // OpenAlex concepts boost: +2 per matching concept (stronger signal than keywords)
  const concepts = (paper.concepts || []).map(c => typeof c === 'string' ? c.toLowerCase() : (c.display_name || '').toLowerCase());
  const conceptMap = {
    0: ['microscopy', 'imaging', 'spectroscopy', 'radiology', 'pathology', 'epidemiology', 'observation'],
    1: ['machine learning', 'artificial intelligence', 'bioinformatics', 'computational biology', 'algorithm', 'statistics', 'computer science'],
    2: ['clinical trial', 'pharmacology', 'cell biology', 'molecular biology', 'genetics', 'chemistry', 'experimental']
  };
  for (const [bucket, terms] of Object.entries(conceptMap)) {
    const idx = parseInt(bucket);
    for (const term of terms) {
      if (concepts.some(c => c.includes(term))) {
        scores[idx] += 2;
      }
    }
  }

  // OpenAlex primaryTopic boost: +4 (strongest signal)
  if (paper.primaryTopic) {
    const topicField = (paper.primaryTopic.field || '').toLowerCase();
    const topicSubfield = (paper.primaryTopic.subfield || '').toLowerCase();
    const topicStr = `${topicField} ${topicSubfield}`;
    if (/imaging|radiology|pathology|epidemiol|spectro|microscop|observ/.test(topicStr)) scores[0] += 4;
    if (/computer|comput|informatic|math|statistic|algorithm|artificial/.test(topicStr)) scores[1] += 4;
    if (/pharmacol|clinical|experiment|molecular|cell bio|genetics|chem/.test(topicStr)) scores[2] += 4;
  }

  // MeSH enrichment boost: +5 (gold standard, highest weight)
  if (paper.meshMethod && paper.meshMethod.method !== null && paper.meshMethod.confidence > 0.3) {
    scores[paper.meshMethod.method] += 5;
  }

  // Return bucket with highest score, default to 0 (observation) on tie
  const maxScore = Math.max(...scores);
  if (maxScore === 0) return 0; // no signals → default to observation
  return scores.indexOf(maxScore);
}

// ─────────────────────────────────────────────────────────────
// Y-AXIS: Surprise Index (0=confirmatory, 1=deviation, 2=anomalous)
// ─────────────────────────────────────────────────────────────

const ANOMALOUS_MARKERS = [
  'unexpectedly', 'unexpected', 'contrary to', 'surprisingly', 'surprising',
  'paradoxically', 'paradoxical', 'challenges the assumption',
  'contradicts', 'contradicted', 'failed to replicate', 'inconsistent with',
  'counterintuitive', 'counter-intuitive', 'overturns', 'unprecedented',
  'first report of', 'previously unknown', 'novel mechanism',
  'challenges the', 'defies', 'anomalous', 'anomaly',
  'contradict', 'disprove', 'refute', 'overturn'
];

const DEVIATION_MARKERS = [
  'additionally', 'incidental finding', 'serendipitously', 'serendipitous',
  'unanticipated', 'not previously reported', 'novel finding',
  'unexpected finding', 'unexpected observation', 'unexplained',
  'intriguing', 'noteworthy', 'remarkable', 'unconventional',
  'atypical', 'rare finding', 'unusual', 'divergent'
];

function classifySurprise(paper) {
  const abstract = (paper.abstract || '').toLowerCase();
  const title = (paper.title || '').toLowerCase();
  const text = `${title} ${abstract}`;

  let score = 0; // 0 = confirmatory, accumulate toward anomalous

  // Check anomalous markers (+3 each, cap at 2 matches for this bucket)
  let anomalyHits = 0;
  for (const marker of ANOMALOUS_MARKERS) {
    if (text.includes(marker)) {
      anomalyHits++;
      if (anomalyHits <= 2) score += 3;
    }
  }

  // Check deviation markers (+1 each)
  for (const marker of DEVIATION_MARKERS) {
    if (text.includes(marker)) {
      score += 1;
    }
  }

  // Citation burst: high citations for recent paper (+2)
  const currentYear = new Date().getFullYear();
  const age = currentYear - (paper.year || currentYear);
  if (paper.citationCount > 50 && age <= 2 && age >= 0) {
    score += 2;
  }

  // Influential citation ratio bonus (+1)
  if (paper.citationCount > 0 && paper.influentialCitationCount) {
    const ratio = paper.influentialCitationCount / paper.citationCount;
    if (ratio > 0.15) {
      score += 1;
    }
  }

  // ── Retraction signals (v2.0) ──

  // Paper is retracted (+3)
  if (paper.isRetracted) {
    score += 3;
  }

  // Paper cites retracted papers (+2)
  if (paper.citesRetracted && paper.citesRetracted.count > 0) {
    score += 2;
  }

  // Citation velocity spike (+2)
  if (paper.citationVelocity && paper.citationVelocity.spike) {
    score += 2;
  }

  // Map score to 0/1/2 (using spec thresholds: 0-2=confirmatory, 3-5=deviation, 6+=anomalous)
  if (score >= 6) return 2; // anomalous
  if (score >= 3) return 1; // deviation
  return 0; // confirmatory
}

// ─────────────────────────────────────────────────────────────
// Z-AXIS: Semantic Orbit (TF-IDF + k-means, k=3)
// ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'our', 'us', 'he', 'she', 'him', 'her', 'his', 'i', 'me', 'my',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very', 'also',
  'just', 'about', 'above', 'after', 'again', 'all', 'am', 'any', 'because',
  'before', 'between', 'both', 'each', 'few', 'further', 'here', 'how',
  'into', 'more', 'most', 'other', 'out', 'over', 'own', 'same', 'some',
  'such', 'through', 'under', 'until', 'up', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'you', 'your',
  // Common academic words to filter
  'study', 'studies', 'result', 'results', 'found', 'showed', 'show',
  'using', 'used', 'based', 'however', 'although', 'among', 'associated',
  'significant', 'significantly', 'compared', 'respectively', 'including',
  'included', 'total', 'group', 'groups', 'data', 'analysis', 'conclusion',
  'conclusions', 'method', 'methods', 'background', 'objective', 'objectives',
  'purpose', 'aim', 'aims', 'patients', 'patient'
]);

function clusterSemantic(papers) {
  const assignments = new Map();

  // Need at least 3 papers to cluster
  if (papers.length < 3) {
    papers.forEach((p, i) => assignments.set(p.paperId, i % 3));
    return assignments;
  }

  // Build TF-IDF matrix
  const tfidf = new natural.TfIdf();
  const tokenizer = new natural.WordTokenizer();
  const validPapers = [];

  for (const paper of papers) {
    const text = `${paper.title || ''} ${paper.abstract || ''}`.toLowerCase();
    const tokens = tokenizer.tokenize(text) || [];
    const filtered = tokens.filter(t => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
    if (filtered.length === 0) {
      // Paper with no usable text — assign later
      continue;
    }
    tfidf.addDocument(filtered.join(' '));
    validPapers.push(paper);
  }

  if (validPapers.length < 3) {
    papers.forEach((p, i) => assignments.set(p.paperId, i % 3));
    return assignments;
  }

  // Extract feature vectors: top N terms across all documents as feature dimensions
  const N_FEATURES = Math.min(100, validPapers.length * 2);
  const termScores = new Map();

  // Collect all terms and their total TF-IDF scores
  for (let docIdx = 0; docIdx < validPapers.length; docIdx++) {
    tfidf.listTerms(docIdx).slice(0, 50).forEach(item => {
      const current = termScores.get(item.term) || 0;
      termScores.set(item.term, current + item.tfidf);
    });
  }

  // Select top N features
  const featureTerms = [...termScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, N_FEATURES)
    .map(([term]) => term);

  if (featureTerms.length < 3) {
    papers.forEach((p, i) => assignments.set(p.paperId, i % 3));
    return assignments;
  }

  // Build vectors: each paper = vector of TF-IDF scores for the top N terms
  const vectors = [];
  for (let docIdx = 0; docIdx < validPapers.length; docIdx++) {
    const termMap = new Map();
    tfidf.listTerms(docIdx).forEach(item => {
      termMap.set(item.term, item.tfidf);
    });
    const vec = featureTerms.map(term => termMap.get(term) || 0);
    vectors.push(vec);
  }

  // Run k-means with k=3
  try {
    const result = kmeans(vectors, 3, {
      initialization: 'kmeans++',
      maxIterations: 100
    });

    // Map cluster assignments
    for (let i = 0; i < validPapers.length; i++) {
      assignments.set(validPapers[i].paperId, result.clusters[i]);
    }

    // Assign papers that had no usable text to the largest cluster
    const clusterCounts = [0, 0, 0];
    result.clusters.forEach(c => clusterCounts[c]++);
    const largestCluster = clusterCounts.indexOf(Math.max(...clusterCounts));
    for (const paper of papers) {
      if (!assignments.has(paper.paperId)) {
        assignments.set(paper.paperId, largestCluster);
      }
    }
  } catch (err) {
    console.error(`[CLASSIFIER] k-means failed: ${err.message} — falling back to round-robin`);
    papers.forEach((p, i) => assignments.set(p.paperId, i % 3));
  }

  return assignments;
}

// ─────────────────────────────────────────────────────────────
// Extract cluster labels from TF-IDF (top terms per cluster)
// ─────────────────────────────────────────────────────────────

function getClusterLabels(papers, assignments) {
  const clusterPapers = [[], [], []];
  for (const paper of papers) {
    const cluster = assignments.get(paper.paperId);
    if (cluster !== undefined) {
      clusterPapers[cluster].push(paper);
    }
  }

  const labels = [];
  for (let c = 0; c < 3; c++) {
    if (clusterPapers[c].length === 0) {
      labels.push(`cluster-${c}`);
      continue;
    }
    // Build mini TF-IDF for this cluster
    const clusterTfidf = new natural.TfIdf();
    const tokenizer = new natural.WordTokenizer();
    for (const p of clusterPapers[c]) {
      const text = `${p.title || ''} ${p.abstract || ''}`.toLowerCase();
      const tokens = (tokenizer.tokenize(text) || [])
        .filter(t => t.length > 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
      clusterTfidf.addDocument(tokens.join(' '));
    }
    // Get top terms across all docs in this cluster
    const termTotals = new Map();
    for (let d = 0; d < clusterPapers[c].length; d++) {
      clusterTfidf.listTerms(d).slice(0, 20).forEach(item => {
        termTotals.set(item.term, (termTotals.get(item.term) || 0) + item.tfidf);
      });
    }
    const topTerms = [...termTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([term]) => term);
    labels.push(topTerms.length > 0 ? topTerms.join('-') : `cluster-${c}`);
  }

  return labels;
}

// ─────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────

const METHOD_LABELS = ['imaging/observation', 'computational', 'experimental'];
const SURPRISE_LABELS = ['confirmatory', 'deviation', 'anomalous'];

function classifyAll(papers) {
  console.log(`[CLASSIFIER] Classifying ${papers.length} papers on 3 axes`);

  const methodClasses = papers.map(classifyMethod);
  const surpriseClasses = papers.map(classifySurprise);
  const semanticClusters = clusterSemantic(papers);
  const clusterLabels = getClusterLabels(papers, semanticClusters);

  // Log distribution stats
  const methodDist = [0, 0, 0];
  const surpriseDist = [0, 0, 0];
  const clusterDist = [0, 0, 0];

  const classified = papers.map((paper, i) => {
    const x = methodClasses[i];
    const y = surpriseClasses[i];
    const z = semanticClusters.get(paper.paperId) || 0;
    const cell = z * 9 + y * 3 + x;

    methodDist[x]++;
    surpriseDist[y]++;
    clusterDist[z]++;

    return {
      paper,
      x, y, z,
      cell,
      methodLabel: METHOD_LABELS[x],
      surpriseLabel: SURPRISE_LABELS[y],
      clusterLabel: clusterLabels[z] || `cluster-${z}`
    };
  });

  console.log(`[CLASSIFIER] Method DNA:     imaging=${methodDist[0]} computational=${methodDist[1]} experimental=${methodDist[2]}`);
  console.log(`[CLASSIFIER] Surprise Index:  confirmatory=${surpriseDist[0]} deviation=${surpriseDist[1]} anomalous=${surpriseDist[2]}`);
  console.log(`[CLASSIFIER] Semantic Orbit:  c0=${clusterDist[0]} c1=${clusterDist[1]} c2=${clusterDist[2]}`);

  return { classified, clusterLabels };
}

module.exports = {
  classifyMethod,
  classifySurprise,
  clusterSemantic,
  getClusterLabels,
  classifyAll,
  METHOD_LABELS,
  SURPRISE_LABELS,
  // Exposed for testing
  ANOMALOUS_MARKERS,
  DEVIATION_MARKERS,
  METHOD_KEYWORDS
};
