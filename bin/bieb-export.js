#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BeloofteLibrary } = require('../src/bieb/belofte-library');

const ROOT_DIR = path.join(__dirname, '..');
const EXPORTS_DIR = path.join(ROOT_DIR, 'data', 'bieb', 'exports');
const dateStamp = new Date().toISOString().slice(0, 10);

fs.mkdirSync(EXPORTS_DIR, { recursive: true });

const bieb = new BeloofteLibrary();
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
