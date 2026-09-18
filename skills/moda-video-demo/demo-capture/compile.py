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

from app.services.demo_video.canvas_compiler import ClipBox, compile_demo  # noqa: E402
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
    # FULL-BLEED, which is what this command compiles: `compile_demo` below is
    # called with no clip box and no composition, so the clip IS the page at
    # the recording's size. The emitter takes the box rather than a width/height
    # pair precisely so this cannot be filled from the wrong thing (ENG-6306).
    #
    # This lane therefore plans a FULL-BLEED camera. The iterate loop grades it
    # before publish, and a composed publish emits a different program — framed
    # against the inset clip, in both extent and origin. The published program
    # is graded separately and correctly (publish-take passes the server's
    # `clip_box` to `checkShots`), so the gap is the loop tuning one camera and
    # shipping another. See ENG-6372.
    emitter = MotionCodeZoomEmitter(
        page_id=page_id,
        clip=ClipBox.full_bleed(timeline.viewport.width, timeline.viewport.height),
        node_id=node_id,
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
    # FAIL CLOSED on a chunked program. `_programs` splits past MAX_CODE_SIZE by
    # design — raising there meant a long demo lost ALL caption timing — and the
    # pieces are meant to be submitted as several edits. This branch has one
    # output path, so it can carry only the first, and `references/capture.md`
    # documents these three subcommands as a workflow an agent runs BY HAND.
    # Writing a partial file and exiting 0 therefore hands a real caller an
    # artifact that applies cleanly and leaves most captions on screen for the
    # whole clip, stacked — the exact defect `caption_emitter` exists to fix,
    # with nothing having reported a failure.
    #
    # So refuse, BEFORE writing, and name a repair the reader can actually carry
    # out on this lane: not "submit every program", which this command cannot
    # hand them. ENG-6393 carries the real fix — a multi-program output, or
    # deleting this subcommand in favour of publish.
    if len(ops) > 1:
        raise SystemExit(
            f"captions_truncated: the caption tracks chunked into {len(ops)} `motion.page` programs and "
            "this subcommand writes a single file, so it would have carried only the first — leaving the "
            f"other {len(ops) - 1} program(s)' captions on screen for the whole clip, stacked. Nothing "
            "was written. Time the captions through `moda demo publish`, which does this server-side and "
            "applies every program, or shorten the demo. See ENG-6393."
        )
    if ops:
        Path(out).write_text(ops[0] + "\n")
    # `fully_timed`, not `bool(ops)`. Its docstring opens with "`bool(ops)` is not
    # this, in both directions", and both are live here: a partially mapped
    # ids.json still emits operations for the pairs that resolved, and a demo
    # whose captions all legitimately span the clip needs no tracks at all. One
    # reports success over a broken take, the other failure over a correct one.
    print(json.dumps({"warnings": emitter.warnings, "timed": emitter.fully_timed,
                      "programs": len(ops),
                      "planned": len(result.caption_plans)}))
else:
    raise SystemExit(f"unknown command {cmd!r}")
