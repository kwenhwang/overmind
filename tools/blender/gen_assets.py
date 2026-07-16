"""OVERMIND 로우폴리 에셋 생성 v2 — blender --background --python tools/blender/gen_assets.py

디자인 언어: 어두운 장갑 셸(건메탈) + 유닛별 채도 높은 발광 코어/심 1색.
규약: 원점 = 시각적 중심(게임에서 y=0.9 배치), 정면 = Blender -Y (glTF 변환 후 three.js -Z).
각 모델은 Empty 루트 아래 파트별 오브젝트 — 게임 코드가 이름으로 파트를 찾아 회전 연출.
프리뷰 루프: tools/blender/preview.py 로 렌더해 눈으로 확인 후 반영.
출력: public/models/<name>.glb
"""
import math
import os
import sys

import bmesh
import bpy

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "models")

SHELL = (0.045, 0.05, 0.065)  # 공통 건메탈 셸


def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, emission=None, strength=2.0, metallic=0.55, rough=0.4):
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


def shell_mat(name="shell", tint=SHELL):
    """게임 카메라 거리에선 순수 건메탈이 실루엣을 잃음 — 유닛 정체성 색을 어둡게 틴트"""
    return material(name, tint, metallic=0.55, rough=0.4)


def glow_mat(name, color, strength=3.0):
    return material(name, (0.01, 0.01, 0.015), emission=color, strength=strength, rough=0.3)


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


