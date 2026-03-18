/* ============================================================
   FRAMED TRAILS — script.js
   All application logic: GPX parsing, Mapbox, Chart.js, export
   ============================================================ */

// ── CONFIG ────────────────────────────────────────────────
// Token is loaded from config.js (gitignored) via window.ENV.
// Copy config.example.js → config.js and add your token.
const MAPBOX_TOKEN = window.ENV?.MAPBOX_TOKEN || '';

const MAP_STYLES = {
  'streets':          'mapbox://styles/mapbox/streets-v12',
  'outdoors':         'mapbox://styles/mapbox/outdoors-v12',
  'light':            'mapbox://styles/mapbox/light-v11',
  'dark':             'mapbox://styles/mapbox/dark-v11',
  'satellite':        'mapbox://styles/mapbox/satellite-v9',
  'satellite-streets':'mapbox://styles/mapbox/satellite-streets-v12',
  'nav-day':          'mapbox://styles/mapbox/navigation-day-v1',
  'nav-night':        'mapbox://styles/mapbox/navigation-night-v1',
};

// ── STATE ─────────────────────────────────────────────────
let uploadStatusTimer = null;
let routePillTimer    = null;
let map            = null;
let elevChart      = null;
let routeCoords    = [];   // [[lng, lat], ...]
let elevData       = [];   // [meters, ...]
let routeColor     = '#e63946';
let startMarker    = null;
let endMarker      = null;
let markerSize     = 12;
let dashGap        = 2;
let dashPatternKey = 'short';

// Returns mapbox line-dasharray for current pattern + gap
const DASH_PATTERNS = {
  'short':    (g) => [3,   g],
  'long':     (g) => [8,   g],
  'dot':      (g) => [0.5, g],
  'dash-dot': (g) => [6,   g, 1, g],
};

const state = {
  showMarkers:   true,
  showElevation: true,
  showBrand:     true,
  isDash:        false,
};

// ── GPX FILE LIST ─────────────────────────────────────────
const uploadedFiles  = [];   // [{name, coords, elevations, pointCount, distanceKm}]
let   activeFileIdx  = -1;
// ── PERSISTENCE (IndexedDB — no size limit unlike sessionStorage) ──────────
const IDB_NAME  = 'FramedTrails';
const IDB_STORE = 'routes';

function openRouteDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e =>
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'idx' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function persistRoutes() {
  try {
    const db = await openRouteDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const st = tx.objectStore(IDB_STORE);
    st.clear();
    uploadedFiles.forEach((f, idx) =>
      st.put({ idx, name: f.name, coords: f.coords,
               elevations: f.elevations, pointCount: f.pointCount,
               distanceKm: f.distanceKm }));
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
    // store active index separately (tiny, fine for sessionStorage)
    sessionStorage.setItem('ft_activeIdx', String(activeFileIdx));
  } catch (e) {
    console.warn('[IDB] persistRoutes failed:', e);
  }
}

