import { findManifestPath, readManifest } from '../lib/manifest.js';
import { resolveRegistry, listRegistrySpecs } from '../lib/registry.js';

export async function listCommand(options) {
  // list doesn't require opensdd.json, but uses it for registry resolution if available
  let manifest = null;
  const manifestPath = findManifestPath(process.cwd());
  if (manifestPath) {
    try {
      manifest = readManifest(manifestPath);
    } catch {
      // ignore — list works without opensdd.json
    }
  }

  const registrySource = resolveRegistry(options, manifest);

  let specs;
  try {
    specs = await listRegistrySpecs(registrySource);
  } catch (err) {
    console.error(`Error: Could not reach registry at ${registrySource}`);
    console.error(err.message);
    process.exit(1);
  }

  if (specs.length === 0) {
    console.log('No specs available in the registry.');
    return;
  }

  console.log('Available specs:\n');

  for (const spec of specs) {
    const name = (spec.name || 'unknown').padEnd(17);
    const version = `v${spec.latest || '0.0.0'}`.padEnd(8);
    const desc = spec.description || '';
    console.log(`  ${name}${version}${desc}`);
  }
}
