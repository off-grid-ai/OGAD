#!/usr/bin/env python3
"""Verify a GGUF is sd.cpp-loadable: its tensor names must carry the
`model.diffusion_model.*` (or webui `first_stage_model.`/`cond_stage_model.`)
namespaces sd.cpp uses for version detection. Exits non-zero if not."""
import sys, struct

def tensor_names(path):
    with open(path, 'rb') as f:
        assert f.read(4) == b'GGUF', 'not a gguf'
        struct.unpack('<I', f.read(4))
        nt = struct.unpack('<Q', f.read(8))[0]
        nk = struct.unpack('<Q', f.read(8))[0]
        def rstr():
            n = struct.unpack('<Q', f.read(8))[0]; return f.read(n).decode('utf-8', 'replace')
        def sv(t):
            if t in (0, 1, 7): f.read(1)
            elif t in (2, 3): f.read(2)
            elif t in (4, 5, 6): f.read(4)
            elif t in (10, 11, 12): f.read(8)
            elif t == 8: rstr()
            elif t == 9:
                et = struct.unpack('<I', f.read(4))[0]; c = struct.unpack('<Q', f.read(8))[0]
                [sv(et) for _ in range(c)]
        for _ in range(nk): rstr(); sv(struct.unpack('<I', f.read(4))[0])
        out = []
        for _ in range(nt):
            nm = rstr(); nd = struct.unpack('<I', f.read(4))[0]
            for _ in range(nd): struct.unpack('<Q', f.read(8))
            struct.unpack('<I', f.read(4)); struct.unpack('<Q', f.read(8)); out.append(nm)
        return out

names = tensor_names(sys.argv[1])
allinone = any(n.startswith('first_stage_model.') or n.startswith('cond_stage_model.') for n in names)
unet = any(n.startswith('model.diffusion_model.') for n in names)
if allinone:
    print(f'    OK: all-in-one ({len(names)} tensors)')
elif unet:
    print(f'    OK: diffusion-model namespace ({len(names)} tensors)')
else:
    pref = sorted(set(n.split('.')[0] for n in names))[:6]
    print(f'    FAIL: not sd.cpp-loadable; top-level prefixes={pref}')
    sys.exit(1)
