/* Карта путешествий Антона. Данные: ../data/places.json, ../data/trips.json, ../data/tracks/*.geojson.
   Если настоящих данных нет, берётся sample/ (тестовые данные, помечаются плашкой). */
(async function () {
  const COLORS = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4','#f032e6','#9a6324','#469990','#800000','#808000','#000075'];
  const TYPE_RU = { hitchhiking: 'автостоп', hiking: 'поход', leisure: 'отдых', volunteering: 'волонтёрство', caving: 'спелеология', city: 'город', other: 'другое' };
  const PREC_RU = { exact: 'точная точка', poi: 'объект', settlement: 'населённый пункт', region: 'регион', unclear: 'неясно' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = iso => (iso || '').slice(0, 10);
  const fmt = iso => { if (!iso) return '—'; const [y, m, d] = day(iso).split('-'); return `${d}.${m}.${y}`; };

  async function getJSON(u) { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); }
  let places, trips, isSample = false;
  let DATA = null;
  for (const base of ['data/', '../data/']) {
    try { [places, trips] = await Promise.all([getJSON(base + 'places.json'), getJSON(base + 'trips.json')]); DATA = base; break; } catch (e) {}
  }
  if (!DATA) { [places, trips] = await Promise.all([getJSON('sample/places.json'), getJSON('sample/trips.json')]); isSample = true; DATA = 'sample/'; }
  places = (places.places || places).filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon));
  if (trips.meta && trips.meta.trip_types) Object.assign(TYPE_RU, trips.meta.trip_types);
  trips = trips.trips || trips;
  if (isSample) { const b = document.getElementById('dataBadge'); b.textContent = 'Тестовые данные: настоящие places.json/trips.json ещё не готовы.'; b.classList.remove('hidden'); }

  // Поездки: порядок по дате начала, цвета
  const tripById = new Map();
  trips.forEach(t => tripById.set(t.id, t));
  places.forEach(p => { if (!tripById.has(p.trip_id)) { const t = { id: p.trip_id || 'none', name: p.trip_id ? p.trip_id : 'Без поездки', type: 'other' }; tripById.set(t.id, t); trips.push(t); } });
  trips.forEach(t => { t._places = places.filter(p => (p.trip_id || 'none') === t.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.date > b.date ? 1 : -1)); });
  trips = trips.filter(t => t._places.length);
  trips.sort((a, b) => (a._places[0].date > b._places[0].date ? 1 : -1));
  trips.forEach((t, i) => { t._color = COLORS[i % COLORS.length]; t._on = true; });

  // Карта
  const map = L.map('map', { zoomControl: true, preferCanvas: false });
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Esri World Imagery' });
  L.control.layers({ 'Схема': osm, 'Рельеф': topo, 'Спутник': sat }, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  let photoCache = {}; try { photoCache = await getJSON('media/photos.json'); } catch (e) {}
  function photoUrl(ph) { const u = !ph ? null : typeof ph === 'string' ? ph : (ph.url || ph.src || null); return (u && photoCache[u]) || u; }
  function popupHtml(p, t) {
    const posts = p.posts && p.posts.length ? p.posts : [{ url: p.url, date: p.post_date }];
    const warn = [];
    if (p.confidence === 'low') warn.push('место определено неуверенно');
    if (p.precision && p.precision !== 'exact' && p.precision !== 'poi') warn.push('точность: ' + (PREC_RU[p.precision] || p.precision));
    if (p.date_is_approx) warn.push('дата приблизительная');
    if (p.coord_source && /external|внешн/i.test(p.coord_source)) warn.push('место определено по внешнему источнику, в посте не названо');
    const img = photoUrl(p.photo);
    return `<div class="pop">
      ${img ? `<img src="${esc(img)}" loading="lazy" alt="" onerror="this.remove()">` : ''}
      <h3>${esc(p.name)}</h3>
      <div class="d">${esc(p.country || '')}${p.country ? ' · ' : ''}${fmt(p.date)} · ${esc(t.name)}</div>
      ${warn.length ? `<div class="warn">⚠ ${esc(warn.join('; '))}</div>` : ''}
      ${p.excerpt ? `<div class="ex">${esc(p.excerpt)}${p.excerpt.length >= 280 ? '…' : ''}</div>` : ''}
      <a class="tg" href="${esc(posts[0].url)}" target="_blank" rel="noopener">Пост в Telegram</a>
      ${posts.length > 1 ? `<div class="more">Ещё: ${posts.slice(1).map(q => `<a href="${esc(q.url)}" target="_blank" rel="noopener">#${esc(q.id ?? '')}</a>`).join(', ')}</div>` : ''}
    </div>`;
  }

  // Слои по поездкам
  trips.forEach(t => {
    t._layer = L.layerGroup();
    t._markers = t._places.map(p => {
      const low = p.confidence === 'low' || p.precision === 'region' || p.precision === 'unclear';
      const m = L.circleMarker([+p.lat, +p.lon], { radius: low ? 5 : 6, color: t._color, weight: 2, fillColor: low ? '#fff' : t._color, fillOpacity: low ? 0.9 : 0.85, dashArray: low ? '2 2' : null });
      m.bindPopup(() => popupHtml(p, t), { maxWidth: 300 });
      m.bindTooltip(p.name, { direction: 'top', offset: [0, -4] });
      m._p = p; m._low = low;
      return m;
    });
    t._segs = L.layerGroup();
    t._tracks = L.layerGroup();
    (t.track_files || []).forEach(f => {
      const path = typeof f === 'string' ? f : (f.file || f.path);
      if (!path) return;
      const url = isSample ? 'sample/' + path.replace(/^.*\//, '') : DATA + path.replace(/^(\.\.\/)?(data\/)?/, '');
      getJSON(url).then(g => L.geoJSON(g, { style: { color: t._color, weight: 3, opacity: 0.9 } }).addTo(t._tracks)).catch(() => console.warn('Трек не загрузился', url));
    });
  });
  // Сегменты маршрута: стиль по способу, которым добрались до точки (leg.mode у точки назначения)
  const MODE = {
    flight: { ru: 'перелёт', arc: true, dash: '6 8', weight: 2, opacity: 0.7 },
    ferry: { ru: 'паром', dash: '2 6', weight: 3, opacity: 0.85 },
    boat: { ru: 'лодка', dash: '2 6', weight: 3, opacity: 0.85 },
    train: { ru: 'поезд', dash: '10 4', weight: 3, opacity: 0.8 },
    bus: { ru: 'автобус', dash: null, weight: 3, opacity: 0.75 },
    car: { ru: 'машина', dash: null, weight: 3, opacity: 0.75 },
    hitchhiking: { ru: 'автостоп', dash: null, weight: 3, opacity: 0.75 },
    walk: { ru: 'пешком', dash: null, weight: 3, opacity: 0.75 },
    hike: { ru: 'пешком', dash: null, weight: 3, opacity: 0.75 },
  };
  function arc(a, b) {
    const dx = b.lng - a.lng, dy = b.lat - a.lat, k = 0.18;
    const c = L.latLng((a.lat + b.lat) / 2 + dx * k, (a.lng + b.lng) / 2 - dy * k);
    const pts = [];
    for (let i = 0; i <= 32; i++) { const t = i / 32, u = 1 - t; pts.push([u * u * a.lat + 2 * u * t * c.lat + t * t * b.lat, u * u * a.lng + 2 * u * t * c.lng + t * t * b.lng]); }
    return pts;
  }
  function segment(m1, m2, color) {
    const leg = m2._p.leg || {}, st = MODE[leg.mode] || { dash: null, weight: 3, opacity: 0.75 };
    const a = m1.getLatLng(), b = m2.getLatLng();
    const guessed = leg.source && leg.source !== 'post';
    const line = L.polyline(st.arc ? arc(a, b) : [a, b], { color, weight: st.weight, opacity: guessed && (st.arc || st.dash) ? st.opacity * 0.5 : st.opacity, dashArray: st.dash });
    const km = leg.distance_km ? `${leg.distance_km} км (из поста)` : leg.straight_km ? `≈${Math.round(leg.straight_km)} км по прямой` : null;
    const how = (st.ru || leg.mode) ? (st.ru || leg.mode) + (leg.source === 'post' ? '' : leg.source === 'inferred' ? ' (по тексту)' : leg.source ? ' (предположительно)' : '') : null;
    const tip = [`${m1._p.name} → ${m2._p.name}`, how, km].filter(Boolean).join(' · ');
    line.bindTooltip(tip, { sticky: true });
    return line;
  }
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => { const d = L.DomUtil.create('div', 'legend');
    d.innerHTML = '<div><svg width="34" height="8"><line x1="0" y1="4" x2="34" y2="4" stroke="#444" stroke-width="3"/></svg> по земле</div>' +
      '<div><svg width="34" height="8"><line x1="0" y1="4" x2="34" y2="4" stroke="#444" stroke-width="2" stroke-dasharray="6 8"/></svg> перелёт</div>' +
      '<div><svg width="34" height="8"><line x1="0" y1="4" x2="34" y2="4" stroke="#444" stroke-width="3" stroke-dasharray="2 6"/></svg> паром</div>' +
      '<div><svg width="34" height="8"><circle cx="17" cy="4" r="3.5" fill="#fff" stroke="#444" stroke-dasharray="2 2"/></svg> место неточно</div>';
    return d; };
  legend.addTo(map);
  const joinLine = L.polyline([], { color: '#555', weight: 1.5, opacity: 0.6, dashArray: '6 6' });

  // Ползунок по датам
  const dates = [...new Set(places.map(p => day(p.date)))].sort();
  const slider = document.getElementById('slider'), label = document.getElementById('sliderLabel');
  slider.max = Math.max(0, dates.length - 1); slider.value = slider.max;
  const showLow = document.getElementById('showLow'), joinTrips = document.getElementById('joinTrips');

  function render() {
    const until = dates[+slider.value] || '9999';
    label.textContent = fmt(until);
    const chain = [];
    trips.forEach(t => {
      t._layer.clearLayers();
      if (!t._on) { map.removeLayer(t._layer); return; }
      const vis = t._markers.filter(m => day(m._p.date) <= until && (showLow.checked || !m._low));
      t._segs.clearLayers();
      for (let i = 1; i < vis.length; i++) t._segs.addLayer(segment(vis[i - 1], vis[i], t._color));
      t._layer.addLayer(t._segs);
      if (vis.length === t._markers.length) t._layer.addLayer(t._tracks);
      vis.forEach(m => t._layer.addLayer(m));
      t._layer.addTo(map);
      vis.forEach(m => chain.push(m));
    });
    chain.sort((a, b) => (a._p.date > b._p.date ? 1 : a._p.date < b._p.date ? -1 : 0));
    joinLine.setLatLngs(chain.map(m => m.getLatLng()));
    if (joinTrips.checked) joinLine.addTo(map); else map.removeLayer(joinLine);
  }

  // Список поездок
  const ul = document.getElementById('trips');
  trips.forEach(t => {
    const li = document.createElement('li');
    const s = t._places[0].date, e = t._places[t._places.length - 1].date;
    const stats = [t.days && `${t.days} дн.`, t.km && `${t.km} км`, t.ascent_m && `↑${t.ascent_m} м`, t.descent_m && `↓${t.descent_m} м`, t.passes && `перевалов: ${t.passes}`].filter(Boolean).join(' · ');
    li.innerHTML = `<input type="checkbox" checked aria-label="Показать"><span class="sw" style="background:${t._color}"></span>
      <div><div class="t">${esc(t.name)}</div><div class="m">${fmt(s)}${day(s) !== day(e) ? ' — ' + fmt(e) : ''} · ${esc(TYPE_RU[t.type] || t.type || '')} · мест: ${t._places.length}${stats ? ' · ' + esc(stats) : ''}</div></div>`;
    const cb = li.querySelector('input');
    cb.addEventListener('click', ev => { ev.stopPropagation(); t._on = cb.checked; li.classList.toggle('off', !t._on); render(); });
    li.addEventListener('click', () => {
      if (!t._on) { t._on = cb.checked = true; li.classList.remove('off'); render(); }
      map.fitBounds(L.latLngBounds(t._markers.map(m => m.getLatLng())).pad(0.2), { maxZoom: 11 });
      if (window.innerWidth <= 760) document.getElementById('panel').classList.add('collapsed');
    });
    ul.appendChild(li);
  });
  document.getElementById('stats').textContent = `Поездок: ${trips.length}, мест: ${places.length}` + (dates.length ? `, ${fmt(dates[0])} — ${fmt(dates[dates.length - 1])}` : '');

  slider.addEventListener('input', render);
  showLow.addEventListener('change', render);
  joinTrips.addEventListener('change', render);
  document.getElementById('togglePanel').addEventListener('click', () => { document.getElementById('panel').classList.toggle('collapsed'); setTimeout(() => map.invalidateSize(), 250); });

  let timer = null; const playBtn = document.getElementById('play');
  playBtn.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; playBtn.textContent = '▶'; return; }
    if (+slider.value >= +slider.max) slider.value = 0;
    playBtn.textContent = '⏸';
    timer = setInterval(() => { if (+slider.value >= +slider.max) { clearInterval(timer); timer = null; playBtn.textContent = '▶'; return; } slider.value = +slider.value + 1; render(); }, 400);
  });

  render();
  if (places.length) map.fitBounds(L.latLngBounds(places.map(p => [+p.lat, +p.lon])).pad(0.1)); else map.setView([55.75, 37.6], 4);
  window.addEventListener('resize', () => map.invalidateSize());
})();
