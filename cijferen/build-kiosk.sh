#!/usr/bin/env bash

# Build kiosk HTML presentation from Markdown using reveal.js
# Usage: ./build-kiosk.sh [--watch] [--serve] [--port N] [input.md] [output-dir]
#
# Dependencies provided by shell.nix (chromium, nodejs, mermaid-cli, fonts)
# Works both in template repo (filters in ../) and when scaffolded (filters local)
#
# Arguments:
#   input.md   - Input markdown file (default: slides.md)
#   output-dir - Output directory (default: kiosk-output)
#
# Flags:
#   --watch    - Rebuild whenever the markdown or diagram/asset/video sources change
#   --serve    - Serve the output over HTTP with live reload (default port 8000)
#   --port N   - Port for --serve
#   --stop     - Stop the watcher/server started for this deck and exit
#   --pdf [f]  - Build, then print one page per slide to f (default: <input>.pdf)

set -e

# Save the original working directory and convert input paths to absolute
ORIG_DIR="$(pwd)"

# Parse flags. --port takes a value, so track when the next arg is consumed.
WATCH=false
SERVE=false
STOP=false
PDF=false
PDF_FILE=""
PORT=8000
expect_port=false
expect_pdf=false
args=()
for arg in "$@"; do
    if [[ "$expect_port" == "true" ]]; then
        PORT="$arg"
        expect_port=false
    elif [[ "$expect_pdf" == "true" ]]; then
        # --pdf takes an OPTIONAL filename, so a following flag or the input
        # file must not be swallowed: only a .pdf argument counts as its value.
        expect_pdf=false
        if [[ "$arg" == *.pdf ]]; then
            PDF_FILE="$arg"
        else
            args+=("$arg")
        fi
    elif [[ "$arg" == "--pdf" ]]; then
        PDF=true
        expect_pdf=true
    elif [[ "$arg" == --pdf=* ]]; then
        PDF=true
        PDF_FILE="${arg#--pdf=}"
    elif [[ "$arg" == "--watch" ]]; then
        WATCH=true
    elif [[ "$arg" == "--serve" ]]; then
        SERVE=true
    elif [[ "$arg" == "--stop" ]]; then
        STOP=true
    elif [[ "$arg" == "--port" ]]; then
        expect_port=true
    elif [[ "$arg" == --port=* ]]; then
        PORT="${arg#--port=}"
    else
        args+=("$arg")
    fi
done
if [[ "$expect_port" == "true" ]]; then
    echo "Error: --port requires a value" >&2
    exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
    echo "Error: --port must be a number, got: $PORT" >&2
    exit 1
fi
set -- "${args[@]}"

INPUT_FILE="${1:-slides.md}"
OUTPUT_DIR="${2:-kiosk-output}"

