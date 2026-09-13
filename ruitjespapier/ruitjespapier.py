#!/usr/bin/env python3
"""Genereer ruitjespapier als PDF, zonder externe afhankelijkheden.

Standaard: A4 staand, ruitjes van 10x10 mm, elke 5e lijn dikker.

Voorbeeld:
    python3 ruitjespapier.py                          # ruitjespapier.pdf
    python3 ruitjespapier.py --ruit 5 --dik-om 4 -o klein.pdf
    python3 ruitjespapier.py --formaat a4-liggend --marge 15
"""

import argparse
import zlib

MM = 72.0 / 25.4  # millimeter -> PostScript punten

FORMATEN = {
    "a4": (210.0, 297.0),
    "a4-liggend": (297.0, 210.0),
    "a5": (148.0, 210.0),
    "a5-liggend": (210.0, 148.0),
    "a3": (297.0, 420.0),
    "a3-liggend": (420.0, 297.0),
    "letter": (215.9, 279.4),
}


def rasterlijnen(lengte_mm, ruit_mm, marge_mm):
    """Posities (in mm) van de lijnen, gecentreerd binnen de marges."""
    bruikbaar = lengte_mm - 2 * marge_mm
    if bruikbaar < ruit_mm:
        raise SystemExit("Marge te groot voor dit formaat.")
    aantal = int(bruikbaar / ruit_mm)
    rest = bruikbaar - aantal * ruit_mm
    start = marge_mm + rest / 2
    return [start + i * ruit_mm for i in range(aantal + 1)]


def tekenopdrachten(breedte, hoogte, ruit, marge, dik_om, dun, dikte,
                    grijs_dun, grijs_dik):
    """Bouw de PDF-contentstream voor het raster."""
    xs = rasterlijnen(breedte, ruit, marge)
    ys = rasterlijnen(hoogte, ruit, marge)
    y0, y1 = ys[0] * MM, ys[-1] * MM
    x0, x1 = xs[0] * MM, xs[-1] * MM

    # De dikke lijnen vertrekken vanaf de linker-/onderrand van het raster,
    # zodat de hoek van het blad altijd een dik kruispunt is.
    def is_dik(i):
        return dik_om > 0 and i % dik_om == 0

    ops = ["1 J"]
    for breed in (False, True):  # dikke lijnen bovenop de dunne
        ops.append(f"{grijs_dik if breed else grijs_dun:.3f} G")
        ops.append(f"{dikte if breed else dun:.3f} w")
        for i, x in enumerate(xs):
            if is_dik(i) == breed:
                ops.append(f"{x * MM:.3f} {y0:.3f} m {x * MM:.3f} {y1:.3f} l S")
        for i, y in enumerate(ys):
            if is_dik(i) == breed:
                ops.append(f"{x0:.3f} {y * MM:.3f} m {x1:.3f} {y * MM:.3f} l S")
    return "\n".join(ops).encode("ascii")


def schrijf_pdf(pad, breedte_mm, hoogte_mm, stream, comprimeren=True):
    """Minimale PDF met één pagina en één contentstream."""
    if comprimeren:
        data = zlib.compress(stream)
        filtr = b"/Filter /FlateDecode "
    else:
        data, filtr = stream, b""

    objecten = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.3f %.3f] /Contents 4 0 R "
        b"/Resources << >> >>" % (breedte_mm * MM, hoogte_mm * MM),
        b"<< %s/Length %d >>\nstream\n" % (filtr, len(data)) + data + b"\nendstream",
    ]

    uit = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    posities = []
    for nr, obj in enumerate(objecten, start=1):
        posities.append(len(uit))
        uit += b"%d 0 obj\n" % nr + obj + b"\nendobj\n"

    xref = len(uit)
    uit += b"xref\n0 %d\n" % (len(objecten) + 1)
    uit += b"0000000000 65535 f \n"
    for pos in posities:
        uit += b"%010d 00000 n \n" % pos
    uit += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objecten) + 1,
        xref,
    )

    with open(pad, "wb") as f:
        f.write(uit)


def main():
    p = argparse.ArgumentParser(description="Genereer ruitjespapier als PDF.")
    p.add_argument("-o", "--uit", default="ruitjespapier.pdf", help="uitvoerbestand")
    p.add_argument("--formaat", default="a4", choices=sorted(FORMATEN),
                   help="papierformaat (standaard a4 staand)")
    p.add_argument("--ruit", type=float, default=10.0, help="ruitgrootte in mm")
    p.add_argument("--dik-om", type=int, default=5,
                   help="elke hoeveelste lijn dik (0 = geen dikke lijnen)")
    p.add_argument("--marge", type=float, default=10.0, help="marge in mm")
    p.add_argument("--dun", type=float, default=0.25, help="dikte dunne lijn in pt")
    p.add_argument("--dik", type=float, default=0.8, help="dikte dikke lijn in pt")
    p.add_argument("--grijs-dun", type=float, default=0.72,
                   help="grijswaarde dunne lijnen (0 = zwart, 1 = wit)")
    p.add_argument("--grijs-dik", type=float, default=0.55,
                   help="grijswaarde dikke lijnen")
    args = p.parse_args()

    breedte, hoogte = FORMATEN[args.formaat]
    stream = tekenopdrachten(breedte, hoogte, args.ruit, args.marge,
                             args.dik_om, args.dun, args.dik,
                             args.grijs_dun, args.grijs_dik)
    schrijf_pdf(args.uit, breedte, hoogte, stream)
    print(f"{args.uit}: {args.formaat}, ruit {args.ruit} mm, dik om de {args.dik_om}")


if __name__ == "__main__":
    main()
