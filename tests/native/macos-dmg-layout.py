"""Check the layout and payload of a read-only mounted Scratchtree disk image."""

import argparse
import os
from pathlib import Path
import re
import subprocess

from ds_store import DSStore
from mac_alias import Alias


def require(condition, message):
    if not condition:
        raise SystemExit(message)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mount", type=Path)
args = parser.parse_args()
mount = args.mount

require((mount / "Scratchtree.app").is_dir(), "Scratchtree.app is missing")
applications = mount / "Applications"
require(
    applications.is_symlink() and os.readlink(applications) == "/Applications",
    "Applications must link to /Applications",
)
require((mount / ".DS_Store").is_file(), "Finder layout is missing")
background = mount / ".background.tiff"
require(background.is_file() and background.stat().st_size > 0, "Installer background is missing or empty")

with DSStore.open(str(mount / ".DS_Store"), "r") as layout:
    require(layout["."]["icvl"] == (b"type", b"icnv"), "Finder must open in icon view")
    window = layout["."]["bwsp"]
    for key in ("ShowToolbar", "ShowSidebar", "ShowStatusBar", "ShowPathbar"):
        require(window[key] is False, f"{key} must be disabled")
    bounds = re.fullmatch(
        r"\{\{-?\d+, -?\d+\}, \{([1-9]\d*), ([1-9]\d*)\}\}",
        window["WindowBounds"],
    )
    require(bounds is not None, "Finder window bounds are invalid")
    width, height = map(int, bounds.groups())
    icons = layout["."]["icvp"]
    require(
        icons["backgroundType"] == 2 and icons["backgroundImageAlias"],
        "Finder background is not linked",
    )
    alias = Alias.from_bytes(icons["backgroundImageAlias"])
    require(alias.target.posix_path == f"/{background.name}", "Finder links to the wrong background")
    require(icons["arrangeBy"] == "none", "Finder must retain the custom icon positions")
    app_x, app_y = layout["Scratchtree.app"]["Iloc"]
    applications_x, applications_y = layout["Applications"]["Iloc"]
    require(
        0 < app_x < applications_x < width and 0 < app_y == applications_y < height,
        "App and shortcut must form a left-to-right row within the installer window",
    )

tiff = subprocess.check_output(["/usr/bin/tiffutil", "-info", str(background)], text=True)
images = re.findall(r"Image Width: (\d+) Image Length: (\d+)", tiff)
require(
    [(int(w), int(h)) for w, h in images] == [(width, height), (width * 2, height * 2)],
    "Background must match the Finder window at both display scales",
)

print("Mounted DMG layout and Applications link verified")
