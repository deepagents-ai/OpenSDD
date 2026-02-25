import fs from 'node:fs';
import path from 'node:path';

/**
 * Validate a spec directory for conformance to the OpenSDD spec-format.
 * Returns an object with errors, warnings, and detailed results per file.
 */
export function validateSpec(specDir) {
  const result = {
    errors: [],
    warnings: [],
    specErrors: [],
    specWarnings: [],
    manifestErrors: [],
    manifestExists: false,
    hasDeviations: false,
    manifest: null,
  };

  // Check for spec.md
  const specMdPath = path.join(specDir, 'spec.md');
  if (!fs.existsSync(specMdPath)) {
    result.specErrors.push('Missing required file: spec.md');
    result.errors.push('Missing required file: spec.md');
  } else {
    const content = fs.readFileSync(specMdPath, 'utf-8');
    validateSpecMd(content, result);
  }

  // Check for manifest.json (optional, but validate if present)
  const manifestPath = path.join(specDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    result.manifestExists = true;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      result.manifest = manifest;
      validateManifest(manifest, result);
    } catch (err) {
      result.manifestErrors.push(`Malformed JSON: ${err.message}`);
      result.errors.push('manifest.json: Malformed JSON');
    }
  }

  // Check for deviations.md (specs for registry MUST NOT contain deviations)
  if (fs.existsSync(path.join(specDir, 'deviations.md'))) {
    result.hasDeviations = true;
    result.errors.push('deviations.md found (specs for the registry must not contain deviations)');
  }

  return result;
}

function validateSpecMd(content, result) {
  const lines = content.split('\n');

  // Check for H1 header — spec says "MUST start with an H1 header"
  // Find the first non-empty line
  const firstContentIndex = lines.findIndex((l) => l.trim().length > 0);
  const firstContentLine = firstContentIndex !== -1 ? lines[firstContentIndex] : '';

  if (!/^# .+/.test(firstContentLine)) {
    result.specErrors.push('Missing required: H1 header with blockquote summary');
    result.errors.push('spec.md: Missing H1 header with blockquote summary');
  } else {
    // Check for blockquote summary after H1
    let foundBlockquote = false;
    for (let i = firstContentIndex + 1; i < Math.min(firstContentIndex + 5, lines.length); i++) {
      if (lines[i].startsWith('> ')) {
        foundBlockquote = true;
        break;
      }
    }
    if (!foundBlockquote) {
      result.specErrors.push('Missing required: blockquote summary after H1 header');
      result.errors.push('spec.md: Missing blockquote summary after H1');
    }
  }

  // Check for Behavioral Contract section
  if (!content.includes('## Behavioral Contract')) {
    result.specErrors.push('Missing required: ## Behavioral Contract section');
    result.errors.push('spec.md: Missing Behavioral Contract section');
  }

  // SHOULD warnings for recommended sections
  if (!content.includes('## NOT Specified')) {
    result.specWarnings.push('Missing ## NOT Specified section (recommended)');
    result.warnings.push('spec.md: Missing NOT Specified section');
  }

  if (!content.includes('## Invariants')) {
    result.specWarnings.push('Missing ## Invariants section (recommended)');
    result.warnings.push('spec.md: Missing Invariants section');
  }

  if (!content.includes('## Edge Cases')) {
    result.specWarnings.push('Missing ## Edge Cases section (recommended)');
    result.warnings.push('spec.md: Missing Edge Cases section');
  }
}

function validateManifest(manifest, result) {
  if (!manifest.name) {
    result.manifestErrors.push('Missing required field: name');
    result.errors.push('manifest.json: Missing name');
  }

  if (!manifest.spec_format) {
    result.manifestErrors.push('Missing required field: spec_format');
    result.errors.push('manifest.json: Missing spec_format');
  }

  if (!manifest.version) {
    result.manifestErrors.push('Missing required field: version');
    result.errors.push('manifest.json: Missing version');
  } else if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
    result.manifestErrors.push(
      `Invalid version format: ${manifest.version} (must be valid semver)`
    );
    result.errors.push('manifest.json: Invalid version format');
  }
}