async function restoreRoutes() {
  // Called from inside map.on('load') so source always exists and style is ready.
  // No timing guards needed — just read IDB and set data directly.
  try {
    const db = await openRouteDB();
    const records = await new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    if (!records.length) return;

    records.sort((a, b) => a.idx - b.idx).forEach(r =>
      uploadedFiles.push({ name: r.name, coords: r.coords, elevations: r.elevations,
                           pointCount: r.pointCount, distanceKm: r.distanceKm }));

    const saved   = parseInt(sessionStorage.getItem('ft_activeIdx') || '0');
    activeFileIdx = Math.max(0, Math.min(saved, uploadedFiles.length - 1));
    const f       = uploadedFiles[activeFileIdx];
    routeCoords   = f.coords;
    elevData      = f.elevations;

    // Source was added by addRouteSource() before restoreRoutes() was called.
    map.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: routeCoords },
    });
    fitToRoute();
    renderMarkers();
    renderElevChart();
    computeStats();

    document.getElementById('route-pill').style.display = 'none'; // pill is upload-only feedback
    document.getElementById('map-empty').classList.add('hidden');
    renderFileList();
  } catch (e) {
    console.warn('[IDB] restoreRoutes failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function addToFileList(name, coords, elevations) {
  const cumDist    = buildCumDist(coords);
  const distanceKm = cumDist[cumDist.length - 1] || 0;
  uploadedFiles.push({ name, coords, elevations, pointCount: coords.length, distanceKm });
  activeFileIdx = uploadedFiles.length - 1;
  persistRoutes();
  renderFileList();
}

function loadFileFromList(index) {
  if (index < 0 || index >= uploadedFiles.length) return;
  activeFileIdx = index;
  const f = uploadedFiles[index];
  routeCoords = f.coords;
  elevData    = f.elevations;
  renderRoute();
  renderElevChart();
  computeStats();
  document.getElementById('route-pill').style.display = 'none'; // pill is upload-only feedback
  document.getElementById('map-empty').classList.add('hidden');
  sessionStorage.setItem('ft_activeIdx', String(index));
  renderFileList();
}

function deleteFileFromList(index) {
  uploadedFiles.splice(index, 1);
  if (!uploadedFiles.length) {
    activeFileIdx = -1;
    routeCoords = []; elevData = [];
    if (map.getSource('route')) map.getSource('route').setData(emptyGeoJSON());
    if (startMarker) { startMarker.remove(); startMarker = null; }
    if (endMarker)   { endMarker.remove();   endMarker   = null; }
    elevChart.data.labels = []; elevChart.data.datasets[0].data = []; elevChart.update('none');
    document.getElementById('route-pill').style.display = 'none';
    document.getElementById('map-empty').classList.remove('hidden');
  } else {
    loadFileFromList(Math.min(index, uploadedFiles.length - 1));
  }
  persistRoutes();
  renderFileList();
}

function renderFileList() {
  const card = document.getElementById('added-routes-card');
  const list = document.getElementById('added-routes-list');
  if (!card || !list) return;
  card.style.display = uploadedFiles.length ? 'flex' : 'none';
  list.innerHTML = '';
  uploadedFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'route-list-item' + (i === activeFileIdx ? ' active' : '');
    item.innerHTML = `
      <div class="route-list-icon">
        <i data-lucide="route" style="width:15px;height:15px;"></i>
      </div>
      <div class="route-list-info" onclick="loadFileFromList(${i})">
        <span class="route-list-name" id="route-name-${i}">${f.name}</span>
        <span class="route-list-sub">Upload · ${f.pointCount.toLocaleString()} pts · ${f.distanceKm.toFixed(1)} km</span>
      </div>
      <div class="route-list-actions">
        <button class="route-name-edit-btn" onclick="startEditName(event,${i})" title="Rename">
          <i data-lucide="pencil" style="width:13px;height:13px;"></i>
        </button>
        <button class="route-list-delete" onclick="deleteFileFromList(${i})" title="Remove">
          <i data-lucide="trash-2" style="width:13px;height:13px;"></i>
        </button>
      </div>`;
    list.appendChild(item);
  });
  lucide.createIcons();
}

function startEditName(event, index) {
  event.stopPropagation();
  const nameSpan = document.getElementById(`route-name-${index}`);
  const original = uploadedFiles[index].name;

  const input = document.createElement('input');
  input.className = 'route-name-input';
  input.type  = 'text';
  input.value = original;

  const commit = () => {
    const newName = input.value.trim() || original;
    uploadedFiles[index].name = newName;
    persistRoutes();
    renderFileList();
    lucide.createIcons();
  };

  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { input.blur(); }
    if (e.key === 'Escape') { input.value = original; input.blur(); }
  });

  nameSpan.replaceWith(input);
  input.focus();
  input.select();
}


// ── INIT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Hide token banner if real token supplied
  if (MAPBOX_TOKEN !== 'YOUR_MAPBOX_TOKEN') {
    const banner = document.getElementById('token-banner');
    if (banner) banner.style.display = 'none';
  }

  initMap();
  initElevChart();
  initDragDrop();
  lucide.createIcons();
});

// ── MAPBOX INIT ───────────────────────────────────────────
function initMap() {
  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: 'map',
    style: MAP_STYLES.streets,
    center: [-1.548, 53.801],   // Default: Yorkshire Dales
    zoom: 10,
    projection: 'mercator',      // Flat Mercator, not globe
    preserveDrawingBuffer: true, // Required for PNG export
    attributionControl: false,
  });

  map.on('zoom', updateZoomLabel);
  map.on('load', () => {
    updateZoomLabel();
    addRouteSource();          // source + layer always exist before restore runs
    setTimeout(() => map.resize(), 50);
    loadBasemapThumbnails();
    restoreRoutes();           // IDB read happens here; source is guaranteed ready
  });

  window.addEventListener('resize', () => map && map.resize());
}

