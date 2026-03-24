import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCES = ['semantic-scholar', 'openalex', 'arxiv', 'crossref'];

const DOMAIN_REGISTRY = [
  {
    id: 'cancer-research',
    label: 'Kankeronderzoek',
    keywords: [
      'circadian rhythm cancer',
      'pembrolizumab resistance colorectal cancer',
      'brain tumor deep learning MRI classification',
      'chronotherapy oncology immunotherapy',
      'circadian clock gene tumor expression',
      'cancer immunotherapy timing administration',
      'pembrolizumab colorectal cancer morning afternoon',
      'astrocytic tumor MRI heterogeneity',
      'GBM circadian clock disruption',
      'chronobiology cancer treatment outcome'
    ],
    cubeConfig: { focus: 'biology-medicine', depth: 'high' }
  },
  {
    id: 'ai-governance',
    label: 'AI Governance',
    keywords: ['AI governance', 'AI safety', 'model drift', 'consent architecture', 'AI audit'],
    cubeConfig: { focus: 'computer-science-law', depth: 'high' }
  },
  {
    id: 'finance-ai',
    label: 'Finance AI',
    keywords: ['algorithmic trading', 'credit scoring AI', 'financial AI risk', 'robo-advisor'],
    cubeConfig: { focus: 'finance-technology', depth: 'medium' }
  },
  {
    id: 'healthcare-ai',
    label: 'Healthcare AI',
    keywords: ['clinical AI', 'diagnostic AI', 'medical imaging AI', 'healthcare algorithm bias'],
    cubeConfig: { focus: 'medicine-technology', depth: 'high' }
  }
];

function cloneDomain(domain) {
  return {
    ...domain,
    keywords: (domain.keywords || []).slice(),
    cubeConfig: {
      ...(domain.cubeConfig || {})
    }
  };
}

function listDomains() {
  return DOMAIN_REGISTRY.map(cloneDomain);
}

function getDomainById(domainId) {
  return listDomains().find((domain) => domain.id === String(domainId || '').trim()) || null;
}

function toRunnerDomain(domainId) {
  const domain = typeof domainId === 'string' ? getDomainById(domainId) : cloneDomain(domainId || {});
  if (!domain || !domain.id) return null;

  return {
    id: domain.id,
    label: domain.label,
    keywords: domain.keywords.slice(),
    queries: domain.keywords.slice(),
    sources: DEFAULT_SOURCES.slice(),
    sourceWeight: 1,
    minScore: 0.4,
    cubeConfig: {
      ...(domain.cubeConfig || {})
    }
  };
}

export {
  DEFAULT_SOURCES,
  DOMAIN_REGISTRY,
  getDomainById,
  listDomains,
  toRunnerDomain
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({
    domains: listDomains()
  }, null, 2));
}
