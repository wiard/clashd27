const fs = require('fs');
const path = require('path');

function loadClassifier() {
  try {
    return require('../src/properties/property-classifier.cjs');
  } catch (_error) {
    return require('../src/properties/property-classifier');
  }
}

const { classifyProperty } = loadClassifier();
const gapsDir = path.join(__dirname, '../data/gaps');
const files = fs.readdirSync(gapsDir)
  .filter((file) => file.endsWith('.json') && file !== 'index.json');

let count = 0;
files.forEach((file) => {
  const fp = path.join(gapsDir, file);
  try {
    const gap = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!gap.property) {
      const prop = classifyProperty({}, {
        citationCount: gap.scoring?.evidence || 0,
        yearsSincePublication: 0,
        domainCoverage: gap.domains || gap.cellLabels || [],
        collisionScore: gap.scoring?.collision || 0,
        hasGapStatement: true
      });
      gap.property = {
        name: prop.name,
        axis: prop.axis
      };
      fs.writeFileSync(fp, JSON.stringify(gap, null, 2));
      console.log(file, '→', prop.name);
      count += 1;
    }
  } catch (error) {
    console.warn('skip', file, error.message);
  }
});

console.log('Klaar —', count, 'gaps bijgewerkt');
