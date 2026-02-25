import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_REGISTRY = 'https://github.com/deepagents-ai/opensdd';

export function resolveRegistry(options, manifest) {
  if (options?.registry) return options.registry;
  if (manifest?.registry) return manifest.registry;
  return DEFAULT_REGISTRY;
}

export function isLocalPath(source) {
  return !source.startsWith('http://') && !source.startsWith('https://');
}

export function isGitHubUrl(source) {
  return /github\.com/.test(source);
}

export function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

async function githubApiFetch(urlPath, owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${urlPath}`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'opensdd-cli',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function githubRawFetch(filePath, owner, repo) {
  const data = await githubApiFetch(filePath, owner, repo);
  if (!data) return null;
  if (data.content) {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  // For larger files, use download_url
  if (data.download_url) {
    const response = await fetch(data.download_url, {
      headers: { 'User-Agent': 'opensdd-cli' },
    });
    if (!response.ok) throw new Error(`Failed to download ${filePath}`);
    return response.text();
  }
  throw new Error(`Could not fetch content for ${filePath}`);
}

/**
 * List all specs available in the registry.
 * Returns an array of index.json objects.
 */
export async function listRegistrySpecs(registrySource) {
  if (isLocalPath(registrySource)) {
    const registryDir = path.join(registrySource, 'registry');
    if (!fs.existsSync(registryDir)) return [];
    const entries = fs.readdirSync(registryDir, { withFileTypes: true });
    const specs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const indexPath = path.join(registryDir, entry.name, 'index.json');
        if (fs.existsSync(indexPath)) {
          try {
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            specs.push(index);
          } catch {
            console.warn(`Warning: Malformed index.json for ${entry.name}, skipping.`);
          }
        }
      }
    }
    return specs;
  }

  // GitHub registry
  const { owner, repo } = parseGitHubUrl(registrySource);
  const contents = await githubApiFetch('registry', owner, repo);
  if (!contents || !Array.isArray(contents)) return [];

  const specs = [];
  for (const item of contents) {
    if (item.type === 'dir') {
      try {
        const indexContent = await githubRawFetch(`registry/${item.name}/index.json`, owner, repo);
        if (indexContent) {
          specs.push(JSON.parse(indexContent));
        }
      } catch {
        console.warn(`Warning: Could not read index.json for ${item.name}, skipping.`);
      }
    }
  }
  return specs;
}

/**
 * Fetch index.json for a specific spec from the registry.
 */
export async function fetchSpecIndex(registrySource, specName) {
  if (isLocalPath(registrySource)) {
    const indexPath = path.join(registrySource, 'registry', specName, 'index.json');
    if (!fs.existsSync(indexPath)) return null;
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  }

  const { owner, repo } = parseGitHubUrl(registrySource);
  const content = await githubRawFetch(`registry/${specName}/index.json`, owner, repo);
  if (!content) return null;
  return JSON.parse(content);
}

/**
 * Fetch manifest.json for a specific spec version from the registry.
 */
export async function fetchSpecManifest(registrySource, specName, version) {
  if (isLocalPath(registrySource)) {
    const manifestPath = path.join(registrySource, 'registry', specName, version, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }

  const { owner, repo } = parseGitHubUrl(registrySource);
  const content = await githubRawFetch(`registry/${specName}/${version}/manifest.json`, owner, repo);
  if (!content) return null;
  return JSON.parse(content);
}

/**
 * Fetch all files for a specific spec version from the registry.
 * Returns an object mapping filename -> content string.
 */
export async function fetchSpecFiles(registrySource, specName, version) {
  const files = {};

  if (isLocalPath(registrySource)) {
    const versionDir = path.join(registrySource, 'registry', specName, version);
    if (!fs.existsSync(versionDir)) return null;
    const entries = fs.readdirSync(versionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        files[entry.name] = fs.readFileSync(path.join(versionDir, entry.name), 'utf-8');
      }
    }
    return files;
  }

  // GitHub registry
  const { owner, repo } = parseGitHubUrl(registrySource);
  const contents = await githubApiFetch(`registry/${specName}/${version}`, owner, repo);
  if (!contents || !Array.isArray(contents)) return null;

  for (const item of contents) {
    if (item.type === 'file') {
      const content = await githubRawFetch(
        `registry/${specName}/${version}/${item.name}`,
        owner,
        repo
      );
      if (content !== null) {
        files[item.name] = content;
      }
    }
  }
  return files;
}
