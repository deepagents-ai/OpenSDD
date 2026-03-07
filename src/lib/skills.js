import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENSDD_SECTION_START = '<!-- OpenSDD Skills (managed by opensdd init \u2014 do not edit this section) -->';
const OPENSDD_SECTION_END = '<!-- /OpenSDD Skills -->';

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) return { frontmatter: {}, body: content };

  const yamlStr = content.substring(4, endIdx);
  const body = content.substring(endIdx + 5);

  const frontmatter = {};
  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^(\w+):\s*"([^"]*)"\s*$/) || line.match(/^(\w+):\s*(.*?)\s*$/);
    if (match) {
      frontmatter[match[1]] = match[2];
    }
  }
  return { frontmatter, body };
}

function getSkillContent() {
  const opensddDir = path.resolve(__dirname, '../../opensdd');
  const skillsDir = path.join(opensddDir, 'skills');
  return {
    sddManager: fs.readFileSync(path.join(skillsDir, 'sdd-manager.md'), 'utf-8'),
    sddGenerate: fs.readFileSync(path.join(skillsDir, 'sdd-generate.md'), 'utf-8'),
    specFormat: fs.readFileSync(path.join(opensddDir, 'spec-format.md'), 'utf-8'),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileSync(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

/**
 * Update a managed section in a file (GEMINI.md or AGENTS.md).
 * Creates the file if it doesn't exist.
 * Only modifies the clearly delimited OpenSDD section.
 */
function updateManagedSection(filePath, sectionBody) {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const sectionContent = `${OPENSDD_SECTION_START}\n${sectionBody}\n${OPENSDD_SECTION_END}`;

  const startIdx = content.indexOf(OPENSDD_SECTION_START);
  const endIdx = content.indexOf(OPENSDD_SECTION_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section
    content =
      content.substring(0, startIdx) +
      sectionContent +
      content.substring(endIdx + OPENSDD_SECTION_END.length);
  } else if (startIdx !== -1) {
    // Start marker exists but no end marker — replace from start to end
    content = content.substring(0, startIdx) + sectionContent;
  } else {
    // No existing section — append
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    if (content.length > 0) {
      content += '\n';
    }
    content += sectionContent + '\n';
  }

  fs.writeFileSync(filePath, content);
}

/**
 * Append a line to the managed section in a file (GEMINI.md or AGENTS.md).
 * Creates the file and section if they don't exist.
 * If the line is already present in the section, does nothing.
 */
function appendToManagedSection(filePath, line) {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const startIdx = content.indexOf(OPENSDD_SECTION_START);
  const endIdx = content.indexOf(OPENSDD_SECTION_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Section exists — check if line is already there
    const sectionBody = content.substring(startIdx + OPENSDD_SECTION_START.length, endIdx);
    if (sectionBody.includes(line)) return;

    // Insert the line before the end marker
    const before = content.substring(0, endIdx);
    const after = content.substring(endIdx);
    content = before + line + '\n' + after;
  } else {
    // No section — create one with the line
    const sectionContent = `${OPENSDD_SECTION_START}\n${line}\n${OPENSDD_SECTION_END}`;
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    if (content.length > 0) {
      content += '\n';
    }
    content += sectionContent + '\n';
  }

  fs.writeFileSync(filePath, content);
}

/**
 * Install both skills (sdd-manager and sdd-generate) into all 6 supported agent formats.
 * Returns an array of warnings for non-critical failures.
 * Throws on critical failures (e.g., Claude Code installation fails).
 */
/**
 * Generate a SKILL.md from spec.md content.
 * Extracts the H1 name and blockquote description, returns SKILL.md with frontmatter.
 */
export function generateSkillMd(specContent) {
  const h1Match = specContent.match(/^#\s+(.+)$/m);
  if (!h1Match) {
    throw new Error('spec.md must contain an H1 header (e.g., "# My Spec")');
  }

  const blockquoteMatch = specContent.match(/^>\s+(.+)$/m);
  if (!blockquoteMatch) {
    throw new Error('spec.md must contain a blockquote description (e.g., "> A short description.")');
  }

  const name = h1Match[1].trim();
  const description = blockquoteMatch[1].trim().replace(/"/g, '\\"');

  return `---\nname: ${name}\ndescription: "${description}"\n---\n${specContent}`;
}

/**
 * Install a dependency spec as an agent skill across all supported agent formats.
 * The skillMd is a SKILL.md string (with frontmatter). supplementaryFiles is an
 * object mapping filename -> content for additional .md reference files.
 */
export function installDependencySkill(projectRoot, name, skillMd, supplementaryFiles = {}) {
  const warnings = [];
  const { frontmatter, body } = parseFrontmatter(skillMd);

  // 1. Claude Code
  const claudeBase = path.join(projectRoot, '.claude', 'skills');
  writeFileSync(path.join(claudeBase, name, 'SKILL.md'), skillMd);
  for (const [fileName, content] of Object.entries(supplementaryFiles)) {
    writeFileSync(path.join(claudeBase, name, 'references', fileName), content);
  }

  // 2. Codex CLI
  try {
    const codexBase = path.join(projectRoot, '.agents', 'skills');
    writeFileSync(path.join(codexBase, name, 'SKILL.md'), skillMd);
    for (const [fileName, content] of Object.entries(supplementaryFiles)) {
      writeFileSync(path.join(codexBase, name, 'references', fileName), content);
    }
  } catch (err) {
    warnings.push(`Could not install Codex CLI skill for ${name}: ${err.message}`);
  }

  // 3. Cursor
  try {
    const cursorBase = path.join(projectRoot, '.cursor', 'rules');
    ensureDir(cursorBase);

    const cursorContent = `---\ndescription: "${frontmatter.description || ''}"\nalwaysApply: false\n---\n\n${body}`;
    writeFileSync(path.join(cursorBase, `${name}.md`), cursorContent);
  } catch (err) {
    warnings.push(`Could not install Cursor skill for ${name}: ${err.message}`);
  }

  // 4. GitHub Copilot
  try {
    const copilotBase = path.join(projectRoot, '.github', 'instructions');
    ensureDir(copilotBase);

    const copilotContent = `---\napplyTo: "**"\ndescription: "${frontmatter.description || ''}"\n---\n\n${body}`;
    writeFileSync(path.join(copilotBase, `${name}.instructions.md`), copilotContent);
  } catch (err) {
    warnings.push(`Could not install GitHub Copilot skill for ${name}: ${err.message}`);
  }

  // 5. Gemini CLI
  try {
    const geminiPath = path.join(projectRoot, 'GEMINI.md');
    const geminiRef = `@.claude/skills/${name}/SKILL.md`;
    appendToManagedSection(geminiPath, geminiRef);
  } catch (err) {
    warnings.push(`Could not install Gemini CLI skill for ${name}: ${err.message}`);
  }

  // 6. Amp
  try {
    const ampPath = path.join(projectRoot, 'AGENTS.md');
    const ampRef = `@.claude/skills/${name}/SKILL.md`;
    appendToManagedSection(ampPath, ampRef);
  } catch (err) {
    warnings.push(`Could not install Amp skill for ${name}: ${err.message}`);
  }

  return warnings;
}

export function installSkills(projectRoot, { mode = 'full' } = {}) {
  const skills = getSkillContent();
  const warnings = [];
  const isFull = mode === 'full';

  // 1. Claude Code (critical — Gemini and Amp depend on this)
  const claudeBase = path.join(projectRoot, '.claude', 'skills');
  writeFileSync(
    path.join(claudeBase, 'sdd-manager', 'SKILL.md'),
    skills.sddManager
  );
  writeFileSync(
    path.join(claudeBase, 'sdd-manager', 'references', 'spec-format.md'),
    skills.specFormat
  );
  if (isFull) {
    writeFileSync(
      path.join(claudeBase, 'sdd-generate', 'SKILL.md'),
      skills.sddGenerate
    );
    writeFileSync(
      path.join(claudeBase, 'sdd-generate', 'references', 'spec-format.md'),
      skills.specFormat
    );
  }

  // 2. Codex CLI
  try {
    const codexBase = path.join(projectRoot, '.agents', 'skills');
    writeFileSync(
      path.join(codexBase, 'sdd-manager', 'SKILL.md'),
      skills.sddManager
    );
    writeFileSync(
      path.join(codexBase, 'sdd-manager', 'references', 'spec-format.md'),
      skills.specFormat
    );
    if (isFull) {
      writeFileSync(
        path.join(codexBase, 'sdd-generate', 'SKILL.md'),
        skills.sddGenerate
      );
      writeFileSync(
        path.join(codexBase, 'sdd-generate', 'references', 'spec-format.md'),
        skills.specFormat
      );
    }
  } catch (err) {
    warnings.push(`Could not install Codex CLI skills: ${err.message}`);
  }

  // 3. Cursor
  try {
    const cursorBase = path.join(projectRoot, '.cursor', 'rules');
    ensureDir(cursorBase);

    const { frontmatter: managerFm, body: managerBody } = parseFrontmatter(skills.sddManager);

    const sddManagerCursor = `---
description: "${managerFm.description}"
alwaysApply: false
---

${managerBody}`;

    const specFormatCursor = `---
description: "OpenSDD spec format reference. Defines the structure and rules for behavioral specifications. Referenced by sdd-manager and sdd-generate skills."
alwaysApply: false
---

${skills.specFormat}`;

    writeFileSync(path.join(cursorBase, 'sdd-manager.md'), sddManagerCursor);
    writeFileSync(path.join(cursorBase, 'opensdd-spec-format.md'), specFormatCursor);

    if (isFull) {
      const { frontmatter: generateFm, body: generateBody } = parseFrontmatter(skills.sddGenerate);

      const sddGenerateCursor = `---
description: "${generateFm.description}"
alwaysApply: false
---

${generateBody}`;

      writeFileSync(path.join(cursorBase, 'sdd-generate.md'), sddGenerateCursor);
    }
  } catch (err) {
    warnings.push(`Could not install Cursor skills: ${err.message}`);
  }

  // 4. GitHub Copilot
  try {
    const copilotBase = path.join(projectRoot, '.github', 'instructions');
    ensureDir(copilotBase);

    const { frontmatter: managerFmCp, body: managerBodyCp } = parseFrontmatter(skills.sddManager);

    writeFileSync(
      path.join(copilotBase, 'sdd-manager.instructions.md'),
      `---\napplyTo: "**"\ndescription: "${managerFmCp.description}"\n---\n\n${managerBodyCp}`
    );
    writeFileSync(
      path.join(copilotBase, 'opensdd-spec-format.instructions.md'),
      `---\napplyTo: "**"\ndescription: "OpenSDD spec format reference. Defines the structure and rules for behavioral specifications. Referenced by sdd-manager and sdd-generate skills."\n---\n\n${skills.specFormat}`
    );

    if (isFull) {
      const { frontmatter: generateFmCp, body: generateBodyCp } = parseFrontmatter(skills.sddGenerate);

      writeFileSync(
        path.join(copilotBase, 'sdd-generate.instructions.md'),
        `---\napplyTo: "**"\ndescription: "${generateFmCp.description}"\n---\n\n${generateBodyCp}`
      );
    }
  } catch (err) {
    warnings.push(`Could not install GitHub Copilot skills: ${err.message}`);
  }

  // 5. Gemini CLI
  try {
    const geminiPath = path.join(projectRoot, 'GEMINI.md');
    let geminiBody = `@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md`;
    if (isFull) {
      geminiBody += `\n@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md`;
    }
    updateManagedSection(geminiPath, geminiBody);
  } catch (err) {
    warnings.push(`Could not install Gemini CLI skills: ${err.message}`);
  }

  // 6. Amp
  try {
    const ampPath = path.join(projectRoot, 'AGENTS.md');
    let ampBody = `@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md`;
    if (isFull) {
      ampBody += `\n@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md`;
    }
    updateManagedSection(ampPath, ampBody);
  } catch (err) {
    warnings.push(`Could not install Amp skills: ${err.message}`);
  }

  return warnings;
}
