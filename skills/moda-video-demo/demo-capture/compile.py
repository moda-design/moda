#!/usr/bin/env python
"""The Moda-side compile, exposed as two subcommands.

Two, not one, because the ORDER IS FORCED: the camera needs the clip's node id,
and the node does not exist until the markup has been applied. So `markup` runs
first, the caller applies it and reads the id back, then `motion` runs.
"""
import json
import sys
from pathlib import Path

def _studio_backend() -> Path:
    """Find the studio checkout whose compiler this pipeline drives.

    Walking UP first, because once this lives inside studio there is nothing to
    configure — `moda-cli/skills/moda-video-demo/demo-capture/` finds the repo root above it and the
    setup step disappears. The `.studio` file is the escape hatch for running
    from outside a checkout, which is how this was developed.

    The compiler is imported FROM SOURCE, not from a deployed backend, so
    whatever branch is checked out is what the camera does. No deploy sits
    between an edit to `zoom.py` and the next take.
    """
    here = Path(sys.argv[0]).resolve().parent
    for candidate in (here, *here.parents):
        if (candidate / "backend" / "app" / "services" / "demo_video").is_dir():
            return candidate / "backend"
    pointer = here / ".studio"
    if pointer.is_file():
        return Path(pointer.read_text().strip()) / "backend"
    raise SystemExit(
        "no studio checkout found. Run this from inside one, or drop its path in a `.studio` file "
        f"beside {Path(sys.argv[0]).name}."
    )


sys.path.insert(0, str(_studio_backend()))

from app.config import settings  # noqa: E402

settings.API_URL = "https://api.moda.app"

from app.services.demo_video.canvas_compiler import compile_demo  # noqa: E402
from app.services.demo_video.timeline import parse_timeline  # noqa: E402
from app.services.demo_video.caption_emitter import MotionCodeCaptionEmitter  # noqa: E402
from app.services.demo_video.zoom_emitter import MotionCodeZoomEmitter  # noqa: E402

cmd, doc_path = sys.argv[1], sys.argv[2]
doc = json.loads(Path(doc_path).read_text())
timeline = parse_timeline(doc)

if cmd == "markup":
    ref = sys.argv[3]
    result = compile_demo(timeline, video_ref=ref)
    Path(sys.argv[4]).write_text(result.markup)
    print(json.dumps({"warnings": result.warnings, "zooms": len(result.zoom_plans)}))
elif cmd == "motion":
    ref, page_id, node_id, out = sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    emitter = MotionCodeZoomEmitter(
        page_id=page_id, page_width=timeline.viewport.width,
        page_height=timeline.viewport.height, node_id=node_id,
    )
    result = compile_demo(timeline, video_ref=ref, zoom_emitter=emitter)
    if result.zoom_ops:
        Path(out).write_text(result.zoom_ops[0] + "\n")
    print(json.dumps({"warnings": result.warnings, "wrote_camera": bool(result.zoom_ops)}))
elif cmd == "captions":
    # The caption pass. Same workflow constraint as the camera: the node ids do
    # not exist until the markup is applied, so this runs after the read-back.
    ref, page_id, ids_path, out = sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    node_ids = json.loads(Path(ids_path).read_text())
    result = compile_demo(timeline, video_ref=ref)
    emitter = MotionCodeCaptionEmitter(
        page_id=page_id, node_ids=node_ids, clip_duration_sec=timeline.duration_sec
    )
    ops = emitter.emit(list(result.caption_plans))
    if ops:
        Path(out).write_text(ops[0] + "\n")
    print(json.dumps({"warnings": emitter.warnings, "timed": bool(ops),
                      "planned": len(result.caption_plans)}))
else:
    raise SystemExit(f"unknown command {cmd!r}")
