function corridorToHashtag(corridor) {
  const raw = corridor || 'Cross-domain';
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned) return '#CrossDomain';
  return `#${cleaned}`;
}

function trimToLimit(text, limit) {
  if (text.length <= limit) return text;
  const trimmed = text.slice(0, limit - 1).trim();
  return `${trimmed}…`;
}

function pickSummary(gap) {
  return gap?.summary || gap?.hypothesis || gap?.claim || gap?.description || 'A new cross-domain gap has been identified.';
}

function pickProposal(gap) {
  return gap?.proposed_experiment || gap?.proposal || gap?.action_summary || 'Design a lightweight pilot study to test the connection.';
}

function generateXPost(gap) {
  const summary = pickSummary(gap);
  const proposal = pickProposal(gap);
  const corridorTag = corridorToHashtag(gap?.corridor);

  const hasRepo = Array.isArray(gap?.githubRepos) && gap.githubRepos.length > 0;
  let header;
  if (hasRepo) {
    const repo = gap.githubRepos[0]?.full_name || gap.githubRepos[0]?.repo || 'the repo';
    header = `New research gap detected in ${repo}:`;
  } else {
    header = 'AI research gap detected:';
  }

  const body = `${header}\n\n${summary}\n\nSuggested experiment:\n${proposal}\n\n${corridorTag}`;
  return trimToLimit(body, 260);
}

function generateThread(gap) {
  const tweets = [];
  const first = generateXPost(gap);
  tweets.push(first);

  const papers = Array.isArray(gap?.papers) ? gap.papers : [];
  if (papers.length > 0 && tweets.length < 5) {
    const paperList = papers
      .slice(0, 3)
      .map(p => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('; ');
    const text = trimToLimit(`Sources: ${paperList}`, 260);
    tweets.push(text);
  }

  const repos = Array.isArray(gap?.githubRepos) ? gap.githubRepos : [];
  if (repos.length > 1 && tweets.length < 5) {
    const repoList = repos
      .slice(0, 3)
      .map(r => r.full_name || r.repo || '')
      .filter(Boolean)
      .join(', ');
    const text = trimToLimit(`Related repos: ${repoList}`, 260);
    if (repoList) tweets.push(text);
  }

  return tweets.slice(0, 5);
}

module.exports = {
  generateXPost,
  generateThread
};
