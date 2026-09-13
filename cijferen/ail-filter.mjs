#!/usr/bin/env node
/**
 * Agent Illustrator filter for Markdown.
 *
 * Finds ```ail code blocks and replaces them with rendered SVG images.
 *
 * Two modes:
 *   • Static (default) — block has no `keyframe` declarations; output is a
 *     centered <img> referencing the rendered SVG, sized via the alt-text
 *     hint (Marp-style "w:600 h:400").
 *   • Animated — block contains `keyframe "name" { ... }` declarations;
 *     output is the inline SVG plus one invisible reveal.js fragment per
 *     keyframe (skipping the first "idle" frame, which is the slide's
 *     initial state). A reveal.js handler in the page template flips the
 *     SVG's `frame-<name>` class as fragments come and go.
 *
 * Usage: node ail-filter.mjs input.md output.md
 *
 * Environment:
 *   AI_BIN  Path to the agent-illustrator binary. Default: `agent-illustrator`
 *           from PATH.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';

const [,, inputFile, outputFile] = process.argv;

if (!inputFile || !outputFile) {
  console.error('Usage: node ail-filter.mjs <input.md> <output.md>');
  process.exit(1);
}

const AI_BIN = process.env.AI_BIN || 'agent-illustrator';
const outputDir = dirname(outputFile);
const assetsDir = join(outputDir, 'assets');
mkdirSync(assetsDir, { recursive: true });

const content = readFileSync(inputFile, 'utf-8');
const inputDir = dirname(resolve(inputFile));

const ailBlockRegex = /```ail(?:[ \t]+([^\n]*))?\n([\s\S]*?)```/g;
const DEFAULT_SIZE = 'w:900';

const scriptDir = dirname(new URL(import.meta.url).pathname);
const stylesheetPath = join(scriptDir, 'kapernikov-ail.css');

function shellQuote(s) {
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function runAil(args, stdinCode) {
  const cmd = `${shellQuote(AI_BIN)} ${args.join(' ')}`;
  // maxBuffer must comfortably exceed the largest SVG we emit — base64-embedded
  // raster images push output well past execSync's 1 MB default (ENOBUFS).
  const opts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 };
  if (stdinCode !== undefined) opts.input = stdinCode;
  return execSync(cmd, opts);
}

function detectKeyframes(ailCode) {
  const re = /^\s*keyframe\s+"([^"]+)"/gm;
  const names = [];
  let m;
  while ((m = re.exec(ailCode)) !== null) names.push(m[1]);
  return names;
}

// Prefix every id the SVG declares, and every reference to one. Two diagrams
// on one deck both name their elements after the thing they draw ("diagram",
// "act"), so inlining them unprefixed puts duplicate ids in the document.
function namespaceSvgIds(svg, prefix) {
  const ids = new Set();
  for (const m of svg.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  let out = svg;
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\bid="${esc}"`, 'g'), `id="${prefix}-${id}"`);
    out = out.replace(new RegExp(`url\\(#${esc}\\)`, 'g'), `url(#${prefix}-${id})`);
    out = out.replace(new RegExp(`((?:xlink:)?href)="#${esc}"`, 'g'), `$1="#${prefix}-${id}"`);
  }
  return out;
}

// Used by the animated path, which has to be inline so reveal can flip
// classes on it. Static diagrams stay <img> — see the static branch below.
function inlineSvgFor(svgOutput, { id, className }) {
  let svg = svgOutput.replace(/^<\?xml[^?]*\?>\s*/, '');
  // Namespace BEFORE grafting the root id on: doing it the other way round
  // prefixes the id we just added too ("ail-x" -> "ail-x-ail-x"), and the
  // page's fragment handler then cannot find the SVG to flip frames on.
  svg = namespaceSvgIds(svg, id);
  svg = rewriteSvgRoot(svg, { id, className });
  // Markdown reads a blank line inside the SVG as a paragraph break, which
  // shatters the inline HTML — collapse them so the SVG is one block.
  return svg.replace(/^\s*$\n/gm, '');
}

