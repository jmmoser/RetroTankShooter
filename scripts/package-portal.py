#!/usr/bin/env python3
"""Build the solo CrazyGames edition without modifying the ordinary game."""
import argparse
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'dist')
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
files = ['index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
         'icon-180.png', 'icon-192.png', 'icon-512.png', 'LICENSE']
files += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'js').rglob('*')) if p.is_file()]
edition = output / 'crazygames'
with ZipFile(output / 'phantom-arena-crazygames.zip', 'w', ZIP_DEFLATED) as archive:
    for name in files:
        data = (ROOT / name).read_bytes()
        if name == 'index.html':
            text = data.decode('utf-8')
            assert text.count('<head>') == 1
            text = text.replace('<head>', '<head>\n<script>window.PA_PLATFORM = "crazygames";</script>', 1)
            data = text.encode('utf-8')
        dest = edition / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        archive.writestr(name, data)
print(f'{output / "phantom-arena-crazygames.zip"} ({len(files)} files)')
