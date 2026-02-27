import fs from 'node:fs';
import path from 'node:path';

/**
 * Search upward from startDir for opensdd.json, stopping at filesystem root.
 * Returns the absolute path to opensdd.json, or null if not found.
 */
export function findManifestPath(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, 'opensdd.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readManifest(manifestPath) {
  const content = fs.readFileSync(manifestPath, 'utf-8');
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`opensdd.json is malformed JSON: ${err.message}`);
  }
}

export function writeManifest(manifestPath, data) {
  fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2) + '\n');
}

export function isConsumerOnly(manifest) {
  return !manifest.specsDir;
}

export function getSpecsDir(manifest) {
  return manifest.specsDir || 'opensdd';
}

export function getDepsDir(manifest) {
  return manifest.depsDir || '.opensdd.deps';
}