// Inject real Mapbox Static API thumbnails into basemap swatches
// Uses the Swiss Alps (Innsbruck) as a visually rich preview location
function loadBasemapThumbnails() {
  // Map style key → Mapbox style path segment
  const STYLE_PATHS = {
    'streets':          'streets-v12',
    'outdoors':         'outdoors-v12',
    'light':            'light-v11',
    'dark':             'dark-v11',
    'satellite':        'satellite-v9',
    'satellite-streets':'satellite-streets-v12',
    'nav-day':          'navigation-day-v1',
    'nav-night':        'navigation-night-v1',
  };

  // Center: Innsbruck, Austria (good for terrain + city + satellite variety)
  const center = '11.39,47.27,8,0,0';
  const size   = '200x130@2x';

  document.querySelectorAll('.swatch-img[data-mapstyle]').forEach(img => {
    const key  = img.dataset.mapstyle;
    const path = STYLE_PATHS[key];
    if (path) {
      img.src = `https://api.mapbox.com/styles/v1/mapbox/${path}/static/${center}/${size}?access_token=${MAPBOX_TOKEN}`;
    }
  });
}

function addRouteSource() {
  if (map.getSource('route')) return;

  map.addSource('route', {
    type: 'geojson',
    data: emptyGeoJSON(),
  });

  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': routeColor,
      'line-width': 3,
      'line-opacity': 0.92,
    },
  });
}

function emptyGeoJSON() {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } };
}

function updateZoomLabel() {
  const lbl = document.getElementById('zoom-label');
  if (lbl && map) lbl.textContent = `Zoom ${map.getZoom().toFixed(1)}`;
}

function mapZoom(delta) {
  if (!map) return;
  map.setZoom(map.getZoom() + delta);
}

// ── GPX UPLOAD ────────────────────────────────────────────
function handleGPXUpload(input) {
  const file = input.files[0];
  if (file) processGPXFile(file);
}

function showMapLoader() {
  document.getElementById('map-loader')?.classList.add('active');
}
function hideMapLoader() {
  document.getElementById('map-loader')?.classList.remove('active');
}

function processGPXFile(file) {
  const fileName = file.name;

  // Duplicate check — same filename already in the list
  if (uploadedFiles.some(f => f.name === fileName)) {
    showUploadStatus('error', `"${fileName}" is already uploaded`);
    return;
  }

  showMapLoader();                // spinner on as soon as file is chosen

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = parseGPX(e.target.result);
      if (parsed.coords.length < 2) throw new Error('Not enough track points');

      routeCoords = parsed.coords;
      elevData    = parsed.elevations;

      renderRoute();
      renderElevChart();
      computeStats();

      const dist = totalDistanceKm();
      showUploadStatus('success', `✓ ${routeCoords.length.toLocaleString()} points loaded`);

      const pill = document.getElementById('route-pill');
      const pillText = document.getElementById('route-pill-text');
      pillText.textContent = `${routeCoords.length.toLocaleString()} pts · ${dist.toFixed(1)} km`;
      pill.classList.remove('fading');
      void pill.offsetWidth; // reflow to restart animation if triggered again
      pill.style.display = 'flex';
      document.getElementById('map-empty').classList.add('hidden');

      // Auto-hide pill after 3 s
      clearTimeout(routePillTimer);
      routePillTimer = setTimeout(() => {
        pill.classList.add('fading');
        setTimeout(() => { pill.style.display = 'none'; }, 420);
      }, 3000);

      addToFileList(fileName, parsed.coords, parsed.elevations);
      lucide.createIcons();
    } catch (err) {
      showUploadStatus('error', `Error: ${err.message}`);
      console.error(err);
    } finally {
      hideMapLoader();            // spinner off regardless of success/error
    }
  };
  reader.readAsText(file);
}

