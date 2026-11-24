# Builds the detailed 3D parts of the scene and exports them as one glTF file for the website and the card.
# Run: npm run assets   (needs Blender 4.2 or newer; runs in the background and never touches an open file)
#
# All coordinates are written in three.js space (y up, the house front faces +z) so they match LAYOUTS in scene.js.
# Each part is a root node: detached, terraced, car, battery, charger. Static meshes are merged per material.
# Some material names are swapped for the scene's own live materials at load time:
#   glass (windows that light up at night), lamp (street lamps, headlights), pine (seasonal colour), brick (canvas texture).
import bpy, bmesh, math, random, sys
from mathutils import Matrix, Vector

OUT = sys.argv[sys.argv.index('--') + 1]
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)


def lin(c):  # sRGB byte to linear, which is what Principled Base Color and glTF expect
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


MATS = {}


def mat(name, hexc, rough=0.8, metal=0.0, emit=0.0):
    if name in MATS:
        return name
    m = bpy.data.materials.new(name)
    if hasattr(m, 'use_nodes') and not m.use_nodes:
        m.use_nodes = True
    p = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    rgb = [lin(int(hexc[i:i + 2], 16)) for i in (1, 3, 5)]
    p.inputs['Base Color'].default_value = (*rgb, 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emit:
        p.inputs['Emission Color'].default_value = (*rgb, 1)
        p.inputs['Emission Strength'].default_value = emit
    MATS[name] = m
    return name


PARTS = {}  # part -> material -> bmesh, in three.js coordinates


def target(part, m):
    return PARTS.setdefault(part, {}).setdefault(m, bmesh.new())


def put(part, m, tmp, mtx):
    bmesh.ops.transform(tmp, matrix=mtx, verts=tmp.verts)
    me = bpy.data.meshes.new('tmp')
    tmp.to_mesh(me)
    tmp.free()
    target(part, m).from_mesh(me)  # appends to what is already there
    bpy.data.meshes.remove(me)


def place(x, y, z, rx=0.0, ry=0.0, rz=0.0, base=None):
    m = Matrix.Translation((x, y, z)) @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X') @ Matrix.Rotation(rz, 4, 'Z')
    return base @ m if base else m


def box(part, m, w, h, d, x, y, z, bevel=0.0, seg=1, **rot):
    tmp = bmesh.new()
    bmesh.ops.create_cube(tmp, size=1)
    bmesh.ops.scale(tmp, vec=(w, h, d), verts=tmp.verts)
    if bevel:
        bmesh.ops.bevel(tmp, geom=list(tmp.edges), offset=min(bevel, w / 2.2, h / 2.2, d / 2.2), segments=seg,
                        affect='EDGES', profile=0.5, clamp_overlap=True)
    put(part, m, tmp, place(x, y, z, **rot))


def cyl(part, m, r1, r2, h, x, y, z, seg=12, **rot):  # along local y
    tmp = bmesh.new()
    bmesh.ops.create_cone(tmp, cap_ends=True, segments=seg, radius1=r1, radius2=r2, depth=h)
    bmesh.ops.transform(tmp, matrix=Matrix.Rotation(-math.pi / 2, 4, 'X'), verts=tmp.verts)
    put(part, m, tmp, place(x, y, z, **rot))


def ball(part, m, r, x, y, z, sub=1, sy=1.0, jitter=0.0, **rot):
    tmp = bmesh.new()
    bmesh.ops.create_icosphere(tmp, subdivisions=sub, radius=r)
    for v in tmp.verts:
        v.co *= 1 + random.uniform(-jitter, jitter)
        v.co.y *= sy
    put(part, m, tmp, place(x, y, z, **rot))


def prism(part, m, pts, width, x, y, z, bevel=0.0, seg=1, taper=None, **rot):
    """Side profile pts as (z, y), extruded along x by width. taper=(y0, y1, k) narrows it by k at height y1."""
    tmp = bmesh.new()
    vs = [tmp.verts.new((-width / 2, py, pz)) for pz, py in pts]
    f = tmp.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(tmp, geom=[f])
    bmesh.ops.translate(tmp, vec=(width, 0, 0), verts=[e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    if bevel:
        bmesh.ops.bevel(tmp, geom=list(tmp.edges), offset=bevel, segments=seg, affect='EDGES', profile=0.5, clamp_overlap=True)
    if taper:
        y0, y1, k = taper
        for v in tmp.verts:
            v.co.x *= 1 - k * max(0.0, min(1.0, (v.co.y - y0) / (y1 - y0)))
    put(part, m, tmp, place(x, y, z, **rot))


def torus(part, m, R, r, x, y, z, seg=24, ring=6, **rot):  # ring in the local xy plane
    tmp = bmesh.new()
    vs = [[tmp.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
           for b in (2 * math.pi * j / ring for j in range(ring))] for a in (2 * math.pi * i / seg for i in range(seg))]
    for i in range(seg):
        for j in range(ring):
            tmp.faces.new((vs[i][j], vs[(i + 1) % seg][j], vs[(i + 1) % seg][(j + 1) % ring], vs[i][(j + 1) % ring]))
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    put(part, m, tmp, place(x, y, z, **rot))


def rod(part, m, a, b, r, seg=6):  # thin tube from point a to point b
    a, b = Vector(a), Vector(b)
    tmp = bmesh.new()
    bmesh.ops.create_cone(tmp, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=(b - a).length)
    q = (b - a).to_track_quat('Z', 'Y')
    put(part, m, tmp, Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4())


def bins(part, x, z, colours):  # Dutch wheelie bins
    for k, c in enumerate(colours):
        bx = x + k * 0.7
        box(part, mat(f'bin_{c}', c, 0.6), 0.58, 1.0, 0.7, bx, 0.55, z, bevel=0.05, seg=2)
        box(part, mat(f'bin_{c}', c, 0.6), 0.64, 0.06, 0.76, bx, 1.08, z + 0.02, bevel=0.02)
        for sx in (-1, 1):
            cyl(part, mat('tyre', '#16181c', 0.9), 0.09, 0.09, 0.06, bx + sx * 0.25, 0.09, z - 0.3, seg=10, rz=math.pi / 2)


# Shared colours (sRGB, as in scene.js)
TRIM = mat('trim', '#f4f1ea', 0.6)
DARK = mat('dark', '#3a3f47', 0.6)
GLASS = mat('glass', '#9cc7e8', 0.3)
LAMP = mat('lamp', '#fff3d6', 0.5)
PINE = mat('pine', '#3f8f4f')
BARK = mat('bark', '#6b4a2f', 0.9)
LEAF = mat('leaf', '#4c9a52', 0.9)
CONCRETE = mat('concrete', '#c9c4b8', 0.9)
METAL = mat('metal', '#9aa1a9', 0.4, 0.15)  # low metalness: the scene has no environment map, so metal turns dark
GOLD = mat('gold', '#d4af37', 0.35, 0.3)


def window(part, w, h, x, y, z, ry=0.0, bars=True, glass=GLASS, frame=TRIM, sill=TRIM):
    """Window in a wall facing +z (turned by ry), z is the wall surface."""
    b = place(x, y, z, ry=ry)
    box(part, glass, w, h, 0.06, 0, 0, -0.01, base=b)
    t = 0.09
    for sx in (-1, 1):
        box(part, frame, t, h + 2 * t, 0.1, sx * (w / 2 + t / 2), 0, 0.02, base=b)
        box(part, frame, w, t, 0.1, 0, sx * (h / 2 + t / 2), 0.02, base=b)
    if bars:
        box(part, frame, 0.05, h, 0.06, 0, 0, 0.02, base=b)
        box(part, frame, w, 0.05, 0.06, 0, h * 0.18, 0.02, base=b)
    box(part, sill, w + 0.36, 0.07, 0.22, 0, -h / 2 - t - 0.03, 0.08, bevel=0.015, base=b)


def pine(part, x, z, s):
    cyl(part, BARK, 0.2 * s, 0.14 * s, 1.4 * s, x, 0.7 * s, z, seg=8)
    for r, h, y0 in ((1.35, 1.6, 0.9), (1.05, 1.45, 1.75), (0.7, 1.3, 2.6)):
        cyl(part, PINE, r * s, 0.02, h * s, x, (y0 + h / 2) * s, z, seg=9, ry=random.uniform(0, 1))


def lamp_post(part, x, z):
    pole = mat('pole', '#3a3f47', 0.5, 0.2)
    cyl(part, pole, 0.1, 0.06, 4.3, x, 2.15, z, seg=10)
    cyl(part, pole, 0.14, 0.14, 0.3, x, 0.15, z, seg=10)
    for k in range(4):  # arm curving over the road
        a = k / 3 * math.pi / 2
        box(part, pole, 0.08, 0.08, 0.32, x, 4.3 + math.sin(a) * 0.25, z + 0.12 + k * 0.22, rx=-a * 0.6)
    box(part, pole, 0.36, 0.1, 0.6, x, 4.5, z + 0.9, bevel=0.03, seg=2)
    box(part, LAMP, 0.3, 0.05, 0.5, x, 4.43, z + 0.9)


def bush(part, x, y, z, s=1.0):
    ball(part, LEAF, 0.42 * s, x, y, z, sub=1, sy=0.85, jitter=0.12)


def cabinet(part, x, z, w=0.8, d=0.5):
    grey = mat('cabinet', '#8b9199', 0.6, 0.2)
    box(part, grey, w, 1.0, d, x, 0.5, z, bevel=0.03, seg=2)
    box(part, grey, w + 0.08, 0.06, d + 0.08, x, 1.03, z, bevel=0.02)
    box(part, DARK, 0.02, 0.7, 0.01, x, 0.5, z + d / 2 + 0.005)  # door split
    box(part, DARK, w - 0.1, 0.03, 0.01, x, 0.2, z + d / 2 + 0.005)  # vent


# ---------- Detached house: x -6..2, z -4..2, walls 3.2 high, gable roof along x ----------
P = 'detached'
WALL = mat('wall_cream', '#f2e6d0', 0.9)
ROOF = mat('roof_tile', '#b5533c', 0.75)
TILE = mat('roof_tile_edge', '#9a4431', 0.75)
box(P, WALL, 8, 3.2, 6, -2, 1.6, -1, bevel=0.03)
box(P, mat('plinth_cream', '#b9ab94', 0.9), 8.12, 0.35, 6.12, -2, 0.175, -1, bevel=0.02)
prism(P, WALL, [(-3.0, 0), (3.0, 0), (0, 1.95)], 7.98, -2, 3.2, -1)  # gable walls
a = math.atan(2.2 / 3.4)
L = math.hypot(3.4, 2.2) + 0.45
for side in (1, -1):  # roof slabs, top surface through the eave line and the ridge, like the panels expect
    d = Vector((0, -math.sin(a), side * math.cos(a)))  # down the slope in (x, y, z)
    n = Vector((0, math.cos(a), side * math.sin(a)))
    ridge = Vector((-2, 5.4, -1))
    c = ridge + d * (L / 2) - n * 0.09
    box(P, ROOF, 8.8, 0.18, L, c.x, c.y, c.z, rx=side * a)
    for k in range(1, 14):  # tile courses
        p = ridge + d * (k * 0.32) + n * 0.012
        box(P, TILE, 8.8, 0.024, 0.06, p.x, p.y, p.z, rx=side * a)
    for ex in (-6.42, 2.42):  # barge boards
        q = ridge + d * (L / 2) - n * 0.05
        box(P, TRIM, 0.07, 0.26, L, ex, q.y, q.z, rx=side * a)
    e = ridge + d * L - n * 0.12  # fascia and gutter along the eave
    box(P, TRIM, 8.9, 0.22, 0.05, -2, e.y, e.z + side * 0.02)
    cyl(P, TRIM, 0.08, 0.08, 8.9, -2, e.y - 0.08, e.z + side * 0.1, seg=10, rz=math.pi / 2)
box(P, mat('ridge', '#8e3c2b', 0.7), 8.9, 0.14, 0.32, -2, 5.43, -1, bevel=0.04, seg=2)
# Downpipe from the front gutter to the ground, at the corner
pipe_z = 2 + 0.05
cyl(P, TRIM, 0.045, 0.045, 2.75, 1.82, 1.5, pipe_z, seg=8)
box(P, TRIM, 0.09, 0.09, 0.72, 1.82, 2.9, 2.45)
# Chimney on the back slope, clear of the panels
CH = mat('chimney', '#9c4a36', 0.85)
box(P, CH, 0.7, 2.1, 0.7, -4.4, 4.95, -2.4, bevel=0.02)
box(P, DARK, 0.86, 0.12, 0.86, -4.4, 6.04, -2.4, bevel=0.02)
cyl(P, DARK, 0.1, 0.1, 0.3, -4.3, 6.2, -2.4, seg=8)
# Front: door with panels, canopy, steps, wall lamp, two windows
DOOR = mat('door_wood', '#7a4b2a', 0.7)
box(P, TRIM, 1.32, 2.2, 0.08, -2, 1.36, 2.0)
box(P, DOOR, 1.08, 2.02, 0.1, -2, 1.32, 2.02)
for dx in (-0.25, 0.25):
    for dy, hh in ((0.85, 0.7), (1.8, 0.55)):
        box(P, mat('door_panel', '#6a3f22', 0.7), 0.38, hh, 0.04, -2 + dx, dy, 2.08, bevel=0.015)
box(P, GOLD, 0.06, 0.06, 0.1, -1.62, 1.3, 2.12)
box(P, TRIM, 1.7, 0.08, 0.7, -2, 2.62, 2.33, bevel=0.02)
for sx in (-0.7, 0.7):
    box(P, TRIM, 0.06, 0.3, 0.06, -2 + sx, 2.45, 2.62, rx=0.6)
box(P, CONCRETE, 1.7, 0.16, 0.7, -2, 0.08, 2.35, bevel=0.02)
box(P, CONCRETE, 1.5, 0.16, 0.38, -2, 0.24, 2.2, bevel=0.02)
box(P, LAMP, 0.12, 0.2, 0.08, -1.1, 2.1, 2.06, bevel=0.02)
box(P, DARK, 0.16, 0.05, 0.1, -1.1, 2.22, 2.07)
for x in (-4.6, 0.4):
    window(P, 1.5, 1.2, x, 1.9, 2.0)
window(P, 1.2, 1.1, 2.0, 2.1, -0.7, ry=math.pi / 2)  # right side
window(P, 1.2, 1.1, -6.0, 2.1, -1.2, ry=-math.pi / 2)  # left side
for x in (-4.4, 0.2):
    window(P, 1.3, 1.1, x, 2.0, -4.0, ry=math.pi)  # back
box(P, mat('meter', '#e8e8e8', 0.5), 0.25, 0.5, 0.4, 2.12, 1.5, 0.7, bevel=0.03)
# Garden: bushes by the path, a hedge along the back and side, pines, a street lamp
for x, z, s in ((-3.2, 4.4, 0.8), (-0.8, 4.4, 0.8), (-3.2, 6.6, 0.8), (-0.8, 6.6, 0.8), (8.3, -3, 1.2), (8.7, -2.1, 0.9)):
    bush(P, x, 0.3 * s / 0.8, z, s)
HEDGE = mat('hedge', '#356f3f', 0.95)
box(P, HEDGE, 25, 0.85, 0.55, 0, 0.42, -10.6, bevel=0.18, seg=3)
box(P, HEDGE, 0.55, 0.85, 16, -12.6, 0.42, -2.6, bevel=0.18, seg=3)
for x, z, s in ((-10, -6, 1.2), (-8.5, -1, 0.9), (9.5, -7, 1.3), (10.5, 4, 1)):
    pine(P, x, z, s)
lamp_post(P, -12.5, 7.8)
bins(P, 8.3, 7.0, ['#2e7d32', '#6d7378'])  # green and grey bins by the driveway
MAILBOX = mat('mailbox', '#2b2f36', 0.5, 0.2)
cyl(P, MAILBOX, 0.04, 0.04, 1.0, -3.15, 0.5, 7.7, seg=8)
box(P, MAILBOX, 0.3, 0.35, 0.45, -3.15, 1.12, 7.7, bevel=0.05, seg=2)
box(P, GOLD, 0.2, 0.02, 0.01, -3.15, 1.2, 7.93)
BENCH = mat('bench_wood', '#8a6a4a', 0.85)
for k in range(3):  # garden bench by the back hedge
    box(P, BENCH, 1.6, 0.05, 0.12, -4, 0.45, -9.75 + k * 0.15, bevel=0.01)
    box(P, BENCH, 1.6, 0.12, 0.04, -4, 0.62 + k * 0.15, -10.05, bevel=0.01)
for sx in (-0.7, 0.7):
    box(P, DARK, 0.05, 0.45, 0.4, -4 + sx, 0.22, -9.6)
cyl(P, mat('manhole', '#4b4f55', 0.6, 0.2), 0.35, 0.35, 0.02, 2.0, 0.07, 9.5, seg=20)
# Grid pole with a crossarm, braces, insulators and a connection box
WOOD = mat('pole_wood', '#6b5846', 0.95)
cyl(P, WOOD, 0.17, 0.12, 6, -9, 3, 7.2, seg=10)
box(P, WOOD, 2.4, 0.18, 0.18, -9, 5.4, 7.2)
for sx in (-1, 1):
    box(P, WOOD, 0.08, 0.9, 0.08, -9 + sx * 0.35, 5.0, 7.2, rz=sx * 0.7)
PORC = mat('porcelain', '#dfe6ea', 0.3)
for x in (-10, -9.4, -8.6, -8):
    for k in range(3):
        cyl(P, PORC, 0.09 - k * 0.012, 0.09 - k * 0.012, 0.06, x, 5.55 + k * 0.08, 7.2, seg=10)
cyl(P, mat('transformer', '#7d848c', 0.5, 0.3), 0.3, 0.3, 0.8, -9, 4.3, 7.55, seg=14)
cabinet(P, -9, 6.5, 0.9, 0.7)

# ---------- Terraced town house: x -3..3, z -6..2, 6.4 high, flat roof; grey neighbours ----------
P = 'terraced'
BRICK = mat('brick', '#b8674a', 0.9)  # swapped for the canvas brick texture; uvs are set below in metres / 1.6
box(P, BRICK, 6, 6.4, 8, 0, 3.2, -2)
box(P, mat('roof_edge', '#4a4d52', 0.7), 6.2, 0.25, 8.2, 0, 6.5, -2)
box(P, METAL, 6.24, 0.05, 0.14, 0, 6.64, 2.05)
box(P, TRIM, 6.2, 0.22, 0.2, 0, 6.2, 2.06)
for k in range(19):  # dentils under the cornice
    box(P, TRIM, 0.12, 0.1, 0.08, -2.7 + k * 0.3, 6.04, 2.04)
box(P, mat('plinth_brick', '#5d4038', 0.9), 6.05, 0.4, 0.12, 0, 0.2, 2.03)
LINTEL = mat('lintel', '#8e4a35', 0.9)
SILL = mat('sill_stone', '#d9d2c3', 0.8)
DOORG = mat('door_green', '#2f4a3a', 0.6)
box(P, TRIM, 1.3, 2.75, 0.08, -1.6, 1.53, 2.0)
box(P, DOORG, 1.1, 2.1, 0.1, -1.6, 1.21, 2.02)
for dy, hh in ((0.7, 0.75), (1.65, 0.65)):
    for dx in (-0.24, 0.24):
        box(P, mat('door_green_panel', '#264032', 0.6), 0.36, hh, 0.04, -1.6 + dx, dy, 2.08, bevel=0.015)
box(P, GLASS, 1.1, 0.4, 0.06, -1.6, 2.58, 2.01)  # transom
box(P, TRIM, 1.1, 0.06, 0.1, -1.6, 2.33, 2.03)
box(P, GOLD, 0.06, 0.06, 0.1, -1.22, 1.2, 2.1)
box(P, GOLD, 0.16, 0.05, 0.04, -1.6, 1.55, 2.09)  # letterbox
box(P, mat('house_number', '#1f3a5f', 0.5), 0.2, 0.2, 0.03, -0.75, 2.4, 2.02)
box(P, mat('stoop', '#bdb6a8', 0.8), 1.5, 0.16, 0.45, -1.6, 0.08, 2.25, bevel=0.02)
window(P, 1.5, 1.2, 1.1, 2.2, 2.0, sill=SILL)
box(P, LINTEL, 1.9, 0.18, 0.06, 1.1, 2.98, 2.02)
for y in (3.9, 5.4):
    for x in (-1.4, 1.4):
        window(P, 1.4, 1.1, x, y, 2.0, sill=SILL)
        box(P, LINTEL, 1.8, 0.18, 0.06, x, y + 0.73, 2.02)
box(P, mat('planter_wood', '#6b5846', 0.9), 1.5, 0.22, 0.25, -1.4, 3.18, 2.2)  # flower box under an upper window
for k in range(5):
    ball(P, mat('flower_red', '#c0392b', 0.8), 0.1, -1.95 + k * 0.28, 3.38, 2.22, sub=1, jitter=0.1)
box(P, mat('meter', '#e8e8e8', 0.5), 0.3, 0.45, 0.12, 0.4, 1.3, 2.05, bevel=0.02)
cyl(P, METAL, 0.05, 0.05, 6.3, 2.85, 3.3, 2.08, seg=8)  # downpipe
# Facade garden with hollyhocks, very Dutch
box(P, mat('planter_wood', '#6b5846', 0.9), 0.6, 0.12, 0.4, -2.6, 0.12, 2.2)
for k, (dx, hgt) in enumerate(((-0.15, 1.5), (0.05, 1.9), (0.18, 1.3))):
    cyl(P, LEAF, 0.025, 0.02, hgt, -2.6 + dx, 0.18 + hgt / 2, 2.2, seg=5)
    for j in range(4):
        ball(P, mat('flower_pink', '#d16a8f', 0.8), 0.08, -2.6 + dx + (0.06 if j % 2 else -0.06), 0.18 + hgt * (0.55 + j * 0.13), 2.24, sub=1, jitter=0.15)
    ball(P, LEAF, 0.16, -2.6 + dx, 0.32, 2.22, sub=1, jitter=0.2)
cyl(P, METAL, 0.06, 0.06, 0.5, 2.6, 6.85, -1.2, seg=8)  # roof vent
# Grey neighbours on both sides
GREYS = [mat('grey_wall_a', '#c4c6c9', 0.9), mat('grey_wall_b', '#bcbfc3', 0.9)]
GEDGE = mat('grey_edge', '#8d9094', 0.7)
GGLASS = mat('grey_glass', '#9aa3ad', 0.35)
GTRIM = mat('grey_trim', '#dcdee0', 0.7)
for i, (cx, h) in enumerate(((-6, 5.6), (-12, 7), (6, 6.9), (12, 5.8))):
    box(P, GREYS[i % 2], 6, h, 8, cx, h / 2, -2)
    box(P, GEDGE, 6.05, 0.22, 8.1, cx, h + 0.06, -2)
    box(P, GTRIM, 6.05, 0.16, 0.14, cx, h - 0.35, 2.04)
    box(P, GEDGE, 6.02, 0.35, 0.1, cx, 0.175, 2.02)
    box(P, GTRIM, 1.25, 2.25, 0.06, cx - 1.6, 1.12, 2.0)
    box(P, GEDGE, 1.1, 2.1, 0.1, cx - 1.6, 1.05, 2.02)
    box(P, mat('stoop', '#bdb6a8', 0.8), 1.4, 0.14, 0.4, cx - 1.6, 0.07, 2.22)
    y = 2.2
    while y < h - 0.8:
        for x in (-1.4, 1.4):
            if y > 3 or x > 0:
                window(P, 1.4, 1.1, cx + x, y, 2.0, glass=GGLASS, frame=GTRIM, sill=GTRIM, bars=False)
        y += 1.6
for x, z, s in ((-10, -9, 1.2), (9, -9.5, 1.3)):
    pine(P, x, z, s)
OXBLOOD = mat('bollard', '#5b2a24', 0.5)
for x in (-15, -12, -9, 8.5, 11.5, 14.5):  # canal-street bollards
    cyl(P, OXBLOOD, 0.13, 0.1, 0.75, x, 0.45, 3.75, seg=12)
    cyl(P, OXBLOOD, 0.14, 0.14, 0.06, x, 0.65, 3.75, seg=12)
    ball(P, OXBLOOD, 0.1, x, 0.83, 3.75, sub=2)
lamp_post(P, -10.5, 3.6)
cabinet(P, -5, 3.6)
# A Dutch bike leaning on the neighbour's wall, bins and street furniture
BIKE = mat('bike_frame', '#1d1f22', 0.5)
bx, bz = 8.3, 2.45
for wx in (-0.52, 0.52):
    torus(P, mat('tyre', '#16181c', 0.9), 0.33, 0.028, bx + wx, 0.36, bz)
    for k in range(6):
        rod(P, METAL, (bx + wx, 0.36, bz), (bx + wx + 0.3 * math.cos(k * math.pi / 3), 0.36 + 0.3 * math.sin(k * math.pi / 3), bz), 0.006, seg=4)
A, B, C, D, E, F = ((bx - 0.52, 0.36, bz), (bx + 0.52, 0.36, bz), (bx - 0.05, 0.3, bz), (bx - 0.22, 0.86, bz), (bx + 0.36, 0.92, bz), (bx + 0.42, 0.62, bz))
for a, b in ((A, C), (A, D), (C, D), (D, E), (C, F), (F, B), (E, F)):
    rod(P, BIKE, a, b, 0.022)
box(P, mat('saddle', '#5a3b22', 0.7), 0.24, 0.05, 0.12, bx - 0.24, 0.93, bz, bevel=0.02)
rod(P, BIKE, (bx + 0.34, 1.0, bz - 0.28), (bx + 0.34, 1.0, bz + 0.28), 0.015)
box(P, BIKE, 0.42, 0.03, 0.16, bx - 0.5, 0.72, bz)  # rear rack
rod(P, BIKE, (bx - 0.7, 0.72, bz), (bx - 0.52, 0.36, bz), 0.012)
bins(P, 13.5, 2.55, ['#6d7378', '#2e7d32'])
for x in (-6.5, 6.5):  # drain grates by the curb
    box(P, mat('grate', '#3b3f45', 0.5, 0.3), 0.6, 0.02, 0.3, x, 0.065, 4.3)
cyl(P, mat('manhole', '#4b4f55', 0.6, 0.2), 0.35, 0.35, 0.02, 1.5, 0.065, 7.3, seg=20)
SIGN = mat('sign_pole', '#9aa1a9', 0.5, 0.1)
cyl(P, SIGN, 0.04, 0.04, 2.4, 15.8, 1.2, 3.8, seg=8)
box(P, mat('sign_blue', '#1f5fa8', 0.5), 0.5, 0.5, 0.03, 15.8, 2.3, 3.82, bevel=0.03, seg=2)
box(P, TRIM, 0.2, 0.3, 0.01, 15.8, 2.3, 3.84)

# ---------- Car: an electric crossover with its own origin, front +z, wheels at z +-1.4 as scene.js expects ----------
P = 'car'
BODY = mat('car_body', '#f4f5f7', 0.25, 0.2)
CTRIM = mat('car_trim', '#2a2d33', 0.5)
# Smooth closed nose (no grille), long glass cabin, short sloping tail
prism(P, BODY, [(-2.3, 0.3), (2.25, 0.3), (2.36, 0.48), (2.36, 0.66), (2.22, 0.82), (1.85, 0.92), (1.15, 1.0), (-1.9, 1.04),
                (-2.28, 0.98), (-2.36, 0.78), (-2.34, 0.5)], 1.9, 0, 0, 0, bevel=0.1, seg=3)
prism(P, mat('car_glass', '#1b2330', 0.08), [(1.25, 0.98), (0.2, 1.54), (-0.9, 1.6), (-1.65, 1.46), (-2.2, 1.04)], 1.8, 0, 0, 0,
      bevel=0.16, seg=4, taper=(1.0, 1.6, 0.22))  # glass cabin that narrows to the roof
box(P, CTRIM, 1.86, 0.04, 3.2, 0, 1.03, -0.45, bevel=0.02)  # black window line
box(P, CTRIM, 1.94, 0.2, 4.62, 0, 0.4, 0, bevel=0.08, seg=2)  # black cladding around the bottom
box(P, CTRIM, 1.2, 0.08, 0.05, 0, 0.5, 2.36, bevel=0.02)  # small lower air intake
box(P, CTRIM, 1.7, 0.1, 0.04, 0, 0.79, 2.3, bevel=0.02)  # dark band so the light bar reads in daylight
box(P, LAMP, 1.6, 0.035, 0.05, 0, 0.8, 2.31, bevel=0.015)  # front light bar
for sx in (-1, 1):
    box(P, LAMP, 0.3, 0.06, 0.05, sx * 0.66, 0.77, 2.32, bevel=0.02)
box(P, mat('tail', '#b3261e', 0.4, 0, 2.0), 1.7, 0.06, 0.05, 0, 0.88, -2.34, bevel=0.02)  # rear light bar
for sx in (-1, 1):
    box(P, BODY, 0.1, 0.1, 0.22, sx * 1.0, 1.05, 1.0, bevel=0.04, seg=2)  # mirrors
    box(P, CTRIM, 0.08, 0.04, 0.2, sx * 1.0, 1.0, 1.0)
    for hz in (0.45, -0.75):
        box(P, CTRIM, 0.01, 0.035, 0.22, sx * 0.957, 0.86, hz)  # flush door handles
    box(P, CTRIM, 0.008, 0.6, 0.01, sx * 0.955, 0.68, -0.15)  # door gap
    for wz in (1.4, -1.4):
        cyl(P, CTRIM, 0.46, 0.46, 0.02, sx * 0.956, 0.38, wz, seg=24, rz=math.pi / 2)  # wheel arch shadow
        cyl(P, mat('tyre', '#16181c', 0.9), 0.37, 0.37, 0.26, sx * 0.88, 0.37, wz, seg=24, rz=math.pi / 2)
        cyl(P, mat('rim', '#c4c8ce', 0.35, 0.2), 0.28, 0.28, 0.27, sx * 0.88, 0.37, wz, seg=20, rz=math.pi / 2)  # aero cover
        cyl(P, CTRIM, 0.08, 0.08, 0.28, sx * 0.88, 0.37, wz, seg=12, rz=math.pi / 2)
        for k in range(5):
            a = k * 2 * math.pi / 5
            box(P, CTRIM, 0.02, 0.12, 0.04, sx * 1.015, 0.37 + math.cos(a) * 0.19, wz + math.sin(a) * 0.19, rx=-a)

# ---------- Battery: LEDs stay in scene.js on the +x face ----------
P = 'battery'
box(P, mat('battery_white', '#e9edf2', 0.45), 0.5, 1.5, 1.1, 0, 0.84, 0, bevel=0.06, seg=3)
box(P, DARK, 0.46, 0.09, 1.0, 0, 0.045, 0, bevel=0.02)
box(P, mat('battery_lid', '#c9cfd6', 0.45), 0.54, 0.07, 1.14, 0, 1.6, 0, bevel=0.03, seg=2)
box(P, mat('battery_panel', '#2a2d33', 0.3), 0.02, 1.4, 0.82, 0.255, 0.85, 0, bevel=0.01)
for k in range(6):
    box(P, DARK, 0.02, 0.03, 0.6, -0.255, 0.4 + k * 0.12, 0)  # vents on the back

# ---------- Charger post: the LED ring at y 1.1 stays in scene.js ----------
P = 'charger'
box(P, mat('charger_white', '#e9edf2', 0.45), 0.25, 1.2, 0.25, 0, 0.6, 0, bevel=0.04, seg=2)
box(P, DARK, 0.4, 0.06, 0.4, 0, 0.03, 0, bevel=0.02)
box(P, mat('charger_face', '#2a2d33', 0.3), 0.16, 0.3, 0.02, 0, 0.8, 0.13, bevel=0.01)
cyl(P, DARK, 0.06, 0.06, 0.18, 0, 0.55, 0.16, seg=10, rx=math.pi / 2)  # holster

# ---------- Parts used as geometry by scene.js and season.js (they keep their own live materials) ----------
P = 'panel'  # aluminium frame and rails around one 0.88 by 1.12 panel, facing +z
for sx in (-1, 1):
    box(P, METAL, 0.035, 1.16, 0.075, sx * 0.457, 0, 0.005)
    box(P, METAL, 0.88, 0.035, 0.075, 0, sx * 0.577, 0.005)
for sy in (-0.3, 0.3):
    box(P, METAL, 0.84, 0.05, 0.04, 0, sy, -0.05)
P = 'tree'  # trunk that forks into branches, scaled by the tree size
cyl(P, BARK, 0.24, 0.17, 1.9, 0, 0.95, 0, seg=9)
for k, (ry, tilt, ln) in enumerate(((0, 0.6, 1.3), (2.1, 0.55, 1.2), (4.2, 0.7, 1.1), (1.0, 0.2, 1.2), (3.2, 0.35, 1.0))):
    base = Vector((0, 1.7 + 0.1 * (k % 2), 0))
    tip = base + Vector((math.sin(tilt) * math.cos(ry), math.cos(tilt), math.sin(tilt) * math.sin(ry))) * ln
    rod(P, BARK, base, tip, 0.07 - 0.01 * (k % 3), seg=6)
    for t in (-0.6, 0.6):  # twigs
        rod(P, BARK, tip, tip + Vector((math.cos(ry + t) * 0.35, 0.4, math.sin(ry + t) * 0.35)), 0.025, seg=4)
P = 'crown'  # a cluster of leafy lumps, about 1.3 across like the old sphere
for cx, cy, cz, r in ((0, 0.1, 0, 0.95), (0.6, -0.15, 0.25, 0.7), (-0.55, -0.1, 0.35, 0.7), (0.1, 0.55, -0.3, 0.7), (-0.2, -0.25, -0.6, 0.65),
                      (0.45, 0.35, -0.5, 0.55), (-0.5, 0.45, 0.1, 0.55)):
    ball(P, LEAF, r, cx, cy, cz, sub=2, jitter=0.12)
P = 'snowman'
SNOW = mat('snow', '#f7f9fb', 0.9)
for r, y in ((0.55, 0.5), (0.4, 1.25), (0.28, 1.8)):
    ball(P, SNOW, r, 0, y, 0, sub=2, jitter=0.03)
COAL = mat('coal', '#1d1f22', 0.9)
cyl(P, mat('carrot', '#e67e22', 0.7), 0.06, 0.0, 0.3, 0, 1.8, 0.38, seg=8, rx=math.pi / 2)
for x in (-0.1, 0.1):
    ball(P, COAL, 0.04, x, 1.9, 0.25, sub=1)
for k in range(3):
    ball(P, COAL, 0.045, 0, 1.15 + k * 0.15, 0.39 - abs(k - 1) * 0.02, sub=1)
for k in range(5):  # smile
    ball(P, COAL, 0.025, -0.1 + k * 0.05, 1.71 - 0.03 * (1 - abs(k - 2) / 2), 0.265, sub=1)
SCARF = mat('scarf', '#c0392b', 0.8)
torus(P, SCARF, 0.3, 0.07, 0, 1.5, 0, rx=math.pi / 2)
box(P, SCARF, 0.12, 0.4, 0.05, 0.15, 1.35, 0.3, rz=0.15)
cyl(P, COAL, 0.3, 0.3, 0.04, 0, 2.03, 0, seg=16)  # hat brim
cyl(P, COAL, 0.19, 0.19, 0.32, 0, 2.2, 0, seg=16)
cyl(P, mat('hat_band', '#8e2c22', 0.7), 0.195, 0.195, 0.06, 0, 2.08, 0, seg=16)
for sx in (-1, 1):  # stick arms
    rod(P, BARK, (sx * 0.35, 1.3, 0), (sx * 0.95, 1.65, 0.05), 0.025)
    rod(P, BARK, (sx * 0.8, 1.56, 0.04), (sx * 0.95, 1.8, 0.0), 0.015)
P = 'pumpkin'  # ribbed, about the size of the old sphere
tmp = bmesh.new()
bmesh.ops.create_uvsphere(tmp, u_segments=32, v_segments=14, radius=0.32)
for v in tmp.verts:
    ang = math.atan2(v.co.z, v.co.x)
    v.co.x *= 1 - 0.07 * (0.5 + 0.5 * math.cos(ang * 10))
    v.co.z *= 1 - 0.07 * (0.5 + 0.5 * math.cos(ang * 10))
    v.co.y *= 0.75
put(P, mat('pumpkin_orange', '#e67e22', 0.6), tmp, Matrix())

# ---------- Turn the parts into objects and export ----------
SMOOTH = {'car_body', 'car_glass', 'tyre', 'rim', 'snow', 'pumpkin_orange', 'bin_#2e7d32', 'bin_#6d7378'}
TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))  # three (x, y, z) -> Blender (x, -z, y)
for part, by_mat in PARTS.items():
    root = bpy.data.objects.new(part, None)
    bpy.context.scene.collection.objects.link(root)
    for m, bm in by_mat.items():
        if m == BRICK:  # wall uvs in metres / 1.6, matching the canvas brick texture repeat
            uv = bm.loops.layers.uv.verify()
            for f in bm.faces:
                n = f.normal
                for loop in f.loops:
                    v = loop.vert.co
                    loop[uv].uv = ((v.x if abs(n.z) >= abs(n.x) else v.z) / 1.6, v.y / 1.6)
        bmesh.ops.transform(bm, matrix=TO_BLENDER, verts=bm.verts)
        me = bpy.data.meshes.new(f'{part}_{m}')
        bm.to_mesh(me)
        bm.free()
        me.materials.append(MATS[m])
        ob = bpy.data.objects.new(f'{part}_{m}', me)
        if m in SMOOTH:  # rounded parts: smooth normals, but keep creases sharper than 35 degrees
            me.shade_smooth()
            me.set_sharp_from_angle(angle=math.radians(35))
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = root

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_apply=False, export_cameras=False,
                          export_lights=False, export_animations=False, export_materials='EXPORT')
faces = {}
for o in bpy.data.objects:
    if o.type == 'MESH':
        faces[o.parent.name] = faces.get(o.parent.name, 0) + len(o.data.polygons)
print('EXPORTED', OUT, faces)
