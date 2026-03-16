#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { BeloofteLibrary } = require('../src/bieb/belofte-library');
const { resolvePromiseLibraryLayout } = require('../src/bieb/promise-paths');

const PROMISE_LAYOUT = resolvePromiseLibraryLayout();
const EXPORTS_DIR = PROMISE_LAYOUT.exportsDir;
const dateStamp = new Date().toISOString().slice(0, 10);

fs.mkdirSync(EXPORTS_DIR, { recursive: true });

const bieb = new BeloofteLibrary(PROMISE_LAYOUT);
const stats = bieb.stats();
const markdown = bieb.export('markdown');

const header = [
  '# Bieb vol Beloftes',
  '',
  '> "A library of what could be discovered next.',
  '> Built by reading gaps between domains.',
  '> AI observes. Humans decide."',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Total beloftes: ${stats.totalBeloftes}`,
  `Cross-domain: ${stats.crossDomainCount}`,
  '',
  '---',
  '',
].join('\n');

const outputPath = path.join(EXPORTS_DIR, `beloftes-${dateStamp}.md`);
fs.writeFileSync(outputPath, header + markdown);

console.log(outputPath);
