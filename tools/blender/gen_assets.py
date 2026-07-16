"""OVERMIND 로우폴리 에셋 생성 — blender --background --python tools/blender/gen_assets.py

모든 모델은 코드로 생성된다 (재현 가능, 외부 에셋·라이선스 이슈 0).
규약: 원점 = 시각적 중심(게임에서 y=0.9에 배치), 정면 = Blender -Y (glTF 변환 후 three.js -Z).
각 모델은 Empty 루트 아래 파트별 오브젝트 — 게임 코드가 이름으로 파트를 찾아 회전 연출.
출력: public/models/<name>.glb
"""
import math
import os
import sys

import bpy

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "models")


def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, emission=None, strength=2.0, metallic=0.3, rough=0.45):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


def active():
    return bpy.context.active_object


def set_mat(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def root_empty(name):
    e = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(e)
    return e


def parent(obj, root, name=None):
    if name:
        obj.name = name
    obj.parent = root
    return obj


def export(root, filename):
    bpy.ops.object.select_all(action="DESELECT")

    def sel(o):
        o.select_set(True)
        for c in o.children:
            sel(c)

    sel(root)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, filename)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
    )
    print(f"exported {path}")


# ── 플레이어: 호버 유닛 — 둥근 동체 + 시안 바이저 + 측면 핀 + 하부 스러스터 ──
def make_player():
    clean_scene()
    body_mat = material("p-body", (0.16, 0.75, 0.38), emission=(0.05, 0.3, 0.12), strength=0.4)
    visor_mat = material("p-visor", (0.02, 0.05, 0.06), emission=(0.3, 0.9, 1.0), strength=4.0, rough=0.2)
    dark_mat = material("p-dark", (0.08, 0.1, 0.12), metallic=0.6)

    root = root_empty("player")

    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.55)
    body = active()
    body.scale = (1.0, 1.0, 1.25)
    set_mat(body, body_mat)
    parent(body, root, "body")

    # 바이저 (정면 -Y)
    bpy.ops.mesh.primitive_cube_add(size=1)
    visor = active()
    visor.scale = (0.34, 0.1, 0.13)
    visor.location = (0, -0.48, 0.18)
    set_mat(visor, visor_mat)
    parent(visor, root, "visor")

    # 측면 핀 2개
    for sx, name in ((1, "fin-r"), (-1, "fin-l")):
        bpy.ops.mesh.primitive_cube_add(size=1)
        fin = active()
        fin.scale = (0.1, 0.42, 0.24)
        fin.location = (sx * 0.6, 0.1, 0.05)
        fin.rotation_euler = (0, math.radians(sx * 15), 0)
        set_mat(fin, dark_mat)
        parent(fin, root, name)

    # 하부 스러스터
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.24, radius2=0.1, depth=0.35)
    thr = active()
    thr.location = (0, 0, -0.72)
    thr.rotation_euler = (math.pi, 0, 0)
    set_mat(thr, visor_mat)
    parent(thr, root, "thruster")

    export(root, "player.glb")


# ── 드론: 공격 파편 — 길쭉한 코어 + 회전 블레이드 4장 ──
def make_drone():
    clean_scene()
    core_mat = material("d-core", (0.78, 0.22, 0.22), emission=(0.9, 0.15, 0.1), strength=1.2)
    blade_mat = material("d-blade", (0.14, 0.1, 0.12), metallic=0.7, rough=0.3)

    root = root_empty("drone")

    bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.42, radius2=0.0, depth=0.7)
    top = active()
    top.location = (0, 0, 0.35)
    set_mat(top, core_mat)
    parent(top, root, "core-top")

    bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.42, radius2=0.0, depth=0.7)
    bot = active()
    bot.location = (0, 0, -0.35)
    bot.rotation_euler = (math.pi, 0, 0)
    set_mat(bot, core_mat)
    parent(bot, root, "core-bottom")

    # 블레이드 링 (게임 코드가 'blades'를 회전)
    blades = root_empty("blades")
    blades.parent = root
    for i in range(4):
        a = i * math.pi / 2
        bpy.ops.mesh.primitive_cube_add(size=1)
        bl = active()
        bl.scale = (0.34, 0.07, 0.1)
        bl.location = (math.cos(a) * 0.55, math.sin(a) * 0.55, 0)
        bl.rotation_euler = (math.radians(20), 0, a)
        set_mat(bl, blade_mat)
        parent(bl, blades, f"blade-{i}")

    export(root, "drone.glb")