# Convert to absolute paths before changing directory
[[ "$INPUT_FILE" != /* ]] && INPUT_FILE="$ORIG_DIR/$INPUT_FILE"
[[ "$OUTPUT_DIR" != /* ]] && OUTPUT_DIR="$ORIG_DIR/$OUTPUT_DIR"

if [[ "$PDF" == "true" ]]; then
    [[ -z "$PDF_FILE" ]] && PDF_FILE="${INPUT_FILE%.*}.pdf"
    [[ "$PDF_FILE" != /* ]] && PDF_FILE="$ORIG_DIR/$PDF_FILE"
    # Printing is a one-shot job; a watcher would keep the script alive after
    # the PDF is written.
    WATCH=false
    SERVE=false
fi

# --- long-running process bookkeeping -----------------------------------
# A --watch/--serve run spawns a tree (nix-shell → build script → inotifywait
# + dev server) whose leaves survive a kill of the root: an orphaned
# inotifywait keeps firing builds, and two builds racing in one output
# directory interleave `rm -rf` with `cp -r` and serve a broken deck. So
# record every root PID and offer --stop to take the whole tree down.
PIDFILE="$(dirname "$INPUT_FILE")/.kiosk-dev.pid"

# Only ever signal processes that are recognisably part of a deck build: a
# recorded PID can have been recycled by the OS since it was written.
kiosk_owned() {
    local pid="$1" cmd
    # -r first: a pid that died between listing and here would otherwise make
    # bash itself complain about the redirect, which no redirect can silence.
    [[ -r "/proc/$pid/cmdline" ]] || return 1
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 1
    # `kiosk-build` is the marker argv the inner build script is run with: its
    # command line is otherwise just `bash /tmp/tmp.XXXX.sh`, which matches
    # nothing recognisable, and an unkillable inner script keeps a watcher
    # alive after everything around it is gone.
    [[ "$cmd" == *build-kiosk* || "$cmd" == *dev-server.mjs* \
       || "$cmd" == *inotifywait* || "$cmd" == *nix-shell* \
       || "$cmd" == *kiosk-build* ]]
}

# Children first, so a parent cannot spawn a replacement while we work.
kiosk_descendants() {
    local pid="$1" kid
    for kid in $(pgrep -P "$pid" 2>/dev/null || true); do
        kiosk_descendants "$kid"
        echo "$kid"
    done
}

kiosk_stop() {
    if [[ ! -f "$PIDFILE" ]]; then
        echo "Nothing recorded in $PIDFILE — nothing to stop."
        return 0
    fi
    local roots=() targets=() pid killed=0
    mapfile -t roots < "$PIDFILE"
    for pid in "${roots[@]}"; do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        mapfile -t -O "${#targets[@]}" targets < <(kiosk_descendants "$pid")
        targets+=("$pid")
    done
    for pid in "${targets[@]}"; do
        if kiosk_owned "$pid"; then
            kill -TERM "$pid" 2>/dev/null && killed=$((killed + 1))
        fi
    done
    if (( killed > 0 )); then
        sleep 1
        for pid in "${targets[@]}"; do
            kiosk_owned "$pid" && kill -KILL "$pid" 2>/dev/null || true
        done
    fi
    rm -f "$PIDFILE"
    echo "Stopped $killed process(es) for $(basename "$INPUT_FILE")."
}

if [[ "$STOP" == "true" ]]; then
    kiosk_stop
    exit 0
fi

# Two watchers on one deck is the failure above, so refuse rather than race.
if [[ "$WATCH" == "true" || "$SERVE" == "true" ]] && [[ -f "$PIDFILE" ]]; then
    while read -r pid; do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        if kiosk_owned "$pid"; then
            echo "Error: a watcher/server for this deck is already running (pid $pid)." >&2
            echo "Stop it first:  $0 --stop" >&2
            exit 1
        fi
    done < "$PIDFILE"
    rm -f "$PIDFILE"   # every recorded pid is gone: stale file
fi

if [[ "$WATCH" == "true" || "$SERVE" == "true" ]]; then
    echo "$$" > "$PIDFILE"
fi

# Change to script directory for filter access
cd "$(dirname "$0")"

# Detect if we're in repo (filters in parent) or scaffolded (filters local)
if [[ -f "./kiosk-theme.css" ]]; then
    export PREFIX="$(pwd)"
else
    export PREFIX="$(cd .. && pwd)"
fi

# Export variables for nix-shell
export INPUT_FILE OUTPUT_DIR ORIG_DIR PREFIX WATCH SERVE PORT PIDFILE PDF PDF_FILE

NIX_SHELL_ARGS=(--extra-experimental-features "nix-command flakes" "$PREFIX/shell.nix"
    --keep PREFIX --keep INPUT_FILE --keep OUTPUT_DIR --keep ORIG_DIR --keep KEEP_MERMAID_ASSETS --keep WATCH
    --keep SERVE --keep PORT --keep AI_BIN --keep PIDFILE --keep PDF --keep PDF_FILE)

# Use a separate script file to avoid quoting issues in nix-shell --run
BUILD_SCRIPT=$(mktemp --suffix=.sh)
trap "rm -f $BUILD_SCRIPT" EXIT

cat > "$BUILD_SCRIPT" << 'BUILDEOF'
set -e

# Record this shell too: it is the parent of inotifywait and the dev server,
# so --stop needs it to find them (see the pidfile comment in the outer script).
if [[ -n "${PIDFILE:-}" && ( "$WATCH" == "true" || "$SERVE" == "true" ) ]]; then
  echo "$$" >> "$PIDFILE"
fi

# CI/container detection: if running as root, Chrome needs --no-sandbox
if [[ "$(id -u)" == "0" ]]; then
  echo "Running as root - setting up Chrome wrapper with --no-sandbox"
  CHROMIUM_BIN=$(which chromium)
  CHROME_WRAPPER=$(mktemp)
  cat > "$CHROME_WRAPPER" << WRAPPEREOF
#!/bin/sh
exec "$CHROMIUM_BIN" --no-sandbox --disable-setuid-sandbox --disable-gpu "\$@"
WRAPPEREOF
  chmod +x "$CHROME_WRAPPER"
  export PUPPETEER_EXECUTABLE_PATH="$CHROME_WRAPPER"
  export CHROME_PATH="$CHROME_WRAPPER"
  PUPPETEER_CONFIG=$(mktemp --suffix=.json)
  echo '{"args": ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]}' > "$PUPPETEER_CONFIG"
  export PUPPETEER_CONFIG_FILE="$PUPPETEER_CONFIG"
  trap "rm -f $CHROME_WRAPPER $PUPPETEER_CONFIG" EXIT
fi

# Install reveal.js if not already present
if [[ ! -d "$PREFIX/node_modules/reveal.js" ]]; then
  echo "Installing reveal.js..."
  npm install --prefix "$PREFIX" reveal.js
fi

# Temp files for preprocessing. Named per-process: two builds in the same
# directory (an editor's save racing the watcher, or two watchers) otherwise
# share these paths, and each one's EXIT trap deletes the other's work —
# "mv: cannot stat '.kiosk-processed2.md'" mid-build, then a half-written deck.
TEMP_MD=".kiosk-processed.$$.md"
TEMP_MD2=".kiosk-processed2.$$.md"
# Fixed name: video-filter.mjs writes it next to its output file.
VIDEO_MANIFEST=".video-manifest.json"

# A function rather than an inline trap string: the dev server's PID is only
# known later, and bash allows a single EXIT trap.
DEV_SERVER_PID=""
cleanup() {
  rm -f "$TEMP_MD" "$TEMP_MD2" "$VIDEO_MANIFEST" \
        ${CHROME_WRAPPER:+"$CHROME_WRAPPER"} ${PUPPETEER_CONFIG:+"$PUPPETEER_CONFIG"}
  if [[ -n "$DEV_SERVER_PID" ]]; then
    kill "$DEV_SERVER_PID" 2>/dev/null || true
  fi
  # A Ctrl+C leaves no watcher behind, so the pidfile must not outlive us:
  # a stale one makes the next --watch refuse to start.
  if [[ -n "${PIDFILE:-}" && ( "$WATCH" == "true" || "$SERVE" == "true" ) ]]; then
    rm -f "$PIDFILE"
  fi
}
trap cleanup EXIT

# Validate input file exists
if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Error: Input file not found: $INPUT_FILE" >&2
  exit 1
fi

# Build font cache (required in CI where cache doesn't exist)
echo "Building font cache..."
fc-cache -f

# Parse YAML frontmatter and extract kiosk settings
parse_frontmatter() {
  local file="$1"
  # Extract lines between first and second --- markers
  awk 'NR==1 && /^---$/{found=1; next} found && /^---$/{exit} found{print}' "$file"
}

get_fm_value() {
  local frontmatter="$1"
  local key="$2"
  local default="$3"
  local value
  value=$(echo "$frontmatter" | grep "^${key}:" | sed "s/^${key}:[[:space:]]*//" | tr -d '"')
  echo "${value:-$default}"
}

strip_frontmatter() {
  local file="$1"
  # Skip the first two --- markers (frontmatter), keep all subsequent --- (slide separators)
  awk 'BEGIN{count=0} /^---$/{count++; if(count<=2) next} count>=2{print}' "$file"
}

build() {
    echo ""
    echo "=== Building kiosk presentation ==="

    # Parse frontmatter
    local frontmatter
    frontmatter=$(parse_frontmatter "$INPUT_FILE")
    local autoslide loop muted transition title
    autoslide=$(get_fm_value "$frontmatter" "autoslide" "8000")
    loop=$(get_fm_value "$frontmatter" "loop" "true")
    muted=$(get_fm_value "$frontmatter" "muted" "true")
    transition=$(get_fm_value "$frontmatter" "transition" "fade")
    title=$(get_fm_value "$frontmatter" "title" "Kiosk Presentation")

    # Strip frontmatter and save to temp file
    strip_frontmatter "$INPUT_FILE" > "$TEMP_MD"

    # Preprocess mermaid diagrams
    echo "Preprocessing mermaid diagrams..."
    node "$PREFIX/mermaid-filter.mjs" "$TEMP_MD" "$TEMP_MD2"
    mv "$TEMP_MD2" "$TEMP_MD"

    # Preprocess agent-illustrator diagrams
    echo "Preprocessing agent-illustrator diagrams..."
    node "$PREFIX/ail-filter.mjs" "$TEMP_MD" "$TEMP_MD2"
    mv "$TEMP_MD2" "$TEMP_MD"

    # Preprocess video references
    echo "Preprocessing video references..."
    node "$PREFIX/video-filter.mjs" "$TEMP_MD" "$TEMP_MD2" "$muted"
    mv "$TEMP_MD2" "$TEMP_MD"

    # Create output directory structure
    rm -rf "$OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"

    # Copy reveal.js core files
    echo "Bundling reveal.js..."
    # -T: treat the destination as the directory itself. Plain `cp -r` copies
    # INTO an existing dist/, giving kiosk-output/dist/dist and a 404 on
    # dist/reveal.js — the deck then renders as raw markdown in a textarea.
    cp -rT "$PREFIX/node_modules/reveal.js/dist" "$OUTPUT_DIR/dist"
    mkdir -p "$OUTPUT_DIR/plugin/markdown"
    cp "$PREFIX/node_modules/reveal.js/plugin/markdown/markdown.js" "$OUTPUT_DIR/plugin/markdown/"
    mkdir -p "$OUTPUT_DIR/plugin/highlight"
    cp "$PREFIX/node_modules/reveal.js/plugin/highlight/highlight.js" "$OUTPUT_DIR/plugin/highlight/"
    mkdir -p "$OUTPUT_DIR/plugin/notes"
    cp "$PREFIX/node_modules/reveal.js/plugin/notes/notes.js" "$OUTPUT_DIR/plugin/notes/"
    cp "$PREFIX/node_modules/reveal.js/plugin/notes/speaker-view.html" "$OUTPUT_DIR/plugin/notes/"

    # Copy theme and assets
    cp "$PREFIX/kiosk-theme.css" "$OUTPUT_DIR/"
    cp -r "$PREFIX/assets" "$OUTPUT_DIR/"

    # Copy video files referenced in manifest
    local input_dir
    input_dir=$(dirname "$INPUT_FILE")
    if [[ -f "$VIDEO_MANIFEST" ]]; then
      local video_files
      # grep returns 1 on no matches; tolerate it under `set -e`
      video_files=$(tr -d '[]" ' < "$VIDEO_MANIFEST" | tr ',' '\n' | grep -v '^$' || true)
      if [[ -n "$video_files" ]]; then
        mkdir -p "$OUTPUT_DIR/videos"
        while IFS= read -r vfile; do
          local src="$input_dir/$vfile"
          if [[ -f "$src" ]]; then
            cp "$src" "$OUTPUT_DIR/videos/"
            echo "  Copied video: $vfile"
          else
            echo "  Warning: Video not found: $src" >&2
          fi
        done <<< "$video_files"
      fi
    fi

    # Copy diagram SVGs to output assets
    shopt -s nullglob
    local input_assets_dir
    input_assets_dir="$(dirname "$INPUT_FILE")/assets"
    for svg in "$input_assets_dir"/mermaid-*.svg "$input_assets_dir"/ail-*.svg; do
      cp "$svg" "$OUTPUT_DIR/assets/"
    done
    shopt -u nullglob

    # Read processed markdown content
    local markdown_content
    markdown_content=$(cat "$TEMP_MD")

    # Generate reveal.js config
    local reveal_config
    reveal_config="{
      autoSlide: ${autoslide},
      loop: ${loop},
      autoSlideStoppable: true,
      transition: '${transition}',
      center: false,
      controls: true,
      progress: false,
      hash: true,
      // Reshape the logical slide to the viewport aspect ratio (no letterbox
      // on landscape), but never narrower than the 1280px content canvas —
      // below that (portrait / rotated displays) fall back to a fixed
      // 1280x720 slide that reveal scales-to-fit and letterboxes gracefully.
      // ?print-pdf pins it: reveal derives the PDF page box from these
      // numbers, and a headless window's viewport would otherwise decide the
      // paper's aspect ratio.
      width: window.location.search.match(/print-pdf/gi)
        ? 1280
        : Math.max(1280, Math.round(720 * (window.innerWidth / window.innerHeight))),
      // Idem voor de hoogte: op een portretscherm is 720 te laag, waardoor
      // reveal niet naar de schermbreedte schaalt en de slide rechts en
      // onder wegvalt. Laat het canvas dan meegroeien met het scherm: klein
      // maar volledig zichtbaar is beter dan groot en afgesneden.
      height: window.location.search.match(/print-pdf/gi)
        ? 720
        : Math.max(720, Math.round(1280 * (window.innerHeight / window.innerWidth))),
      margin: 0,
      // One page per slide: fragments are a presenting device, and a handout
      // with the same slide four times reads as a mistake.
      pdfSeparateFragments: false,
      plugins: [RevealMarkdown, RevealHighlight, RevealNotes]
    }"

    # Read template and replace placeholders
    local template
    template=$(cat "$PREFIX/kiosk-template.html")

    # Write output HTML by splitting template at placeholders
    # Use node for reliable multiline string replacement
    node -e "
      const fs = require('fs');
      let html = fs.readFileSync('$PREFIX/kiosk-template.html', 'utf-8');
      const md = fs.readFileSync('$TEMP_MD', 'utf-8');
      html = html.replace('{{MARKDOWN_CONTENT}}', md);
      html = html.replace('{{REVEAL_CONFIG}}', \`$reveal_config\`);
      html = html.replace('{{DEFAULT_AUTOSLIDE}}', '$autoslide');
      fs.writeFileSync('$OUTPUT_DIR/index.html', html);
    "

    # Clean up diagram SVGs from source dir if not keeping
    if [[ -z "${KEEP_MERMAID_ASSETS:-}" ]]; then
      shopt -s nullglob
      for svg in "$input_assets_dir"/mermaid-*.svg "$input_assets_dir"/ail-*.svg; do
        rm -f "$svg"
      done
      shopt -u nullglob
    fi

    # Written last, on purpose: the dev server's live-reload poller watches
    # this file, so the id must only change once the whole tree is in place.
    date +%s%N > "$OUTPUT_DIR/.build-id"

    echo ""
    echo "Generated: $OUTPUT_DIR/index.html"
    echo "Open in browser: file://$OUTPUT_DIR/index.html"
    echo "Done!"
}

build

if [[ "$PDF" == "true" ]]; then
    echo ""
    echo "Printing to PDF..."
    # Over file:// the markdown plugin's fetch is blocked and reveal renders a
    # single empty page, so print from a throwaway HTTP server rather than the
    # generated file. Its own port, so this works while a --serve is running.
    pdf_port=""
    for candidate in $(seq 8600 8699); do
        if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
            pdf_port="$candidate"
            break
        fi
        exec 3>&- 2>/dev/null || true
    done
    if [[ -z "$pdf_port" ]]; then
        echo "Error: no free port in 8600-8699 to print from" >&2
        exit 1
    fi

    node "$PREFIX/dev-server.mjs" --root "$OUTPUT_DIR" --port "$pdf_port" \
        > /dev/null 2>&1 &
    pdf_server_pid=$!
    sleep 1
    if ! kill -0 "$pdf_server_pid" 2>/dev/null; then
        echo "Error: could not start a server to print from" >&2
        exit 1
    fi

    # ?print-pdf puts reveal in print layout (one section per page, all
    # slides laid out at once) and pins the slide size, which is what decides
    # the paper's aspect ratio. The virtual time budget stands in for "wait
    # until the deck has rendered": markdown, highlighting and the SVG
    # diagrams all happen after load.
    "${PUPPETEER_EXECUTABLE_PATH:-chromium}" \
        --headless --disable-gpu --no-sandbox --hide-scrollbars \
        --run-all-compositor-stages-before-draw \
        --virtual-time-budget=60000 \
        --window-size=1280,720 \
        --no-pdf-header-footer \
        --print-to-pdf="$PDF_FILE" \
        "http://localhost:$pdf_port/?print-pdf" 2>&1 | grep -v "^\[" || true

    kill "$pdf_server_pid" 2>/dev/null || true

    if [[ ! -s "$PDF_FILE" ]]; then
        echo "Error: no PDF was written to $PDF_FILE" >&2
        exit 1
    fi
    echo "PDF: $PDF_FILE"
    exit 0
fi

if [[ "$SERVE" == "true" ]]; then
    echo ""
    node "$PREFIX/dev-server.mjs" --root "$OUTPUT_DIR" --port "$PORT" &
    DEV_SERVER_PID=$!
    # Give the listener a moment to bind (or to fail loudly on a busy port).
    sleep 1
    if ! kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
        echo "Error: dev server failed to start" >&2
        DEV_SERVER_PID=""
        exit 1
    fi
    [[ -n "${PIDFILE:-}" ]] && echo "$DEV_SERVER_PID" >> "$PIDFILE"
fi

if [[ "$WATCH" == "true" ]]; then
    echo ""
    INPUT_DIR=$(cd "$(dirname "$INPUT_FILE")" && pwd)
    # Watch the input file plus any sibling directories that hold sources
    # the filters consume (diagrams/, assets/, videos/). A change to e.g.
    # diagrams/foo.ail must also trigger a rebuild, otherwise the served
    # deck silently goes stale.
    WATCH_PATHS=("$INPUT_FILE")
    for sub in diagrams assets videos; do
        [[ -d "$INPUT_DIR/$sub" ]] && WATCH_PATHS+=("$INPUT_DIR/$sub")
    done
    # The theme, the template and the filters all change the output too; without
    # them a theme edit serves a stale deck and looks like a broken watch.
    for f in kiosk-theme.css kapernikov-ail.css kiosk-template.html \
             ail-filter.mjs mermaid-filter.mjs video-filter.mjs; do
        [[ -f "$PREFIX/$f" ]] && WATCH_PATHS+=("$PREFIX/$f")
    done
    echo "Watching ${WATCH_PATHS[*]} for changes... (Ctrl+C, or --stop, to stop)"
    while true; do
        # The ail/mermaid filters write their SVGs into assets/, which is
        # watched — without excluding them a build re-triggers itself, and two
        # concurrent builds interleave `rm -rf` with `cp -r` in the output dir
        # (symptom: kiosk-output/dist/dist and a 404 on dist/reveal.js).
        inotifywait -qq -r -e close_write -e moved_to -e create \
            --exclude '(ail|mermaid)-[0-9a-f]+\.svg$' "${WATCH_PATHS[@]}" || sleep 1
        echo ""
        echo "Change detected, rebuilding..."
        build || echo "Build failed, waiting for next change..."
    done
elif [[ "$SERVE" == "true" ]]; then
    echo "Serving without --watch; edits will not rebuild. (Ctrl+C to stop)"
    wait "$DEV_SERVER_PID"
fi
BUILDEOF

if [[ "$WATCH" == "true" || "$SERVE" == "true" ]]; then
    nix-shell "${NIX_SHELL_ARGS[@]}" --run "bash $BUILD_SCRIPT kiosk-build"
else
    exec nix-shell "${NIX_SHELL_ARGS[@]}" --run "bash $BUILD_SCRIPT kiosk-build"
fi
