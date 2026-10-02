#!/usr/bin/env python3
"""Pack the registered facial layers without any full-body animation inputs."""
from pathlib import Path
import hashlib
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "packages/companions/assets"
ROLES = ["lead", "code", "research", "review"]


def main():
    atlas = Image.new("RGBA", (1024, 6912))
    counts = {}
    for column, role in enumerate(ROLES):
        source = Image.open(ASSETS / "source/animation-v3" / role / "face-registered.png")
        assert source.mode == "RGBA" and source.size == (256, 6912), role
        seen = set()
        for row in range(18):
            frame = source.crop((0, row * 384, 256, row * 384 + 384))
            bounds = frame.getbbox()
            assert bounds and 80 <= bounds[0] < bounds[2] <= 186 and 40 <= bounds[1] < bounds[3] <= 119, (role, row, bounds)
            digest = hashlib.sha256(frame.tobytes()).hexdigest()
            assert digest not in seen, (role, row, "duplicate expression")
            seen.add(digest)
        counts[role] = len(seen)
        atlas.paste(source, (column * 256, 0))
    atlas.save(ASSETS / "facial-v3.png", optimize=True)
    print(json.dumps({"facialLayers": counts, "total": sum(counts.values())}))


if __name__ == "__main__":
    main()
