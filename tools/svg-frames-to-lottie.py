#!/usr/bin/env python3
"""
svg-frames-to-lottie — turn a sequence of SVG frames (one file per frame, as exported
from Illustrator/Figma artboards) into a small, renderer-friendly Lottie.

What it does, in order:
  1. Flattens each SVG to an ordered list of drawables (paths, circles, ellipses, rects,
     lines, polygons) with absolute cubic-bezier geometry and resolved CSS styles.
  2. Culls what can never be seen: elements outside the viewBox (neighbouring artboards
     leak into Illustrator exports), and anything painted *under* an opaque circle that
     covers it entirely.
  3. Re-aligns frames whose opaque background circle drifted by a sub-pixel amount
     (artboard misalignment) so the container does not jitter.
  4. Resolves circle clip-paths geometrically (bezier segments split at the circle,
     outside spans replaced by arcs) — the output has no masks at all.
  5. Deduplicates across time: the same shape (geometry + style, up to translation)
     at the same position in several frames becomes ONE shape group whose opacity is
     a hold-keyframe track. Paint order is a topological sort of every frame's order,
     so z-order is preserved by construction (an instance is split only if a cycle
     forces it).
  6. Merges paint-adjacent groups that share style and visibility into one group with
     several paths and a single fill/stroke — only when that provably paints the same
     pixels (opaque, and either disjoint or same winding).

Output: one shape layer, no masks/mattes/effects/precomps/expressions, only fills,
strokes and hold keyframes — the subset every Lottie player (lottie-web, lottie-ios
Core Animation engine, lottie-android) renders fast.

Stdlib only. Verify the result against the SVGs with tools/verify-svg-frames.mjs.

Usage:
  python3 tools/svg-frames-to-lottie.py "frames/*.svg" -o out.json [--fps 30] [--no-merge]
         [--no-realign] [--precision 2] [--crop] [--name NAME]
"""
import argparse, collections, glob, heapq, json, math, re, sys
import xml.etree.ElementTree as ET


# ---------------------------------------------------------------- SVG flattening


NS = '{http://www.w3.org/2000/svg}'
K = 0.5522847498307936  # kappa for circle approximation

def parse_css(css):
    rules = {}
    for sel, body in re.findall(r'([^{}]+)\{([^}]*)\}', css):
        props = dict((k.strip(), v.strip()) for k, v in re.findall(r'([\w-]+)\s*:\s*([^;]+)', body))
        for cls in re.findall(r'\.([\w-]+)', sel):
            rules.setdefault(cls, {}).update(props)
    return rules

def parse_transform(t):
    """Return 2x3 matrix [a,b,c,d,e,f] for 'translate(x y) rotate(deg)' etc."""
    m = [1, 0, 0, 1, 0, 0]
    for name, args in re.findall(r'(\w+)\(([^)]*)\)', t or ''):
        nums = [float(x) for x in re.findall(r'-?\d*\.?\d+(?:e-?\d+)?', args)]
        if name == 'translate':
            tx, ty = nums[0], nums[1] if len(nums) > 1 else 0
            mm = [1, 0, 0, 1, tx, ty]
        elif name == 'rotate':
            a = math.radians(nums[0]); ca, sa = math.cos(a), math.sin(a)
            mm = [ca, sa, -sa, ca, 0, 0]
            if len(nums) == 3:
                cx, cy = nums[1], nums[2]
                mm = mul([1, 0, 0, 1, cx, cy], mul(mm, [1, 0, 0, 1, -cx, -cy]))
        elif name == 'scale':
            sx = nums[0]; sy = nums[1] if len(nums) > 1 else sx
            mm = [sx, 0, 0, sy, 0, 0]
        elif name == 'matrix':
            mm = nums
        else:
            raise ValueError('transform ' + name)
        m = mul(m, mm)
    return m

def mul(m, n):
    a, b, c, d, e, f = m; a2, b2, c2, d2, e2, f2 = n
    return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2,
            a * e2 + c * f2 + e, b * e2 + d * f2 + f]

def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)

# ---- geometry: a subpath is dict(v=[(x,y)], i=[(x,y)] abs in-tangent points, o=[(x,y)] abs out-tangent points, c=bool)

