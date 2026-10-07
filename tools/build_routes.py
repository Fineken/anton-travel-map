"""Строит дорожные маршруты между соседними точками поездок через OSRM.

Результат: data/routes.json — {"<from_id>><to_id>": {"g": polyline5, "km": .., "h": .., "p": profile}}.
Перелёты и паромы не маршрутизируются (рисуются дугой/пунктиром в app.js).
Если дорога не найдена или выглядит неправдоподобно (огромный крюк, точка далеко от дорог),
пара пропускается — на карте будет прямая.

Запуск: python tools/build_routes.py   (уже посчитанные пары берутся из кэша; --force — пересчитать всё)
"""
import json, sys, time, math, urllib.request, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'routes.json'
SERVERS = {
    'car': 'https://router.project-osrm.org/route/v1/driving/',
    'foot': 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
}
SKIP = {'flight', 'ferry', 'boat'}
# Точки без связи с дорожной сетью (острова без машин): маршрут считается от ближайшего причала,
# а до него на карте рисуется прямой отрезок.
START_OVERRIDE = {'princes-islands>cappadocia': (40.9926, 29.0230)}  # причал Кадыкёй
TOLERANCE = 0.00015  # упрощение линии, градусы (~15 м)
FOOT = {'walk', 'hike', 'hiking'}


def hav(a, b):
    r = math.radians
    dlat, dlon = r(b[0] - a[0]), r(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(r(a[0])) * math.cos(r(b[0])) * math.sin(dlon / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def decode(s):
    pts, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            res = shift = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                res |= (b & 0x1f) << shift; shift += 5
                if b < 0x20:
                    break
            vals.append(~(res >> 1) if res & 1 else res >> 1)
        lat += vals[0]; lng += vals[1]
        pts.append((lat / 1e5, lng / 1e5))
    return pts


def encode(pts):
    out, plat, plng = [], 0, 0
    for lat, lng in pts:
        ilat, ilng = round(lat * 1e5), round(lng * 1e5)
        for d in (ilat - plat, ilng - plng):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return ''.join(out)


def simplify(pts, tol):
    # Дуглас — Пекер, итеративно
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (y1, x1), (y2, x2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        best, idx = 0, None
        for i in range(a + 1, b):
            y, x = pts[i]
            if L2 == 0:
                d = math.hypot(x - x1, y - y1)
            else:
                t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / L2))
                d = math.hypot(x - x1 - t * dx, y - y1 - t * dy)
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def osrm(profile, a, b):
    url = SERVERS[profile] + f'{a[1]},{a[0]};{b[1]},{b[0]}?overview=full&geometries=polyline'
    req = urllib.request.Request(url, headers={'User-Agent': 'anton-travel-map/1.0 (github.com/Fineken/anton-travel-map)'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            err = e
            time.sleep(3 * (attempt + 1))
    return {'code': 'Error', 'message': str(err)}


def main():
    places = json.loads((ROOT / 'data' / 'places.json').read_text('utf8'))['places']
    cache = {} if '--force' in sys.argv or not OUT.exists() else json.loads(OUT.read_text('utf8'))
    trips = {}
    for p in places:
        trips.setdefault(p.get('trip_id') or 'none', []).append(p)
    out, rejected = {}, []
    for tid, pts in trips.items():
        pts.sort(key=lambda p: (p.get('order') or 0, p.get('date') or ''))
        for a, b in zip(pts, pts[1:]):
            mode = (b.get('leg') or {}).get('mode')
            if mode in SKIP:
                continue
            key = f"{a['id']}>{b['id']}"
            A, B = (a['lat'], a['lon']), (b['lat'], b['lon'])
            straight = hav(A, B)
            if straight < 0.05:
                continue
            if key in cache:
                out[key] = dict(cache[key], g=encode(simplify(decode(cache[key]['g']), TOLERANCE)))
                continue
            profile = 'foot' if mode in FOOT else 'car'
            res = osrm(profile, START_OVERRIDE.get(key, A), B)
            time.sleep(1.1)
            if res.get('code') != 'Ok':
                rejected.append((key, res.get('code'), res.get('message')))
                continue
            rt = res['routes'][0]
            km = rt['distance'] / 1000
            snap = max(w.get('distance', 0) for w in res['waypoints']) / 1000
            if key in START_OVERRIDE:
                straight = hav(START_OVERRIDE[key], B)
            # неправдоподобно: точка далеко от дороги или крюк сильно больше прямой
            if snap > max(3, straight * 0.3) or km > straight * 3 + 30:
                rejected.append((key, f'implausible: {km:.0f} km road vs {straight:.0f} km straight, snap {snap:.1f} km', ''))
                continue
            out[key] = {'g': encode(simplify(decode(rt['geometry']), TOLERANCE)), 'km': round(km, 1), 'h': round(rt['duration'] / 3600, 1), 'p': profile}
            print(f'{key}: {km:.0f} km ({profile})', flush=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), 'utf8')
    print(f'\nroutes: {len(out)}, rejected: {len(rejected)}')
    for r in rejected:
        print('  -', *r)


if __name__ == '__main__':
    main()
