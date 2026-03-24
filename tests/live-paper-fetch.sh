#!/bin/zsh
set -euo pipefail

OUT_DIR="/tmp/clashd27-live-paper-corpus"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/openalex" "$OUT_DIR/crossref" "$OUT_DIR/arxiv" "$OUT_DIR/semanticScholar"

fetch_to_file() {
  local url="$1"
  local file="$2"
  if curl -s --max-time 45 -H 'User-Agent: clashd27-live-load-test/1.0' -o "$file" "$url"; then
    echo "200" > "${file}.status"
  else
    echo "000" > "${file}.status"
  fi
}

openalex_queries=(
  "AI+governance"
  "AI+safety"
  "AI+verification"
  "multi-agent+systems"
  "software+architecture"
  "distributed+systems"
  "agent+memory"
  "autonomous+systems+oversight"
)

crossref_queries=(
  "AI+governance"
  "AI+safety+verification"
  "multi-agent+systems"
  "software+architecture"
)

arxiv_queries=(
  "AI+governance"
  "AI+safety"
  "large+language+model+alignment"
  "multi-agent+systems"
  "software+architecture"
  "autonomous+AI+oversight"
)

semantic_queries=(
  "AI+governance"
  "AI+safety+verification"
)

for query in "${openalex_queries[@]}"; do
  for page in 1 2; do
    file="$OUT_DIR/openalex/${query}-page${page}.json"
    url="https://api.openalex.org/works?search=${query}&page=${page}&per-page=200&sort=cited_by_count:desc"
    fetch_to_file "$url" "$file"
  done
done

for query in "${crossref_queries[@]}"; do
  for offset in 0 100; do
    file="$OUT_DIR/crossref/${query}-offset${offset}.json"
    url="https://api.crossref.org/works?query=${query}&rows=100&offset=${offset}&sort=is-referenced-by-count&order=desc"
    fetch_to_file "$url" "$file"
  done
done

for query in "${arxiv_queries[@]}"; do
  file="$OUT_DIR/arxiv/${query}.xml"
  url="https://export.arxiv.org/api/query?search_query=all:${query}&start=0&max_results=120&sortBy=submittedDate&sortOrder=descending"
  fetch_to_file "$url" "$file"
done

for query in "${semantic_queries[@]}"; do
  file="$OUT_DIR/semanticScholar/${query}.json"
  url="https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&limit=20&fields=title,abstract,year,authors,venue,paperId,citationCount,referenceCount,url"
  fetch_to_file "$url" "$file"
done

echo "$OUT_DIR"
