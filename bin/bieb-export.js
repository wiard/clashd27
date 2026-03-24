#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

import { BeloofteLibrary } from '../src/bieb/belofte-library.js';
import { resolvePromiseLibraryLayout } from '../src/bieb/promise-paths.js';

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