def path_to_subpaths(d):
    toks = re.findall(r'[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?', d)
    i = 0; subs = []; cur = None; cx = cy = 0; startx = starty = 0; last_c2 = None; cmd = None
    def num():
        nonlocal i
        v = float(toks[i]); i += 1; return v
    def begin(x, y):
        nonlocal cur
        cur = {'v': [(x, y)], 'i': [(x, y)], 'o': [(x, y)], 'c': False}
        subs.append(cur)
    def lineto(x, y):
        cur['o'][-1] = cur['v'][-1]
        cur['v'].append((x, y)); cur['i'].append((x, y)); cur['o'].append((x, y))
    def curveto(x1, y1, x2, y2, x, y):
        cur['o'][-1] = (x1, y1)
        cur['v'].append((x, y)); cur['i'].append((x2, y2)); cur['o'].append((x, y))
    while i < len(toks):
        if re.match(r'[A-Za-z]', toks[i]):
            cmd = toks[i]; i += 1
            if cmd in 'Zz':
                if cur is not None:
                    cur['c'] = True
                    cx, cy = startx, starty
                last_c2 = None
                continue
        rel = cmd.islower(); C = cmd.upper()
        if C == 'M':
            x, y = num(), num()
            if rel: x += cx; y += cy
            begin(x, y); cx, cy = x, y; startx, starty = x, y
            cmd = 'l' if rel else 'L'; last_c2 = None
        elif C == 'L':
            x, y = num(), num()
            if rel: x += cx; y += cy
            lineto(x, y); cx, cy = x, y; last_c2 = None
        elif C == 'H':
            x = num(); x = x + cx if rel else x
            lineto(x, cy); cx = x; last_c2 = None
        elif C == 'V':
            y = num(); y = y + cy if rel else y
            lineto(cx, y); cy = y; last_c2 = None
        elif C == 'C':
            x1, y1, x2, y2, x, y = (num() for _ in range(6))
            if rel: x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy
            curveto(x1, y1, x2, y2, x, y); last_c2 = (x2, y2); cx, cy = x, y
        elif C == 'S':
            x2, y2, x, y = (num() for _ in range(4))
            if rel: x2 += cx; y2 += cy; x += cx; y += cy
            if last_c2 is not None: x1, y1 = 2 * cx - last_c2[0], 2 * cy - last_c2[1]
            else: x1, y1 = cx, cy
            curveto(x1, y1, x2, y2, x, y); last_c2 = (x2, y2); cx, cy = x, y
        else:
            raise ValueError('unsupported path command ' + cmd)
    # closed subpaths: if last vertex == first vertex, merge tangents & drop duplicate
    for s in subs:
        if s['c'] and len(s['v']) > 1 and near(s['v'][0], s['v'][-1]):
            s['i'][0] = s['i'][-1]
            for k in ('v', 'i', 'o'): s[k].pop()
    return subs

def near(p, q, eps=1e-6):
    return abs(p[0] - q[0]) < eps and abs(p[1] - q[1]) < eps

def ellipse_subpath(cx, cy, rx, ry, m=None, n=8):
    # n-arc cubic approximation, starting at (cx+rx, cy), clockwise in screen coords
    K = 4 / 3 * math.tan(math.pi / (2 * n))
    pts = []
    for k in range(n):
        a = k * 2 * math.pi / n
        x, y = cx + rx * math.cos(a), cy + ry * math.sin(a)
        # tangent direction (derivative)
        tx, ty = -rx * math.sin(a), ry * math.cos(a)
        pts.append(((x, y), (x - K * tx, y - K * ty), (x + K * tx, y + K * ty)))
    sub = {'v': [p[0] for p in pts], 'i': [p[1] for p in pts], 'o': [p[2] for p in pts], 'c': True}
    if m: sub = transform_sub(sub, m)
    return sub

def poly_subpath(points, closed):
    return {'v': list(points), 'i': list(points), 'o': list(points), 'c': closed}

def transform_sub(s, m):
    return {'v': [apply(m, *p) for p in s['v']], 'i': [apply(m, *p) for p in s['i']],
            'o': [apply(m, *p) for p in s['o']], 'c': s['c']}

def bbox(subs):
    xs = [p[0] for s in subs for k in ('v', 'i', 'o') for p in s[k]]
    ys = [p[1] for s in subs for k in ('v', 'i', 'o') for p in s[k]]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None

def parse_color(c):
    c = c.strip()
    if c == 'none': return None
    m = re.match(r'#([0-9a-fA-F]{3,8})$', c)
    if m:
        h = m.group(1)
        if len(h) == 3: h = ''.join(ch * 2 for ch in h)
        return tuple(int(h[k:k + 2], 16) / 255 for k in (0, 2, 4))
    m = re.match(r'rgb\(([^)]*)\)', c)
    if m:
        return tuple(float(x) / 255 for x in m.group(1).split(','))
    named = {'white': (1, 1, 1), 'black': (0, 0, 0)}
    if c in named: return named[c]
    raise ValueError('color ' + c)

