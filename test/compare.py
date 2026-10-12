"""Compare a browser reference screenshot with a Figma render.

    python3 test/compare.py test/output/tailwind.png test/output/figma/tailwind.png test/output/compare/tailwind

Writes <out>-side.png (browser | figma) and <out>-diff.png (changed pixels in red over a faded
reference), and prints the share of pixels that differ noticeably.
"""
import sys
from PIL import Image, ImageChops

ref_path, fig_path, out = sys.argv[1:4]
ref = Image.open(ref_path).convert("RGB")
fig = Image.open(fig_path).convert("RGB")
if fig.size != ref.size:
    fig = fig.resize((ref.width, round(fig.height * ref.width / fig.width)), Image.LANCZOS)
h = min(ref.height, fig.height)
ref, fig = ref.crop((0, 0, ref.width, h)), fig.crop((0, 0, ref.width, h))

diff = ImageChops.difference(ref, fig).convert("L")
mask = diff.point(lambda v: 255 if v > 40 else 0)
changed = sum(1 for v in mask.getdata() if v)
total = ref.width * h

side = Image.new("RGB", (ref.width * 2 + 20, h), "white")
side.paste(ref, (0, 0))
side.paste(fig, (ref.width + 20, 0))
side.save(out + "-side.png")

faded = Image.blend(ref, Image.new("RGB", ref.size, "white"), 0.7)
red = Image.new("RGB", ref.size, (230, 30, 30))
faded.paste(red, (0, 0), mask)
faded.save(out + "-diff.png")
print(f"{changed / total:.2%} of pixels differ ({ref.width}x{h})")
