"""적 모델 정적화 — blender --background --python tools/blender/destatic.py

Robot Enemy CC0 모델이 SkinnedMesh(뼈대+애니메이션)라 three.js clone 시 스켈레톤이
깨져 ANGLE/D3D11 GPU에서 렌더 실패. 애니메이션은 안 쓰므로(코드로 회전) 스킨/애니를
제거해 정적 메시로 재익스포트한다. bind(rest) 포즈 형태로 고정됨.
"""
import os
import bpy

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "models")
TARGETS = ["drone", "spitter", "brute", "boss"]  # player는 이미 정적(skins=0)

for name in TARGETS:
    path = os.path.join(MODELS_DIR, f"{name}.glb")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    # 스킨/애니 없이 재익스포트 → 현재(rest) 포즈로 정점 고정, SkinnedMesh → 정적 Mesh
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_skins=False,
        export_animations=False,
        export_apply=True,
    )
    print(f"destaticized {name}")

print("DESTATIC_DONE")