// ── GPX PARSER ────────────────────────────────────────────
function parseGPX(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  if (doc.querySelector('parsererror')) throw new Error('Invalid GPX XML');

  const trkpts = doc.querySelectorAll('trkpt');
  if (!trkpts.length) throw new Error('No <trkpt> elements found');

  const coords     = [];
  const elevations = [];

  trkpts.forEach(pt => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (isNaN(lat) || isNaN(lon)) return;

    coords.push([lon, lat]);

    const ele = pt.querySelector('ele');
    elevations.push(ele ? parseFloat(ele.textContent) : null);
  });

  // Fill null elevations with nearest known value
  fillNulls(elevations);

  return { coords, elevations };
}

function fillNulls(arr) {
  let last = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== null) { last = arr[i]; }
    else arr[i] = last;
  }
}

// ── ROUTE RENDERING ───────────────────────────────────────
function renderRoute() {
  // isStyleLoaded() is true as soon as the style fires 'load'.
  // map.loaded() additionally waits for tiles, causing it to be false
  // during the 'load' callback — making map.once('load', renderRoute)
  // register a handler that never fires (event already past).
  if (!map.isStyleLoaded()) { map.once('style.load', renderRoute); return; }

  const src = map.getSource('route');
  if (src) {
    src.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: routeCoords },
    });
  }

  fitToRoute();
  renderMarkers();
}

function fitToRoute() {
  if (!routeCoords.length) return;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of routeCoords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  // Sync Mapbox's internal canvas size to the current DOM layout before
  // fitting — prevents wrong bounds when called during initial load.
  map.resize();

  const mapEl = document.getElementById('map');
  const w     = mapEl.offsetWidth  || 600;
  const h     = mapEl.offsetHeight || 500;

  // Compute padding independently per axis so elongated routes (tall/narrow
  // or wide/flat) always have proportional breathing room on all four sides.
  // 15% of each dimension, floored at 90 px so markers never bleed to edge.
  const padH = Math.max(55, Math.round(w * 0.10));
  const padV = Math.max(55, Math.round(h * 0.10));

  map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
    padding:  { top: padV, bottom: padV, left: padH, right: padH },
    duration: 700,
  });
}

function renderMarkers() {
  if (startMarker) { startMarker.remove(); startMarker = null; }
  if (endMarker)   { endMarker.remove();   endMarker   = null; }
  if (!state.showMarkers || !routeCoords.length) return;

  startMarker = new mapboxgl.Marker({ element: makeMarkerEl('#27ae60') })
    .setLngLat(routeCoords[0])
    .addTo(map);

  endMarker = new mapboxgl.Marker({ element: makeMarkerEl(routeColor) })
    .setLngLat(routeCoords[routeCoords.length - 1])
    .addTo(map);
}

function makeMarkerEl(color) {
  const el = document.createElement('div');
  const s  = markerSize;
  const b  = Math.max(1.5, s * 0.2); // border scales with size
  el.style.cssText = `
    width:${s}px;height:${s}px;
    background:${color};
    border:${b}px solid #fff;
    border-radius:50%;
    box-shadow:0 1px 5px rgba(0,0,0,0.4);
  `;
  return el;
}

// ── ELEVATION CHART ───────────────────────────────────────
function initElevChart() {
  const ctx = document.getElementById('elevation-chart').getContext('2d');

  elevChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        fill: true,
        backgroundColor: 'rgba(110,120,110,0.22)',
        borderColor: 'rgba(90,100,90,0.65)',
        borderWidth: 1.5,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `${items[0].label} km`,
            label: (item) => `${Math.round(item.raw)} m`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            maxTicksLimit: 5,
            color: '#bbb',
            font: { size: 8 },
            callback: (val) => `${val} km`,
          },
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            maxTicksLimit: 3,
            color: '#bbb',
            font: { size: 8 },
            callback: (val) => `${val} m`,
          },
        },
      },
    },
  });
}

function renderElevChart() {
  const canvas  = document.getElementById('elevation-chart');
  const emptyEl = document.getElementById('elevation-empty');

  if (!elevData.length) {
    canvas.style.display = 'none';
    emptyEl.classList.remove('hidden');
    return;
  }

  canvas.style.display = 'block';
  emptyEl.classList.add('hidden');

  // Build cumulative distances for x-axis labels
  const cumdist = buildCumDist(routeCoords);

  // Downsample to ≤300 points for performance
  const step = Math.max(1, Math.floor(elevData.length / 300));
  const elev  = [];
  const labels = [];
  for (let i = 0; i < elevData.length; i += step) {
    elev.push(elevData[i]);
    labels.push((cumdist[Math.min(i, cumdist.length - 1)]).toFixed(1));
  }

  elevChart.data.labels              = labels;
  elevChart.data.datasets[0].data    = elev;
  elevChart.update('none');
}

