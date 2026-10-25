---
name: blender
description:
  Create 3D renders, animations, procedural scenes and text/logo treatments with headless Blender,
  and convert between 3D formats (glTF/GLB, FBX, OBJ, STL, USD, Alembic). Use whenever a task needs
  3D output, a 3D asset inspected or converted, or motion graphics that 2D tools cannot do.
---

# blender

Blender 4.5 LTS is preinstalled; `blender` is on PATH. This sandbox has **no GPU and no display**:
always run with `-b` (background). Blender uses its own bundled Python — write scene logic as `bpy`
scripts and pass them with `-P`.

```bash
blender -b --factory-startup -P scene.py -- out_dir=/workspace/render
```

Everything after `--` reaches the script via `sys.argv`. `--factory-startup` keeps runs
reproducible. Argument order matters: `-P`/`--python-expr` must come before `-f`/`-a`, or the script
runs after the render.

## Engine choice (CPU-only, binding)

- **Cycles** (`-E CYCLES`) for final quality. It renders on CPU here, so keep it cheap: 16–64
  samples with the denoiser instead of high sample counts:
  ```python
  scene = bpy.context.scene
  scene.cycles.samples = 32
  scene.cycles.use_denoising = True
  scene.cycles.denoiser = "OPENIMAGEDENOISE"
  ```
- **Workbench** (`-E BLENDER_WORKBENCH`) for fast previews, layout checks and stylized flat shading
  — near-instant per frame.
- **EEVEE does not work** without a GPU. Never select it.

Budget expectations on 4 CPU cores: a simple Cycles scene at 720p/32 samples takes roughly 10–60
seconds per frame; scale resolution and frame count to the deadline, and render a single preview
frame before committing to an animation.

## Stills and animations

Render PNG frames into the workspace, then assemble with ffmpeg (already installed):

```bash
blender -b --factory-startup -P scene.py -E CYCLES \
  -o /workspace/render/frame_#### -F PNG -s 1 -e 72 -a
ffmpeg -framerate 24 -i /workspace/render/frame_%04d.png \
  -c:v libx264 -pix_fmt yuv420p /workspace/render/out.mp4
```

Set resolution in the script (`scene.render.resolution_x/_y`); for transparent overlays use
`scene.render.film_transparent = True` and `scene.render.image_settings.color_mode = "RGBA"`. Show
finished stills or videos with the preview skill. For an animation, publish 3–8 rendered frames (one
per shot or beat, titled by it) as its storyboard in one call once the first draft renders, and the
finished video last.

## Format conversion and asset inspection

Import/export operators cover glTF/GLB (`bpy.ops.import_scene.gltf` / `export_scene.gltf`), FBX, OBJ
(`bpy.ops.wm.obj_import` / `obj_export`), STL, USD (`bpy.ops.wm.usd_import` / `usd_export`) and
Alembic. A conversion is one short script: import, optionally clean up or rescale, export. To
inspect an asset, import it and print `bpy.data.objects`, dimensions, material and polygon counts.

## Limits

- 8 GB RAM: keep scenes moderate — no multi-million-polygon sculpt meshes or 4K texture stacks.
- No network inside renders: bring fonts, HDRIs and textures into the workspace first.
- Headless means no screenshots of the Blender UI; judge results from rendered frames.
