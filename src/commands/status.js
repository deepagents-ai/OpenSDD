import fs from 'node:fs';
import path from 'node:path';
import {
  findManifestPath,
  readManifest,
  getSpecsDir,
  getDepsDir,
} from '../lib/manifest.js';

export async function statusCommand() {
  const manifestPath = findManifestPath(process.cwd());
  if (!manifestPath) {
    console.log('OpenSDD not initialized. Run `opensdd init` to get started.');
    return;
  }

  const manifest = readManifest(manifestPath);
  const projectRoot = path.dirname(manifestPath);
  const specsDir = getSpecsDir(manifest);
  const depsDir = getDepsDir(manifest);

  let hasContent = false;

  // Authored spec
  if (manifest.publish) {
    hasContent = true;
    const pub = manifest.publish;
    console.log('Authored spec:\n');
    console.log(`  ${pub.name}  v${pub.version}  ${specsDir}/`);
    console.log('');
  }

  // Dependencies
  const deps = manifest.dependencies || {};
  const depKeys = Object.keys(deps);

  if (depKeys.length > 0) {
    hasContent = true;
    console.log('Installed dependencies:\n');

    for (const depName of depKeys) {
      const entry = deps[depName];
      const namePad = depName.padEnd(16);
      const version = `v${entry.version}`.padEnd(8);

      let status;
      if (entry.implementedVersion == null) {
        status = 'not implemented';
      } else if (entry.implementedVersion === entry.version) {
        status = `implemented v${entry.implementedVersion}`;
      } else {
        status = `stale (impl v${entry.implementedVersion})`;
      }

      // Check for deviations
      let deviationInfo = '';
      const deviationsPath = path.join(projectRoot, depsDir, depName, 'deviations.md');
      if (entry.hasDeviations || fs.existsSync(deviationsPath)) {
        if (fs.existsSync(deviationsPath)) {
          const content = fs.readFileSync(deviationsPath, 'utf-8');
          const deviationCount = (content.match(/^## /gm) || []).length;
          if (deviationCount > 0) {
            deviationInfo = `    ${deviationCount} deviation${deviationCount > 1 ? 's' : ''}`;
          }
        }
      }

      console.log(`  ${namePad}${version}${status}${deviationInfo}`);
    }
  }

  // Check for untracked spec directories
  const depsDirPath = path.join(projectRoot, depsDir);
  if (fs.existsSync(depsDirPath)) {
    const dirEntries = fs.readdirSync(depsDirPath, { withFileTypes: true });
    const untracked = dirEntries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !deps[e.name])
      .map((e) => e.name);

    if (untracked.length > 0) {
      console.log('\nWarning: Untracked spec directories:');
      for (const u of untracked) {
        console.log(`  ${depsDir}/${u}/`);
      }
    }
  }

  if (!hasContent) {
    console.log(
      'No specs found. Run `opensdd install <name>` to install a dependency or add a `publish` entry to opensdd.json.'
    );
  }
}
