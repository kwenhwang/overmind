"""모델 프리뷰 렌더 — blender --background --python tools/blender/preview.py -- <out_dir>

public/models/*.glb 를 하나씩 불러와 3/4 앵글 + 게임 탑다운 앵글로 렌더.
디자인 리뷰 루프용 (Cycles CPU, 어두운 배경 = 인게임 톤 근사).
"""
import math
import os
import sys

import bpy

_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else ["/tmp"]
OUT = _args[0]
MODELS = _args[1:] or ["player", "drone", "spitter", "brute", "boss"]
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "models")


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.render.resolution_x = 480
    scene.render.resolution_y = 480
    scene.cycles.use_denoising = False  # 우분투 패키지 빌드엔 OIDN 없음
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.014, 0.02, 1)
    scene.world = world

    # 바닥 (그림자 받이)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -1.05))
    floor = bpy.context.active_object
    m = bpy.data.materials.new("floor")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.055, 0.075, 1)
    floor.data.materials.append(m)

    # 키/림 라이트
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


def add_camera(name, loc, look_at=(0, 0, 0)):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    cam.location = loc
    bpy.context.collection.objects.link(cam)
    target = bpy.data.objects.new(f"{name}-target", None)
    target.location = look_at
    bpy.context.collection.objects.link(target)
    tc = cam.constraints.new("TRACK_TO")
    tc.target = target
    tc.track_axis = "TRACK_NEGATIVE_Z"
    tc.up_axis = "UP_Y"
    return cam


for name in MODELS:
    setup_scene()
    path = os.path.join(BASE, f"{name}.glb")
    bpy.ops.import_scene.gltf(filepath=path)
    scale = 2.2 if name == "boss" else 1.0

    for angle, loc in (
        ("34", (3.2 * scale, -3.2 * scale, 2.2 * scale)),      # 3/4 스튜디오 앵글
        ("top", (0, -2.2 * scale, 4.2 * scale)),               # 게임 카메라 근사 (높은 탑다운)
    ):
        cam = add_camera(f"cam-{angle}", loc)
        bpy.context.scene.camera = cam
        bpy.context.scene.render.filepath = os.path.join(OUT, f"{name}-{angle}.png")
        bpy.ops.render.render(write_still=True)
        print(f"rendered {name}-{angle}")

print("PREVIEW_DONE")
