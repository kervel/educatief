#!/usr/bin/env node

// Minimal static dev server for the kiosk build output.
//
// Usage: node dev-server.mjs --root <dir> [--port <n>]
//
// Serves <root> over HTTP. For index.html only, a small live-reload poller is
// injected before </body>. The injection happens in the response body, never on
// disk, so kiosk-output/index.html stays byte-identical to what CI ships.
//
// The poller watches <root>/.build-id, which build-kiosk.sh writes as the very
// last step of a build. Because the id only changes once the whole tree is in
// place, a reload can never land mid-rebuild.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

function parseArgs(argv) {
    const opts = { root: 'kiosk-output', port: 8000 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--root') opts.root = argv[++i];
        else if (arg === '--port') opts.port = Number(argv[++i]);
        else if (arg.startsWith('--root=')) opts.root = arg.slice('--root='.length);
        else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
        else {
            console.error(`dev-server: unknown argument: ${arg}`);
            process.exit(1);
        }
    }
    if (!opts.root || !Number.isInteger(opts.port) || opts.port <= 0) {
        console.error('dev-server: usage: dev-server.mjs --root <dir> [--port <n>]');
        process.exit(1);
    }
    return opts;
}

const { root: rootArg, port } = parseArgs(process.argv.slice(2));
const ROOT = resolve(rootArg);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

const RELOAD_SNIPPET = `
<script>
// Injected by dev-server.mjs -- not present in the built artifact.
// Poll the build id and reload when it changes. Errors and 404s are ignored so
// that the rm -rf window at the start of a rebuild is harmless. reveal.js runs
// with hash: true, so the reload lands back on the slide you were editing.
(function () {
  var current = null;
  setInterval(function () {
    fetch('/__buildid', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (body) {
        if (!body) return;
        var id = body.trim();
        if (!id) return;
        if (current === null) { current = id; return; }
        if (id !== current) location.reload();
      })
      .catch(function () {});
  }, 500);
})();
</script>
`;

function injectReload(html) {
    const idx = html.lastIndexOf('</body>');
    if (idx === -1) return html + RELOAD_SNIPPET;
    return html.slice(0, idx) + RELOAD_SNIPPET + html.slice(idx);
}

// Resolve a URL path to a file inside ROOT, or null if it escapes.
function resolvePath(urlPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return null;
    }
    if (decoded.endsWith('/')) decoded += 'index.html';
    const full = resolve(join(ROOT, normalize(decoded)));
    if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
    return full;
}

function send(res, status, body, type) {
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

const server = createServer(async (req, res) => {
    const urlPath = new URL(req.url, 'http://localhost').pathname;

    if (urlPath === '/__buildid') {
        try {
            const id = await readFile(join(ROOT, '.build-id'), 'utf-8');
            send(res, 200, id, 'text/plain; charset=utf-8');
        } catch {
            // Mid-rebuild, or a build that predates .build-id. The client
            // treats this as "no news" rather than a reload trigger.
            send(res, 404, 'no build id\n', 'text/plain; charset=utf-8');
        }
        return;
    }

    const filePath = resolvePath(urlPath);
    if (!filePath) {
        send(res, 403, 'Forbidden\n', 'text/plain; charset=utf-8');
        return;
    }

    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    try {
        const data = await readFile(filePath);
        if (ext === '.html') {
            send(res, 200, injectReload(data.toString('utf-8')), type);
        } else {
            send(res, 200, data, type);
        }
    } catch {
        send(res, 404, `Not found: ${urlPath}\n`, 'text/plain; charset=utf-8');
    }
});

server.listen(port, () => {
    console.log(`Dev server: http://localhost:${port}  (serving ${ROOT})`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`dev-server: port ${port} is already in use (try --port <n>)`);
    } else {
        console.error(`dev-server: ${err.message}`);
    }
    process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        server.close();
        process.exit(0);
    });
}
