#!/usr/bin/env bash
# Bouwt elk deck in deze repository naar _site/<deckmap>/ en zet er een
# overzichtspagina bij.
#
# Een deck = een map met zowel slides.md als build-kiosk.sh (zoals de
# Kapernikov-templates die scaffolden). Nieuwe decks worden vanzelf
# meegenomen, er is niets om bij te werken.
set -euo pipefail

OUTPUT_DIR="${1:-_site}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

mapfile -t decks < <(
    find . -mindepth 2 -maxdepth 2 -name slides.md \
        -not -path './node_modules/*' -not -path "./${OUTPUT_DIR#./}/*" \
        -printf '%h\n' | sed 's|^\./||' | sort
)

if [[ ${#decks[@]} -eq 0 ]]; then
    echo "Geen decks gevonden (verwacht: <map>/slides.md)" >&2
    exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

built=()
for deck in "${decks[@]}"; do
    if [[ ! -x "$deck/build-kiosk.sh" ]]; then
        echo "Overslaan: $deck heeft geen uitvoerbare build-kiosk.sh" >&2
        continue
    fi
    echo ""
    echo "### $deck"
    (cd "$deck" && ./build-kiosk.sh slides.md "$ROOT/$OUTPUT_DIR/$deck")
    built+=("$deck")
done

node build-index.mjs "$OUTPUT_DIR" "${built[@]}"