// ── STATS ─────────────────────────────────────────────────
function computeStats() {
  const dist = totalDistanceKm();
  const gain = elevGain();

  const dStr = dist.toFixed(1);
  const eStr = Math.round(gain).toString();

  document.getElementById('stat-dist-value').textContent  = dStr;
  document.getElementById('stat-elev-value').textContent  = eStr;
  document.getElementById('inp-dist-val').value           = dStr;
  document.getElementById('inp-elev-val').value           = eStr;
}

function totalDistanceKm() {
  let d = 0;
  for (let i = 1; i < routeCoords.length; i++) {
    d += haversine(routeCoords[i-1][1], routeCoords[i-1][0],
                   routeCoords[i][1],   routeCoords[i][0]);
  }
  return d;
}

function buildCumDist(coords) {
  const d = [0];
  for (let i = 1; i < coords.length; i++) {
    d.push(d[i-1] + haversine(coords[i-1][1], coords[i-1][0],
                               coords[i][1],   coords[i][0]));
  }
  return d;
}

function elevGain() {
  let g = 0;
  for (let i = 1; i < elevData.length; i++) {
    const diff = elevData[i] - elevData[i-1];
    if (diff > 0) g += diff;
  }
  return g;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── DRAG & DROP ───────────────────────────────────────────
function initDragDrop() {
  const area = document.getElementById('upload-area');

  area.addEventListener('dragover', e => {
    e.preventDefault();
    area.classList.add('drag-over');
  });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.name?.toLowerCase().endsWith('.gpx')) processGPXFile(file);
    else showUploadStatus('error', 'Please drop a .gpx file');
  });
}

// ── TAB SWITCHING ─────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === `pane-${name}`));
}

// ── TEXT SYNC ─────────────────────────────────────────────
function syncText(elemId, value) {
  document.getElementById(elemId).textContent = value;
}

// ── TOPO OVERLAY ──────────────────────────────────────────
let topoVisible = false;

function addTopoLayer() {
  // Idempotent — skip if already present
  if (map.getSource('topo-dem')) return;

  // Mapbox Terrain-DEM v1 — free with existing token
  map.addSource('topo-dem', {
    type: 'raster-dem',
    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
    tileSize: 512,
    maxzoom: 14,
  });

  // Hillshade renders terrain relief on top of any basemap.
  // Insert it directly below the route-line layer so the route stays on top.
  map.addLayer({
    id: 'topo-hillshade',
    type: 'hillshade',
    source: 'topo-dem',
    layout: { visibility: topoVisible ? 'visible' : 'none' },
    paint: {
      'hillshade-shadow-color':        '#3d3020',
      'hillshade-highlight-color':     '#ffffff',
      'hillshade-accent-color':        '#5a4a30',
      'hillshade-exaggeration':        0.45,
      'hillshade-illumination-anchor': 'viewport',
    },
  }, 'route-line'); // always below the route line
}

function toggleTopo() {
  topoVisible = !topoVisible;
  document.getElementById('toggle-topo').classList.toggle('on', topoVisible);

  if (!map.getSource('topo-dem')) {
    addTopoLayer(); // lazy-add on first enable
    return;         // addTopoLayer sets visibility from topoVisible
  }
  map.setLayoutProperty('topo-hillshade', 'visibility', topoVisible ? 'visible' : 'none');
}

// ── MAP STYLE ─────────────────────────────────────────────
function setMapStyle(styleName) {
  document.querySelectorAll('.style-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.style === styleName));

  map.setStyle(MAP_STYLES[styleName]);

  map.once('style.load', () => {
    addRouteSource();
    // Re-add topo hillshade (setStyle wipes all custom sources/layers)
    addTopoLayer();
    if (routeCoords.length) {
      map.getSource('route').setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: routeCoords },
      });
      map.setPaintProperty('route-line', 'line-color', routeColor);
      renderMarkers();
    }
  });
}

