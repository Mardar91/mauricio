# Segundo juego de variantes "difíciles" (solo desarrollo): reflejos, dedo, moiré, sin cabecera,
# baja resolución, móvil pequeño en la foto, giros de 20-22° y manchas blancas sobre insignias. Uso: python3 tools/augment2.py → synth/aug2/*.jpg + synth/aug2.json
import json, math, os
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../../../../..'))
OUT = os.path.join(HERE, '..', 'synth', 'aug2')
os.makedirs(OUT, exist_ok=True)
GT = json.load(open(os.path.join(ROOT, 'test/lab/ground-truth.json')))
rng = np.random.default_rng(7)

def glare(im, seed):
    r = np.random.default_rng(seed); w, h = im.size
    a = np.asarray(im).astype(np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    for _ in range(2):
        cx, cy = r.uniform(0.2, 0.6) * w, r.uniform(0.3, 0.8) * h
        sx, sy = r.uniform(0.08, 0.2) * w, r.uniform(0.05, 0.15) * h
        g = np.exp(-(((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2)) * r.uniform(0.5, 0.8)
        a = a * (1 - g[..., None]) + 250 * g[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def finger(im, seed):
    r = np.random.default_rng(seed); w, h = im.size
    m = Image.new('L', (w, h), 0); d = ImageDraw.Draw(m)
    cy = r.uniform(0.45, 0.75) * h; x1 = r.uniform(0.3, 0.45) * w
    d.ellipse((-0.3 * w, cy - 0.06 * h, x1, cy + 0.06 * h), fill=255)
    m = m.filter(ImageFilter.GaussianBlur(6))
    skin = Image.new('RGB', (w, h), (150, 105, 85))
    return Image.composite(skin, im, m)

def moire(im, seed):
    w, h = im.size; a = np.asarray(im).astype(np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    t = math.radians(20 + seed % 30)
    pat = np.sin((xx * math.cos(t) + yy * math.sin(t)) * 2 * math.pi / 5.3)
    a[..., 0] *= 1 + 0.08 * pat; a[..., 1] *= 1 - 0.06 * pat; a[..., 2] *= 1 + 0.07 * np.sin(yy * 2 * math.pi / 7.1)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def nohdr(im, seed):
    w, h = im.size
    return im.crop((0, int(h * 0.3), w, h))

def small(im, seed):
    w, h = im.size; k = 640 / max(w, h)
    return im.resize((round(w * k), round(h * k)), Image.LANCZOS)

def far(im, seed):
    w, h = im.size
    bg = Image.new('RGB', (w * 2, h * 2), (70, 66, 60))
    bg.paste(im, (w // 2, h // 3))
    return bg.resize((w * 2, h * 2), Image.BICUBIC)

def rot(deg):
    return lambda im, seed: im.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(45, 42, 40))

def ghost(im, seed):
    # borra (casi) por completo la 2ª insignia de algunas filas: simula un reflejo fuerte
    a = np.asarray(im).astype(np.float32); h, w, _ = a.shape
    r = np.random.default_rng(seed); yy, xx = np.mgrid[0:h, 0:w]
    for _ in range(3):
        cx, cy = r.uniform(0.3, 0.45) * w, r.uniform(0.3, 0.8) * h
        m = np.clip(1 - (np.hypot(xx - cx, yy - cy) - 0.03 * w) / 8, 0, 1) * 0.8
        a = a * (1 - m[..., None]) + 245 * m[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

VARIANTS = [('glare', glare), ('finger', finger), ('moire', moire), ('nohdr', nohdr), ('small', small), ('far', far),
            ('rot20', rot(20)), ('rotm22', rot(-22)), ('ghost', ghost)]
photos = []; seed = 100
for p in GT['photos']:
    if p['set'] != 'dev' or p['layout'] != 'phone-list': continue
    src = Image.open(os.path.join(ROOT, 'test/fotos', p['file'])).convert('RGB')
    for name, fn in VARIANTS:
        seed += 1
        im = fn(src, seed)
        fname = p['file'].replace('.jpg', f'_{name}.jpg')
        im.save(os.path.join(OUT, fname), quality=90)
        photos.append({'file': 'test/lab/approaches/color-first/synth/aug2/' + fname, 'layout': p['layout'], 'month': p['month'], 'year': p['year'], 'days': p['days'], 'optional': p.get('optional', {}), 'variant': name})
json.dump({'photos': photos}, open(os.path.join(HERE, '..', 'synth', 'aug2.json'), 'w'), indent=1)
print(len(photos), 'imágenes')
