# Genera variantes sintéticas de las fotos de desarrollo (solo herramienta de pruebas).
# Uso: python3 augment.py <dir_fotos> <dir_salida> [semilla]
# Nunca usar las fotos "holdout".
import sys, os, json, math, random
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

HOLDOUT = {'phone-2026-06-b.jpg', 'phone-2026-07-c.jpg', 'phone-2026-08-c.jpg', 'phone-2026-09-c.jpg'}

def persp_coeffs(src, dst):
    # coeficientes para Image.transform(PERSPECTIVE): mapea salida→entrada
    A = []; B = []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()

def rotate(im, deg):
    return im.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(45, 45, 45))

def perspective(im, k, side='top'):
    w, h = im.size
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    d = k * w
    if side == 'top': dst = [(d, 0), (w - d, 0), (w, h), (0, h)]
    else: dst = [(0, d), (w, 0), (w, h), (0, h - d)]
    c = persp_coeffs(src, dst)
    return im.transform((w, h), Image.PERSPECTIVE, c, Image.BICUBIC, fillcolor=(45, 45, 45))

def cast(im, rgb):
    a = np.asarray(im).astype(float) * np.array(rgb)[None, None, :]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def dark(im, rng):
    a = np.asarray(im).astype(float) / 255.0
    a = np.power(a, 1.6) * 0.75
    a = a + rng.normal(0, 0.025, a.shape)
    return Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))

def moire(im):
    a = np.asarray(im).astype(float)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    pat = np.sin(2 * math.pi * (xx * 0.21 + yy * 0.17)) * np.sin(2 * math.pi * (xx * 0.013 - yy * 0.011))
    a = a * (1 + 0.07 * pat[..., None]) + np.stack([pat * 6, -pat * 4, pat * 5], -1)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def glare(im, rng):
    a = np.asarray(im).astype(float)
    h, w = a.shape[:2]
    cx, cy = rng.uniform(0.3, 0.7) * w, rng.uniform(0.3, 0.7) * h
    yy, xx = np.mgrid[0:h, 0:w]
    g = np.exp(-(((xx - cx) / (0.25 * w)) ** 2 + ((yy - cy) / (0.12 * h)) ** 2))
    a = a + 90 * g[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def far(im, k, canvas=None):
    # teléfono más lejos: la foto reducida dentro de un lienzo con fondo texturado
    W, H = canvas or im.size
    bg = Image.fromarray(np.clip(np.random.default_rng(3).normal(70, 18, (H, W, 3)), 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))
    sm = im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS)
    bg.paste(sm, ((W - sm.width) // 2, (H - sm.height) // 3))
    return bg

def main():
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    rng = np.random.default_rng(seed); random.seed(seed)
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    for f in sorted(os.listdir(src_dir)):
        if not f.startswith('phone-') or f in HOLDOUT or not f.endswith('.jpg'): continue
        im = Image.open(os.path.join(src_dir, f)).convert('RGB')
        base = f[:-4]
        vars_ = {
            'rot12': rotate(im, 12), 'rotm15': rotate(im, -15),
            'persp': perspective(im, 0.12, 'top'), 'perspside': perspective(im, 0.08, 'left'),
            'big': im.resize((im.width * 4032 // max(im.size), im.height * 4032 // max(im.size)), Image.LANCZOS),
            'warm': cast(im, (1.08, 0.95, 0.7)), 'cool': cast(im, (0.8, 0.95, 1.12)), 'dark': dark(im, rng),
            'blur': im.filter(ImageFilter.GaussianBlur(1.6)), 'moire': moire(im), 'glare': glare(im, rng),
            'small': im.resize((im.width * 2 // 3, im.height * 2 // 3), Image.LANCZOS),
            'q90': rotate(im, 90 + 6), 'q180': rotate(im, 180 - 5),
            'far': far(im, 0.55), 'far4k': far(im, 1.1, (3024, 4032)),
        }
        for k, v in vars_.items():
            name = f'{base}_{k}.jpg'
            q = 35 if k == 'blur' else 88
            v.save(os.path.join(out_dir, name), quality=q)
            manifest.append({'file': name, 'source': f, 'variant': k})
    json.dump(manifest, open(os.path.join(out_dir, 'manifest.json'), 'w'), indent=1)
    print(len(manifest), 'imágenes')

if __name__ == '__main__':
    main()
