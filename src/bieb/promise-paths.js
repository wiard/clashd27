import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.join(__dirname, '..', '..');
const DEFAULT_PROMISE_DIR = path.join(ROOT_DIR, 'data', 'promise-library');
const DEFAULT_GAP_LIBRARY_PATH = path.join(ROOT_DIR, 'data', 'gap-library.jsonl');
const LEGACY_BIEB_DIR = path.join(ROOT_DIR, 'data', 'bieb');

function resolvePromiseLibraryLayout(options = {}) {
  const envLatestCubeFile = process.env.CLASHD27_BIEB_LATEST_PATH;
  const latestCubeFile = options.latestCubeFile || envLatestCubeFile || path.join(DEFAULT_PROMISE_DIR, 'latest-cube.json');
  const rootDir = options.rootDir || path.dirname(latestCubeFile);
  return {
    rootDir,
    beloftesFile: options.beloftesFile || path.join(rootDir, 'beloftes.jsonl'),
    latestCubeFile,
    runsFile: options.runsFile || path.join(rootDir, 'runs.jsonl'),
    exportsDir: options.exportsDir || path.join(rootDir, 'exports'),
    legacyBeloftesFile: options.legacyBeloftesFile || path.join(LEGACY_BIEB_DIR, 'beloftes.jsonl')
  };
}

export {
  DEFAULT_GAP_LIBRARY_PATH,
  resolvePromiseLibraryLayout
};