function rewriteSvgRoot(svg, { id, className }) {
  // Add id and merge our class onto the <svg> root tag.
  return svg.replace(/<svg\b([^>]*)>/, (_, attrs) => {
    let out = attrs;
    if (id && !/\bid=/.test(out)) out = ` id="${id}"` + out;
    if (className) {
      if (/class="([^"]*)"/.test(out)) {
        out = out.replace(/class="([^"]*)"/, (_, c) => `class="${c} ${className}"`);
      } else {
        out = ` class="${className}"` + out;
      }
    }
    return `<svg${out}>`;
  });
}

let outputContent = content;
let match;

while ((match = ailBlockRegex.exec(content)) !== null) {
  const sizeHint = match[1]?.trim() || DEFAULT_SIZE;
  let ailCode = match[2];
  const fullMatch = match[0];

  const fileRef = ailCode.trim().match(/^file:\s*(.+)$/m);
  let ailFilePath = null;
  if (fileRef) {
    ailFilePath = resolve(inputDir, fileRef[1].trim());
    if (!existsSync(ailFilePath)) {
      console.error(`File not found: ${ailFilePath}`);
      continue;
    }
    ailCode = readFileSync(ailFilePath, 'utf-8');
  }

  const hash = createHash('md5').update(ailCode).digest('hex').slice(0, 8);
  const svgFilename = `ail-${hash}.svg`;
  const svgPath = join(assetsDir, svgFilename);
  const keyframes = detectKeyframes(ailCode);
  const animated = keyframes.length > 1;

  try {
    const baseArgs = [
      `--stylesheet-css ${shellQuote(stylesheetPath)}`,
      `--image-href base64`,
    ];
    const svgOutput = ailFilePath
      ? runAil([...baseArgs, shellQuote(ailFilePath)])
      : runAil(baseArgs, ailCode);
    writeFileSync(svgPath, svgOutput);

    let replacement;
    if (animated) {
      // Inline the SVG so reveal can poke at its class, grafting on an id +
      // ail-anim class for the fragment handler.
      const svgId = `ail-${hash}`;
      const inlineSvg = inlineSvgFor(svgOutput, { id: svgId, className: 'ail-anim' });

      // Apply size hint to the wrapping div: w:NNN / h:NNN
      const wMatch = sizeHint.match(/w:(\d+)/);
      const hMatch = sizeHint.match(/h:(\d+)/);
      const wrapStyle = [
        'text-align:center',
        wMatch ? `--ail-width:${wMatch[1]}px` : '',
        hMatch ? `--ail-height:${hMatch[1]}px` : '',
      ].filter(Boolean).join(';');

      // First keyframe is the idle / initial state — no fragment for it.
      // Explicit fragment indices: without them reveal numbers these triggers
      // after every other fragment on the slide that *does* carry an index,
      // so bullets meant to step in sync with the diagram fall out of step.
      const triggers = keyframes.slice(1).map((k, i) =>
        `<span class="fragment ail-trigger" data-fragment-index="${i}" data-ail-target="${svgId}" data-ail-frame="${k}"></span>`
      ).join('\n');

      replacement = [
        `<div class="ail-anim-wrap" style="${wrapStyle}">`,
        '',
        inlineSvg,
        '',
        triggers,
        '',
        '</div>',
      ].join('\n');

      console.error(`Rendered: ${svgFilename} (animated, ${keyframes.length} frames)`);
    } else {
      // Stays an <img>: the SVG carries a viewBox and no width/height, so the
      // markdown size hint is what scales it. Inlining instead makes it fall
      // back to the CSS default size, and the brand fonts do not need it —
      // kapernikov-ail.css embeds them, so they travel inside the file.
      replacement = `<div style="text-align:center">\n\n![${sizeHint}](./assets/${svgFilename})\n\n</div>`;
      console.error(`Rendered: ${svgFilename} (${sizeHint})`);
    }

    outputContent = outputContent.replace(fullMatch, replacement);
  } catch (err) {
    console.error(`Failed to render ail block: ${err.message}`);
  }
}

writeFileSync(outputFile, outputContent);
console.error(`Wrote: ${outputFile}`);
