const assert = require('assert');
const { mapToCubeCell } = require('../lib/mapping-parity');

function run() {
  const fixtures = [
    {
      id: 'f1',
      input: {
        category: 'intent.fabric.tick',
        text: 'consent policy audit',
        source: 'knowledge_openalex',
        timestampIso: '2026-03-04T10:00:00.000Z',
        publishedAtIso: '2026-03-01T00:00:00.000Z'
      },
      expected: {
        cubeCell: ['trust-model', 'engine', 'current'],
        cellIndex: 15
      }
    },
    {
      id: 'f2',
      input: {
        category: 'intent.scan.competitors',
        text: 'kernel audit policy',
        source: 'competitors',
        timestampIso: '2026-03-04T10:00:00.000Z'
      },
      expected: {
        cubeCell: ['architecture', 'external', 'current'],
        cellIndex: 14
      }
    },
    {
      id: 'f3',
      input: {
        category: 'intent.navigate.room',
        text: 'api channel',
        source: 'internal',
        timestampIso: '2026-03-04T10:00:00.000Z'
      },
      expected: {
        cubeCell: ['surface', 'internal', 'current'],
        cellIndex: 10
      }
    },
    {
      id: 'f4',
      input: {
        category: 'knowledge.signal',
        text: 'audit gap anomaly',
        source: 'internal',
        timestampIso: '2026-03-04T10:00:00.000Z'
      },
      expected: {
        cubeCell: ['architecture', 'internal', 'emerging'],
        cellIndex: 20
      }
    },
    {
      id: 'f5',
      input: {
        category: 'intent.research.paper',
        text: 'study architecture',
        source: 'knowledge_openalex',
        timestampIso: '2026-03-04T10:00:00.000Z',
        publishedAtIso: '2025-01-01T00:00:00.000Z'
      },
      expected: {
        cubeCell: ['architecture', 'engine', 'historical'],
        cellIndex: 8
      }
    },
    {
      id: 'f6',
      input: {
        category: 'intent.fabric.tick',
        text: 'consent trust',
        source: 'openclaw-skills',
        timestampIso: '2026-03-04T10:00:00.000Z'
      },
      expected: {
        cubeCell: ['trust-model', 'external', 'current'],
        cellIndex: 12
      }
    }
  ];

  const mapped = fixtures.map((fixture) => {
    const actual = mapToCubeCell(fixture.input);
    assert.deepStrictEqual(
      actual,
      fixture.expected,
      `fixture ${fixture.id} mismatch: expected ${JSON.stringify(fixture.expected)} got ${JSON.stringify(actual)}`
    );
    return {
      id: fixture.id,
      cubeCell: actual.cubeCell,
      cellIndex: actual.cellIndex
    };
  });

  const stable = [...mapped].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepStrictEqual(
    stable.map((item) => item.id),
    fixtures.map((fixture) => fixture.id),
    'stable ordering by fixture id must match expected ordering'
  );

  console.log('[PASS] parity mapping fixtures match openclashd-v2 shadow spec');
  console.log('[PASS] stable ordering preserved');
  console.log('[DONE] parity test complete');
}

run();