def load_svg(path):
    tree = ET.parse(path); root = tree.getroot()
    vb = [float(x) for x in root.get('viewBox').split()]
    css = ''
    for st in root.iter(NS + 'style'): css += st.text or ''
    rules = parse_css(css)
    clips = {}
    for cp in root.iter(NS + 'clipPath'):
        kids = [k for k in cp if k.tag != NS + 'style']
        assert len(kids) == 1 and kids[0].tag == NS + 'circle', 'only circle clips supported'
        k = kids[0]
        clips[cp.get('id')] = (float(k.get('cx')), float(k.get('cy')), float(k.get('r')))
    out = []
    def style_of(el, inherited):
        st = dict(inherited)
        for cls in (el.get('class') or '').split():
            st.update(rules.get(cls, {}))
        # presentation attributes
        for k in ('fill', 'stroke', 'stroke-width', 'opacity', 'clip-path', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-opacity', 'stroke-opacity', 'fill-rule'):
            if el.get(k) is not None: st[k] = el.get(k)
        return st
    def walk(el, m, inherited, clip, group_opacity):
        tag = el.tag.replace(NS, '')
        if tag in ('defs', 'style', 'clipPath', 'title', 'desc', 'metadata'): return
        st = style_of(el, inherited)
        m2 = mul(m, parse_transform(el.get('transform'))) if el.get('transform') else m
        myclip = clip
        if 'clip-path' in st and st['clip-path'] != 'none' and tag != 'svg':
            cid = re.match(r'url\(#([^)]+)\)', st['clip-path']).group(1)
            assert m2 == [1, 0, 0, 1, 0, 0], 'clip under transform unsupported'
            myclip = (myclip or []) + [clips[cid]]
        # opacity: on group -> we treat as multiplicative per element (exact only when children don't overlap; flagged)
        own_op = float(st.get('opacity', 1)) if 'opacity' in st else 1.0
        # 'opacity' is not inherited in SVG; it applies to the element/group as a whole. Remove from inherited copy.
        st_child = {k: v for k, v in st.items() if k not in ('opacity', 'clip-path')}
        gop = group_opacity * own_op
        if tag in ('g', 'svg'):
            if tag == 'g' and own_op != 1 and len(list(el)) > 1:
                print('WARNING: group opacity on multi-child group', el.get('id'))
            for c in el: walk(c, m2, st_child, myclip, gop)
            return
        subs = None
        if tag == 'path':
            subs = path_to_subpaths(el.get('d'))
        elif tag == 'circle':
            subs = [ellipse_subpath(float(el.get('cx', 0)), float(el.get('cy', 0)), float(el.get('r')), float(el.get('r')))]
        elif tag == 'ellipse':
            subs = [ellipse_subpath(float(el.get('cx', 0)), float(el.get('cy', 0)), float(el.get('rx')), float(el.get('ry')))]
        elif tag == 'rect':
            x, y, w, h = (float(el.get(k, 0)) for k in ('x', 'y', 'width', 'height'))
            assert el.get('rx') is None and el.get('ry') is None
            subs = [poly_subpath([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], True)]
        elif tag == 'line':
            subs = [poly_subpath([(float(el.get('x1')), float(el.get('y1'))), (float(el.get('x2')), float(el.get('y2')))], False)]
        elif tag in ('polygon', 'polyline'):
            nums = [float(x) for x in re.findall(r'-?\d*\.?\d+(?:e-?\d+)?', el.get('points'))]
            pts = list(zip(nums[0::2], nums[1::2]))
            subs = [poly_subpath(pts, tag == 'polygon')]
        else:
            raise ValueError('unsupported element ' + tag)
        if m2 != [1, 0, 0, 1, 0, 0]:
            subs = [transform_sub(s, m2) for s in subs]
        fill = parse_color(st.get('fill', '#000'))
        stroke = parse_color(st.get('stroke', 'none'))
        sw = float(re.sub('px', '', st.get('stroke-width', '1')))
        if stroke is not None and m2 != [1, 0, 0, 1, 0, 0]:
            sc = math.sqrt(abs(m2[0] * m2[3] - m2[1] * m2[2])); sw *= sc
        d = {
            'tag': tag, 'subs': subs,
            'fill': fill, 'fill_op': gop * float(st.get('fill-opacity', 1)),
            'stroke': stroke, 'stroke_op': gop * float(st.get('stroke-opacity', 1)),
            'sw': sw, 'cap': st.get('stroke-linecap', 'butt'), 'join': st.get('stroke-linejoin', 'miter'),
            'miter': float(st.get('stroke-miterlimit', 4)), 'rule': st.get('fill-rule', 'nonzero'),
            'clip': myclip, 'id': el.get('id'),
        }
        d['bbox'] = bbox(subs)
        out.append(d)
    walk(root, [1, 0, 0, 1, 0, 0], {}, None, 1.0)
    return {'viewBox': vb, 'drawables': out}

# ---------------------------------------------------------------- circle clipping


def bez(P, t):
    (x0,y0),(x1,y1),(x2,y2),(x3,y3)=P; mt=1-t
    return (mt**3*x0+3*mt*mt*t*x1+3*mt*t*t*x2+t**3*x3, mt**3*y0+3*mt*mt*t*y1+3*mt*t*t*y2+t**3*y3)

def split(P, t):
    (x0,y0),(x1,y1),(x2,y2),(x3,y3)=P
    def lerp(a,b): return (a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t)
    p01=lerp(P[0],P[1]); p12=lerp(P[1],P[2]); p23=lerp(P[2],P[3])
    p012=lerp(p01,p12); p123=lerp(p12,p23); m=lerp(p012,p123)
    return (P[0],p01,p012,m),(m,p123,p23,P[3])

def roots_circle(P, c, r, n=96):
    f=lambda t: (bez(P,t)[0]-c[0])**2+(bez(P,t)[1]-c[1])**2-r*r
    ts=[k/n for k in range(n+1)]; fs=[f(t) for t in ts]; out=[]
    for k in range(n):
        a,b=ts[k],ts[k+1]; fa,fb=fs[k],fs[k+1]
        if fa==0 and 0<a<1: out.append(a); continue
        if fa*fb<0:
            for _ in range(50):
                m=(a+b)/2; fm=f(m)
                if fa*fm<=0: b,fb=m,fm
                else: a,fa=m,fm
            t=(a+b)/2
            if 1e-9<t<1-1e-9: out.append(t)
    return out

def segments(sub):
    v,i,o=sub['v'],sub['i'],sub['o']; n=len(v); segs=[]
    m=n if sub['c'] else n-1
    for k in range(m):
        k2=(k+1)%n
        segs.append((v[k],o[k],i[k2],v[k2]))
    return segs

def flatten(segs, per=16):
    pts=[]
    for P in segs:
        for k in range(per): pts.append(bez(P,k/per))
    return pts

def point_in_poly(pt, poly):
    x,y=pt; inside=False; n=len(poly)
    for k in range(n):
        x1,y1=poly[k]; x2,y2=poly[(k+1)%n]
        if (y1>y)!=(y2>y):
            xi=x1+(y-y1)*(x2-x1)/(y2-y1)
            if xi>x: inside=not inside
    return inside

def arc_segments(c, r, a0, sweep):
    """Cubic segments approximating circle arc from angle a0 with signed sweep."""
    n=max(1, int(math.ceil(abs(sweep)/(math.pi/4)-1e-9))); d=sweep/n; k=4/3*math.tan(abs(d)/4)*(1 if d>=0 else -1)
    segs=[]
    for j in range(n):
        a=a0+j*d; b=a+d
        p0=(c[0]+r*math.cos(a), c[1]+r*math.sin(a)); p3=(c[0]+r*math.cos(b), c[1]+r*math.sin(b))
        t0=(-math.sin(a), math.cos(a)); t3=(-math.sin(b), math.cos(b))
        p1=(p0[0]+k*r*t0[0], p0[1]+k*r*t0[1]); p2=(p3[0]-k*r*t3[0], p3[1]-k*r*t3[1])
        segs.append((p0,p1,p2,p3))
    return segs

def clip_subpath(sub, c, r):
    """Return list of subpaths (0 or 1) = sub ∩ disk(c,r). Requires closed sub."""
    assert sub['c'], 'open subpath clipping unsupported'
    segs=segments(sub)
    pieces=[]  # (P, inside)
    for P in segs:
        ts=sorted(roots_circle(P,c,r)); prev=0.0; cur=P
        for t in ts:
            tt=(t-prev)/(1-prev)
            a,b=split(cur,tt); pieces.append(a); cur=b; prev=t
        pieces.append(cur)
    def inside(P):
        x,y=bez(P,0.5); return math.hypot(x-c[0],y-c[1])<=r
    flags=[inside(P) for P in pieces]
    if all(flags):
        return [sub]
    if not any(flags):
        return []
    poly=flatten(segs)
    # rotate so we start at an inside piece preceded by outside piece
    n=len(pieces)
    start=next(k for k in range(n) if flags[k] and not flags[k-1])
    order=[(k+start)%n for k in range(n)]
    out=[]  # list of cubic segments
    k=0
    while k<n:
        idx=order[k]
        if flags[idx]:
            out.append(pieces[idx]); k+=1
        else:
            E=out[-1][3]
            # find next inside piece
            j=k
            while j<n and not flags[order[j]]: j+=1
            S=pieces[order[j%n]][0] if j<n else out[0][0]
            aE=math.atan2(E[1]-c[1],E[0]-c[0]); aS=math.atan2(S[1]-c[1],S[0]-c[0])
            ccw=(aS-aE)%(2*math.pi); cw=ccw-2*math.pi
            # choose sweep whose arc midpoint lies inside original polygon
            cands=[]
            for sw in (ccw,cw):
                am=aE+sw/2; mp=(c[0]+r*math.cos(am), c[1]+r*math.sin(am))
                cands.append((point_in_poly(mp,poly), -abs(sw), sw))
            cands.sort(reverse=True)
            sw=cands[0][2]
            if abs(sw)>1e-9: out.extend(arc_segments(c,r,aE,sw))
            k=j
    # assemble subpath from segments (closed)
    v=[];i=[];o=[]
    for P in out:
        v.append(P[0]); o.append(P[1]); i.append(None)
    # in-tangents: seg P's p2 belongs to its end vertex
    i=[None]*len(out)
    for idx,P in enumerate(out):
        i[(idx+1)%len(out)]=P[2]
    # ensure continuity: replace vertex with previous segment end where mismatched (numerical)
    return [{'v':v,'i':i,'o':o,'c':True}]

def clip_drawable(d, c, r):
    subs=[]
    for s in d['subs']:
        subs.extend(clip_subpath(s,c,r))
    if not subs: return None
    d=dict(d); d['subs']=subs; d['clip']=None
    d['bbox']=bbox(subs)
    return d

# ---------------------------------------------------------------- culling & keys
def style_key(d):
    return (d['fill'], round(d['fill_op'],4), d['stroke'], round(d['stroke_op'],4), round(d['sw'],3) if d['stroke'] else 0, d['cap'] if d['stroke'] else '', d['join'] if d['stroke'] else '', d['rule'])

def geom_key(d, prec=2):
    b=d['bbox']; ox,oy=b[0],b[1]
    parts=[]
    for s in d['subs']:
        parts.append((tuple((round(x-ox,prec),round(y-oy,prec)) for x,y in s['v']),
                      tuple((round(x-ox,prec),round(y-oy,prec)) for x,y in s['i']),
                      tuple((round(x-ox,prec),round(y-oy,prec)) for x,y in s['o']), s['c']))
    return tuple(parts)

def clip_key(d):
    return tuple(d['clip']) if d['clip'] else None

def find_occluder(ds, vb):
    """The largest opaque, unclipped circle inside the viewBox: anything painted before it and
    entirely inside it can never be seen (Illustrator exports often carry hidden copies)."""
    best=None
    for i,d in enumerate(ds):
        if d['tag']!='circle' or not d['fill'] or d['fill_op']<1 or d['clip'] or d['stroke']: continue
        b=d['bbox']; cx=(b[0]+b[2])/2; cy=(b[1]+b[3])/2; r=(b[2]-b[0])/2
        if not (vb[0]<=cx<=vb[2] and vb[1]<=cy<=vb[3]): continue
        if best is None or r>=best[1][2]-1e-6: best=(i,(cx,cy,r))  # ties: the later one occludes more
    return best

def cull(ds, vb, log=print):
    """Drop offscreen and occluded drawables. Returns kept list (in order)."""
    kept=[]
    bg=find_occluder(ds, vb)
    for i,d in enumerate(ds):
        b=d['bbox']; m=d['sw']/2 if d['stroke'] else 0
        # offscreen
        if b[2]+m<vb[0] or b[0]-m>vb[2] or b[3]+m<vb[1] or b[1]-m>vb[3]:
            continue
        if d['clip']:
            cx,cy,r=d['clip'][0]
            if cx+r<vb[0] or cx-r>vb[2] or cy+r<vb[1] or cy-r>vb[3]:
                continue
        # occluded: drawn before the opaque circle and entirely inside it
        # (a bezier lies inside the convex hull of its control points; the disk is convex)
        if bg and i<bg[0]:
            cx,cy,r=bg[1]
            same_clip = d['clip'] and abs(d['clip'][0][0]-cx)<0.01 and abs(d['clip'][0][1]-cy)<0.01 and abs(d['clip'][0][2]-r)<0.01
            if d['tag']=='circle':
                dcx=(b[0]+b[2])/2; dcy=(b[1]+b[3])/2; dr=(b[2]-b[0])/2
                if math.hypot(dcx-cx,dcy-cy)+dr+m<=r+1e-6: continue
            pts=[p for s in d['subs'] for k in ('v','i','o') for p in s[k]]
            if same_clip or all(math.hypot(x-cx,y-cy)+m<=r+1e-6 for x,y in pts):
                continue
        kept.append(d)
    return kept

# ---------------------------------------------------------------- building


POS_TOL = 0.05
PREC = 2
SHIFTS = []

def R(x): 
    v = round(x, PREC)
    return int(v) if v == int(v) else v

def realign_frames(frames, log=print):
    """Artboard exports drift by sub-pixel amounts. If every frame has the same opaque background
    circle, translate each frame so that circle sits where it sits in most frames."""
    centers=[]
    for ds in frames:
        bg=find_occluder(ds,(-1e9,-1e9,1e9,1e9))
        centers.append(bg[1] if bg else None)
    if any(c is None for c in centers): return frames, [(0,0)]*len(frames)
    radii=[c[2] for c in centers]
    if max(radii)-min(radii)>0.5: return frames, [(0,0)]*len(frames)
    ref=collections.Counter((round(c[0],2),round(c[1],2)) for c in centers).most_common(1)[0][0]
    out=[]; shifts=[]
    for fi,(ds,c) in enumerate(zip(frames,centers)):
        tx=ref[0]-c[0]; ty=ref[1]-c[1]
        if abs(tx)<1e-9 and abs(ty)<1e-9:
            out.append(ds); shifts.append((0,0)); continue
        m=[1,0,0,1,tx,ty]; nd=[]
        for d in ds:
            d=dict(d); d['subs']=[transform_sub(s,m) for s in d['subs']]; d['bbox']=bbox(d['subs'])
            if d['clip']: d['clip']=[(k[0]+tx,k[1]+ty,k[2]) for k in d['clip']]
            nd.append(d)
        out.append(nd); shifts.append((round(tx,4),round(ty,4)))
        log(f'  frame {fi+1}: re-aligned by {tx:+.2f},{ty:+.2f}')
    return out, shifts

def load_frames(files, realign=True, log=print):
    frames=[]; vb=None
    for f in files:
        svg=load_svg(f); vb=svg['viewBox']
        ds=cull(svg['drawables'], (vb[0],vb[1],vb[0]+vb[2],vb[1]+vb[3]), log)
        frames.append(ds)
    shifts=[(0,0)]*len(frames)
    if realign: frames,shifts=realign_frames(frames, log)
    SHIFTS[:]=shifts
    out=[]
    for ds in frames:
        keep=[]
        for d in ds:
            if d['clip']:
                assert len(d['clip'])==1, 'nested clip-paths unsupported'
                cx,cy,r=d['clip'][0]
                d=clip_drawable(d,(cx,cy),r)
                if d is None: continue
            keep.append(d)
        out.append(keep)
    return out, vb

class Instance:
    __slots__=('key','pos','draw','frames','ind')
    def __init__(self,key,pos,draw,ind):
        self.key=key; self.pos=pos; self.draw=draw; self.frames=set(); self.ind=ind

def build_instances(frames):
    by_key=collections.defaultdict(list); insts=[]; per_frame=[]
    for fi,ds in enumerate(frames):
        seq=[]; used=set()
        for d in ds:
            k=(geom_key(d,PREC), style_key(d))
            pos=(d['bbox'][0],d['bbox'][1])
            hit=None
            for inst in by_key[k]:
                if inst.ind in used: continue
                if abs(inst.pos[0]-pos[0])<=POS_TOL and abs(inst.pos[1]-pos[1])<=POS_TOL:
                    hit=inst; break
            if hit is None:
                hit=Instance(k,pos,d,len(insts)); insts.append(hit); by_key[k].append(hit)
            hit.frames.add(fi); used.add(hit.ind); seq.append(hit.ind)
        per_frame.append(seq)
    return insts, per_frame

def topo_order(insts, per_frame, log=print):
    """Global paint order consistent with every frame. Splits an instance when a cycle forces it."""
    while True:
        n=len(insts); succ=[set() for _ in range(n)]; pred=[set() for _ in range(n)]
        for seq in per_frame:
            for a,b in zip(seq,seq[1:]):
                succ[a].add(b); pred[b].add(a)
        # Kahn, tie-break by first appearance to keep it stable
        indeg=[len(p) for p in pred]; ready=sorted(i for i in range(n) if indeg[i]==0)
        order=[]
        heapq.heapify(ready)
        while ready:
            u=heapq.heappop(ready); order.append(u)
            for v in succ[u]:
                indeg[v]-=1
                if indeg[v]==0: heapq.heappush(ready,v)
        if len(order)==n: return order
        # cycle: find an instance in the cycle appearing in the most frames, split off one frame
        stuck=[i for i in range(n) if indeg[i]>0]
        victim=max(stuck,key=lambda i:len(insts[i].frames))
        # split: give its last frame to a new instance
        f=max(insts[victim].frames)
        new=Instance(insts[victim].key,insts[victim].pos,insts[victim].draw,len(insts)); new.frames={f}
        insts[victim].frames.discard(f); insts.append(new)
        per_frame[f]=[new.ind if x==victim else x for x in per_frame[f]]
        log(f'  z-order conflict: split shape {victim} (frame {f+1})')

def color(c):
    # renderers that truncate (lottie-web canvas, lottie-android) must still land on the exact 8-bit value:
    # round the fraction *up* to 4 dp so v*255 is never a hair below the integer.
    return [min(1.0, math.ceil(v*10000-1e-9)/10000) for v in c]

def opacity_prop(frames_visible, nframes):
    if len(frames_visible)==nframes: return {'a':0,'k':100}
    kfs=[]; prev=None
    for f in range(nframes):
        v=100 if f in frames_visible else 0
        if v!=prev: kfs.append({'t':f,'s':[v],'h':1}); prev=v
    return {'a':1,'k':kfs}

def shape_items(d, ox=0, oy=0):
    items=[]
    for s in d['subs']:
        v=[[R(x-ox),R(y-oy)] for x,y in s['v']]
        i=[[R(ix-x),R(iy-y)] for (ix,iy),(x,y) in zip(s['i'],s['v'])]
        o=[[R(ox-x),R(oy-y)] for (ox,oy),(x,y) in zip(s['o'],s['v'])]
        items.append({'ty':'sh','ks':{'a':0,'k':{'i':i,'o':o,'v':v,'c':bool(s['c'])}}})
    return items

def paint_items(d):
    items=[]
    if d['stroke'] is not None:
        cap={'butt':1,'round':2,'square':3}[d['cap']]; join={'miter':1,'round':2,'bevel':3}[d['join']]
        st={'ty':'st','c':{'a':0,'k':color(d['stroke'])},'o':{'a':0,'k':R(d['stroke_op']*100)},'w':{'a':0,'k':R(d['sw'])},'lc':cap,'lj':join}
        if join==1: st['ml']=R(d['miter'])
        items.append(st)
    if d['fill'] is not None:
        items.append({'ty':'fl','c':{'a':0,'k':color(d['fill'])},'o':{'a':0,'k':R(d['fill_op']*100)},'r':2 if d['rule']=='evenodd' else 1})
    return items

def orientation(sub):
    a=0; v=sub['v']; n=len(v)
    for k in range(n):
        x1,y1=v[k]; x2,y2=v[(k+1)%n]; a+=x1*y2-x2*y1
    return 1 if a>0 else -1

def can_merge(a, b):
    """Two drawables can share one group (one fill/stroke) without changing pixels."""
    if style_key(a)!=style_key(b): return False
    if a['fill'] is not None and a['fill_op']<1: return False
    if a['stroke'] is not None and a['stroke_op']<1: return False
    ba,bb=a['bbox'],b['bbox']; m=(a['sw'] if a['stroke'] else 0)
    disjoint = ba[2]+m<bb[0] or bb[2]+m<ba[0] or ba[3]+m<bb[1] or bb[3]+m<ba[1]
    if disjoint: return True
    if a['fill'] is None: return True  # opaque strokes only: overlap paints the same colour
    if a['rule']=='evenodd': return False
    if len(a['subs'])==1 and len(b['subs'])==1 and orientation(a['subs'][0])==orientation(b['subs'][0]): return True
    return False

def build(files, name='animation', fps=30, merge=True, realign=True, crop=False, log=print):
    frames,vb=load_frames(files, realign, log)
    nf=len(frames)
    insts,per_frame=build_instances(frames)
    log(f'  {sum(len(f) for f in frames)} drawables in {nf} frames -> {len(insts)} unique shapes')
    order=topo_order(insts,per_frame,log)
    # merge paint-adjacent instances that share style + visibility into one group (one fill/stroke)
    runs=[]
    for idx in order:
        inst=insts[idx]
        if merge and runs and runs[-1][0].frames==inst.frames and all(can_merge(x.draw,inst.draw) for x in runs[-1]):
            runs[-1].append(inst)
        else:
            runs.append([inst])
    if merge: log(f'  {len(insts)} shapes -> {len(runs)} groups after merging adjacent same-style runs')
    ox=oy=0; w=int(round(vb[2])); h=int(round(vb[3]))
    if crop:
        bb=None
        for inst in insts:
            b=inst.draw['bbox']; m=inst.draw['sw']/2 if inst.draw['stroke'] else 0
            b=(b[0]-m,b[1]-m,b[2]+m,b[3]+m)
            bb=b if bb is None else (min(bb[0],b[0]),min(bb[1],b[1]),max(bb[2],b[2]),max(bb[3],b[3]))
        ox=math.floor(max(bb[0],vb[0])); oy=math.floor(max(bb[1],vb[1]))
        w=math.ceil(min(bb[2],vb[0]+vb[2]))-ox; h=math.ceil(min(bb[3],vb[1]+vb[3]))-oy
        log(f'  cropped to {w}x{h} (offset {ox},{oy})')
    groups=[]
    # lottie draws the shapes array from last to first (AE panel order: top of the list is on top)
    for run in reversed(runs):
        d=run[0].draw
        it=[]
        for inst in run: it+=shape_items(inst.draw, ox, oy)
        it+=paint_items(d)
        it.append({'ty':'tr','p':{'a':0,'k':[0,0]},'a':{'a':0,'k':[0,0]},'s':{'a':0,'k':[100,100]},'r':{'a':0,'k':0},'o':opacity_prop(run[0].frames,nf)})
        groups.append({'ty':'gr','it':it})
    layer={'ddd':0,'ind':1,'ty':4,'nm':name,'sr':1,'st':0,'ip':0,'op':nf,'bm':0,'ao':0,
           'ks':{'a':{'a':0,'k':[0,0]},'p':{'a':0,'k':[0,0]},'s':{'a':0,'k':[100,100]},'r':{'a':0,'k':0},'o':{'a':0,'k':100}},
           'shapes':groups}
    doc={'v':'5.12.2','fr':fps,'ip':0,'op':nf,'w':w,'h':h,'nm':name,'ddd':0,'assets':[],'layers':[layer],'markers':[]}
    return doc, insts, per_frame, (ox,oy,w,h)

def main(argv=None):
    ap=argparse.ArgumentParser(description='Convert a sequence of SVG frames into a deduplicated hold-keyframe Lottie.')
    ap.add_argument('frames', help='glob of SVG files, one per frame, sorted by name (quote it)')
    ap.add_argument('-o','--out', required=True, help='output .json')
    ap.add_argument('--fps', type=float, default=30)
    ap.add_argument('--name', default=None, help='animation name (default: output basename)')
    ap.add_argument('--precision', type=int, default=2, help='decimals for coordinates (default 2)')
    ap.add_argument('--no-merge', action='store_true', help='keep one group per shape (no adjacent-run merging)')
    ap.add_argument('--no-realign', action='store_true', help='do not correct sub-pixel artboard drift')
    ap.add_argument('--crop', action='store_true', help='crop the composition to the union of visible content')
    ap.add_argument('-q','--quiet', action='store_true')
    a=ap.parse_args(argv)
    global PREC; PREC=a.precision
    files=sorted(glob.glob(a.frames))
    if not files: sys.exit(f'no files match {a.frames}')
    log=(lambda *x: None) if a.quiet else print
    import os
    name=a.name or os.path.splitext(os.path.basename(a.out))[0]
    doc,insts,per_frame,crop=build(files, name=name, fps=a.fps, merge=not a.no_merge, realign=not a.no_realign, crop=a.crop, log=log)
    s=json.dumps(doc,separators=(',',':'))
    with open(a.out,'w') as fh: fh.write(s)
    with open(a.out+'.meta.json','w') as fh:
        json.dump({'files':[os.path.abspath(f) for f in files],'shifts':SHIFTS,'crop':list(crop)},fh)
    ngroups=len(doc['layers'][0]['shapes']); npaths=sum(1 for g in doc['layers'][0]['shapes'] for it in g['it'] if it['ty']=='sh')
    log(f'  wrote {a.out}: {len(s):,} bytes · {doc["w"]}x{doc["h"]} @ {a.fps:g} fps · {doc["op"]} frames · {ngroups} groups · {npaths} paths')

if __name__=='__main__':
    main()
