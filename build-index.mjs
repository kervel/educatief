#!/usr/bin/env node
/**
 * Bouwt de overzichtspagina voor GitHub Pages.
 *
 * Elke map met een slides.md is één deck. De titel komt uit de YAML-frontmatter
 * van die slides.md (veld `title`, met `description` als optionele ondertitel);
 * ontbreekt die, dan valt hij terug op de mapnaam.
 *
 * Onder de decks staat een lijstje met werk dat elders leeft: pas ELDERS
 * hieronder aan om er een toe te voegen.
 *
 * Gebruik: node build-index.mjs <output-dir> <deck-map> [<deck-map> ...]
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const [, , outputDir, ...deckDirs] = process.argv;

if (!outputDir || deckDirs.length === 0) {
  console.error('Gebruik: node build-index.mjs <output-dir> <deck-map> [...]');
  process.exit(1);
}

function frontmatter(file) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  if (lines[0].trim() !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// Oefenmateriaal dat niet in deze repository staat.
const ELDERS = [
  {
    url: 'https://tafels.kervel.theworkpc.com/',
    title: 'Tafels oefenen',
    description: 'Losse oefensite voor de maaltafels.',
    source: 'https://github.com/kervel/tafels',
    sourceLabel: 'github.com/kervel/tafels',
  },
];

const escape = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const decks = deckDirs.map((dir) => {
  const fm = frontmatter(join(dir, 'slides.md'));
  return {
    path: dir,
    title: fm.title || dir,
    description: fm.description || '',
  };
}).sort((a, b) => a.title.localeCompare(b.title, 'nl'));

const cards = decks.map((d) => `      <li>
        <a href="${escape(d.path)}/">
          <span class="title">${escape(d.title)}</span>
          ${d.description ? `<span class="desc">${escape(d.description)}</span>` : ''}
        </a>
      </li>`).join('\n');

const elders = ELDERS.map((d) => `      <li>
        <a href="${escape(d.url)}">
          <span class="title">${escape(d.title)}</span>
          ${d.description ? `<span class="desc">${escape(d.description)}</span>` : ''}
        </a>
        <p class="src">broncode: <a href="${escape(d.source)}">${escape(d.sourceLabel || d.source)}</a></p>
      </li>`).join('\n');

const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Educatieve presentaties</title>
<style>
  :root {
    --accent: #1f6f8b;
    --accent-light: #dff1f6;
    --ink: #33404a;
    --muted: #6b7a86;
    --line: #dde4e8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 20px 80px;
    font: 16px/1.5 "Source Sans 3", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    background: #fff;
  }
  main { max-width: 640px; margin: 0 auto; }
  h1 {
    margin: 0 0 6px;
    font-size: 1.9rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  p.lead { margin: 0 0 32px; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; }
  li + li { margin-top: 10px; }
  a {
    display: block;
    padding: 16px 18px;
    border: 1px solid var(--line);
    border-radius: 8px;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  a:hover, a:focus-visible {
    border-color: var(--accent);
    background: var(--accent-light);
  }
  .title { display: block; font-weight: 600; color: var(--accent); }
  .desc { display: block; margin-top: 2px; font-size: 0.9rem; color: var(--muted); }
  h2 {
    margin: 40px 0 12px;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  .src { margin: 6px 0 0 18px; font-size: 0.82rem; color: var(--muted); }
  .src a {
    display: inline;
    padding: 0;
    border: 0;
    border-radius: 0;
    color: var(--accent);
    text-decoration: underline;
  }
  .src a:hover, .src a:focus-visible { background: none; }
  footer { max-width: 640px; margin: 48px auto 0; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
  <main>
    <h1>Educatieve presentaties</h1>
    <p class="lead">${decks.length} deck${decks.length === 1 ? '' : 's'} — klik om te openen, pijltjestoetsen om door de stappen te gaan.</p>
    <ul>
${cards}
    </ul>
${elders ? `    <h2>Elders</h2>\n    <ul>\n${elders}\n    </ul>` : ''}
  </main>
  <footer>Automatisch gebouwd uit de repository.</footer>
</body>
</html>
`;

writeFileSync(join(outputDir, 'index.html'), html);
console.log(`Overzicht met ${decks.length} deck(s): ${join(outputDir, 'index.html')}`);
