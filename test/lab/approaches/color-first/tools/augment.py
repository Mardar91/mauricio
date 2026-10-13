# Genera variantes aumentadas de las fotos "dev" (solo desarrollo; no se usa en el producto).
# Uso: python3 tools/augment.py  → synth/aug/*.jpg + synth/aug.json
import json, math, os, random, sys
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../../../../..'))
OUT = os.path.join(HERE, '..', 'synth', 'aug')
os.makedirs(OUT, exist_ok=True)
GT = json.load(open(os.path.join(ROOT, 'test/lab/ground-truth.json')))

def perspective_coeffs(src, dst):
    # coeficientes para Image.transform(PERSPECTIVE): mapea dst → src
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()

def rotate(im, deg):
    return im.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(45, 42, 40))

def persp(im, k, side):
    w, h = im.size
    d = k * w
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    if side == 'top': dst = [(d, 0), (w - d, 0), (w, h), (0, h)]
    elif side == 'bottom': dst = [(0, 0), (w, 0), (w - d, h), (d, h)]
    elif side == 'left': dst = [(0, d), (w, 0), (w, h), (0, h - d)]
    else: dst = [(0, 0), (w, d), (w, h - d), (0, h)]
    c = perspective_coeffs(src, dst)
    return im.transform((w, h), Image.PERSPECTIVE, c, Image.BICUBIC, fillcolor=(45, 42, 40))

def cast(im, r, g, b, bright=1.0):
    a = np.asarray(im).astype(np.float32)
    a[..., 0] *= r * bright; a[..., 1] *= g * bright; a[..., 2] *= b * bright
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def noise(im, sigma, seed):
    rng = np.random.default_rng(seed)
    a = np.asarray(im).astype(np.float32) + rng.normal(0, sigma, (im.size[1], im.size[0], 1))
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def upscale(im, long_side):
    w, h = im.size; k = long_side / max(w, h)
    return im.resize((round(w * k), round(h * k)), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.2))

def crop_header(im, frac):
    w, h = im.size
    return im.crop((0, int(h * frac), w, h))

VARIANTS = [
    ('rot8', lambda im, s: rotate(im, 8)),
    ('rotm12', lambda im, s: rotate(im, -12)),
    ('rot15', lambda im, s: rotate(im, 15)),
    ('persp', lambda im, s: persp(im, 0.12, ['top', 'bottom', 'left', 'right'][s % 4])),
    ('big', lambda im, s: upscale(im, 4032)),
    ('warm', lambda im, s: cast(im, 1.12, 1.0, 0.7, 0.75)),
    ('dark', lambda im, s: noise(cast(im, 0.95, 0.95, 1.05, 0.5), 6, s)),
    ('cool', lambda im, s: cast(im, 0.8, 0.95, 1.15, 1.0)),
    ('jpeg', lambda im, s: noise(im.filter(ImageFilter.GaussianBlur(1.0)), 4, s)),
    ('rotpersp', lambda im, s: persp(rotate(im, -6), 0.08, ['top', 'right', 'bottom', 'left'][s % 4])),
]

photos = []
seed = 0
for p in GT['photos']:
    if p['set'] != 'dev': continue
    src = Image.open(os.path.join(ROOT, 'test/fotos', p['file'])).convert('RGB')
    for name, fn in VARIANTS:
        seed += 1
        if p['layout'] != 'phone-list' and name not in ('rot8', 'big', 'warm'): continue
        im = fn(src, seed)
        q = 55 if name == 'jpeg' else 88
        fname = p['file'].replace('.jpg', f'_{name}.jpg')
        im.save(os.path.join(OUT, fname), quality=q)
        photos.append({ 'file': 'test/lab/approaches/color-first/synth/aug/' + fname, 'layout': p['layout'], 'month': p['month'], 'year': p['year'], 'days': p['days'], 'optional': p.get('optional', {}), 'variant': name })
json.dump({ 'photos': photos }, open(os.path.join(HERE, '..', 'synth', 'aug.json'), 'w'), indent=1)
print(len(photos), 'imágenes')
