#!/usr/bin/env node
/**
 * Mermaid filter for Markdown
 *
 * Finds ```mermaid code blocks and replaces them with rendered SVG images.
 * Similar to a pandoc filter but for plain markdown.
 *
 * Usage: node mermaid-filter.mjs input.md output.md
 * Dependencies: @mermaid-js/mermaid-cli (mmdc must be in PATH)
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';

const [,, inputFile, outputFile] = process.argv;

if (!inputFile || !outputFile) {
  console.error('Usage: node mermaid-filter.mjs <input.md> <output.md>');
  process.exit(1);
}

const outputDir = dirname(outputFile);
const assetsDir = join(outputDir, 'assets');

// Ensure assets directory exists
mkdirSync(assetsDir, { recursive: true });

const content = readFileSync(inputFile, 'utf-8');
const inputDir = dirname(resolve(inputFile));

// Match ```mermaid ... ``` blocks, optionally with size hint on first line
// Supports: ```mermaid h:400 or ```mermaid w:600 h:400
const mermaidBlockRegex = /```mermaid(?:[ \t]+([^\n]*))?\n([\s\S]*?)```/g;

// Default: no size constraint (let Marp auto-size)
const DEFAULT_SIZE = '';

// --- brand typography for rendered diagrams ------------------------------
// Two things are needed, and both only work at render time:
//
//   -c  mermaid's neutral theme sets a font-family of its own, so the family
//       has to come from themeVariables or the diagram keeps trebuchet.
//   -C  the family then has to resolve inside the SVG. A diagram is placed as
//       an img, which can neither use the page's @font-face nor fetch a font
//       by URL, so the face travels in the file — the same base64 block
//       kapernikov-ail.css carries for agent-illustrator, lifted from it so
//       there is one copy to regenerate (see embed-ail-fonts.sh).
const scriptDir = dirname(new URL(import.meta.url).pathname);
const AIL_CSS = join(scriptDir, 'kapernikov-ail.css');
const FONT_STACK = "'Avenir LT Std', 'Avenir', 'Segoe UI', Roboto, Arial, sans-serif";

function embeddedFontFaces() {
  if (!existsSync(AIL_CSS)) return '';
  const css = readFileSync(AIL_CSS, 'utf-8');
  // Everything up to the end of the generated block: the @font-face rules.
  const end = css.indexOf('\n}\n', css.lastIndexOf('@font-face'));
  const start = css.indexOf('@font-face');
  if (start === -1 || end === -1) return '';
  return css.slice(start, end + 3);
}

let outputContent = content;
let match;

while ((match = mermaidBlockRegex.exec(content)) !== null) {
  const sizeHint = match[1]?.trim() || DEFAULT_SIZE;
  let mermaidCode = match[2];
  const fullMatch = match[0];

  // Support file references: code block content starts with "file:"
  const fileRef = mermaidCode.trim().match(/^file:\s*(.+)$/m);
  if (fileRef) {
    const filePath = resolve(inputDir, fileRef[1].trim());
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }
    mermaidCode = readFileSync(filePath, 'utf-8');
  }

  // Generate deterministic filename based on content hash
  const hash = createHash('md5').update(mermaidCode).digest('hex').slice(0, 8);
  const svgFilename = `mermaid-${hash}.svg`;
  const svgPath = join(assetsDir, svgFilename);

  // Write mermaid code to temp file (mmdc doesn't support stdin properly)
  const tempFile = join(tmpdir(), `mermaid-${hash}.mmd`);

  // Support PUPPETEER_ARGS env var (e.g. "--no-sandbox --disable-setuid-sandbox")
  let puppeteerConfigFlag = '';
  let tempPuppeteerConfig = null;
  let tempMermaidConfig = null;
  let tempCssFile = null;

  try {
    writeFileSync(tempFile, mermaidCode);
    if (process.env.PUPPETEER_CONFIG_FILE) {
      puppeteerConfigFlag = `-p "${process.env.PUPPETEER_CONFIG_FILE}"`;
    } else if (process.env.PUPPETEER_ARGS) {
      tempPuppeteerConfig = join(tmpdir(), `puppeteer-config-${hash}.json`);
      writeFileSync(tempPuppeteerConfig, JSON.stringify({ args: process.env.PUPPETEER_ARGS.split(/\s+/) }));
      puppeteerConfigFlag = `-p "${tempPuppeteerConfig}"`;
    }
    tempMermaidConfig = join(tmpdir(), `mermaid-config-${hash}.json`);
    writeFileSync(tempMermaidConfig, JSON.stringify({
      themeVariables: { fontFamily: FONT_STACK },
    }));

    let cssFileFlag = '';
    const faces = embeddedFontFaces();
    if (faces) {
      tempCssFile = join(tmpdir(), `mermaid-fonts-${hash}.css`);
      writeFileSync(tempCssFile, faces);
      cssFileFlag = `-C "${tempCssFile}"`;
    }

    execSync(
      `mmdc -i "${tempFile}" -o "${svgPath}" -t neutral -b transparent ` +
      `-c "${tempMermaidConfig}" ${cssFileFlag} ${puppeteerConfigFlag}`,
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Replace the mermaid block with a centered image reference (with Marp size hint if provided)
    outputContent = outputContent.replace(fullMatch, `<div style="text-align:center">\n\n![${sizeHint}](./assets/${svgFilename})\n\n</div>`);
    console.error(`Rendered: ${svgFilename}${sizeHint ? ` (${sizeHint})` : ''}`);
  } catch (err) {
    console.error(`Failed to render mermaid block: ${err.message}`);
    // Leave original block in place on failure
  } finally {
    try { unlinkSync(tempFile); } catch {}
    if (tempPuppeteerConfig) { try { unlinkSync(tempPuppeteerConfig); } catch {} }
    if (tempMermaidConfig) { try { unlinkSync(tempMermaidConfig); } catch {} }
    if (tempCssFile) { try { unlinkSync(tempCssFile); } catch {} }
  }
}

writeFileSync(outputFile, outputContent);
console.error(`Wrote: ${outputFile}`);
