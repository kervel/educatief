#!/usr/bin/env node
/**
 * Video filter for Markdown
 *
 * Finds ![alt](path.mp4) and ![alt](path.webm) references and replaces them
 * with <video> elements for reveal.js autoplay. Also writes a manifest of
 * referenced video files for the build script to copy.
 *
 * Usage: node video-filter.mjs <input.md> <output.md> [muted]
 *   muted: "true" (default) or "false"
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve, join } from 'path';

const [,, inputFile, outputFile, mutedArg] = process.argv;

if (!inputFile || !outputFile) {
  console.error('Usage: node video-filter.mjs <input.md> <output.md> [muted]');
  process.exit(1);
}

const muted = mutedArg !== 'false';
const mutedAttr = muted ? ' muted' : '';

const content = readFileSync(inputFile, 'utf-8');
const inputDir = dirname(resolve(inputFile));

// Match ![alt](path.mp4) or ![alt](path.webm) — standard Markdown image syntax
const videoRegex = /!\[([^\]]*)\]\(([^\)]+\.(mp4|webm))\)/gi;

const videos = [];

const result = content.replace(videoRegex, (match, alt, videoPath, ext) => {
  console.log(`Video: ${videoPath}`);
  videos.push(videoPath);
  return `<video data-autoplay${mutedAttr} src="${videoPath}"></video>`;
});

// Also scan inline <video src="..."> tags and add to manifest
const inlineVideoRegex = /<video\s[^>]*src="([^"]+\.(mp4|webm))"[^>]*>/gi;
const result2 = result.replace(inlineVideoRegex, (match, videoPath) => {
  if (!videos.includes(videoPath)) {
    console.log(`Video (inline): ${videoPath}`);
    videos.push(videoPath);
  }
  let tag = match;
  if (!tag.includes('data-autoplay')) {
    tag = tag.replace('<video ', '<video data-autoplay ');
  }
  if (muted && !tag.includes('muted')) {
    tag = tag.replace('<video ', '<video muted ');
  }
  return tag;
});

writeFileSync(outputFile, result2);

// Write manifest of video files for the build script to copy
const manifestPath = join(dirname(outputFile), '.video-manifest.json');
writeFileSync(manifestPath, JSON.stringify(videos, null, 2));

if (videos.length > 0) {
  console.log(`Processed ${videos.length} video reference(s)`);
} else {
  console.log('No video references found');
}