// ── ROUTE COLOR ───────────────────────────────────────────
function setRouteColor(color, el) {
  routeColor = color;
  document.getElementById('custom-color').value = color;
  const swatch = document.getElementById('custom-color-swatch');
  if (swatch) swatch.style.background = color;

  document.querySelectorAll('#route-color-swatches .color-dot').forEach(d =>
    d.classList.remove('active'));
  if (el) el.classList.add('active');

  if (map.getLayer('route-line')) {
    map.setPaintProperty('route-line', 'line-color', color);
  }

  // Sync end legend dot colour
  const legendEnd = document.getElementById('legend-dot-end');
  if (legendEnd) legendEnd.style.background = color;

  // Update end marker colour
  if (endMarker) { endMarker.remove(); endMarker = null; }
  if (state.showMarkers && routeCoords.length) {
    endMarker = new mapboxgl.Marker({ element: makeMarkerEl(color) })
      .setLngLat(routeCoords[routeCoords.length - 1])
      .addTo(map);
  }
}

// ── ROUTE WIDTH ───────────────────────────────────────────
function setRouteWidth(val) {
  if (map.getLayer('route-line')) {
    map.setPaintProperty('route-line', 'line-width', Number(val));
  }
}

// ── POSTER BG ─────────────────────────────────────────────
function setPosterBg(color, el) {
  document.querySelectorAll('#poster-bg-swatches .color-dot').forEach(d =>
    d.classList.remove('active'));
  if (el) el.classList.add('active');

  const poster     = document.getElementById('poster');
  const isDarkBg   = luminance(color) < 0.2;
  const titleColor = isDarkBg ? '#f0f0f0' : '#1a1a1a';
  const subColor   = isDarkBg ? '#aaaaaa' : '#666666';
  const statVal    = isDarkBg ? '#f0f0f0' : '#1a1a1a';
  const statLbl    = isDarkBg ? '#888888' : '#aaaaaa';
  const divColor   = isDarkBg ? '#333333' : '#e8e8e8';
  const brandColor = isDarkBg ? '#555555' : '#cccccc';

  poster.style.background = color;

  const set = (id, prop, val) => { const el = document.getElementById(id); if (el) el.style[prop] = val; };

  set('poster-title',    'color', titleColor);
  set('poster-subtitle', 'color', subColor);
  set('stat-dist-value', 'color', statVal);
  set('stat-dist-label', 'color', statLbl);
  set('stat-dist-unit',  'color', statLbl);
  set('stat-elev-value', 'color', statVal);
  set('stat-elev-label', 'color', statLbl);
  set('stat-elev-unit',  'color', statLbl);

  poster.querySelector('.poster-stats').style.borderColor = divColor;
  poster.querySelector('.stat-divider').style.background  = divColor;
  poster.querySelectorAll('.poster-stat').forEach(s => s.style.background = color);
  poster.querySelector('.poster-footer-brand').style.color = brandColor;
}

// Simple luminance from hex color
function luminance(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return 0.2126*r + 0.7152*g + 0.0722*b;
}

// ── TOGGLES ───────────────────────────────────────────────
function toggleOption(key) {
  const toggleMap = {
    markers:   { stateKey: 'showMarkers',   toggleId: 'toggle-markers'   },
    elevation: { stateKey: 'showElevation', toggleId: 'toggle-elevation' },
    brand:     { stateKey: 'showBrand',     toggleId: 'toggle-brand'     },
    dash:      { stateKey: 'isDash',        toggleId: 'toggle-dash'      },
  };

  const cfg = toggleMap[key];
  if (!cfg) return;

  state[cfg.stateKey] = !state[cfg.stateKey];
  document.getElementById(cfg.toggleId).classList.toggle('on', state[cfg.stateKey]);

  if (key === 'markers')   renderMarkers();
  if (key === 'elevation') toggleElevationUI();
  if (key === 'brand')     toggleBrandUI();
  if (key === 'dash')      applyDash();
}

function toggleElevationUI() {
  const el = document.getElementById('elevation-container');
  el.style.display = state.showElevation ? '' : 'none';
  // Poster-map is flex:1 — it fills the freed space, but Mapbox needs resize() signal
  setTimeout(() => map && map.resize(), 50);
}

