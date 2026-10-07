/* Карта путешествий Антона. Данные: data/places.json, data/trips.json, data/routes.json (дороги, см. tools/build_routes.py),
   data/tracks/*.geojson. Если настоящих данных нет, берётся sample/ (тестовые данные, помечаются плашкой). */
(async function () {
  const COLORS = ['#e4572e', '#2a9d8f', '#3d5a80', '#e9a23b', '#8e5ad6', '#1b98e0', '#d1495b', '#6a994e', '#c97c5d', '#4f6d7a', '#b5838d', '#00798c'];
  const TYPE_RU = { hitchhiking: 'автостоп', hiking: 'поход', leisure: 'отдых', volunteering: 'волонтёрство', caving: 'спелеология', city: 'город', other: 'другое' };
  const PREC_RU = { exact: 'точная точка', poi: 'объект', settlement: 'населённый пункт', region: 'регион', unclear: 'неясно' };
  const MODE = {
    flight: { ru: 'перелёт', kind: 'air' },
    ferry: { ru: 'паром', kind: 'sea' },
    boat: { ru: 'лодка', kind: 'sea' },
    train: { ru: 'поезд', kind: 'ground' },
    bus: { ru: 'автобус', kind: 'ground' },
    car: { ru: 'машина', kind: 'ground' },
    hitchhiking: { ru: 'автостоп', kind: 'ground' },
    walk: { ru: 'пешком', kind: 'ground' },
    hike: { ru: 'пешком', kind: 'ground' },
    hiking: { ru: 'пешком', kind: 'ground' },
  };
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = iso => (iso || '').slice(0, 10);
  const fmt = iso => { if (!iso) return '—'; const [y, m, d] = day(iso).split('-'); return `${d}.${m}.${y}`; };
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const fmtNice = iso => { if (!iso) return '—'; const [y, m, d] = day(iso).split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
  const num = n => Math.round(n).toLocaleString('ru-RU');
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const isMobile = () => window.matchMedia('(max-width:760px)').matches;
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  async function getJSON(u) { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); }
  let places, trips, isSample = false, DATA = null;
  for (const base of ['data/', '../data/']) {
    try { [places, trips] = await Promise.all([getJSON(base + 'places.json'), getJSON(base + 'trips.json')]); DATA = base; break; } catch (e) {}
  }
  if (!DATA) { [places, trips] = await Promise.all([getJSON('sample/places.json'), getJSON('sample/trips.json')]); isSample = true; DATA = 'sample/'; }
  places = (places.places || places).filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon));
  if (trips.meta && trips.meta.trip_types) Object.assign(TYPE_RU, trips.meta.trip_types);
  trips = trips.trips || trips;
  if (isSample) { const b = $('dataBadge'); b.textContent = 'Тестовые данные: настоящие places.json/trips.json ещё не готовы.'; b.classList.remove('hidden'); }
  let routes = {}; try { routes = await getJSON(DATA + 'routes.json'); } catch (e) { console.warn('routes.json не найден — участки будут прямыми'); }
  let photoCache = {}; try { photoCache = await getJSON('media/photos.json'); } catch (e) {}
  const photoUrl = ph => { const u = !ph ? null : typeof ph === 'string' ? ph : (ph.url || ph.src || null); return (u && photoCache[u]) || u; };
  const localPhoto = ph => { const u = !ph ? null : typeof ph === 'string' ? ph : (ph.url || ph.src || null); return u && photoCache[u]; };

  // Google encoded polyline (precision 5) → [[lat, lng], ...]
  function decode(str) {
    const out = []; let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const k of [0, 1]) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k) lng += d; else lat += d;
      }
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }
  function hav(a, b) {
    const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  function arc(a, b) {
    const dx = b[1] - a[1], dy = b[0] - a[0], k = 0.2;
    const c = [(a[0] + b[0]) / 2 + dx * k, (a[1] + b[1]) / 2 - dy * k];
    const pts = [];
    for (let i = 0; i <= 48; i++) { const t = i / 48, u = 1 - t; pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]); }
    return pts;
  }

  // ---------- поездки и участки ----------
  const tripById = new Map();
  trips.forEach(t => tripById.set(t.id, t));
  places.forEach(p => { if (!tripById.has(p.trip_id || 'none')) { const t = { id: p.trip_id || 'none', name: p.trip_id || 'Без поездки', type: 'other' }; tripById.set(t.id, t); trips.push(t); } });
  trips.forEach(t => { t._places = places.filter(p => (p.trip_id || 'none') === t.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.date > b.date ? 1 : -1)); });
  trips = trips.filter(t => t._places.length);
  trips.sort((a, b) => (a._places[0].date > b._places[0].date ? 1 : -1));
  trips.forEach((t, i) => {
    t._color = COLORS[i % COLORS.length]; t._on = true;
    t._places.forEach((p, j) => { p._trip = t; p._idx = j; p._low = p.confidence === 'low' || p.precision === 'region' || p.precision === 'unclear'; });
    t._cover = (t._places.map(p => localPhoto(p.photo)).find(Boolean)) || null;
    t._legs = [];
    for (let j = 1; j < t._places.length; j++) {
      const a = t._places[j - 1], b = t._places[j], leg = b.leg || {}, A = [+a.lat, +a.lon], B = [+b.lat, +b.lon];
      const st = MODE[leg.mode] || { ru: null, kind: 'ground' }, straight = hav(A, B);
      if (straight < 0.05) continue;
      const r = routes[`${a.id}>${b.id}`];
      let kind = st.kind, pts, km;
      if (kind === 'air') { pts = arc(A, B); km = straight; }
      else if (kind === 'sea') { pts = [A, B]; km = straight; }
      else if (r) { pts = decode(r.g); pts.unshift(A); pts.push(B); km = r.km; kind = 'road'; }
      else { pts = [A, B]; km = straight; kind = 'straight'; }
      t._legs.push({ a, b, leg, st, kind, pts, km, h: r && r.h, straight });
    }
    t._km = t._legs.reduce((s, l) => s + l.km, 0);
    t._roadKm = t._legs.filter(l => l.kind === 'road').reduce((s, l) => s + l.km, 0);
    t._countries = [...new Set(t._places.map(p => p.country).filter(Boolean))];
  });

  // ---------- карта ----------
  const map = L.map('map', { zoomControl: false, preferCanvas: false, worldCopyJump: true });
  const soft = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles-soft', attribution: '© OpenStreetMap' }).addTo(map);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Esri World Imagery' });
  L.control.layers({ 'Мягкая': soft, 'OpenStreetMap': osm, 'Рельеф': topo, 'Спутник': sat }, null, { position: 'topright' }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.createPane('routes').style.zIndex = 410;
  map.createPane('casing').style.zIndex = 405;

  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div', 'legend'), c = dark ? '#ece8e1' : '#3a342c';
    d.innerHTML =
      `<div><svg width="34" height="10"><line x1="0" y1="5" x2="34" y2="5" stroke="${c}" stroke-width="4" stroke-linecap="round"/></svg>по дорогам</div>` +
      `<div><svg width="34" height="10"><line x1="0" y1="5" x2="34" y2="5" stroke="${c}" stroke-width="2.5" stroke-dasharray="1 6" stroke-linecap="round"/></svg>напрямую (дороги нет)</div>` +
      `<div><svg width="34" height="10"><path d="M1 8 Q17 -2 33 8" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="6 6"/></svg>перелёт</div>` +
      `<div><svg width="34" height="10"><line x1="0" y1="5" x2="34" y2="5" stroke="${c}" stroke-width="3" stroke-dasharray="8 4 2 4"/></svg>паром</div>` +
      `<div><svg width="34" height="12"><circle cx="17" cy="6" r="4.5" fill="#fff" stroke="${c}" stroke-width="1.6" stroke-dasharray="2 2"/></svg>место неточно</div>`;
    return d;
  };
  legend.addTo(map);

  const casingColor = dark ? '#0e0f12' : '#ffffff';
  function legTooltip(l) {
    const src = l.leg.source === 'post' ? '' : l.leg.source === 'inferred' ? ' (по тексту)' : l.leg.source ? ' (предположительно)' : '';
    const how = l.st.ru ? l.st.ru + src : null;
    const dist = l.leg.distance_km ? `${l.leg.distance_km} км (из поста)`
      : l.kind === 'road' ? `≈${num(l.km)} км по дорогам${l.h ? `, ~${l.h < 1 ? Math.round(l.h * 60) + ' мин' : l.h + ' ч'} за рулём` : ''}`
      : `≈${num(l.straight)} км по прямой`;
    return `${esc(l.a.name)} → ${esc(l.b.name)}<span class="tm">${[how, dist].filter(Boolean).map(esc).join(' · ')}</span>`;
  }
  function legLayers(l, color) {
    const out = [];
    if (l.kind === 'road' || l.kind === 'straight' || l.kind === 'sea') {
      if (l.kind === 'road') out.push(L.polyline(l.pts, { pane: 'casing', color: casingColor, weight: 7, opacity: 0.9, interactive: false, lineCap: 'round', lineJoin: 'round' }));
      out.push(L.polyline(l.pts, {
        pane: 'routes', color, lineCap: 'round', lineJoin: 'round',
        weight: l.kind === 'road' ? 4 : l.kind === 'sea' ? 3 : 2.5,
        opacity: l.kind === 'road' ? 0.95 : 0.85,
        dashArray: l.kind === 'sea' ? '8 4 2 4' : l.kind === 'straight' ? '1 7' : null,
      }));
    } else {
      out.push(L.polyline(l.pts, { pane: 'routes', color, weight: 2, opacity: 0.75, dashArray: '6 7' }));
    }
    const main = out[out.length - 1];
    main.bindTooltip(legTooltip(l), { sticky: true });
    main.on('mouseover', () => main.setStyle({ weight: main.options.weight + 2 })).on('mouseout', () => main.setStyle({ weight: main.options.weight - 2 }));
    main._main = true;
    return out;
  }

  function popupHtml(p) {
    const t = p._trip, posts = p.posts && p.posts.length ? p.posts : [{ url: p.url, date: p.post_date }];
    const warn = [];
    if (p.confidence === 'low') warn.push('место определено неуверенно');
    if (p.precision && p.precision !== 'exact' && p.precision !== 'poi') warn.push('точность: ' + (PREC_RU[p.precision] || p.precision));
    if (p.date_is_approx) warn.push('дата приблизительная');
    if (p.coord_source && /external|внешн/i.test(p.coord_source)) warn.push('место определено по внешнему источнику, в посте не названо');
    const img = photoUrl(p.photo), n = t._places.length;
    return `<div class="pop" style="--c:${t._color}">
      ${img ? `<div class="ph" style="background-image:url('${esc(img)}')"><span class="n">${p._idx + 1} / ${n}</span></div>` : ''}
      <div class="in">
        <h3>${esc(p.name)}</h3>
        <div class="d">${esc(p.country || '')}${p.country ? ' · ' : ''}${fmtNice(p.date)} · <b>${esc(t.name)}</b></div>
        ${warn.length ? `<div class="warn"><span>⚠</span><span>${esc(warn.join('; '))}</span></div>` : ''}
        ${p.excerpt ? `<div class="ex">${esc(p.excerpt)}${p.excerpt.length >= 280 ? '…' : ''}</div>` : ''}
        <div class="row">
          <a class="tg" href="${esc(posts[0].url)}" target="_blank" rel="noopener"><svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M9.8 15.3l-.4 5.3c.6 0 .8-.2 1.1-.5l2.6-2.5 5.4 4c1 .5 1.7.3 2-.9l3.6-17c.3-1.5-.6-2.1-1.6-1.7L1.4 9.9c-1.4.6-1.4 1.4-.2 1.8l5.4 1.7L19 5.6c.6-.4 1.1-.2.7.2z"/></svg>Пост в Telegram</a>
          ${posts.length > 1 ? `<span class="more">ещё ${posts.slice(1).map(q => `<a href="${esc(q.url)}" target="_blank" rel="noopener">#${esc(q.id ?? '')}</a>`).join(', ')}</span>` : ''}
        </div>
        <div class="nav"><button data-go="${p._idx - 1}" data-trip="${esc(t.id)}" ${p._idx ? '' : 'disabled'}>← ${p._idx ? esc(t._places[p._idx - 1].name) : ''}</button>
          <button data-go="${p._idx + 1}" data-trip="${esc(t.id)}" ${p._idx < n - 1 ? '' : 'disabled'}>${p._idx < n - 1 ? esc(t._places[p._idx + 1].name) : ''} →</button></div>
      </div></div>`;
  }

  // слои по поездкам
  trips.forEach(t => {
    t._layer = L.layerGroup();
    t._markers = t._places.map((p, j) => {
      const edge = j === 0 || j === t._places.length - 1;
      const icon = L.divIcon({
        className: 'pin-wrap', iconSize: edge ? [22, 22] : [14, 14],
        html: `<div class="pin${p._low ? ' low' : ''}${edge && !p._low ? ' big' : ''}" style="--c:${t._color}">${edge && !p._low ? (j === 0 ? '▶' : '■') : ''}</div>`,
      });
      const m = L.marker([+p.lat, +p.lon], { icon, riseOnHover: true, zIndexOffset: edge ? 500 : 0 });
      m.bindPopup(() => popupHtml(p), { maxWidth: 320, minWidth: 260, autoPanPaddingTopLeft: [isMobile() ? 20 : 400, 70], autoPanPaddingBottomRight: [70, 90] });
      m.bindTooltip(`${esc(p.name)}<span class="tm">${fmtNice(p.date)}</span>`, { direction: 'top', offset: [0, -10] });
      m._p = p; p._m = m;
      return m;
    });
    t._legLayers = t._legs.map(l => legLayers(l, t._color));
    t._tracks = L.layerGroup();
    (t.track_files || []).forEach(f => {
      const path = typeof f === 'string' ? f : (f.file || f.path);
      if (!path) return;
      const url = isSample ? 'sample/' + path.replace(/^.*\//, '') : DATA + path.replace(/^(\.\.\/)?(data\/)?/, '');
      getJSON(url).then(g => L.geoJSON(g, { pane: 'routes', style: { color: t._color, weight: 3, opacity: 0.9 } }).addTo(t._tracks)).catch(() => console.warn('Трек не загрузился', url));
    });
    t._layer.addTo(map);
  });
  const joinLayer = L.layerGroup();
  const zoomClass = () => { const z = map.getZoom(), c = map.getContainer().classList; c.toggle('z-far', z < 5); c.toggle('z-mid', z >= 5 && z < 7); };
  map.on('zoomend', zoomClass);

  // ---------- шкала времени ----------
  const dates = [...new Set(places.map(p => day(p.date)))].sort();
  const slider = $('slider'), label = $('sliderLabel'), placeLabel = $('sliderPlace');
  slider.max = Math.max(0, dates.length - 1); slider.value = slider.max;
  const ticks = $('ticks'), span = Math.max(1, dates.length - 1);
  trips.forEach(t => {
    const i0 = dates.indexOf(day(t._places[0].date)), i1 = dates.indexOf(day(t._places[t._places.length - 1].date));
    const el = document.createElement('i');
    el.style.cssText = `left:${(i0 / span) * 100}%;width:max(4px,${((i1 - i0) / span) * 100}%);background:${t._color}`;
    ticks.appendChild(el);
  });
  const showLow = $('showLow'), joinTrips = $('joinTrips');

  let focus = null, drawn = new Set(), animate = false, curP = null;
  // текущая точка при пошаговом просмотре: пульсирующий маркер и подсветка в списке остановок
  function markCur() {
    document.querySelectorAll('.pin.cur').forEach(e => e.classList.remove('cur', 'pulse'));
    const el = curP && curP._m.getElement();
    if (el) el.querySelector('.pin').classList.add('cur', 'pulse');
    document.querySelectorAll('.stop.cur').forEach(e => e.classList.remove('cur'));
    if (focus && curP && curP._trip === focus) {
      const li = document.querySelector(`.stop[data-j="${curP._idx}"]`);
      if (li) { li.classList.add('cur'); li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  }
  function render() {
    const until = dates[+slider.value] || '9999';
    label.textContent = fmtNice(until);
    let last = null;
    trips.forEach(t => {
      t._layer.clearLayers();
      if (!t._on) return;
      const dim = focus && focus !== t;
      t._markers.forEach(m => {
        const p = m._p;
        if (day(p.date) > until || (!showLow.checked && p._low)) return;
        t._layer.addLayer(m);
        if (m._icon) m._icon.style.opacity = dim ? 0.25 : 1;
        m.setOpacity(dim ? 0.25 : 1);
        if (!last || p.date >= last.date) last = p;
      });
      t._legs.forEach((l, i) => {
        if (day(l.b.date) > until) return;
        const key = t.id + i, fresh = animate && !drawn.has(key);
        t._legLayers[i].forEach(ly => {
          t._layer.addLayer(ly);
          ly.setStyle({ opacity: dim ? 0.18 : ly.options.pane === 'casing' ? 0.9 : l.kind === 'road' ? 0.95 : 0.85 });
          const el = ly.getElement && ly.getElement();
          if (el) {
            el.classList.remove('route-new');
            if (fresh) { const len = el.getTotalLength ? Math.ceil(el.getTotalLength()) : 0; if (len) { el.style.setProperty('--len', len); void el.getBoundingClientRect(); el.classList.add('route-new'); } }
            else { el.style.removeProperty('--len'); }
          }
        });
        drawn.add(key);
      });
      if (t._places.every(p => day(p.date) <= until)) t._layer.addLayer(t._tracks);
    });
    placeLabel.textContent = last ? last.name : '';
    // линия между поездками: конец одной → начало следующей
    joinLayer.clearLayers();
    if (joinTrips.checked) {
      const on = trips.filter(t => t._on && day(t._places[0].date) <= until);
      for (let i = 1; i < on.length; i++) {
        const a = on[i - 1]._places[on[i - 1]._places.length - 1], b = on[i]._places[0];
        L.polyline(arc([+a.lat, +a.lon], [+b.lat, +b.lon]), { color: dark ? '#aaa' : '#555', weight: 1.5, opacity: 0.55, dashArray: '2 6', interactive: false }).addTo(joinLayer);
      }
      joinLayer.addTo(map);
    } else map.removeLayer(joinLayer);
    if (focus) renderStops(until);
    if (curP) markCur();
  }

  // ---------- панель ----------
  const tripMeta = t => {
    const s = t._places[0].date, e = t._places[t._places.length - 1].date;
    return `${fmtNice(s)}${day(s) !== day(e) ? ' — ' + fmtNice(e) : ''}`;
  };
  const tripChips = t => {
    const c = [`<span class="chip type">${esc(TYPE_RU[t.type] || t.type || 'поездка')}</span>`,
      `<span class="chip">${t._places.length} ${plural(t._places.length, 'место', 'места', 'мест')}</span>`];
    if (t._km >= 1) c.push(`<span class="chip">≈${num(t.km || t._km)} км</span>`);
    if (t._countries.length > 1) c.push(`<span class="chip">${t._countries.length} ${plural(t._countries.length, 'страна', 'страны', 'стран')}</span>`);
    if (t.days) c.push(`<span class="chip">${t.days} дн.</span>`);
    if (t.ascent_m) c.push(`<span class="chip">↑${num(t.ascent_m)} м</span>`);
    if (t.passes) c.push(`<span class="chip">перевалов: ${t.passes}</span>`);
    return `<div class="chips">${c.join('')}</div>`;
  };
  const EYE_ON = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7c1.8 0 3.3-.5 4.6-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  const ul = $('trips');
  trips.forEach(t => {
    const li = document.createElement('li');
    li.className = 'trip'; li.style.setProperty('--c', t._color); li.tabIndex = 0;
    li.innerHTML = `<div class="cover" ${t._cover ? `style="background-image:url('${esc(t._cover)}')"` : ''}></div>
      <div class="body"><div class="t">${esc(t.name)}</div><div class="m">${tripMeta(t)}</div>${tripChips(t)}</div>
      <button class="eye" aria-label="Показать/скрыть на карте" title="Показать/скрыть на карте">${EYE_ON}</button>`;
    const eye = li.querySelector('.eye');
    t._setOn = on => { t._on = on; li.classList.toggle('off', !on); eye.innerHTML = on ? EYE_ON : EYE_OFF; };
    eye.addEventListener('click', ev => { ev.stopPropagation(); t._setOn(!t._on); render(); syncAll(); });
    li.addEventListener('click', () => openTrip(t));
    li.addEventListener('keydown', ev => { if (ev.key === 'Enter') openTrip(t); });
    ul.appendChild(li);
  });
  const allBtn = $('allToggle');
  const syncAll = () => { allBtn.textContent = trips.some(t => t._on) ? 'скрыть все' : 'показать все'; };
  allBtn.addEventListener('click', () => { const on = !trips.some(t => t._on); trips.forEach(t => t._setOn(on)); render(); syncAll(); });

  const countries = new Set(places.map(p => p.country).filter(Boolean));
  const totalKm = trips.reduce((s, t) => s + t._km, 0);
  $('stats').innerHTML = [[trips.length, plural(trips.length, 'поездка', 'поездки', 'поездок')], [places.length, plural(places.length, 'место', 'места', 'мест')],
    [countries.size, plural(countries.size, 'страна', 'страны', 'стран')], [num(totalKm), 'км пути']]
    .map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  if (dates.length) $('stats').insertAdjacentHTML('afterend', `<div class="range">${fmtNice(dates[0])} — ${fmtNice(dates[dates.length - 1])}</div>`);

  function boundsOf(t) { const b = L.latLngBounds(t._places.map(p => [+p.lat, +p.lon])); t._legs.forEach(l => l.pts.forEach(q => b.extend(q))); return b; }
  function fitOpts() { return isMobile() ? { paddingTopLeft: [20, 70], paddingBottomRight: [20, window.innerHeight * 0.48], maxZoom: 12 } : { paddingTopLeft: [panel.classList.contains('collapsed') ? 40 : 420, 40], paddingBottomRight: [70, 100], maxZoom: 12 }; }

  const panel = $('panel');
  function openTrip(t) {
    if (!t._on) t._setOn(true);
    if (dates[+slider.value] < day(t._places[t._places.length - 1].date)) { stop(); slider.value = slider.max; }
    focus = t;
    $('listView').classList.add('hidden'); $('tripView').classList.remove('hidden');
    $('tripView').style.setProperty('--c', t._color);
    $('tripHead').innerHTML = `<div class="trip-hero" style="--c:${t._color};${t._cover ? `background-image:url('${esc(t._cover)}')` : ''}"><div><h2>${esc(t.name)}</h2><p>${tripMeta(t)}${t._countries.length ? ' · ' + esc(t._countries.length > 4 ? t._countries.slice(0, 4).join(', ') + ` и ещё ${t._countries.length - 4}` : t._countries.join(', ')) : ''}</p></div></div>
      ${tripChips(t)}${t.note ? `<p class="trip-note">${esc(t.note)}</p>` : ''}`;
    panel.scrollTop = 0;
    render();
    map.flyToBounds(boundsOf(t), { ...fitOpts(), duration: 0.9 });
  }
  function closeTrip() {
    focus = null; map.closePopup();
    $('tripView').classList.add('hidden'); $('listView').classList.remove('hidden');
    render();
  }
  $('backBtn').addEventListener('click', () => { closeTrip(); fitAll(true); });

  function renderStops(until) {
    const t = focus, ol = $('stops');
    ol.style.setProperty('--c', t._color);
    ol.innerHTML = t._places.map((p, j) => {
      const l = t._legs.find(x => x.b === p);
      const legTxt = l ? [l.st.ru, l.leg.distance_km ? l.leg.distance_km + ' км' : l.km >= 1 ? '≈' + num(l.km) + ' км' + (l.kind === 'road' ? ' по дорогам' : '') : null].filter(Boolean).join(' · ') : '';
      const edge = j === 0 || j === t._places.length - 1;
      return `<li class="stop${edge ? ' end' : ''}${p._low ? ' low' : ''}${day(p.date) > until ? ' future' : ''}" data-j="${j}">
        <span class="dot"></span>${legTxt ? `<div class="leg">${esc(legTxt)}</div>` : ''}<div class="n">${esc(p.name)}</div><div class="d">${fmtNice(p.date)}${p.country ? ' · ' + esc(p.country) : ''}</div></li>`;
    }).join('');
  }
  $('stops').addEventListener('click', ev => { const li = ev.target.closest('.stop'); if (li) goTo(focus, +li.dataset.j); });

  function goTo(t, j) {
    const p = t._places[j]; if (!p) return;
    const until = dates[+slider.value];
    if (day(p.date) > until) { slider.value = dates.indexOf(day(p.date)); }
    if (p._low && !showLow.checked) showLow.checked = true;
    if (focus !== t) openTrip(t); else render();
    if (isMobile()) panel.classList.add('collapsed');
    curP = p; markCur();
    map.flyTo([+p.lat, +p.lon], Math.max(map.getZoom(), 9), { duration: 0.8 });
    map.once('moveend', () => p._m.openPopup());
  }
  map.getContainer().addEventListener('click', ev => {
    const b = ev.target.closest('.pop .nav button'); if (!b) return;
    goTo(tripById.get(b.dataset.trip), +b.dataset.go);
  });

  function fitAll(fly) {
    const on = trips.filter(t => t._on);
    if (!on.length) return map.setView([55.75, 37.6], 4);
    const b = L.latLngBounds([]); on.forEach(t => b.extend(boundsOf(t)));
    fly ? map.flyToBounds(b, { ...fitOpts(), maxZoom: 7, duration: 0.9 }) : map.fitBounds(b, { ...fitOpts(), maxZoom: 7 });
  }

  // свернуть/развернуть панель
  const app = $('app');
  function setCollapsed(c) {
    panel.classList.toggle('collapsed', c);
    if (!isMobile()) { app.classList.toggle('wide', c); $('openPanel').classList.toggle('hidden', !c); }
    setTimeout(() => map.invalidateSize(), 360);
  }
  $('togglePanel').addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  $('openPanel').addEventListener('click', () => setCollapsed(false));
  $('grip').addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  if (isMobile()) panel.classList.add('collapsed');
  window.matchMedia('(max-width:760px)').addEventListener('change', e => { app.classList.remove('wide'); $('openPanel').classList.add('hidden'); panel.classList.toggle('collapsed', e.matches); });

  slider.addEventListener('input', () => { animate = false; render(); });
  showLow.addEventListener('change', render);
  joinTrips.addEventListener('change', render);

  // ---------- проигрывание: шаги по точкам, слежение камерой, скорость ----------
  const playBtn = $('play'), speedBtn = $('speed'), followBtn = $('follow');
  const SPEEDS = [0.5, 1, 2, 4];
  const load = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  let speed = SPEEDS.includes(+load('tm-speed')) ? +load('tm-speed') : 1, follow = load('tm-follow') !== '0';
  let playing = false, timer = null, waitMove = null;
  function syncCtl() {
    speedBtn.textContent = '×' + String(speed).replace('.', ',');
    followBtn.classList.toggle('on', follow);
    followBtn.title = 'Камера следует за маршрутом: ' + (follow ? 'вкл.' : 'выкл.');
    followBtn.setAttribute('aria-pressed', follow);
  }
  syncCtl();
  speedBtn.addEventListener('click', () => { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; save('tm-speed', speed); syncCtl(); if (playing && !waitMove) schedule(); });
  followBtn.addEventListener('click', () => { follow = !follow; save('tm-follow', follow ? '1' : '0'); syncCtl(); if (follow && curP) show(curP, false); });

  // последовательность точек: выбранная поездка или все видимые, по времени
  function seq() {
    const src = focus ? focus._places : trips.filter(t => t._on).flatMap(t => t._places);
    return src.filter(p => showLow.checked || !p._low).sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a._idx - b._idx));
  }
  function show(p, anim) {
    const di = dates.indexOf(day(p.date));
    curP = p;
    if (+slider.value !== di) { slider.value = di; animate = anim; render(); animate = false; }
    markCur();
    placeLabel.textContent = p.name;
    if (waitMove) { map.off('moveend', waitMove); waitMove = null; }
    if (follow) {
      const far = !map.getBounds().contains([+p.lat, +p.lon]);
      map.closePopup();
      waitMove = () => { waitMove = null; markCur(); if (curP === p) p._m.openPopup(); if (playing) schedule(); };
      map.once('moveend', waitMove);
      const z = Math.min(12, Math.max(map.getZoom(), 8)), sz = map.getSize();
      // flyTo у Leaflet падает на карте нулевого размера (скрытая вкладка) — тогда без анимации
      try { if (!sz.x || !sz.y) throw 0; map.flyTo([+p.lat, +p.lon], z, { duration: (far ? 1.6 : 0.9) / Math.sqrt(speed) }); }
      catch (e) { map.setView([+p.lat, +p.lon], z, { animate: false }); }
    } else {
      if (!map.getBounds().pad(-0.15).contains([+p.lat, +p.lon])) map.panTo([+p.lat, +p.lon], { duration: 0.5 });
      if (playing) schedule();
    }
  }
  function step(dir) {
    const s = seq(); if (!s.length) return false;
    let i = curP ? s.indexOf(curP) : -1;
    if (i < 0 && +slider.value >= +slider.max) i = dir > 0 ? -1 : s.length; // шкала в конце — «далее» начинает с первой точки
    else if (i < 0) { // текущей точки нет — отталкиваемся от даты на шкале
      const until = dates[+slider.value];
      const last = s.reduce((k, p, j) => (day(p.date) <= until ? j : k), -1);
      i = dir > 0 ? last : last + 1;
    }
    const j = i + dir;
    if (j < 0 || j >= s.length) return false;
    show(s[j], dir > 0);
    return true;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (playing && !step(1)) pause(); }, (follow ? 2600 : 700) / speed);
  }
  function play() {
    const s = seq(); if (!s.length) return;
    playing = true; playBtn.classList.add('on'); playBtn.setAttribute('aria-label', 'Пауза');
    const i = curP ? s.indexOf(curP) : -1;
    const atEnd = i === s.length - 1 || (i < 0 && dates[+slider.value] >= day(s[s.length - 1].date));
    if (atEnd) { // с начала: маршрут рисуется заново
      drawn.clear(); curP = null;
      slider.value = Math.max(0, dates.indexOf(day(s[0].date)) - 1); render();
      show(s[0], true);
    } else if (!step(1)) pause();
  }
  function pause() { playing = false; clearTimeout(timer); playBtn.classList.remove('on'); playBtn.setAttribute('aria-label', 'Проиграть маршрут'); }
  const stop = pause;
  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  $('prev').addEventListener('click', () => { pause(); step(-1); });
  $('next').addEventListener('click', () => { pause(); step(1); });
  slider.addEventListener('input', () => { pause(); curP = null; markCur(); });
  document.addEventListener('keydown', ev => {
    const el = ev.target instanceof Element ? ev.target : document.body;
    if (el.closest('input[type=text],textarea,select') || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { ev.preventDefault(); pause(); step(ev.key === 'ArrowRight' ? 1 : -1); }
    else if (ev.key === ' ' && !el.closest('button')) { ev.preventDefault(); playing ? pause() : play(); }
  });
  map.on('dragstart', () => { if (playing && follow) pause(); });

  render();
  trips.forEach(t => t._legs.forEach((l, i) => drawn.add(t.id + i)));
  fitAll(false);
  zoomClass();
  window.addEventListener('resize', () => map.invalidateSize());
})();