def box(scale, loc, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = active()
    o.scale = scale
    o.location = loc
    o.rotation_euler = rot
    if bevel > 0:
        m = o.modifiers.new("bevel", "BEVEL")
        m.width = bevel
        m.segments = 2
    return o


def walk_meshes(root):
    out = []

    def rec(o):
        if o.type == "MESH":
            out.append(o)
        for c in o.children:
            rec(c)

    rec(root)
    return out


def bake_ao(root):
    """AO를 버텍스 컬러(COLOR_0)로 베이크 — three.js가 베이스 컬러에 곱해
    틈·접합부에 부드러운 음영이 생긴다 (로우폴리 '장난감 플라스틱' 인상 탈출의 핵심)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.render.bake.target = "VERTEX_COLORS"
    for o in walk_meshes(root):
        ca = o.data.color_attributes.new(name="AO", type="BYTE_COLOR", domain="CORNER")
        o.data.color_attributes.active_color = ca
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.bake(type="AO")


def export(root, filename):
    bake_ao(root)
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


# ── 플레이어: 호버 인터셉터 — 쐐기 기체 + 발광 바이저 슬릿 + 스웹트 윙 + 링 스러스터 ──
def make_player():
    clean_scene()
    shell = shell_mat(tint=(0.1, 0.32, 0.17))
    green = glow_mat("p-glow", (0.15, 1.0, 0.35), strength=3.5)

    root = root_empty("player")

    # 테이퍼 노즈 — 큐브 앞면을 bmesh로 좁혀 만든 한 덩어리 쐐기 (윗면 평평)
    bpy.ops.mesh.primitive_cube_add(size=1)
    nose = active()
    bm = bmesh.new()
    bm.from_mesh(nose.data)
    for v in bm.verts:
        if v.co.y < 0:  # 전방 절반을 안쪽으로
            v.co.x *= 0.3
            v.co.z *= 0.35
    bm.to_mesh(nose.data)
    bm.free()
    nose.scale = (0.56, 0.72, 0.28)
    nose.location = (0, -0.4, 0.02)
    set_mat(nose, shell)
    parent(nose, root, "nose")
    # 프로우 첨단 발광 스트립
    prow = box((0.16, 0.1, 0.06), (0, -0.74, 0.02))
    set_mat(prow, green)
    parent(prow, root, "prow")

    # 후방 동체 (노즈와 연결)
    hull = box((0.56, 0.66, 0.3), (0, 0.36, 0.02), bevel=0.06)
    set_mat(hull, shell)
    parent(hull, root, "hull")

    # 바이저 슬릿 (동체 전면 상단)
    visor = box((0.4, 0.1, 0.07), (0, 0.06, 0.19))
    set_mat(visor, green)
    parent(visor, root, "visor")

    # 스웹트 윙 + 윙팁 발광 (동체 측면에서 후방으로)
    for sx, name in ((1, "wing-r"), (-1, "wing-l")):
        wing = box((0.55, 0.32, 0.07), (sx * 0.52, 0.5, 0.02), rot=(0, 0, math.radians(-sx * 24)))
        set_mat(wing, shell)
        parent(wing, root, name)
        tip = box((0.12, 0.3, 0.08), (sx * 0.78, 0.6, 0.02), rot=(0, 0, math.radians(-sx * 24)))
        set_mat(tip, green)
        parent(tip, root, f"{name}-tip")

    # 링 스러스터 (동체 하부)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.22, minor_radius=0.05, major_segments=20, minor_segments=8)
    thr = active()
    thr.location = (0, 0.28, -0.24)
    set_mat(thr, green)
    parent(thr, root, "thruster")

    export(root, "player.glb")


# ── 드론: 버즈소 — 발광 눈 코어 + 장갑 X암 + 광폭 블레이드 ──
def make_drone():
    clean_scene()
    shell = shell_mat(tint=(0.34, 0.08, 0.08))
    red = glow_mat("d-glow", (1.0, 0.12, 0.08), strength=3.5)

    root = root_empty("drone")

    # 눈 코어 (셸 사이 간격을 벌려 노출)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.34)
    eye = active()
    set_mat(eye, glow_mat("d-eye", (1.0, 0.12, 0.08), strength=4.5))
    parent(eye, root, "eye")

    # 장갑 셸 (상하 피라미드 — 눈이 보이게 이격)
    for sz, name in ((1, "shell-top"), (-1, "shell-bottom")):
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.46, radius2=0.1, depth=0.34)
        sh = active()
        sh.location = (0, 0, sz * 0.42)
        if sz < 0:
            sh.rotation_euler = (math.pi, 0, 0)
        set_mat(sh, shell)
        parent(sh, root, name)

    # X자 암 4개 + 팁 발광
    for i in range(4):
        a = i * math.pi / 2 + math.pi / 4
        arm = box((0.42, 0.11, 0.08), (math.cos(a) * 0.4, math.sin(a) * 0.4, 0.28), rot=(0, 0, a))
        set_mat(arm, shell)
        parent(arm, root, f"arm-{i}")
        tip = box((0.1, 0.14, 0.1), (math.cos(a) * 0.62, math.sin(a) * 0.62, 0.28), rot=(0, 0, a))
        set_mat(tip, red)
        parent(tip, root, f"arm-tip-{i}")

    # 광폭 블레이드 — 암 아래, 바깥으로 돌출 (게임 코드가 'blades' 회전)
    blades = root_empty("blades")
    blades.parent = root
    for i in range(3):
        a = i * 2 * math.pi / 3
        bl = box((0.55, 0.26, 0.035), (math.cos(a) * 0.62, math.sin(a) * 0.62, -0.3), rot=(math.radians(12), 0, a))
        set_mat(bl, material(f"blade-{i}", (0.09, 0.09, 0.12), emission=(1.0, 0.12, 0.08), strength=0.5, metallic=0.7, rough=0.3))
        parent(bl, blades, f"blade-{i}")

    export(root, "drone.glb")


# ── 스피터: 아틸러리 팟 — 장갑 팟 + 마젠타 심 + 대구경 캐논 + 관절 삼각대 ──
def make_spitter():
    clean_scene()
    shell = shell_mat(tint=(0.24, 0.12, 0.32))
    magenta = glow_mat("s-glow", (1.0, 0.25, 0.9), strength=3.2)

    root = root_empty("spitter")

    # 팟 본체 (납작한 장갑 구)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.5)
    body = active()
    body.scale = (1.0, 1.0, 0.78)
    body.location = (0, 0.08, 0.22)
    set_mat(body, shell)
    parent(body, root, "body")

    # 적도 발광 심
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.44, depth=0.09)
    seam = active()
    seam.location = (0, 0.08, 0.22)
    set_mat(seam, magenta)
    parent(seam, root, "seam")

    # 대구경 캐논 (정면 -Y) + 머즐 링
    bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=0.17, radius2=0.22, depth=0.72)
    cannon = active()
    cannon.rotation_euler = (-math.pi / 2, 0, 0)
    cannon.location = (0, -0.52, 0.26)
    set_mat(cannon, shell)
    parent(cannon, root, "cannon")

    bpy.ops.mesh.primitive_torus_add(major_radius=0.2, minor_radius=0.05, major_segments=14, minor_segments=8)
    muz = active()
    muz.rotation_euler = (math.pi / 2, 0, 0)
    muz.location = (0, -0.9, 0.26)
    set_mat(muz, magenta)
    parent(muz, root, "muzzle")

    # 관절 삼각대 (허벅지 사선 + 정강이 수직 + 발판)
    for i in range(3):
        a = i * 2 * math.pi / 3 + math.pi / 2
        hx, hy = math.cos(a), math.sin(a)
        thigh = box((0.14, 0.5, 0.12), (hx * 0.42, hy * 0.42, -0.05),
                    rot=(math.radians(50) * hy, math.radians(-50) * hx, 0))
        set_mat(thigh, shell)
        parent(thigh, root, f"thigh-{i}")
        shin = box((0.11, 0.11, 0.55), (hx * 0.62, hy * 0.62, -0.55))
        set_mat(shin, shell)
        parent(shin, root, f"shin-{i}")
        foot = box((0.22, 0.22, 0.07), (hx * 0.62, hy * 0.62, -0.85))
        set_mat(foot, glow_mat(f"foot-{i}", (1.0, 0.25, 0.9), strength=1.2))
        parent(foot, root, f"foot-{i}")

    export(root, "spitter.glb")


# ── 브루트: 시즈 골렘 — 사다리꼴 몸통 + 거대 주먹 + 발광 가슴·아이슬릿 ──
def make_brute():
    clean_scene()
    shell = shell_mat(tint=(0.38, 0.24, 0.09))
    amber = glow_mat("b-glow", (1.0, 0.55, 0.08), strength=3.0)

    root = root_empty("brute")

    # 사다리꼴 몸통 (아래가 좁은 역사다리꼴 — 위압감)
    bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.52, radius2=0.85, depth=1.05)
    torso = active()
    torso.rotation_euler = (0, 0, math.radians(45))
    torso.scale = (1.0, 0.78, 1.0)
    torso.location = (0, 0, 0.1)
    set_mat(torso, shell)
    parent(torso, root, "torso")

    # 가슴 발광 코어 (정면 -Y)
    core = box((0.3, 0.08, 0.34), (0, -0.5, 0.28))
    set_mat(core, amber)
    parent(core, root, "core")

    # 어깨 + 팔 + 거대 주먹
    for sx, name in ((1, "r"), (-1, "l")):
        sh = box((0.42, 0.5, 0.42), (sx * 0.78, 0, 0.5), bevel=0.09)
        set_mat(sh, shell)
        parent(sh, root, f"shoulder-{name}")
        arm = box((0.2, 0.2, 0.55), (sx * 0.85, -0.08, -0.05))
        set_mat(arm, shell)
        parent(arm, root, f"arm-{name}")
        fist = box((0.34, 0.4, 0.36), (sx * 0.85, -0.12, -0.5), bevel=0.07)
        set_mat(fist, shell)
        parent(fist, root, f"fist-{name}")
        knuckle = box((0.36, 0.1, 0.1), (sx * 0.85, -0.32, -0.48))
        set_mat(knuckle, amber)
        parent(knuckle, root, f"knuckle-{name}")

    # 헤드 아이슬릿
    head = box((0.34, 0.3, 0.2), (0, -0.1, 0.78), bevel=0.05)
    set_mat(head, shell)
    parent(head, root, "head")
    eye = box((0.26, 0.06, 0.05), (0, -0.26, 0.8))
    set_mat(eye, amber)
    parent(eye, root, "eye")

    export(root, "brute.glb")


# ── 보스: 오버마인드 — 발광 코어 + 부유 장갑판 + 홍채 + 이중 링 + 궤도 파편 ──
def make_boss():
    clean_scene()
    shell = shell_mat()
    orange = glow_mat("o-core", (1.0, 0.3, 0.06), strength=1.1)
    ringm = material("o-ring", (0.12, 0.08, 0.05), emission=(1.0, 0.55, 0.2), strength=0.7, metallic=0.7)

    root = root_empty("boss")

    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1.35)
    core = active()
    set_mat(core, orange)
    parent(core, root, "core")

    # 눈 (정면 -Y) — 어두운 소켓 + 밝은 홍채: 관찰자의 정체성
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.62, depth=0.14)
    socket = active()
    socket.rotation_euler = (math.pi / 2, 0, 0)
    socket.location = (0, -1.2, 0)  # 코어에 반쯤 파묻힘
    set_mat(socket, shell)
    parent(socket, root, "eye-socket")

    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.3, depth=0.1)
    iris = active()
    iris.rotation_euler = (math.pi / 2, 0, 0)
    iris.location = (0, -1.29, 0)
    set_mat(iris, glow_mat("o-iris", (1.0, 0.85, 0.5), strength=6.0))
    parent(iris, root, "iris")

    # 부유 장갑판 8개 — 코어에서 이격된 갑주 (틈새로 발광이 새어나옴)
    plates = root_empty("plates")
    plates.parent = root
    for i in range(8):
        a = i * math.pi / 4 + math.pi / 8
        z = 0.5 if i % 2 == 0 else -0.5
        r = 1.62
        pl = box((0.95, 0.7, 0.14), (math.cos(a) * r * 0.82, math.sin(a) * r * 0.82, z),
                 rot=(math.radians(-35) * (1 if z > 0 else -1), 0, a + math.pi / 2), bevel=0.06)
        set_mat(pl, shell)
        parent(pl, plates, f"plate-{i}")

    for i, (name, tilt) in enumerate((("ring1", 0.5), ("ring2", -0.95))):
        bpy.ops.mesh.primitive_torus_add(major_radius=2.3 + i * 0.4, minor_radius=0.07, major_segments=48, minor_segments=8)
        ring = active()
        ring.rotation_euler = (tilt, 0.3 * (i + 1), 0)
        set_mat(ring, ringm)
        parent(ring, root, name)

    shards = root_empty("shards")
    shards.parent = root
    for i in range(4):
        a = i * math.pi / 2
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.24, radius2=0, depth=0.6)
        s = active()
        s.location = (math.cos(a) * 2.05, math.sin(a) * 2.05, 0)
        s.rotation_euler = (0, math.radians(90), a)
        set_mat(s, shell)
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
