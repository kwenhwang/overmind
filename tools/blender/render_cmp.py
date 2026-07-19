"""임의 GLB 후보 비교 렌더 — blender --background --python render_cmp.py -- <out_dir> label=path ...
preview.py의 라이팅/바닥을 재사용해 3/4 앵글 하나씩 렌더 (후보 시각 비교용)."""
import math
import os
import sys

import bpy

_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else ["/tmp"]
OUT = _args[0]
PAIRS = [a.split("=", 1) for a in _args[1:] if "=" in a]


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.render.resolution_x = 400
    scene.render.resolution_y = 400
    scene.cycles.use_denoising = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.014, 0.02, 1)
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -1.05))
    floor = bpy.context.active_object
    m = bpy.data.materials.new("floor")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.055, 0.075, 1)
    floor.data.materials.append(m)
    key = bpy.data.objects.new("key", bpy.data.lights.new("key", "SUN"))
    key.data.energy = 4
    key.rotation_euler = (math.radians(50), math.radians(-15), math.radians(30))
    bpy.context.collection.objects.link(key)
    rim = bpy.data.objects.new("rim", bpy.data.lights.new("rim", "AREA"))
    rim.data.energy = 300
    rim.data.color = (0.3, 0.75, 1.0)
    rim.location = (-4, 5, 3)
    rim.rotation_euler = (math.radians(-60), math.radians(-30), 0)
    bpy.context.collection.objects.link(rim)


def add_camera(loc, look_at=(0, 0, 0)):
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.location = loc
    bpy.context.collection.objects.link(cam)
    target = bpy.data.objects.new("tgt", None)
    target.location = look_at
    bpy.context.collection.objects.link(target)
    tc = cam.constraints.new("TRACK_TO")
    tc.target = target
    tc.track_axis = "TRACK_NEGATIVE_Z"
    tc.up_axis = "UP_Y"
    return cam


def bounds():
    import mathutils
    mn = mathutils.Vector((1e9, 1e9, 1e9))
    mx = mathutils.Vector((-1e9, -1e9, -1e9))
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and o.name != "Plane":
            for corner in o.bound_box:
                w = o.matrix_world @ mathutils.Vector(corner)
                mn = mathutils.Vector((min(mn[i], w[i]) for i in range(3)))
                mx = mathutils.Vector((max(mx[i], w[i]) for i in range(3)))
    center = (mn + mx) / 2
    radius = max((mx - mn).length / 2, 0.5)
    return center, radius


# VIEWS env: "34" (default) or "34,front" — 정면(-Y)에서 눈 확인용
VIEWS = os.environ.get("VIEWS", "34").split(",")

for label, path in PAIRS:
    for view in VIEWS:
        setup_scene()
        bpy.ops.import_scene.gltf(filepath=path)
        import mathutils
        center, radius = bounds()
        d = radius * 3.0
        if view == "front":
            loc = center + mathutils.Vector((d * 0.12, -d * 1.0, d * 0.14))
        else:
            loc = center + mathutils.Vector((d * 0.7, -d * 0.7, d * 0.55))
        cam = add_camera((0, 0, 0))
        cam.location = loc
        for c in cam.constraints:
            c.target.location = center
        bpy.context.scene.camera = cam
        suffix = "" if view == "34" else f"_{view}"
        bpy.context.scene.render.filepath = os.path.join(OUT, f"{label}{suffix}.png")
        bpy.ops.render.render(write_still=True)
        print(f"rendered {label}{suffix}")

print("CMP_DONE")
