import fs from 'node:fs';
import path from 'node:path';
import { validateSpec } from '../lib/validation.js';

export async function validateCommand(specPath) {
  let targetDir;

  if (specPath) {
    targetDir = path.resolve(specPath);
  } else {
    targetDir = path.join(process.cwd(), 'opensdd');
  }

  if (!fs.existsSync(targetDir)) {
    if (!specPath) {
      console.error(
        'No spec directory found. Provide a path or run from a directory containing `opensdd/`.'
      );
    } else {
      console.error(`Error: Path does not exist: ${specPath}`);
    }
    process.exit(1);
  }

  if (!fs.statSync(targetDir).isDirectory()) {
    console.error(`Error: ${specPath} is not a directory.`);
    process.exit(1);
  }

  const result = validateSpec(targetDir);

  // Determine name and version for display
  let displayName = path.basename(targetDir);
  let displayVersion = '';

  if (result.manifest) {
    displayName = result.manifest.name || displayName;
    displayVersion = result.manifest.version ? ` v${result.manifest.version}` : '';
  }

  if (result.errors.length > 0) {
    console.log(`Validation failed for ${displayName}\n`);
  } else {
    console.log(`Validated ${displayName}${displayVersion}\n`);
  }

  // spec.md structure
  if (result.specErrors.length > 0) {
    console.log('  spec.md structure     error');
    for (const err of result.specErrors) {
      console.log(`    - ${err}`);
    }
  } else if (result.specWarnings.length > 0) {
    console.log(
      `  spec.md structure     ${result.specWarnings.length} warning${result.specWarnings.length > 1 ? 's' : ''}`
    );
    for (const w of result.specWarnings) {
      console.log(`    - ${w}`);
    }
  } else {
    console.log('  spec.md structure     ok');
  }

  // manifest.json
  if (result.manifestExists) {
    if (result.manifestErrors.length > 0) {
      console.log('  manifest.json         error');
      for (const err of result.manifestErrors) {
        console.log(`    - ${err}`);
      }
    } else {
      console.log('  manifest.json         ok');
    }
  }

  // deviations.md check
  if (result.hasDeviations) {
    console.log('  deviations.md         found (should not be in publishable spec)');
  } else {
    console.log('  no deviations.md      ok');
  }

  // Summary
  console.log('');
  if (result.errors.length > 0) {
    console.log(
      `${result.errors.length} error${result.errors.length > 1 ? 's' : ''}. Fix errors before publishing.`
    );
    process.exit(1);
  } else if (result.warnings.length > 0) {
    console.log('Valid with warnings. Review warnings before publishing.');
  } else {
    console.log('Valid. Ready for publishing to registry.');
  }
}
