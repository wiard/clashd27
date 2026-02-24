function trimToLimit(text, limit) {
  if (text.length <= limit) return text;
  const trimmed = text.slice(0, limit - 1).trim();
  return `${trimmed}…`;
}

function selectTemplate(templates, seed) {
  if (!templates.length) return { id: 'default', text: templates[0] || '' };
  const idx = seed ? (seed.charCodeAt(0) + seed.length) % templates.length : 0;
  return templates[idx];
}

function normalizeHandle(handle) {
  if (!handle) return null;
  const clean = handle.trim();
  if (!clean) return null;
  return clean.startsWith('@') ? clean : `@${clean}`;
}

function extractSummary(gap) {
  return gap?.claim || gap?.summary || gap?.hypothesis || 'A new research gap has been identified.';
}

function extractProposal(gap) {
  return gap?.proposal || gap?.suggested_experiment || gap?.proposed_experiment || 'Run a focused pilot to validate the missing link.';
}

function buildLink(gap) {
  const id = gap?.id || 'unknown';
  return `https://clashd27.com/gap/${id}`;
}

function buildText(gap, repoInfo, template) {
  const repo = repoInfo?.repo || 'a target repo';
  const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
  const summary = extractSummary(gap);
  const proposal = extractProposal(gap);
  const link = buildLink(gap);
  const tagLine = handle ? `${handle}` : '';

  return template
    .replace('{repo}', repo)
    .replace('{summary}', summary)
    .replace('{proposal}', proposal)
    .replace('{link}', link)
    .replace('{tag}', tagLine)
    .replace(/\s+\n/g, '\n')
    .trim();
}

const REPO_TEMPLATES = [
  { id: 'repo_a', text: 'New research gap detected in {repo}.

{summary}

Suggested experiment:
{proposal}

{link}
{tag}' },
  { id: 'repo_b', text: 'Gap spotted for {repo}.

{summary}

Next test:
{proposal}

{link}
{tag}' }
];

const PAPER_TEMPLATES = [
  { id: 'paper_a', text: 'AI research gap detected:

{summary}

Missing experiment:
{proposal}

{link}
{tag}' },
  { id: 'paper_b', text: 'Open gap:

{summary}

Proposed test:
{proposal}

{link}
{tag}' }
];

function generateDraft(gap, repoInfo) {
  const hasRepo = !!repoInfo && !!repoInfo.repo;
  const templates = hasRepo ? REPO_TEMPLATES : PAPER_TEMPLATES;
  const template = selectTemplate(templates, gap?.id || 'seed');
  let text = buildText(gap, repoInfo, template.text);
  text = trimToLimit(text, 280);
  return { text, template: template.id, char_count: text.length };
}

function splitIntoTweets(text, maxTweets) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= 280) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (para.length <= 280) {
      current = para;
      continue;
    }
    const sentences = para.split(/(?<=[.!?])\s+/);
    let sentenceBlock = '';
    for (const sentence of sentences) {
      const sentenceCandidate = sentenceBlock ? `${sentenceBlock} ${sentence}` : sentence;
      if (sentenceCandidate.length <= 280) {
        sentenceBlock = sentenceCandidate;
        continue;
      }
      if (sentenceBlock) {
        chunks.push(sentenceBlock.trim());
        sentenceBlock = '';
      }
      if (sentence.length <= 280) {
        sentenceBlock = sentence;
      } else {
        const truncated = trimToLimit(sentence, 280);
        chunks.push(truncated);
      }
    }
    if (sentenceBlock) {
      chunks.push(sentenceBlock.trim());
      sentenceBlock = '';
    }
  }

  if (current) chunks.push(current.trim());
  return chunks.slice(0, maxTweets);
}

function generateThread(gap, repoInfo) {
  const draft = generateDraft(gap, repoInfo);
  if (draft.char_count <= 280) {
    return { tweets: [draft.text], char_counts: [draft.char_count] };
  }
  const tweets = splitIntoTweets(draft.text, 5);
  const char_counts = tweets.map(t => t.length);
  return { tweets, char_counts };
}

module.exports = {
  generateDraft,
  generateThread
};
