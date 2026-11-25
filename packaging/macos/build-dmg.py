"""Package a staged Scratchtree app in the branded macOS disk image."""

import argparse
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from dmgbuild import build_dmg


def verify_app_copy(mount, _settings):
    # dmgbuild does not propagate ditto's exit status.
    subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(Path(mount) / "Scratchtree.app")],
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="staged Scratchtree.app")
    parser.add_argument("output", type=Path, help="new .dmg file")
    args = parser.parse_args()
    if args.app.name != "Scratchtree.app" or args.app.is_symlink() or not args.app.is_dir():
        parser.error("app must be a staged Scratchtree.app directory")
    if args.output.suffix != ".dmg" or os.path.lexists(args.output):
        parser.error("output must be a new .dmg file")

    renderer = Path(__file__).with_name("render-background.swift")
    with TemporaryDirectory(prefix=".scratchtree-dmg-", dir=args.output.parent) as temporary:
        work = Path(temporary)
        layout = json.loads(
            subprocess.check_output(
                ["/usr/bin/swift", "-module-cache-path", str(work / "swift-cache"), str(renderer), str(work)],
                text=True,
            )
        )

        candidate = work / "Scratchtree.dmg"
        build_dmg(
            str(candidate),
            "Scratchtree",
            settings={
                "format": "UDZO",
                "filesystem": "HFS+",
                "compression_level": 9,
                "files": [str(args.app.resolve())],
                "symlinks": {"Applications": "/Applications"},
                "background": str(work / "background.png"),
                "window_rect": ((160, 120), layout["window_size"]),
                "icon_size": layout["icon_size"],
                "text_size": 14,
                "icon_locations": layout["icon_locations"],
                "create_hook": verify_app_copy,
            },
        )
        # A failed build or a concurrent invocation must not replace an output.
        os.link(candidate, args.output)


if __name__ == "__main__":
    main()