function toggleBrandUI() {
  const el = document.querySelector('.poster-footer-brand');
  if (el) el.style.display = state.showBrand ? '' : 'none';
  setTimeout(() => map && map.resize(), 50);
}

function applyDash() {
  if (!map.getLayer('route-line')) return;
  const arr = state.isDash
    ? (DASH_PATTERNS[dashPatternKey] || DASH_PATTERNS['short'])(dashGap)
    : [1, 0];
  map.setPaintProperty('route-line', 'line-dasharray', arr);
}

// ── MARKER SIZE ───────────────────────────────────────────
function setMarkerSize(size) {
  markerSize = Number(size);
  if (state.showMarkers && routeCoords.length) renderMarkers();
}

// ── DASH PATTERN ──────────────────────────────────────────
function setDashPattern(pattern) {
  dashPatternKey = pattern;
  document.querySelectorAll('.dash-pattern-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pattern === pattern));
  applyDash();
}

function setDashGap(val) {
  dashGap = Number(val);
  document.getElementById('dash-gap-val').textContent = val;
  applyDash();
}

// ── TYPOGRAPHY ────────────────────────────────────────────
function setTitleFont(family) {
  document.getElementById('poster-title').style.fontFamily = family;
}

function setTitleSize(px) {
  document.getElementById('poster-title').style.fontSize = px + 'px';
}

// ── POSTER SIZE ───────────────────────────────────────────
// Print size is export-config only — the visual poster preview stays fixed.
let selectedPaperSize = 'digital';

function setPosterSize(size) {
  selectedPaperSize = size;
  document.querySelectorAll('.print-size-item').forEach(s =>
    s.classList.toggle('active', s.dataset.size === size));
}

// ── THEME TOGGLE ──────────────────────────────────────────
function toggleTheme() {
  const html   = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');

  const icon = document.getElementById('theme-icon');
  icon.setAttribute('data-lucide', isDark ? 'moon' : 'sun');
  lucide.createIcons();
}

// ── EXPORT DROPDOWN ───────────────────────────────────────
let exportMenuOpen = false;

function toggleExportMenu() {
  exportMenuOpen = !exportMenuOpen;
  const menu    = document.getElementById('export-menu');
  const chevron = document.getElementById('export-chevron');
  menu.classList.toggle('open', exportMenuOpen);
  if (chevron) chevron.style.transform = exportMenuOpen ? 'rotate(180deg)' : '';
}

// Close menu when clicking outside
document.addEventListener('click', e => {
  if (!document.getElementById('export-dropdown')?.contains(e.target)) {
    exportMenuOpen = false;
    document.getElementById('export-menu')?.classList.remove('open');
    const chevron = document.getElementById('export-chevron');
    if (chevron) chevron.style.transform = '';
  }
});

async function exportAs(format) {
  // Close the menu
  exportMenuOpen = false;
  document.getElementById('export-menu').classList.remove('open');

  const trigger = document.getElementById('export-trigger');
  trigger.disabled = true;

  try {
    const poster  = document.getElementById('poster');
    const mapDiv  = document.getElementById('map');
    const scale   = parseInt(document.getElementById('export-scale')?.value) || 2;

    const mapDataUrl = map.getCanvas().toDataURL('image/png');

    // Hide the WebGL canvas so html2canvas won't try (and fail) to read it,
    // then insert our snapshot img BEFORE the marker elements so markers
    // remain on top and get captured by html2canvas.
    const glCanvas = map.getCanvas();
    glCanvas.style.visibility = 'hidden';

    const mapImg = document.createElement('img');
    mapImg.src = mapDataUrl;
    mapImg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
    mapDiv.insertBefore(mapImg, mapDiv.firstChild);

    await sleep(80);

    const canvas = await html2canvas(poster, {
      scale,
      useCORS: true,
      allowTaint: false,
      logging: false,
      backgroundColor: null,
    });

    mapDiv.removeChild(mapImg);
    glCanvas.style.visibility = '';

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext      = format === 'jpeg' ? 'jpg' : 'png';
    const dpi      = SCALE_TO_DPI[String(scale)] || 300;

    let dataUrl = canvas.toDataURL(mimeType, 0.92);

    // Embed physical DPI metadata into the image binary
    if (format === 'png')  dataUrl = setPNGDPI(dataUrl, dpi);
    if (format === 'jpeg') dataUrl = setJPEGDPI(dataUrl, dpi);

    const link = document.createElement('a');
    link.download = `framed-trails-${selectedPaperSize}-${dpi}dpi-${Date.now()}.${ext}`;
    link.href = dataUrl;
    link.click();

  } catch (err) {
    console.error('Export error:', err);
    alert('Export failed: ' + err.message);
  } finally {
    trigger.disabled = false;
    lucide.createIcons();
  }
}

// ── DPI EMBEDDING ─────────────────────────────────────────
// Maps the export-scale selector value to print DPI
const SCALE_TO_DPI = { '1': 96, '2': 300, '3': 450 };

// CRC32 table (used for PNG pHYs chunk)
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Injects a pHYs chunk into a PNG data-URL to embed physical DPI
function setPNGDPI(dataUrl, dpi) {
  const base64 = dataUrl.split(',')[1];
  const src    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

  const ppm = Math.round(dpi / 0.0254); // pixels per metre

  // Build pHYs chunk: 4 len + 4 type + 4+4 ppm + 1 unit + 4 crc = 21 bytes
  const chunk = new Uint8Array(21);
  // Length field = 9 (covers ppuX + ppuY + unit)
  chunk[3] = 9;
  // Type "pHYs"
  [0x70, 0x48, 0x59, 0x73].forEach((b, i) => { chunk[4 + i] = b; });
  // X and Y pixels per metre (big-endian uint32)
  for (let axis = 0; axis < 2; axis++) {
    const off = 8 + axis * 4;
    chunk[off]   = (ppm >>> 24) & 0xff;
    chunk[off+1] = (ppm >>> 16) & 0xff;
    chunk[off+2] = (ppm >>>  8) & 0xff;
    chunk[off+3] =  ppm         & 0xff;
  }
  chunk[16] = 1; // unit = metre
  // CRC32 over type + data (bytes 4–16)
  const c = crc32(chunk.slice(4, 17));
  chunk[17] = (c >>> 24) & 0xff;
  chunk[18] = (c >>> 16) & 0xff;
  chunk[19] = (c >>>  8) & 0xff;
  chunk[20] =  c         & 0xff;

  // Insert pHYs after IHDR: PNG sig (8) + IHDR chunk (4+4+13+4 = 25) = offset 33
  const insertAt = 33;
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.slice(0, insertAt));
  out.set(chunk, insertAt);
  out.set(src.slice(insertAt), insertAt + chunk.length);

  let bin = '';
  out.forEach(b => { bin += String.fromCharCode(b); });
  return 'data:image/png;base64,' + btoa(bin);
}

