"""Builds Blueprint-ify from src/ into two pages.

  index.html                     the standalone site: open it, host it on GitHub Pages
  dist/blueprint-ify-artifact.html  the same page as a Claude artifact body

    python3 build.py
"""
import base64
import pathlib

root = pathlib.Path(__file__).resolve().parent
src = root / "src"

kernel = (root / "vendor" / "hairline-kernel.js").read_text()
font_file = root / "fonts" / "CaliperSans-Regular.otf"
font = base64.b64encode(font_file.read_bytes()).decode() if font_file.exists() else ""
app = (src / "app.js").read_text().replace("/*FLAT*/", (src / "flat.js").read_text())

body = (
    (src / "page.html").read_text()
    .replace("/*KERNEL*/", kernel)
    .replace("/*FONT*/", font)
    .replace("/*PRESETS*/", (src / "presets.js").read_text())
    .replace("/*APP*/", app)
)

# the artifact host wraps the body itself
dist = root / "dist"
dist.mkdir(exist_ok=True)
(dist / "blueprint-ify-artifact.html").write_text(body)

# the standalone page carries its own document, the same small reset, and config.js
head = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    "<title>Blueprint-ify</title>"
    '<meta name="description" content="Name a product, add photos or paste spec notes, and get an exploded technical drawing you can take apart, section and export.">'
    "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}"
    "body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>"
    '<script src="config.js"></script>'
    "</head><body>"
)
(root / "index.html").write_text(head + body + "</body></html>")

for f in ("index.html", "dist/blueprint-ify-artifact.html"):
    print(f, (root / f).stat().st_size, "bytes")