# ── 스피터: 포탑 — 삼각대 + 구형 몸통 + 전방 포신 ──
def make_spitter():
    clean_scene()
    body_mat = material("s-body", (0.55, 0.32, 0.75), emission=(0.4, 0.15, 0.7), strength=0.8)
    leg_mat = material("s-leg", (0.12, 0.1, 0.16), metallic=0.6)
    muzzle_mat = material("s-muzzle", (0.05, 0.02, 0.08), emission=(0.95, 0.5, 1.0), strength=4.0)

    root = root_empty("spitter")

    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.48)
    body = active()
    body.location = (0, 0, 0.15)
    set_mat(body, body_mat)
    parent(body, root, "body")

    # 포신 (정면 -Y)
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.13, depth=0.55)
    barrel = active()
    barrel.rotation_euler = (math.pi / 2, 0, 0)
    barrel.location = (0, -0.55, 0.18)
    set_mat(barrel, leg_mat)
    parent(barrel, root, "barrel")

    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.15, depth=0.1)
    muz = active()
    muz.rotation_euler = (math.pi / 2, 0, 0)
    muz.location = (0, -0.83, 0.18)
    set_mat(muz, muzzle_mat)
    parent(muz, root, "muzzle")

    # 삼각대
    for i in range(3):
        a = i * 2 * math.pi / 3 + math.pi / 6
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.07, depth=1.0)
        leg = active()
        leg.location = (math.cos(a) * 0.35, math.sin(a) * 0.35, -0.4)
        leg.rotation_euler = (math.radians(-25) * math.sin(a + math.pi / 2), math.radians(25) * math.cos(a + math.pi / 2), 0)
        set_mat(leg, leg_mat)
        parent(leg, root, f"leg-{i}")

    export(root, "spitter.glb")


# ── 브루트: 골렘 — 베벨 큐브 몸통 + 어깨 슬랩 + 가슴 코어 ──
def make_brute():
    clean_scene()
    body_mat = material("b-body", (0.8, 0.55, 0.25), metallic=0.4, rough=0.55)
    core_mat = material("b-core", (0.1, 0.04, 0.02), emission=(1.0, 0.45, 0.1), strength=2.0)
    dark_mat = material("b-dark", (0.15, 0.12, 0.1), metallic=0.6)

    root = root_empty("brute")

    bpy.ops.mesh.primitive_cube_add(size=1)
    torso = active()
    torso.scale = (0.85, 0.7, 0.8)
    torso.location = (0, 0, 0.1)
    m = torso.modifiers.new("bevel", "BEVEL")
    m.width = 0.12
    m.segments = 2
    set_mat(torso, body_mat)
    parent(torso, root, "torso")

    for sx, name in ((1, "shoulder-r"), (-1, "shoulder-l")):
        bpy.ops.mesh.primitive_cube_add(size=1)
        sh = active()
        sh.scale = (0.35, 0.55, 0.55)
        sh.location = (sx * 0.75, 0, 0.35)
        mm = sh.modifiers.new("bevel", "BEVEL")
        mm.width = 0.08
        mm.segments = 2
        set_mat(sh, dark_mat)
        parent(sh, root, name)

    # 가슴 코어 (정면 -Y)
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.2, depth=0.12)
    core = active()
    core.rotation_euler = (math.pi / 2, 0, 0)
    core.location = (0, -0.42, 0.25)
    set_mat(core, core_mat)
    parent(core, root, "core")

    # 머리
    bpy.ops.mesh.primitive_cube_add(size=1)
    head = active()
    head.scale = (0.3, 0.3, 0.22)
    head.location = (0, -0.15, 0.72)
    set_mat(head, dark_mat)
    parent(head, root, "head")

    export(root, "brute.glb")


# ── 보스: 오버마인드 — 대형 코어 + 이중 링 (게임 코드가 'ring1','ring2' 회전) ──
def make_boss():
    clean_scene()
    core_mat = material("o-core", (0.12, 0.04, 0.04), emission=(1.0, 0.37, 0.18), strength=1.6, rough=0.25, metallic=0.5)
    ring_mat = material("o-ring", (0.2, 0.12, 0.06), emission=(1.0, 0.72, 0.42), strength=0.7, metallic=0.7)
    shard_mat = material("o-shard", (0.08, 0.06, 0.08), metallic=0.8, rough=0.3)

    root = root_empty("boss")

    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1.5)
    core = active()
    set_mat(core, core_mat)
    parent(core, root, "core")

    for i, (name, tilt) in enumerate((("ring1", 0.5), ("ring2", -0.9))):
        bpy.ops.mesh.primitive_torus_add(major_radius=2.2 + i * 0.35, minor_radius=0.08, major_segments=40, minor_segments=8)
        ring = active()
        ring.rotation_euler = (tilt, 0.3 * (i + 1), 0)
        set_mat(ring, ring_mat)
        parent(ring, root, name)

    # 궤도 파편 4개
    shards = root_empty("shards")
    shards.parent = root
    for i in range(4):
        a = i * math.pi / 2
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.22, radius2=0, depth=0.55)
        s = active()
        s.location = (math.cos(a) * 2.0, math.sin(a) * 2.0, 0)
        s.rotation_euler = (0, math.radians(90), a)
        set_mat(s, shard_mat)
        parent(s, shards, f"shard-{i}")

    export(root, "boss.glb")


if __name__ == "__main__":
    make_player()
    make_drone()
    make_spitter()
    make_brute()
    make_boss()
    print("ALL_ASSETS_DONE")
    sys.exit(0)