// Sets DPI in JPEG by patching the JFIF APP0 density fields
function setJPEGDPI(dataUrl, dpi) {
  const base64 = dataUrl.split(',')[1];
  const data   = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

  // JPEG JFIF APP0 layout:
  //  0-1: FF D8 (SOI)
  //  2-3: FF E0 (APP0 marker)
  //  4-5: length (big-endian, includes itself but not marker)
  //  6-10: "JFIF\0"
  // 11-12: version
  //    13: density units (0=none, 1=DPI, 2=DPCM)
  // 14-15: X density
  // 16-17: Y density
  if (data[0] === 0xff && data[1] === 0xd8 &&
      data[2] === 0xff && data[3] === 0xe0 &&
      String.fromCharCode(...data.slice(6, 10)) === 'JFIF') {
    data[13] = 1;                       // units = DPI
    data[14] = (dpi >>> 8) & 0xff;
    data[15] =  dpi        & 0xff;
    data[16] = (dpi >>> 8) & 0xff;
    data[17] =  dpi        & 0xff;
  }

  let bin = '';
  data.forEach(b => { bin += String.fromCharCode(b); });
  return 'data:image/jpeg;base64,' + btoa(bin);
}

// ── HELPERS ───────────────────────────────────────────────
function showUploadStatus(type, msg) {
  const el = document.getElementById('upload-status');
  el.classList.remove('fading');
  void el.offsetWidth; // reflow to restart animation if re-triggered
  el.className = `upload-status ${type}`;
  el.textContent = msg;

  clearTimeout(uploadStatusTimer);
  uploadStatusTimer = setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => { el.className = 'upload-status'; }, 420);
  }, 3000);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
