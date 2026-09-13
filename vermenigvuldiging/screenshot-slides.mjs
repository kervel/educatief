#!/usr/bin/env node
/**
 * Screenshot each reveal.js slide using headless Chrome (no Playwright).
 *
 * Usage: node screenshot-slides.mjs [output-dir] [kiosk-output-dir]
 *
 * Requires: chromium binary on PATH or at $PUPPETEER_EXECUTABLE_PATH.
 * shell.nix provides both.
 *
 * Strategy: spawn chromium --headless --screenshot once per slide, jumping
 * to slide N via reveal.js's URL fragment `#/N`. virtual-time-budget gives
 * the page enough wall-clock to initialize reveal and the markdown plugin.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

const outputDir = resolve(process.argv[2] || '/tmp/kiosk-slides');
const kioskDir = resolve(process.argv[3] || 'kiosk-output');
mkdirSync(outputDir, { recursive: true });

const htmlPath = resolve(kioskDir, 'index.html');
if (!existsSync(htmlPath)) {
  console.error(`Not found: ${htmlPath}`);
  process.exit(1);
}

const chromium = process.env.PUPPETEER_EXECUTABLE_PATH || 'chromium';
const extraArgs = (process.env.PUPPETEER_ARGS || '').split(/\s+/).filter(Boolean);

// Count slides by parsing the source markdown — skip the frontmatter block.
function countSlides() {
  // Prefer the source slides.md next to the kiosk dir's parent
  const candidates = [
    resolve(dirname(kioskDir), 'slides.md'),
    resolve(kioskDir, '..', 'slides.md'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf-8').split('\n');
    let inFm = false, fmDone = false, count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === '---' && i === 0) { inFm = true; continue; }
      if (inFm && line === '---') { inFm = false; fmDone = true; count = 1; continue; }
      if (fmDone && line === '---') count++;
    }
    if (count > 0) return count;
  }
  console.error('Could not determine slide count; defaulting to 100.');
  return 100;
}

const total = countSlides();
console.log(`Total slides: ${total}`);

for (let i = 0; i < total; i++) {
  const num = String(i + 1).padStart(2, '0');
  const out = `${outputDir}/slide-${num}.png`;
  const url = `file://${htmlPath}#/${i}`;
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=1280,720`,
    `--virtual-time-budget=4000`,
    `--screenshot=${out}`,
    ...extraArgs,
    url,
  ];
  const result = spawnSync(chromium, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) {
    console.error(`Slide ${i + 1} failed: ${result.stderr?.toString()}`);
    continue;
  }
  console.log(`Captured slide ${i + 1}/${total}`);
}

console.log(`\nScreenshots saved to ${outputDir}/`);
