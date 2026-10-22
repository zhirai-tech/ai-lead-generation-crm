/**
 * Prompt loader.
 *
 * Prompts are server-side assets: they live as versioned markdown files under
 * `server/agents/prompts/` and are NEVER returned by an API or handed to the
 * browser. Each file starts with a small front matter block:
 *
 *   ---
 *   role: outreach_writer
 *   version: 1
 *   output: json
 *   ---
 *
 * `prompt_version` is recorded on every agent execution so a draft can always
 * be traced back to the exact prompt that produced it.
 */
import fs from 'node:fs';

const PROMPT_DIR = new URL('./prompts/', import.meta.url);
const cache = new Map();

function parseFrontMatter(text) {
  const source = text.replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return { meta: {}, body: source.trim() };
  const end = source.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: source.trim() };
  const block = source.slice(3, end).trim();
  const body = source.slice(end + 4).trim();
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index < 1) continue;
    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { meta, body };
}

/**
 * Load (and cache) one role prompt.
 * @returns {{role:string, version:number, promptVersion:string, output:string, system:string, file:string}}
 */
export function loadPrompt(role) {
  if (!role || typeof role !== 'string' || !/^[a-z_]+$/.test(role)) {
    throw new Error(`invalid agent role for prompt loading: ${role}`);
  }
  const cached = cache.get(role);
  if (cached) return cached;
  const relative = `server/agents/prompts/${role}.md`;
  let text;
  try {
    text = fs.readFileSync(new URL(`${role}.md`, PROMPT_DIR), 'utf8');
  } catch (error) {
    throw new Error(`prompt file missing for role "${role}" (${relative})`, { cause: error });
  }
  const { meta, body } = parseFrontMatter(text);
  const parsedVersion = Number.parseInt(meta.version, 10);
  const version = Number.isInteger(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1;
  const prompt = {
    role: meta.role || role,
    version,
    promptVersion: `${role}@${version}`,
    output: meta.output || 'json',
    system: body,
    file: relative,
  };
  cache.set(role, prompt);
  return prompt;
}

/** Load every prompt, used by tests to detect drift between files and roles. */
export function loadAllPrompts(roles) {
  return roles.map((role) => loadPrompt(role));
}

export default { loadPrompt, loadAllPrompts };
