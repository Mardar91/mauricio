// Pruebas del ajuste de códigos (codes.js). Uso: node test/lab/approaches/rectify-rows/tools/test-codes.mjs
import { snapBadge } from '../codes.js';
import { C } from '../rows.js';
import { DEFAULT_KNOWN as K } from '../codes.js';
const t = (cls, shape, reads, exp) => { const r = snapBadge(cls, shape, reads.map(([text, conf]) => ({ text, conf })), K); const got = r ? r.code : null; console.log(got === exp ? 'ok ' : 'MAL', CLS(cls), JSON.stringify(reads), '→', got, r ? r.conf.toFixed(2) : ''); };
const CLS = (c) => Object.keys(C).find((k) => C[k] === c);
t(C.YELLOW, 'circle', [['S1', 90], ['S1', 85], ['S1', 80]], null);      // color mal: no F1
t(C.YELLOW, 'circle', [['F1', 80]], 'F1');
t(C.YELLOW, 'circle', [['F7', 90], ['F7', 88], ['F7', 92]], null);      // 1↔7 con F1: dudoso
t(C.YELLOW, 'circle', [['F7', 90], ['F1', 60], ['F7', 92]], null);
t(C.MAGENTA, 'circle', [['S31', 53], ['S51', 7], ['51', 0]], null);
t(C.MAGENTA, 'circle', [['S31', 80], ['S51', 70]], 'S51');
t(C.MAGENTA, 'circle', [['F33', 70], ['F53', 60]], 'F53');
t(C.MAGENTA, 'circle', [['N51', 0]], null);
t(C.GREEN, 'circle', [['1', 0], ['S1', 60], ['S1', 72]], 'S1');
t(C.GREEN, 'circle', [['F1', 90], ['F1', 90]], null);                  // letra F en verde
t(C.RED, 'circle', [['S31', 94]], 'S31');
t(C.PINK, 'tag', [['W-', 89]], 'W-');
t(C.PINK, 'circle', [['Z1', 60]], 'Z1');
t(C.BLUE, 'hexagon', [['TS', 95]], 'TS');
t(C.BLUE, 'circle', [['N1', 88]], 'N1');
t(C.MAGENTA, 'circle', [['F33', 90], ['F33', 88], ['F33', 92]], null); // 3↔5 con F53 conocido
t(C.MAGENTA, 'circle', [['F54', 90], ['F54', 88], ['F54', 92]], 'F54'); // nuevo de verdad
t(C.GREEN, 'circle', [['S2', 91], ['S2', 48], ['S2', 79]], 'S2');
