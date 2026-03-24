#!/usr/bin/env node
'use strict';

const fs = require('fs');

const nightlyConfig = require('../config/nightly-reader.json');
const { loadDomains } = require('../src/domains/domain-config');
const { GapLibrary } = require('../src/library/gap-library');
const { resolveLibraryLayout } = require('../src/library/library-paths');

const libraryLayout = resolveLibraryLayout({ config: nightlyConfig.nightlyReader || {} });
const exportsDir = libraryLayout.exportsDir;
const dateStamp = new Date().toISOString().slice(0, 10);

fs.mkdirSync(exportsDir, { recursive: true });

const library = new GapLibrary();
const stats = library.stats();
const domains = loadDomains().map((domain) => domain.label);
const outputs = {
  json: library.export('json'),
  csv: library.export('csv'),
  markdown: library.export('markdown')
};

const markdownHeader = [
  '# CLASHD27 Gap Library',
  '',
  '> "A permanent library of what AI frameworks are missing.',
  '> Built by reading thousands of papers.',
  '> Governed by human approval."',
  '',
  '**Not Jarvis. Jeeves.**',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Domains: ${domains.join(', ')}`,
  `Total gaps: ${stats.totalGaps}`,
  '',
  '---',
  '',
].join('\n');

const jsonPath = `${exportsDir}/gap-library-${dateStamp}.json`;
const csvPath = `${exportsDir}/gap-library-${dateStamp}.csv`;
const mdPath = `${exportsDir}/gap-library-${dateStamp}.md`;

fs.writeFileSync(jsonPath, outputs.json);
fs.writeFileSync(csvPath, outputs.csv);
fs.writeFileSync(mdPath, markdownHeader + outputs.markdown);

console.log(jsonPath);
console.log(csvPath);
console.log(mdPath);
