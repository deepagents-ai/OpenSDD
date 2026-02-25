import { resolveRegistry, listRegistrySpecs } from '../lib/registry.js';

export async function listCommand(options) {
  const registrySource = resolveRegistry(options);

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
