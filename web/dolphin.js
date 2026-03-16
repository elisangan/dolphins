import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Scene locations in local coords (origin 12.1N, 105.0E, UTM 48N)
const SCENE_LOCATIONS = [
    { name: 'Kampi Pool',      localX:  110582, localZ:  -42388 },
    { name: 'Mekong Transit',  localX:   50512, localZ:   11789 },
    { name: 'PP Confluence',   localX:   -6687, localZ:   56909 },
    { name: 'Tonle Sap',      localX:  -86054, localZ:  -52835 },
];

// ─── Main scene setup ────────────────────────────────────────────────────────

const canvas = document.getElementById('scene-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x1a1030);

function canvasSize() {
    return { w: canvas.clientWidth, h: canvas.clientHeight };
}
let { w, h } = canvasSize();
renderer.setSize(w, h, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, w / h, 1, 500000);
camera.position.set(2, 1, 3);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

// ─── Lighting ────────────────────────────────────────────────────────────────

function makeTwilightSky() {
    // Vertical gradient: warm horizon → deep blue zenith
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 2;
    skyCanvas.height = 256;
    const ctx = skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, '#0a0a2e');   // zenith — deep navy
    grad.addColorStop(0.35, '#1a1545');  // upper sky — indigo
    grad.addColorStop(0.55, '#3a2255');  // mid sky — purple
    grad.addColorStop(0.75, '#8a3a40');  // lower sky — dusky rose
    grad.addColorStop(0.88, '#cc6633');  // horizon glow — warm orange
    grad.addColorStop(1.0, '#eea855');   // horizon — golden
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(skyCanvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
}

const twilightSky = makeTwilightSky();

function addLights(s) {
    // Set sky background
    s.background = twilightSky;
    // Twilight ambient — brighter indigo-blue
    s.add(new THREE.AmbientLight(0x2a2a5a, 3.0));
    // Low sun — warm orange, grazing angle from the horizon
    const sun = new THREE.DirectionalLight(0xffaa66, 2.5);
    sun.position.set(-5, 0.8, 3);
    s.add(sun);
    // Sky fill — soft violet-blue from above
    const sky = new THREE.DirectionalLight(0x6677cc, 1.2);
    sky.position.set(0, 4, -1);
    s.add(sky);
    // Warm bounce from water/ground
    const bounce = new THREE.DirectionalLight(0x774433, 0.6);
    bounce.position.set(1, -1, 2);
    s.add(bounce);
    // Hemisphere: sky lavender → ground warm amber
    const hemi = new THREE.HemisphereLight(0x4a4a8a, 0x885522, 1.0);
    s.add(hemi);
}
addLights(scene);

// ─── State ───────────────────────────────────────────────────────────────────

let terrainGroup = new THREE.Group();
let waterSurfaceGroup = new THREE.Group();
let pointCloudGroup = new THREE.Group();
let stationsGroup = new THREE.Group();
let mainSceneContent = new THREE.Group();

scene.add(terrainGroup);
scene.add(waterSurfaceGroup);
scene.add(pointCloudGroup);
scene.add(stationsGroup);
scene.add(mainSceneContent);

// Corridor hazards for Scene 2 — placed in world coordinates, separate from scene content
const corridorHazardsGroup = new THREE.Group();
corridorHazardsGroup.visible = false;
scene.add(corridorHazardsGroup);

let terrainLoaded = false;
let terrainMeshRef = null;
let currentMonth = 1; // 1-12
let echoMode = false;

// Water surface state
let waterSurfaceMaterial = null;
let waterSurfaceConfig = null;
let jrcManifest = null;
let jrcTextureCache = {};

// Point cloud state
let pointCloudMaterial = null;
let echoPointCloudMaterial = null;
let echoStartTime = 0;

// Shared sonar uniforms — referenced by echo point cloud shader AND hazard reveal shaders
const sonarUniforms = {
    time: { value: 0.0 },
    pulseOrigin: { value: new THREE.Vector3(0, 0, 0) },
    pulseSpeed: { value: 15000.0 },
    pulseWidth: { value: 8000.0 },
    maxDist: { value: 80000.0 },
    echoActive: { value: 0.0 },
};

// Echo transition state (smooth lerp between optical ↔ echo)
let echoTransition = 0;      // 0 = optical, 1 = full echo
let echoTransitionTarget = 0;

// Dolphin POV camera for Scene 2 preview panel (first-person view from dolphin's head)
const dolphinPOVCamera = new THREE.PerspectiveCamera(90, 1, 10, 120000);
let dolphinPOVUnderwater = false; // tracks whether POV camera is underwater

// Sonar pulse ring — visible expanding ring emanating from dolphin when underwater
const SONAR_RING_COUNT = 3;
const sonarRings = [];
const sonarRingGroup = new THREE.Group();
sonarRingGroup.visible = false;
for (let i = 0; i < SONAR_RING_COUNT; i++) {
    const ringGeo = new THREE.RingGeometry(1, 1.15, 64);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0x4488ff,
        transparent: true,
        opacity: 0.0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    sonarRingGroup.add(ring);
    sonarRings.push({ mesh: ring, mat: ringMat });
}
scene.add(sonarRingGroup);

// Echo hysteresis: minimum time echo stays on/off to prevent rapid toggling
const ECHO_MIN_DURATION = 2.0; // seconds
let echoLastToggleTime = 0;

// ─── Scene 2 transit data collection ─────────────────────────────────────────
const transitData = {
    hazards: { gillnet: 0, trash: 0, carcass: 0, cargo_noise: 0 },
    detectedSet: new Set(),       // track which hazard indices have been detected
    samples: 0,                    // total water quality samples collected
    lastSampleTime: 0,
    // Live water quality readings (vary along corridor)
    liveWQ: { DO: 6.5, turbidity: 40, TSS: 80, pH: 7.2, nitrate: 0.5, temp: 28 },
    distanceTravelled: 0,          // meters
    lastPos: null,
    diveCount: 0,
    lastDiveState: false,
};

function resetTransitData() {
    transitData.hazards = { gillnet: 0, trash: 0, carcass: 0, cargo_noise: 0 };
    transitData.detectedSet.clear();
    transitData.samples = 0;
    transitData.lastSampleTime = 0;
    transitData.liveWQ = { DO: 6.5, turbidity: 40, TSS: 80, pH: 7.2, nitrate: 0.5, temp: 28 };
    transitData.distanceTravelled = 0;
    transitData.lastPos = null;
    transitData.diveCount = 0;
    transitData.lastDiveState = false;
}

// ─── Load terrain ────────────────────────────────────────────────────────────

async function loadTerrain() {
    try {
        const texLoader = new THREE.TextureLoader();
        const texture = await texLoader.loadAsync('../geo/mekong_terrain_texture_small.jpg');
        texture.colorSpace = THREE.SRGBColorSpace;

        const objLoader = new OBJLoader();
        const obj = await objLoader.loadAsync('../geo/mekong_terrain.obj');

        obj.traverse(child => {
            if (child.isMesh) {
                child.material = new THREE.MeshLambertMaterial({
                    map: texture,
                    side: THREE.DoubleSide,
                    transparent: true,
                    opacity: 0.2,
                });
                if (!terrainMeshRef) terrainMeshRef = child;
            }
        });

        terrainGroup.add(obj);
        terrainLoaded = true;
        console.log('Terrain loaded');

        // Bathymetry — separate mesh showing river channel shape
        try {
            const bathObj = await new OBJLoader().loadAsync('../geo/mekong_bathymetry_lake.obj');
            bathObj.traverse(child => {
                if (child.isMesh) {
                    const geo = child.geometry;
                    const pos = geo.getAttribute('position');
                    const colors = new Float32Array(pos.count * 3);
                    let minY = Infinity, maxY = -Infinity;
                    for (let i = 0; i < pos.count; i++) {
                        const y = pos.getY(i);
                        if (y !== 0) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
                    }
                    // Deep purple → bright cyan gradient
                    for (let i = 0; i < pos.count; i++) {
                        const y = pos.getY(i);
                        const t = (maxY - minY) > 0 ? (y - minY) / (maxY - minY) : 0;
                        // t=0 deepest (purple), t=1 shallowest (bright cyan)
                        colors[i * 3]     = 0.16 * (1 - t);         // R: purple at deep
                        colors[i * 3 + 1] = 0.04 + t * 0.82;        // G: bright at shallow
                        colors[i * 3 + 2] = 0.47 + t * 0.53;        // B: always blue-ish
                    }
                    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
                    child.material = new THREE.MeshBasicMaterial({
                        vertexColors: true,
                        side: THREE.DoubleSide,
                    });
                }
            });
            terrainGroup.add(bathObj);
            console.log('Bathymetry loaded');
            // Also add to minimap immediately
            bathObj.traverse(child => {
                if (child.isMesh && child.geometry.getAttribute('color')) {
                    const bathClone = child.clone();
                    bathClone.material = child.material.clone();
                    bathClone.material.opacity = 1.0;
                    minimapScene.add(bathClone);
                    console.log('Bathymetry added to minimap');
                }
            });
        } catch (e) {
            console.warn('Bathymetry load skipped:', e);
        }

    } catch (e) {
        console.warn('Terrain load failed:', e);
    }
}

// ─── Load water surface (JRC shape + MRC height) ─────────────────────────────

async function loadWaterSurface() {
    // Load JRC manifest for UV mapping
    try {
        const mResp = await fetch('../geo/jrc_water/manifest.json');
        if (!mResp.ok) return;
        jrcManifest = await mResp.json();
    } catch (_) { return; }

    // Load water surface config (station positions + monthly MSL)
    try {
        const cResp = await fetch('../api/water-surface-config.json');
        if (!cResp.ok) return;
        waterSurfaceConfig = await cResp.json();
    } catch (_) { return; }

    if (!terrainMeshRef || !jrcManifest?.uv_mapping || !waterSurfaceConfig?.stations?.length) return;

    const uv = jrcManifest.uv_mapping;
    const numStations = waterSurfaceConfig.stations.length;

    const stationPosArray = [];
    const stationLevelArray = new Array(numStations).fill(0.0);
    for (const st of waterSurfaceConfig.stations) {
        stationPosArray.push(new THREE.Vector2(st.local_x, -st.local_z));
    }

    const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    placeholder.needsUpdate = true;

    waterSurfaceMaterial = new THREE.ShaderMaterial({
        uniforms: {
            waterTex: { value: placeholder },
            uvOffset: { value: new THREE.Vector2(uv.offset.u, uv.offset.v) },
            uvScale: { value: new THREE.Vector2(uv.scale.u, uv.scale.v) },
            opacity: { value: 0.35 },
            stationPos: { value: stationPosArray },
            stationLevel: { value: stationLevelArray },
        },
        vertexShader: `
            uniform vec2 stationPos[${numStations}];
            uniform float stationLevel[${numStations}];
            varying vec2 vUv;

            void main() {
                vUv = uv;
                vec3 newPos = position;

                float totalWeight = 0.0;
                float weightedLevel = 0.0;
                for (int i = 0; i < ${numStations}; i++) {
                    float dx = position.x - stationPos[i].x;
                    float dz = position.z - stationPos[i].y;
                    float dist = sqrt(dx * dx + dz * dz);
                    float w = 1.0 / max(dist, 500.0);
                    w = w * w;
                    totalWeight += w;
                    weightedLevel += w * stationLevel[i];
                }
                newPos.y = weightedLevel / totalWeight;

                gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D waterTex;
            uniform vec2 uvOffset;
            uniform vec2 uvScale;
            uniform float opacity;
            varying vec2 vUv;
            void main() {
                vec2 jrcUv = (vUv - uvOffset) / uvScale;
                if (jrcUv.x < 0.0 || jrcUv.x > 1.0 || jrcUv.y < 0.0 || jrcUv.y > 1.0) discard;
                float water = texture2D(waterTex, jrcUv).r;
                if (water < 0.5) discard;
                gl_FragColor = vec4(0.08, 0.35, 0.65, opacity);
            }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });

    const clonedGeo = terrainMeshRef.geometry.clone();
    waterSurfaceGroup.add(new THREE.Mesh(clonedGeo, waterSurfaceMaterial));

    // Also add water surface to minimap
    if (terrainMeshRef) {
        const mmWater = new THREE.Mesh(terrainMeshRef.geometry.clone(), waterSurfaceMaterial);
        minimapScene.add(mmWater);
        console.log('Water surface added to minimap');
    }

    // Set initial month and load texture
    updateWaterMonth(currentMonth);
    console.log(`Water surface loaded: ${numStations} stations`);
}

function updateWaterMonth(month) {
    if (!waterSurfaceConfig || !waterSurfaceMaterial) return;
    const idx = Math.max(0, Math.min(11, month - 1));
    const arr = waterSurfaceMaterial.uniforms.stationLevel.value;
    for (let i = 0; i < waterSurfaceConfig.stations.length; i++) {
        arr[i] = waterSurfaceConfig.stations[i].monthly_msl[idx];
    }
    // Load a JRC texture for this month (use a recent year's data)
    loadJrcTexture(month);
}

async function loadJrcTexture(month) {
    if (!jrcManifest?.months) return;
    // Use selected year; if projected (>2021), fall back to latest historical
    let targetYear = currentYear;
    if (targetYear > HISTORICAL_END) targetYear = HISTORICAL_END;

    const key = `${targetYear}_${String(month).padStart(2, '0')}`;
    if (jrcTextureCache[key]) {
        waterSurfaceMaterial.uniforms.waterTex.value = jrcTextureCache[key];
        return;
    }
    // Find exact year+month, or fall back to latest year with this month
    const candidates = jrcManifest.months.filter(m => m.month === month);
    if (candidates.length === 0) return;
    let entry = candidates.find(m => m.year === targetYear);
    if (!entry) entry = candidates[candidates.length - 1]; // latest available
    const fname = entry.file;
    try {
        const tex = await new THREE.TextureLoader().loadAsync(`../geo/jrc_water/${fname}`);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.NearestFilter;
        jrcTextureCache[key] = tex;
        waterSurfaceMaterial.uniforms.waterTex.value = tex;
    } catch (e) {
        console.warn('JRC texture load failed:', e);
    }
}

// ─── Load point cloud ────────────────────────────────────────────────────────

async function loadPointCloud() {
    try {
        const loader = new PLYLoader();
        const geometry = await loader.loadAsync('../geo/mekong_bathymetry_pointcloud.ply');

        // Normal mode: elevation gradient (from PLY vertex colors)
        pointCloudMaterial = new THREE.PointsMaterial({
            size: 200,
            vertexColors: true,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.6,
        });

        // Echolocation mode: sonar pulse shader (uses shared sonarUniforms)
        echoPointCloudMaterial = new THREE.ShaderMaterial({
            uniforms: {
                time: sonarUniforms.time,
                pulseOrigin: sonarUniforms.pulseOrigin,
                pulseSpeed: sonarUniforms.pulseSpeed,
                pulseWidth: sonarUniforms.pulseWidth,
                maxDist: sonarUniforms.maxDist,
            },
            vertexShader: `
                uniform float time;
                uniform vec3 pulseOrigin;
                uniform float pulseSpeed;
                uniform float pulseWidth;
                uniform float maxDist;
                attribute vec3 color;
                varying float vAlpha;
                varying float vDist;

                void main() {
                    vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
                    float dist = distance(worldPos, pulseOrigin);
                    float pulseRadius = pulseSpeed * time;

                    // Pulse envelope: bright at wavefront, fading behind
                    float distFromPulse = abs(dist - pulseRadius);
                    float envelope = 1.0 - smoothstep(0.0, pulseWidth, distFromPulse);

                    // Distance falloff
                    float distFade = 1.0 - smoothstep(0.0, maxDist, dist);

                    // Decay after pulse passes
                    float passedTime = max(0.0, time - dist / pulseSpeed);
                    float decay = exp(-passedTime * 1.5);

                    vAlpha = max(envelope * 0.9, decay * 0.3) * distFade;
                    vDist = dist / maxDist;

                    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = max(1.0, 400.0 / -mvPos.z) * (0.5 + vAlpha * 1.5);
                    gl_Position = projectionMatrix * mvPos;
                }
            `,
            fragmentShader: `
                varying float vAlpha;
                varying float vDist;
                void main() {
                    // Circular point
                    vec2 c = gl_PointCoord - 0.5;
                    if (dot(c, c) > 0.25) discard;

                    // Cool blue-white sonar color
                    vec3 nearColor = vec3(0.7, 0.85, 1.0);
                    vec3 farColor = vec3(0.15, 0.25, 0.5);
                    vec3 col = mix(nearColor, farColor, vDist);

                    gl_FragColor = vec4(col, vAlpha * 0.85);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        const points = new THREE.Points(geometry, pointCloudMaterial);
        pointCloudGroup.add(points);
        console.log('Point cloud loaded');
    } catch (e) {
        console.warn('Point cloud load failed:', e);
    }
}

// ─── Load station markers ────────────────────────────────────────────────────

async function loadStations() {
    // Station markers disabled — data still used by water surface config
}

// ─── Load dolphin model ──────────────────────────────────────────────────────

const gltfLoader = new GLTFLoader();
const gltf = await gltfLoader.loadAsync('../data/irrawaddy_dolphin.glb');
const dolphinRaw = gltf.scene;

const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 4);
dolphinRaw.quaternion.copy(qX.multiply(qY));

const dolphinTemplate = new THREE.Group();
dolphinTemplate.add(dolphinRaw);

const templateBox = new THREE.Box3().setFromObject(dolphinTemplate);
const templateSize = templateBox.getSize(new THREE.Vector3());
const modelLength = Math.max(templateSize.x, templateSize.y, templateSize.z);
console.log('Dolphin model length:', modelLength);

let dolphinCounter = 0;
function cloneDolphin() {
    const d = dolphinTemplate.clone(true);
    d.userData.isDolphin = true;
    d.userData.dolphinId = dolphinCounter++;
    // Tag all meshes inside so raycaster can find the parent group
    d.traverse(c => { if (c.isMesh) c.userData.dolphinGroup = d; });
    return d;
}

// ─── Procedural scene objects ─────────────────────────────────────────────────

const L = modelLength;

// ─── Scene 2: World-space swim path following Mekong centerline ──────────────
// Scene 1 (Kratie): x=110582, z=-42388  →  Scene 3 (PP Confluence): x=-6687, z=56909
// Waypoints extracted from Natural Earth river_centerline.geojson, converted to local UTM
// Dolphin travels downstream from Kratie → PP, with dives and surfacing.
// Return leg at surface completes the loop.
const S = 50 / L; // terrain scale factor for dolphin body

const SWIM_PATH_WORLD = new THREE.CatmullRomCurve3([
    // ── Downstream leg: Scene 1 → Scene 3 (diving, echolocating) ──
    // Start near Kratie (Scene 1), at surface
    new THREE.Vector3(110243,     3,  -42388),
    // Dive into bedrock reach
    new THREE.Vector3(112208,    -7,  -39431),
    new THREE.Vector3(113959,   -12,  -25780),
    new THREE.Vector3(111748,   -18,  -20852),
    new THREE.Vector3(106942,   -22,  -18080),
    // Wide meander section
    new THREE.Vector3( 87968,   -15,  -17266),
    // Brief surface to breathe
    new THREE.Vector3( 62202,     4,  -21525),
    // Dive again — alluvial reach
    new THREE.Vector3( 58883,   -18,  -16775),
    new THREE.Vector3( 58348,   -22,  -10483),
    new THREE.Vector3( 60615,   -15,   -5879),
    new THREE.Vector3( 58964,   -12,   -2825),
    new THREE.Vector3( 57593,   -18,    2626),
    // Surface to breathe
    new THREE.Vector3( 53213,     4,    8047),
    new THREE.Vector3( 51390,     3,   11195),
    // Deep pools near mid-corridor
    new THREE.Vector3( 50443,   -20,   17231),
    new THREE.Vector3( 46923,   -15,   20468),
    new THREE.Vector3( 37738,   -10,   18235),
    new THREE.Vector3( 27743,   -18,   18880),
    new THREE.Vector3( 18927,   -22,   18010),
    new THREE.Vector3( 16174,   -25,   19982),
    new THREE.Vector3( 13253,   -18,   26576),
    // Rising toward PP
    new THREE.Vector3(  3031,   -10,   27626),
    new THREE.Vector3(  -734,    -6,   28809),
    // Surface near PP Confluence (Scene 3)
    new THREE.Vector3( -5774,     3,   47149),
    new THREE.Vector3( -6687,     3,   56909),

    // ── Return leg: Scene 3 → Scene 1 (also dives + echolocates) ──
    new THREE.Vector3( -4363,     4,   43316),
    new THREE.Vector3(  3031,   -10,   27626),
    new THREE.Vector3( 13253,   -15,   26576),
    new THREE.Vector3( 18927,     3,   18010),  // breathe
    new THREE.Vector3( 27743,   -12,   18880),
    new THREE.Vector3( 37738,   -18,   18235),
    new THREE.Vector3( 46923,     3,   20468),  // breathe
    new THREE.Vector3( 53213,   -14,    8047),
    new THREE.Vector3( 58964,   -10,   -2825),
    new THREE.Vector3( 60615,     4,   -5879),  // breathe
    new THREE.Vector3( 87968,   -12,  -17266),
    new THREE.Vector3(106942,     4,  -18080),
], true, 'centripetal');

// Hazard positions — scattered along/near the swim path with lateral offsets
const CORRIDOR_HAZARDS = [
    // Downstream leg hazards
    { type: 'gillnet',     x: 112400, y: -10, z: -38000, rotY: 0.6 },
    { type: 'trash',       x: 113500, y: -8,  z: -27000 },
    { type: 'gillnet',     x: 111200, y: -16, z: -21200, rotY: -0.3 },
    { type: 'carcass',     x: 107500, y: -4,  z: -18500 },
    { type: 'trash',       x: 90000,  y: -10, z: -17500 },
    { type: 'gillnet',     x: 88500,  y: -12, z: -16800, rotY: 1.1 },
    { type: 'cargo_noise', x: 62000,  y: -1,  z: -21000, rotY: 0.2 },
    { type: 'gillnet',     x: 59000,  y: -16, z: -15000, rotY: -0.5 },
    { type: 'trash',       x: 58000,  y: -18, z: -11000 },
    { type: 'carcass',     x: 60200,  y: -5,  z:  -6200 },
    { type: 'gillnet',     x: 57800,  y: -14, z:   2200, rotY: 0.4 },
    { type: 'trash',       x: 53500,  y: -1,  z:   7500 },
    { type: 'gillnet',     x: 50800,  y: -18, z:  16800, rotY: 0.7 },
    { type: 'cargo_noise', x: 47200,  y: -2,  z:  20000, rotY: -0.2 },
    { type: 'trash',       x: 38000,  y: -8,  z:  18500 },
    { type: 'gillnet',     x: 27500,  y: -15, z:  19200, rotY: -0.6 },
    { type: 'carcass',     x: 19200,  y: -6,  z:  17500 },
    { type: 'gillnet',     x: 16500,  y: -22, z:  19500, rotY: 0.9 },
    { type: 'trash',       x: 13500,  y: -14, z:  26000 },
    { type: 'cargo_noise', x:  3500,  y: -2,  z:  27200, rotY: 0.3 },
    { type: 'gillnet',     x:  -500,  y: -5,  z:  29200, rotY: -0.4 },
    // Return leg hazards
    { type: 'gillnet',     x:  3200,  y: -8,  z:  28000, rotY: 0.7 },
    { type: 'trash',       x: 13000,  y: -12, z:  27000 },
    { type: 'carcass',     x: 28000,  y: -5,  z:  18300 },
    { type: 'gillnet',     x: 37500,  y: -15, z:  18600, rotY: 0.2 },
    { type: 'trash',       x: 53500,  y: -10, z:   8500 },
    { type: 'cargo_noise', x: 59200,  y: -2,  z:  -2500, rotY: 1.0 },
    { type: 'gillnet',     x: 88200,  y: -10, z: -16900, rotY: -0.7 },
];

function makeBoat(length, color = 0x8b6914) {
    const g = new THREE.Group();
    // Hull
    const hull = new THREE.Mesh(
        new THREE.BoxGeometry(length * 0.3, length * 0.15, length),
        new THREE.MeshLambertMaterial({ color })
    );
    hull.position.y = length * 0.05;
    g.add(hull);
    // Cabin
    const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(length * 0.2, length * 0.12, length * 0.3),
        new THREE.MeshLambertMaterial({ color: 0x555555 })
    );
    cabin.position.set(0, length * 0.18, -length * 0.15);
    g.add(cabin);
    return g;
}

function makeCarcass(length = 1) {
    // Dead dolphin — grey, belly-up, slightly bloated
    const g = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(length * 0.15, length * 0.6, 8, 12),
        new THREE.MeshLambertMaterial({ color: 0x667777 })
    );
    body.rotation.z = Math.PI; // belly up
    body.rotation.y = Math.random() * Math.PI;
    g.add(body);
    // Tail fluke — limp
    const tail = new THREE.Mesh(
        new THREE.BoxGeometry(length * 0.3, length * 0.02, length * 0.1),
        new THREE.MeshLambertMaterial({ color: 0x556666 })
    );
    tail.position.set(0, 0, length * 0.4);
    tail.rotation.x = 0.3;
    g.add(tail);
    return g;
}

function makeCargoWithNoise(length, color = 0x3a3a3a) {
    // Cargo vessel with noise emission rings
    const g = new THREE.Group();
    // Hull
    const hull = new THREE.Mesh(
        new THREE.BoxGeometry(length * 0.3, length * 0.15, length),
        new THREE.MeshLambertMaterial({ color })
    );
    hull.position.y = length * 0.05;
    g.add(hull);
    // Cabin
    const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(length * 0.2, length * 0.12, length * 0.3),
        new THREE.MeshLambertMaterial({ color: 0x555555 })
    );
    cabin.position.set(0, length * 0.18, -length * 0.15);
    g.add(cabin);
    // Noise emission rings (concentric, pulsing outward)
    const NOISE_RING_COUNT = 4;
    const noiseRings = [];
    for (let i = 0; i < NOISE_RING_COUNT; i++) {
        const ringGeo = new THREE.RingGeometry(1, 1.3, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xff4422,
            transparent: true,
            opacity: 0.0,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = length * 0.02;
        ring.userData.isNoiseRing = true;
        g.add(ring);
        noiseRings.push({ mesh: ring, mat: ringMat });
    }
    g.userData.noiseRings = noiseRings;
    g.userData.noiseScale = length;
    return g;
}

function makeStiltHouse(size = 1) {
    const g = new THREE.Group();
    const woodDark = 0x5a3a1a;
    const woodLight = 0x8b6914;
    const thatch = 0x9a8a50;

    // Four stilts (legs) going into the water
    const stiltH = size * 2.5;
    const stiltR = size * 0.04;
    const floorW = size * 1.2;
    const floorD = size * 1.0;
    const stiltPositions = [
        [-floorW * 0.4, -floorD * 0.4],
        [ floorW * 0.4, -floorD * 0.4],
        [-floorW * 0.4,  floorD * 0.4],
        [ floorW * 0.4,  floorD * 0.4],
    ];
    for (const [sx, sz] of stiltPositions) {
        const stilt = new THREE.Mesh(
            new THREE.CylinderGeometry(stiltR, stiltR, stiltH, 6),
            new THREE.MeshLambertMaterial({ color: woodDark })
        );
        stilt.position.set(sx, stiltH * 0.3, sz);
        g.add(stilt);
    }

    // Cross-braces between stilts
    const braceGeo = new THREE.CylinderGeometry(stiltR * 0.5, stiltR * 0.5, floorW * 0.85, 4);
    const braceMat = new THREE.MeshLambertMaterial({ color: woodDark });
    const brace1 = new THREE.Mesh(braceGeo, braceMat);
    brace1.rotation.z = Math.PI / 2;
    brace1.position.set(0, stiltH * 0.15, -floorD * 0.4);
    g.add(brace1);
    const brace2 = new THREE.Mesh(braceGeo, braceMat);
    brace2.rotation.z = Math.PI / 2;
    brace2.position.set(0, stiltH * 0.15, floorD * 0.4);
    g.add(brace2);

    // Platform / floor
    const floorY = stiltH * 0.55;
    const floor = new THREE.Mesh(
        new THREE.BoxGeometry(floorW, size * 0.03, floorD),
        new THREE.MeshLambertMaterial({ color: woodLight })
    );
    floor.position.y = floorY;
    g.add(floor);

    // Walls (three sides, front open)
    const wallH = size * 0.6;
    const wallMat = new THREE.MeshLambertMaterial({ color: woodLight, side: THREE.DoubleSide });
    // Back wall
    const backWall = new THREE.Mesh(
        new THREE.PlaneGeometry(floorW, wallH),
        wallMat
    );
    backWall.position.set(0, floorY + wallH / 2, floorD * 0.48);
    g.add(backWall);
    // Side walls
    const sideWallGeo = new THREE.PlaneGeometry(floorD * 0.96, wallH);
    const leftWall = new THREE.Mesh(sideWallGeo, wallMat);
    leftWall.rotation.y = Math.PI / 2;
    leftWall.position.set(-floorW * 0.48, floorY + wallH / 2, 0);
    g.add(leftWall);
    const rightWall = new THREE.Mesh(sideWallGeo, wallMat);
    rightWall.rotation.y = Math.PI / 2;
    rightWall.position.set(floorW * 0.48, floorY + wallH / 2, 0);
    g.add(rightWall);

    // Roof — pitched (two angled planes)
    const roofOverhang = 1.15;
    const roofW = floorW * roofOverhang;
    const roofD = floorD * roofOverhang * 0.55;
    const roofPeak = floorY + wallH + size * 0.35;
    const roofBase = floorY + wallH;
    const roofMat = new THREE.MeshLambertMaterial({ color: thatch, side: THREE.DoubleSide });
    const roofGeo = new THREE.PlaneGeometry(roofW, roofD);
    const roofL = new THREE.Mesh(roofGeo, roofMat);
    roofL.position.set(0, (roofPeak + roofBase) / 2, -roofD * 0.35);
    roofL.rotation.x = 0.55;
    g.add(roofL);
    const roofR = new THREE.Mesh(roofGeo, roofMat);
    roofR.position.set(0, (roofPeak + roofBase) / 2, roofD * 0.35);
    roofR.rotation.x = -0.55;
    g.add(roofR);

    // Ladder — angled from water to platform
    const ladderLen = stiltH * 0.7;
    const ladder = new THREE.Mesh(
        new THREE.BoxGeometry(size * 0.15, size * 0.02, ladderLen),
        new THREE.MeshLambertMaterial({ color: woodDark })
    );
    ladder.position.set(0, floorY * 0.5, -floorD * 0.6);
    ladder.rotation.x = -0.6;
    g.add(ladder);
    // Ladder rungs
    for (let i = 0; i < 4; i++) {
        const rung = new THREE.Mesh(
            new THREE.BoxGeometry(size * 0.15, size * 0.015, size * 0.015),
            new THREE.MeshLambertMaterial({ color: woodDark })
        );
        const rt = (i + 0.5) / 4;
        rung.position.set(0, floorY * (0.2 + rt * 0.6), -floorD * (0.45 + rt * 0.2));
        rung.rotation.x = -0.6;
        g.add(rung);
    }

    return g;
}

function makeBuoy(height = 120, color = 0xff6600) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(2, 2, height, 8),
        new THREE.MeshLambertMaterial({ color: 0x888888 })
    );
    pole.position.y = height / 2;
    g.add(pole);
    const top = new THREE.Mesh(
        new THREE.SphereGeometry(5, 8, 6),
        new THREE.MeshBasicMaterial({ color })
    );
    top.position.y = height + 4;
    g.add(top);
    return g;
}

function makeGillnet(width, height) {
    const geo = new THREE.PlaneGeometry(width, height, Math.max(1, Math.floor(width / 50)), Math.max(1, Math.floor(height / 20)));
    const mat = new THREE.MeshBasicMaterial({
        color: 0xaaaaaa,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.25,
        wireframe: true,
    });
    return new THREE.Mesh(geo, mat);
}

function makeStationMonitor(height = L * 2) {
    const g = new THREE.Group();
    // Pole/mast — metal cylinder
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(height * 0.04, height * 0.05, height, 8),
        new THREE.MeshLambertMaterial({ color: 0x666677 })
    );
    pole.position.y = height / 2;
    g.add(pole);
    // Solar panel — angled flat box
    const panel = new THREE.Mesh(
        new THREE.BoxGeometry(height * 0.4, height * 0.02, height * 0.25),
        new THREE.MeshLambertMaterial({ color: 0x223355 })
    );
    panel.position.set(0, height * 0.85, -height * 0.1);
    panel.rotation.x = -0.4;
    g.add(panel);
    // Antenna — thin cylinder on top
    const antenna = new THREE.Mesh(
        new THREE.CylinderGeometry(height * 0.01, height * 0.01, height * 0.3, 4),
        new THREE.MeshLambertMaterial({ color: 0x999999 })
    );
    antenna.position.y = height + height * 0.15;
    g.add(antenna);
    // Sensor housing — small box at water level
    const sensor = new THREE.Mesh(
        new THREE.BoxGeometry(height * 0.15, height * 0.1, height * 0.12),
        new THREE.MeshLambertMaterial({ color: 0x445566 })
    );
    sensor.position.set(0, height * 0.15, height * 0.08);
    g.add(sensor);
    // Status LED — glowing green dot
    const led = new THREE.Mesh(
        new THREE.SphereGeometry(height * 0.025, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0x44ff88 })
    );
    led.position.set(0, height * 0.75, height * 0.06);
    g.add(led);
    // Float/platform at water line
    const float = new THREE.Mesh(
        new THREE.CylinderGeometry(height * 0.2, height * 0.22, height * 0.06, 12),
        new THREE.MeshLambertMaterial({ color: 0xcc6600 })
    );
    float.position.y = 0;
    g.add(float);
    return g;
}

function makeDataTransfer(origin, target, numParticles = 40) {
    // Animated particles flowing from dolphin to station
    const positions = new Float32Array(numParticles * 3);
    const offsets = new Float32Array(numParticles); // phase offset per particle
    for (let i = 0; i < numParticles; i++) {
        offsets[i] = i / numParticles;
        // Initialize at origin
        positions[i * 3] = origin.x;
        positions[i * 3 + 1] = origin.y;
        positions[i * 3 + 2] = origin.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
        color: 0x00ff00,
        size: 4,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.userData.dataTransfer = { origin, target, offsets, numParticles };
    return points;
}

function updateDataTransfer(points, time) {
    const { origin, target, offsets, numParticles } = points.userData.dataTransfer;
    const pos = points.geometry.attributes.position.array;
    const speed = 0.3; // cycle duration in seconds-ish
    for (let i = 0; i < numParticles; i++) {
        // t goes from 0 to 1 along the path, with phase offset
        let t = ((time * speed + offsets[i]) % 1.0);
        // Arc upward in the middle of the path
        const arc = Math.sin(t * Math.PI) * L * 0.4;
        pos[i * 3]     = origin.x + (target.x - origin.x) * t;
        pos[i * 3 + 1] = origin.y + (target.y - origin.y) * t + arc;
        pos[i * 3 + 2] = origin.z + (target.z - origin.z) * t;
    }
    points.geometry.attributes.position.needsUpdate = true;
    // Pulse the opacity
    points.material.opacity = 0.5 + 0.4 * Math.sin(time * 3);
}

function makeTrash() {
    const g = new THREE.Group();
    const colors = [0xdddddd, 0x4488cc, 0xcc4444, 0x44cc44, 0xcccc44];
    for (let i = 0; i < 15; i++) {
        const size = 5 + Math.random() * 15;
        const mesh = new THREE.Mesh(
            Math.random() > 0.5
                ? new THREE.BoxGeometry(size, size * 0.3, size * 0.8)
                : new THREE.SphereGeometry(size * 0.4, 6, 4),
            new THREE.MeshLambertMaterial({
                color: colors[Math.floor(Math.random() * colors.length)],
                transparent: true,
                opacity: 0.7,
            })
        );
        mesh.position.set(
            (Math.random() - 0.5) * 400,
            Math.random() * 5,
            (Math.random() - 0.5) * 400
        );
        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
        g.add(mesh);
    }
    return g;
}

// ─── Scene water plane for model-scale views ────────────────────────────────

function makeSceneWater(extent = L * 30) {
    const g = new THREE.Group();
    // Lilac circle at y=0
    const circleGeo = new THREE.CircleGeometry(extent, 48);
    circleGeo.rotateX(-Math.PI / 2);
    const fillMat = new THREE.MeshBasicMaterial({
        color: 0x0a3a6a,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcColorFactor,
    });
    const circle = new THREE.Mesh(circleGeo, fillMat);
    circle.position.y = 0;
    g.add(circle);
    // Glowing lilac ring outline
    // Inner bright ring (sharp stroke)
    const ringGeo = new THREE.RingGeometry(extent * 0.985, extent, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xdde4ff,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.01;
    g.add(ring);
    // Outer glow (wider, softer)
    const glowGeo = new THREE.RingGeometry(extent * 0.96, extent * 1.04, 48);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xbfcaff,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.y = 0.01;
    g.add(glow);
    // Extra wide soft glow
    const glow2Geo = new THREE.RingGeometry(extent * 0.93, extent * 1.07, 48);
    glow2Geo.rotateX(-Math.PI / 2);
    const glow2Mat = new THREE.MeshBasicMaterial({
        color: 0x8899dd,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const glow2 = new THREE.Mesh(glow2Geo, glow2Mat);
    glow2.position.y = 0.01;
    g.add(glow2);
    return g;
}

// ─── Hazard reveal material (sonar-revealed underwater objects) ──────────────

function makeHazardRevealMaterial(originalColor) {
    return new THREE.ShaderMaterial({
        uniforms: {
            time: sonarUniforms.time,
            pulseOrigin: sonarUniforms.pulseOrigin,
            pulseSpeed: sonarUniforms.pulseSpeed,
            pulseWidth: sonarUniforms.pulseWidth,
            maxDist: sonarUniforms.maxDist,
            echoActive: sonarUniforms.echoActive,
            baseColor: { value: new THREE.Color(originalColor) },
        },
        vertexShader: `
            uniform float time;
            uniform vec3 pulseOrigin;
            uniform float pulseSpeed;
            uniform float pulseWidth;
            uniform float maxDist;
            varying float vReveal;
            varying float vFlash;
            varying float vDist;
            varying vec3 vNormal;
            varying vec3 vWorldPos;

            void main() {
                vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
                vWorldPos = worldPos;
                vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
                float dist = distance(worldPos, pulseOrigin);
                vDist = dist;
                float pulseRadius = pulseSpeed * time;

                // Pulse wavefront hit — sharp bright flash
                float distFromPulse = abs(dist - pulseRadius);
                float envelope = 1.0 - smoothstep(0.0, pulseWidth * 0.5, distFromPulse);

                // Reflection burst: intense flash that decays quickly
                float passedTime = max(0.0, time - dist / pulseSpeed);
                float reflectionFlash = passedTime > 0.0 ? exp(-passedTime * 2.0) : 0.0;

                // Persistent dim outline after first hit
                float persistGlow = passedTime > 0.0 ? 0.25 : 0.0;

                vFlash = envelope;
                vReveal = max(max(envelope, reflectionFlash), persistGlow);

                // Scale up vertices slightly during flash for bloom effect
                vec3 displaced = position + normal * envelope * 2.0;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 baseColor;
            uniform float echoActive;
            uniform float maxDist;
            uniform vec3 pulseOrigin;
            varying float vReveal;
            varying float vFlash;
            varying float vDist;
            varying vec3 vNormal;
            varying vec3 vWorldPos;

            void main() {
                float alpha = echoActive * vReveal;
                if (alpha < 0.01) discard;

                // Distance fade
                float distFade = 1.0 - smoothstep(0.0, maxDist * 0.5, vDist);

                // Sonar reflection: bright on surfaces facing the pulse origin
                vec3 pulseDir = normalize(vWorldPos - pulseOrigin);
                float facing = abs(dot(vNormal, pulseDir));

                // Color: cyan outline → white flash on hit
                vec3 outlineColor = vec3(0.2, 0.5, 0.8);
                vec3 flashColor = vec3(0.8, 0.95, 1.0);
                vec3 reflectColor = vec3(0.4, 0.7, 1.0);
                vec3 col = mix(outlineColor, flashColor, vFlash);
                col = mix(col, reflectColor, facing * 0.5);

                // Boost brightness during flash
                col *= 1.0 + vFlash * 2.0;

                gl_FragColor = vec4(col, alpha * distFade);
            }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
    });
}

function applyHazardMaterials(sceneGroup) {
    sceneGroup.traverse(child => {
        if (!child.isMesh) return;
        // Walk up to find hazard-tagged ancestor
        let node = child;
        let isUnderwaterHazard = false;
        while (node) {
            if (node.userData && node.userData.underwaterHazard) {
                isUnderwaterHazard = true;
                break;
            }
            node = node.parent;
        }
        if (isUnderwaterHazard) {
            // Don't swap noise emission ring materials — they animate independently
            if (child.userData.isNoiseRing) return;
            child.userData._origMat = child.material;
            const color = child.material.color ? child.material.color.getHex() : 0xffffff;
            child.material = makeHazardRevealMaterial(color);
        }
    });
}

// ─── Swim animation functions ────────────────────────────────────────────────

function updateSwimAnimation(sceneGroup, time, isMainScene) {
    const swim = sceneGroup.userData.swimAnim;
    if (!swim) return;

    const { dolphin, path, cycleDuration } = swim;

    // Parameter t along path [0,1], looping
    const t = (time / cycleDuration) % 1.0;

    // Position on path
    const pos = path.getPointAt(t);

    // ─── Hazard avoidance: swerve laterally when near a detected hazard ────
    const AVOID_RADIUS = 500;   // start swerving within 500m
    const AVOID_STRENGTH = 150; // max lateral offset in meters
    let avoidX = 0, avoidZ = 0;
    if (isMainScene && swim.echoActive) {
        for (let hi = 0; hi < CORRIDOR_HAZARDS.length; hi++) {
            const h = CORRIDOR_HAZARDS[hi];
            const dx = h.x - pos.x, dz = h.z - pos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < AVOID_RADIUS && dist > 1) {
                // Push away perpendicular to path (cross product with up)
                const strength = AVOID_STRENGTH * (1.0 - dist / AVOID_RADIUS);
                // Direction away from hazard
                avoidX -= (dx / dist) * strength;
                avoidZ -= (dz / dist) * strength;
            }
        }
    }

    if (isMainScene && terrainLoaded) {
        // WORLD-SPACE mode: move the entire scene content group to the path position
        // The dolphin stays at local origin; the group moves through the terrain
        sceneGroup.position.set(pos.x + avoidX, pos.y, pos.z + avoidZ);
        dolphin.position.set(0, 0, 0);
    } else {
        // Preview mode: move dolphin locally (path scaled down for preview)
        const pathStart = path.getPointAt(0);
        const previewScale = L * 15 / 73000;
        dolphin.position.set(
            (pos.x - pathStart.x) * previewScale,
            pos.y * previewScale * 5,
            (pos.z - pathStart.z) * previewScale
        );
    }

    // Orientation: look along tangent
    const tangent = path.getTangentAt(t);
    // dolphin.lookAt expects coordinates in parent space
    // In main scene: dolphin is at (0,0,0) in group, tangent gives direction
    // In preview: dolphin is at a local position, add tangent to it
    const lookTarget = dolphin.position.clone().add(tangent);
    dolphin.rotation.set(0, 0, 0);
    dolphin.lookAt(lookTarget);
    dolphin.rotateY(Math.PI);  // correct model facing direction

    // Gentle body oscillation
    dolphin.rotation.z += Math.sin(time * 3.5) * 0.04;
    dolphin.rotation.x += Math.sin(time * 4.0) * 0.03;

    if (!isMainScene) return;

    // ─── Camera follows dolphin along corridor ───────────────────────────
    const actualX = pos.x + avoidX, actualZ = pos.z + avoidZ;
    if (terrainLoaded) {
        const camTarget = new THREE.Vector3(actualX, 0, actualZ);
        controls.target.lerp(camTarget, 0.03);
        const camIdeal = new THREE.Vector3(
            actualX + tangent.x * -4000 + 1500,
            2000,
            actualZ + tangent.z * -4000
        );
        camera.position.lerp(camIdeal, 0.02);
    }

    // ─── Update minimap marker to track dolphin ──────────────────────────
    activeRing.position.set(actualX, 250, actualZ);

    // ─── Auto echolocation based on depth (with hysteresis) ─────────────
    const isUnderwater = pos.y < 0;
    const timeSinceToggle = time - echoLastToggleTime;

    if (isUnderwater && !swim.echoActive && timeSinceToggle > ECHO_MIN_DURATION) {
        swim.echoActive = true;
        swim.echoStartTime = time;
        echoLastToggleTime = time;
        sonarUniforms.echoActive.value = 1.0;
        setEchoMode(true);
        sonarRingGroup.visible = true;
    } else if (!isUnderwater && swim.echoActive && timeSinceToggle > ECHO_MIN_DURATION) {
        swim.echoActive = false;
        echoLastToggleTime = time;
        sonarUniforms.echoActive.value = 0.0;
        setEchoMode(false);
        sonarRingGroup.visible = false;
    }

    // Update sonar pulse origin + animate sonar rings
    if (swim.echoActive) {
        sonarUniforms.pulseOrigin.value.set(actualX, pos.y, actualZ);
        const echoElapsed = time - swim.echoStartTime;
        sonarUniforms.time.value = echoElapsed % 6.0;

        // Animate expanding sonar rings from dolphin position
        sonarRingGroup.position.set(actualX, pos.y, actualZ);
        const pulseCycle = 3.0; // seconds per pulse
        for (let ri = 0; ri < SONAR_RING_COUNT; ri++) {
            const phase = ((echoElapsed / pulseCycle) + ri / SONAR_RING_COUNT) % 1.0;
            const radius = phase * 15000; // expand to 15km
            const ringObj = sonarRings[ri];
            ringObj.mesh.scale.set(radius, radius, radius);
            // Fade in then out
            const fadeIn = Math.min(phase * 5.0, 1.0);
            const fadeOut = 1.0 - Math.pow(phase, 0.5);
            ringObj.mat.opacity = fadeIn * fadeOut * 0.6;
        }
    }

    // ─── Transit data collection ────────────────────────────────────────
    // Track distance
    if (transitData.lastPos) {
        transitData.distanceTravelled += pos.distanceTo(transitData.lastPos);
    }
    transitData.lastPos = pos.clone();

    // Track dives
    if (isUnderwater && !transitData.lastDiveState) {
        transitData.diveCount++;
    }
    transitData.lastDiveState = isUnderwater;

    // Detect hazards within sonar range
    if (swim.echoActive) {
        const echoElapsed = time - swim.echoStartTime;
        const pulseRadius = sonarUniforms.pulseSpeed.value * (echoElapsed % 6.0);
        for (let hi = 0; hi < CORRIDOR_HAZARDS.length; hi++) {
            if (transitData.detectedSet.has(hi)) continue;
            const h = CORRIDOR_HAZARDS[hi];
            const hx = h.x - pos.x, hz = h.z - pos.z;
            const dist = Math.sqrt(hx * hx + hz * hz);
            if (dist < pulseRadius && dist < sonarUniforms.maxDist.value) {
                transitData.detectedSet.add(hi);
                transitData.hazards[h.type] = (transitData.hazards[h.type] || 0) + 1;
            }
        }
    }

    // Collect water quality sample every 2 seconds
    if (time - transitData.lastSampleTime > 2.0) {
        transitData.lastSampleTime = time;
        transitData.samples++;
        // Simulate readings that vary along corridor (t = 0→1 path progress)
        // Upstream (Kratie) generally better quality, downstream (PP) more turbid
        const noise = () => (Math.random() - 0.5) * 0.1;
        transitData.liveWQ.DO = 6.8 - t * 1.5 + noise() * 2;
        transitData.liveWQ.turbidity = 30 + t * 60 + noise() * 20;
        transitData.liveWQ.TSS = 50 + t * 100 + noise() * 30;
        transitData.liveWQ.pH = 7.3 - t * 0.3 + noise();
        transitData.liveWQ.nitrate = 0.3 + t * 0.8 + noise() * 0.2;
        transitData.liveWQ.temp = 27.5 + t * 2 + noise();
    }

    // Update right sidebar every 30 frames
    if (!swim._panelFrame) swim._panelFrame = 0;
    if (++swim._panelFrame % 30 === 0) {
        renderTransitPanels(t);
    }

    // Update dolphin POV camera (for Scene 2 preview panel)
    const povOffset = tangent.clone().multiplyScalar(35);
    dolphinPOVCamera.position.set(actualX + povOffset.x, pos.y + 8, actualZ + povOffset.z);
    const lookAhead = new THREE.Vector3(actualX, pos.y, actualZ).add(tangent.clone().multiplyScalar(500));
    dolphinPOVCamera.lookAt(lookAhead);
    dolphinPOVUnderwater = pos.y < 0;
}

// ─── Build corridor hazards (world-space objects for Scene 2 transit) ────────

function buildCorridorHazards() {
    corridorHazardsGroup.clear();
    for (const h of CORRIDOR_HAZARDS) {
        let obj;
        if (h.type === 'gillnet') {
            obj = makeGillnet(120, 40);
        } else if (h.type === 'trash') {
            obj = makeTrash();
            obj.scale.setScalar(15);
        } else if (h.type === 'carcass') {
            obj = makeCarcass(30);  // ~30m dolphin carcass
        } else if (h.type === 'cargo_noise') {
            obj = makeCargoWithNoise(60, 0x3a3a3a);
        }
        if (!obj) continue;
        obj.userData.underwaterHazard = true;
        obj.position.set(h.x, h.y, h.z);
        if (h.rotY) obj.rotation.y = h.rotY;
        corridorHazardsGroup.add(obj);
    }
    // Apply sonar reveal to all hazards
    let revealCount = 0;
    applyHazardMaterials(corridorHazardsGroup);
    corridorHazardsGroup.traverse(c => {
        if (c.isMesh && c.material && c.material.isShaderMaterial) revealCount++;
    });
}
buildCorridorHazards();

// ─── Scene configs ───────────────────────────────────────────────────────────

// Water level MSL at each scene (approximate dry-season values for initial positioning)
// These get updated by the season slider via the water surface shader
const SCENE_WATER_MSL = [8, 5, 2, 4]; // Kampi, Transit, PP, Tonle Sap (rough dry season)

const sceneConfigs = [
    {
        // Scene 1: Kampi Pool — dolphin transferring data to station monitor
        name: 'kampi',
        setup(s) {
            s.add(makeSceneWater());

            // Dolphin surfacing near the station, transferring data
            const d1 = cloneDolphin();
            d1.position.set(0.00, -0.10, 0.00);
            d1.rotation.set(-1.939, 1.275, 1.834);
            s.add(d1);

            // Station monitor — positioned nearby
            const stationPos = new THREE.Vector3(L * 3.5, 0, L * 1.5);
            const station = makeStationMonitor(L * 2);
            station.position.copy(stationPos);
            s.add(station);

            // Data transfer particles: dolphin → station sensor
            const dolphinHead = new THREE.Vector3(0.3, 0.0, 0.2);
            const sensorPos = new THREE.Vector3(stationPos.x, L * 0.3, stationPos.z);
            const transfer = makeDataTransfer(dolphinHead, sensorPos, 50);
            s.add(transfer);
            s.userData.dataTransfer = transfer;

            // Two more dolphins in the background, waiting
            const d2 = cloneDolphin();
            d2.position.set(-2.00, -0.15, -1.50);
            d2.rotation.set(-0.500, -0.200, 0.000);
            s.add(d2);
            const d3 = cloneDolphin();
            d3.position.set(-1.00, -0.20, -2.50);
            d3.rotation.set(-0.700, 0.100, 0.000);
            s.add(d3);

            // Conservationist rowboat observing
            const boat1 = makeBoat(L * 3, 0x6b4226);
            boat1.position.set(-L * 5, -L * 0.05, L * 3);
            boat1.rotation.y = 0.6;
            s.add(boat1);
        },
        camera: { pos: [0, L*2, -L*6], target: [0, -L*0.3, L*3] },
        // Terrain-scale camera: close to water, slightly behind dolphin
        terrainCamera: { offset: [2000, 1500, -3000], targetOffset: [0, 0, 0] },
    },
    {
        // Scene 2: Mekong Transit — dolphin traverses full corridor Scene 2 → Scene 3
        // The scene content group moves along SWIM_PATH_WORLD in world coordinates.
        // Hazards are placed in a separate world-space group (corridorHazardsGroup).
        name: 'transit',
        setup(s) {
            s.add(makeSceneWater());
            // Dolphin — group repositioned each frame along corridor
            const d = cloneDolphin();
            s.add(d);

            // Store swim animation state (path is in world coords)
            s.userData.swimAnim = {
                dolphin: d,
                path: SWIM_PATH_WORLD,
                cycleDuration: 45,  // 45s to traverse ~73km corridor + return
                echoActive: false,
                echoStartTime: 0,
            };
        },
        camera: { pos: [L*0.3, L*0.8, -L*5], target: [0, 0, L*6] },
        terrainCamera: { offset: [3000, 2000, -4000], targetOffset: [0, 0, 0] },
    },
    {
        // Scene 3: Phnom Penh Confluence — dolphin reports hazard data to station
        // Fishing boats cluster around the buoy/station receiving data the dolphin transferred.
        // Dolphin glows golden as it shares data — "karma" indicator.
        name: 'confluence',
        setup(s) {
            s.add(makeSceneWater());

            // Dolphin surfacing near station, uploading data — tagged for golden glow
            const d = cloneDolphin();
            d.position.set(-6.35, -0.01, 0.07);
            d.rotation.set(-1.340, 0.352, 0.427);
            d.userData.karmaGlow = true;
            // Give this dolphin its own material instances so color changes don't affect others
            d.traverse(c => {
                if (c.isMesh && c.material) {
                    c.material = c.material.clone();
                }
            });
            s.add(d);
            s.userData.karmaDolphin = d;

            // Station monitor / buoy — positioned nearby
            const stationPos = new THREE.Vector3(-L * 4, 0, L * 2);
            const station = makeStationMonitor(L * 2);
            station.position.copy(stationPos);
            s.add(station);

            // Data transfer: dolphin → station (hazard report upload, neon green)
            const dolphinHead = new THREE.Vector3(-6.0, 0.1, 0.3);
            const sensorPos = new THREE.Vector3(stationPos.x, L * 0.3, stationPos.z);
            const transfer = makeDataTransfer(dolphinHead, sensorPos, 50);
            s.add(transfer);
            s.userData.dataTransfer = transfer;

            // Fishing boats clustered around station/buoy, facing it, receiving data
            const boatTransfers = [];
            const boatCount = 6;
            for (let i = 0; i < boatCount; i++) {
                const size = L * (1.5 + Math.random() * 2);
                const boat = makeBoat(size, [0x6b4226, 0x5a3a1a, 0x8b6914, 0x3a5a3a, 0x4a3a2a, 0x7a5533][i]);
                // Cluster around the station in a semicircle
                const angle = (-Math.PI * 0.4) + (i / (boatCount - 1)) * Math.PI * 0.8;
                const dist = L * (3 + (i % 2) * 1.5);
                const bx = stationPos.x + Math.cos(angle) * dist;
                const bz = stationPos.z + Math.sin(angle) * dist;
                boat.position.set(bx, -L * 0.03, bz);
                // Face the station
                boat.lookAt(stationPos.x, 0, stationPos.z);
                s.add(boat);

                // Data stream: station → each fishing boat (neon green particles)
                const boatTop = new THREE.Vector3(bx, L * 0.2, bz);
                const stationOut = new THREE.Vector3(stationPos.x, L * 0.5, stationPos.z);
                const bt = makeDataTransfer(stationOut, boatTop, 20);
                s.add(bt);
                boatTransfers.push(bt);
            }
            s.userData.boatTransfers = boatTransfers;

            // Trash accumulation near banks
            const trash = makeTrash();
            trash.position.set(L * 10, 0, L * 6);
            trash.scale.setScalar(L / 1.5);
            s.add(trash);

            // Track karma animation state
            s.userData.karmaStart = null; // set on first animate frame
            s.userData.karma = 0; // 0→1 over time
        },
        camera: { pos: [-L*3, L*0.8, -L*1.2], target: [-L*3, 0, L*0.5] },
        terrainCamera: { offset: [-500, 400, -800], targetOffset: [0, 0, 0] },
    },
    {
        // Scene 4: Tonle Sap — family pod, homecoming
        name: 'homecoming',
        setup(s) {
            const water = makeSceneWater();
            // Replace water circle fill with shimmery golden shader
            water.traverse(c => {
                if (c.isMesh && c.material && c.material.color && c.material.color.getHex() === 0x0a3a6a) {
                    const goldenShaderMat = new THREE.ShaderMaterial({
                        uniforms: {
                            uTime: { value: 0 },
                        },
                        vertexShader: `
                            varying vec2 vUv;
                            varying vec3 vWorldPos;
                            void main() {
                                vUv = uv;
                                vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
                                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                            }
                        `,
                        fragmentShader: `
                            uniform float uTime;
                            varying vec2 vUv;
                            varying vec3 vWorldPos;
                            void main() {
                                // Base golden color
                                vec3 gold = vec3(0.42, 0.30, 0.05);
                                // Shimmer waves
                                float wave1 = sin(vWorldPos.x * 0.8 + uTime * 1.5) * 0.5 + 0.5;
                                float wave2 = sin(vWorldPos.z * 0.6 - uTime * 1.2 + 1.5) * 0.5 + 0.5;
                                float wave3 = sin((vWorldPos.x + vWorldPos.z) * 0.4 + uTime * 0.8) * 0.5 + 0.5;
                                float shimmer = wave1 * wave2 * 0.6 + wave3 * 0.4;
                                // Sparkle highlights
                                float sparkle = pow(sin(vWorldPos.x * 3.0 + uTime * 4.0) * sin(vWorldPos.z * 2.7 - uTime * 3.5), 8.0);
                                vec3 highlight = vec3(1.0, 0.85, 0.4);
                                vec3 col = mix(gold, gold * 1.5, shimmer * 0.4) + highlight * sparkle * 0.3;
                                float alpha = 0.35 + shimmer * 0.1 + sparkle * 0.15;
                                gl_FragColor = vec4(col, alpha);
                            }
                        `,
                        transparent: true,
                        side: THREE.DoubleSide,
                        depthWrite: false,
                        blending: THREE.AdditiveBlending,
                    });
                    c.material = goldenShaderMat;
                    c.userData.goldenWater = true;
                }
            });
            s.add(water);

            // dolphin 14 — the golden dolphin from Scene 3 (karma carrier)
            const d1 = cloneDolphin();
            d1.position.set(11.01, 0.00, -18.40);
            d1.rotation.set(-1.265, -0.622, -1.136);
            d1.traverse(c => {
                if (c.isMesh && c.material) {
                    c.material = c.material.clone();
                    c.material.color.set(0xe8b830);
                    if (c.material.emissive) {
                        c.material.emissive.set(0x9a7520);
                        c.material.emissiveIntensity = 0.4;
                    }
                }
            });
            s.add(d1);

            // Golden shimmer particles around the karma dolphin
            const shimmerCount = 80;
            const shimmerPositions = new Float32Array(shimmerCount * 3);
            const shimmerPhases = new Float32Array(shimmerCount);
            for (let i = 0; i < shimmerCount; i++) {
                shimmerPhases[i] = Math.random();
                shimmerPositions[i * 3] = d1.position.x + (Math.random() - 0.5) * 3;
                shimmerPositions[i * 3 + 1] = d1.position.y + Math.random() * 1.5;
                shimmerPositions[i * 3 + 2] = d1.position.z + (Math.random() - 0.5) * 3;
            }
            const shimmerGeo = new THREE.BufferGeometry();
            shimmerGeo.setAttribute('position', new THREE.BufferAttribute(shimmerPositions, 3));
            const shimmerMat = new THREE.PointsMaterial({
                color: 0xffd700,
                size: 3,
                sizeAttenuation: false,
                transparent: true,
                opacity: 0.7,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });
            const shimmerPoints = new THREE.Points(shimmerGeo, shimmerMat);
            shimmerPoints.userData.shimmer = { phases: shimmerPhases, center: d1.position.clone() };
            s.add(shimmerPoints);
            s.userData.goldenShimmer = shimmerPoints;

            // dolphin 15 (juvenile)
            const d2 = cloneDolphin();
            d2.position.set(0.61, -0.05, -0.37);
            d2.rotation.set(0.020, 0.080, 0.000);
            d2.scale.setScalar(0.55);
            s.add(d2);

            // dolphin 16
            const d3 = cloneDolphin();
            d3.position.set(8.52, 0.07, -22.37);
            d3.rotation.set(-0.683, -0.120, 0.000);
            s.add(d3);

            // dolphin 17
            const d4 = cloneDolphin();
            d4.position.set(6.04, 0.18, -22.53);
            d4.rotation.set(-0.998, 0.661, 0.822);
            d4.scale.setScalar(0.90);
            s.add(d4);

            // dolphin 18
            const d5 = cloneDolphin();
            d5.position.set(9.45, 0.12, -20.87);
            d5.rotation.set(-0.851, 0.400, 0.000);
            d5.scale.setScalar(0.85);
            s.add(d5);

            // dolphin 19
            const d6 = cloneDolphin();
            d6.position.set(10.95, -0.06, -20.02);
            d6.rotation.set(-0.944, -0.765, -0.538);
            d6.scale.setScalar(0.80);
            s.add(d6);

            // Single peaceful fishing boat (traditional)
            const boat = makeBoat(L * 3, 0x8b6914);
            boat.position.set(L * 12, -L * 0.05, L * 8);
            boat.rotation.y = 0.7;
            s.add(boat);

            // Cambodian stilt house on the bank
            const house = makeStiltHouse(L * 3);
            house.position.set(0.53, -0.12, -13.82);
            house.rotation.set(0.000, 0.300, 0.000);
            house.userData.isDolphin = true;  // allow gizmo selection
            house.userData.dolphinId = 'house';
            house.traverse(c => { if (c.isMesh) c.userData.dolphinGroup = house; });
            s.add(house);

        },
        camera: { pos: [L*0.5, L*2.5, -L*7], target: [0, 0, L*1] },
        terrainCamera: { offset: [2000, 1500, -3000], targetOffset: [0, 0, 0] },
    },
];

// ─── Scene loading ───────────────────────────────────────────────────────────

let activeScene = 0;

function loadMainScene(sceneIndex) {
    // When leaving scene 2, deactivate echo mode and hide corridor hazards + sonar rings
    if (activeScene === 1 && sceneIndex !== 1) {
        setEchoMode(false);
        echoTransition = 0;
        echoTransitionTarget = 0;
        sonarUniforms.echoActive.value = 0.0;
        corridorHazardsGroup.visible = false;
        sonarRingGroup.visible = false;
        restoreStationPanels();
    }
    // When leaving scene 3 or 4, restore standard panels
    if ((activeScene === 2 || activeScene === 3) && sceneIndex !== activeScene) {
        restoreStationPanels();
    }
    // When entering scene 2, reset transit data
    if (sceneIndex === 1 && activeScene !== 1) {
        resetTransitData();
    }

    mainSceneContent.clear();
    const config = sceneConfigs[sceneIndex];
    config.setup(mainSceneContent);

    const loc = SCENE_LOCATIONS[sceneIndex];

    if (terrainLoaded) {
        // Scale dolphins to ~50m body length on terrain
        const terrainScale = 50 / modelLength;
        mainSceneContent.scale.setScalar(terrainScale);
        mainSceneContent.position.set(loc.localX, 20, loc.localZ);

        if (sceneIndex === 1) {
            // Scene 2: corridor transit — show hazards, camera set to start position
            corridorHazardsGroup.visible = true;
            const startPt = SWIM_PATH_WORLD.getPointAt(0);
            mainSceneContent.position.set(startPt.x, startPt.y, startPt.z);
            camera.position.set(startPt.x + 3000, 2000, startPt.z - 4000);
            controls.target.set(startPt.x, 0, startPt.z);
        } else {
            // Other scenes: standard terrain camera
            const tc = config.terrainCamera;
            camera.position.set(
                loc.localX + tc.offset[0],
                tc.offset[1],
                loc.localZ + tc.offset[2]
            );
            controls.target.set(
                loc.localX + tc.targetOffset[0],
                tc.targetOffset[1],
                loc.localZ + tc.targetOffset[2]
            );
        }
    } else {
        const { pos, target } = config.camera;
        camera.position.set(...pos);
        controls.target.set(...target);
    }

    // Update echolocation pulse origin to scene location
    sonarUniforms.pulseOrigin.value.set(loc.localX, 0, loc.localZ);
    sonarUniforms.time.value = 0;
    echoStartTime = performance.now() / 1000;

    controls.update();
    activeScene = sceneIndex;
    updateMinimapActive(sceneIndex);
}

// ─── Echolocation mode toggle ────────────────────────────────────────────────

function setEchoMode(enabled) {
    echoMode = enabled;
    echoTransitionTarget = enabled ? 1 : 0;

    // Point cloud material swap
    if (pointCloudGroup.children.length > 0) {
        pointCloudGroup.children[0].material = enabled
            ? (echoPointCloudMaterial || pointCloudGroup.children[0].material)
            : (pointCloudMaterial || pointCloudGroup.children[0].material);
    }

    // Terrain wireframe swap (discrete — can't lerp wireframe)
    terrainGroup.traverse(child => {
        if (child.isMesh) {
            if (enabled && !child.userData._echoWireframe) {
                child.userData._origMat = child.material;
                child.userData._echoWireframe = new THREE.MeshBasicMaterial({
                    color: 0x1a3a6a,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.35,
                });
                child.material = child.userData._echoWireframe;
            } else if (!enabled && child.userData._origMat) {
                child.material = child.userData._origMat;
                child.userData._echoWireframe = null;
            }
        }
    });

    if (enabled) {
        echoStartTime = performance.now() / 1000;
    }
}

// Smooth echo transition (called every frame in animate loop)
const echoColorOptical = new THREE.Color(0x0d1117);
const echoColorFull = new THREE.Color(0x000204);  // near-black with hint of blue
const echoColorCurrent = new THREE.Color();

function updateEchoTransition() {
    // Lerp toward target
    echoTransition += (echoTransitionTarget - echoTransition) * 0.06;
    // Snap when close
    if (Math.abs(echoTransition - echoTransitionTarget) < 0.005) {
        echoTransition = echoTransitionTarget;
    }

    // Water surface: fully transparent during echo
    if (waterSurfaceMaterial) {
        waterSurfaceMaterial.uniforms.opacity.value = THREE.MathUtils.lerp(0.6, 0.0, echoTransition);
    }
    // Hide the water surface group entirely at full echo
    waterSurfaceGroup.visible = echoTransition < 0.5;

    // Terrain: hide entirely during echo — wireframe is too subtle
    terrainGroup.visible = echoTransition < 0.3;

    // Dim scene lights during echo so only sonar rings + hazard shaders illuminate
    scene.traverse(child => {
        if (child.isLight && child.userData._echoManaged !== false) {
            if (!child.userData._origIntensity && child.userData._origIntensity !== 0) {
                child.userData._origIntensity = child.intensity;
            }
            child.intensity = THREE.MathUtils.lerp(child.userData._origIntensity, 0, echoTransition);
        }
    });

    // Sky background: remove during echo so clear color shows through
    if (echoTransition > 0.1) {
        if (!scene.userData._origBackground) {
            scene.userData._origBackground = scene.background;
        }
        scene.background = null;
    } else if (scene.userData._origBackground) {
        scene.background = scene.userData._origBackground;
        scene.userData._origBackground = null;
    }

    // Background color — pitch black with slight blue
    echoColorCurrent.copy(echoColorOptical).lerp(echoColorFull, echoTransition);
    renderer.setClearColor(echoColorCurrent);
}

// ─── Minimap ─────────────────────────────────────────────────────────────────

const minimapCanvas = document.getElementById('minimap-canvas');
const minimapRenderer = new THREE.WebGLRenderer({ canvas: minimapCanvas, antialias: true });
minimapRenderer.setPixelRatio(window.devicePixelRatio);
minimapRenderer.setClearColor(0x0d1117);

const minimapScene = new THREE.Scene();
minimapScene.add(new THREE.AmbientLight(0xffffff, 1.5));
const minimapDirLight = new THREE.DirectionalLight(0xffffff, 1.0);
minimapDirLight.position.set(0, 1, 0);
minimapScene.add(minimapDirLight);

// Orthographic top-down camera covering the whole terrain extent
// Terrain spans roughly -200km to +200km in local coords
const mmExtent = 220000;
const minimapCamera = new THREE.OrthographicCamera(-mmExtent, mmExtent, mmExtent, -mmExtent, 1, 500000);
minimapCamera.position.set(0, 100000, 0);
minimapCamera.up.set(0, 0, -1);
minimapCamera.lookAt(0, 0, 0);

// Clone terrain into minimap scene once terrain is loaded
let minimapTerrainAdded = false;
function addTerrainToMinimap() {
    if (minimapTerrainAdded || !terrainMeshRef) return;
    const clone = terrainMeshRef.clone();
    // Low opacity so water masks are clearly visible
    clone.material = new THREE.MeshLambertMaterial({
        map: terrainMeshRef.material.map,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.1,
    });
    minimapScene.add(clone);
    minimapTerrainAdded = true;
}

// Add water surface + bathymetry to minimap after they load
let minimapWaterAdded = false;
function addWaterToMinimap() {
    if (minimapWaterAdded || !terrainMeshRef) return;
    // Water surface: solid blue where JRC says water, at interpolated height
    if (waterSurfaceMaterial) {
        const waterClone = new THREE.Mesh(
            terrainMeshRef.geometry.clone(),
            waterSurfaceMaterial  // shares the same shader material
        );
        minimapScene.add(waterClone);
    }
    // Bathymetry: find the bathymetry mesh in terrainGroup and clone it
    terrainGroup.traverse(child => {
        if (child.isMesh && child.geometry.getAttribute('color')) {
            // This is the bathymetry mesh (has vertex colors)
            const bathClone = child.clone();
            bathClone.material = child.material.clone();
            bathClone.material.opacity = 1.0;
            minimapScene.add(bathClone);
        }
    });
    minimapWaterAdded = true;
}

// Scene location markers on minimap
const minimapMarkers = [];
const activeMarkerMat = new THREE.MeshBasicMaterial({ color: 0xbfcaff, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
const inactiveMarkerMat = new THREE.MeshBasicMaterial({ color: 0xbfcaff, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
const markerGeoMinimap = new THREE.CircleGeometry(6000, 32);

const markerRingGeo = new THREE.RingGeometry(5500, 6000, 32);
const markerRingMat = new THREE.MeshBasicMaterial({ color: 0xbfcaff, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
const markerRingActiveMat = new THREE.MeshBasicMaterial({ color: 0xbfcaff, side: THREE.DoubleSide });

for (let i = 0; i < SCENE_LOCATIONS.length; i++) {
    if (i === 1) {
        // Scene 2 has no static marker — the dolphin IS the traveling marker
        minimapMarkers.push(null);
        continue;
    }
    const loc = SCENE_LOCATIONS[i];
    const group = new THREE.Group();
    // Filled circle at 20% opacity
    const fill = new THREE.Mesh(markerGeoMinimap, activeMarkerMat.clone());
    fill.rotation.x = -Math.PI / 2;
    group.add(fill);
    // Ring outline
    const ring = new THREE.Mesh(markerRingGeo, i === 0 ? markerRingActiveMat.clone() : markerRingMat.clone());
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    group.position.set(loc.localX, 200, loc.localZ);
    minimapScene.add(group);
    minimapMarkers.push({ group, fill, ring });
}

// Active scene ring (larger, hollow via second circle)
const ringGeo = new THREE.RingGeometry(7000, 9000, 24);
const ringMat = new THREE.MeshBasicMaterial({ color: 0xbfcaff, side: THREE.DoubleSide });
const activeRing = new THREE.Mesh(ringGeo, ringMat);
activeRing.rotation.x = -Math.PI / 2;
activeRing.position.set(SCENE_LOCATIONS[0].localX, 250, SCENE_LOCATIONS[0].localZ);
minimapScene.add(activeRing);

function updateMinimapActive(sceneIndex) {
    for (let i = 0; i < minimapMarkers.length; i++) {
        const m = minimapMarkers[i];
        if (!m) continue; // Scene 2 has no static marker
        const isActive = i === sceneIndex;
        m.ring.material.opacity = isActive ? 1.0 : 0.4;
        m.fill.material.opacity = isActive ? 0.3 : 0.15;
    }
    // For Scene 2, activeRing is positioned by updateSwimAnimation
    if (sceneIndex !== 1) {
        const loc = SCENE_LOCATIONS[sceneIndex];
        activeRing.position.set(loc.localX, 250, loc.localZ);
    }
}

function resizeMinimap() {
    const w = minimapCanvas.clientWidth;
    const h = minimapCanvas.clientHeight;
    if (w === 0 || h === 0) return;
    minimapRenderer.setSize(w, h, false);
    const aspect = w / h;
    if (aspect > 1) {
        minimapCamera.left = -mmExtent * aspect;
        minimapCamera.right = mmExtent * aspect;
        minimapCamera.top = mmExtent;
        minimapCamera.bottom = -mmExtent;
    } else {
        minimapCamera.left = -mmExtent;
        minimapCamera.right = mmExtent;
        minimapCamera.top = mmExtent / aspect;
        minimapCamera.bottom = -mmExtent / aspect;
    }
    minimapCamera.updateProjectionMatrix();
}
resizeMinimap();

// Minimap click → switch scene
minimapCanvas.addEventListener('click', (e) => {
    const rect = minimapCanvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    // Convert to world coords using camera bounds
    const worldX = minimapCamera.left + nx * (minimapCamera.right - minimapCamera.left);
    const worldZ = minimapCamera.top + ny * (minimapCamera.bottom - minimapCamera.top);

    // Find nearest scene location
    let bestDist = Infinity, bestIdx = 0;
    for (let i = 0; i < SCENE_LOCATIONS.length; i++) {
        const loc = SCENE_LOCATIONS[i];
        const dx = worldX - loc.localX;
        const dz = worldZ - loc.localZ;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    if (bestIdx !== activeScene) {
        document.querySelectorAll('.scene-panel').forEach((p, i) => p.classList.toggle('active', i === bestIdx));
        loadMainScene(bestIdx);
        updateTimeline();
    }
});

// ─── Preview renderers ───────────────────────────────────────────────────────

const previewCanvases = document.querySelectorAll('.scene-preview');
const previews = [];

previewCanvases.forEach((pvCanvas, i) => {
    const pvRenderer = new THREE.WebGLRenderer({ canvas: pvCanvas, antialias: true });
    pvRenderer.setPixelRatio(window.devicePixelRatio);
    pvRenderer.setClearColor(0x1a1030);

    const pvScene = new THREE.Scene();
    addLights(pvScene);

    const config = sceneConfigs[i];
    config.setup(pvScene);

    const { pos, target } = config.camera;
    const pvCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    pvCamera.position.set(...pos);
    pvCamera.lookAt(new THREE.Vector3(...target));

    previews.push({ renderer: pvRenderer, scene: pvScene, camera: pvCamera, canvas: pvCanvas });
});

function resizePreviews() {
    for (const pv of previews) {
        const w = pv.canvas.clientWidth;
        const h = pv.canvas.clientHeight;
        if (w === 0 || h === 0) continue;
        pv.renderer.setSize(w, h, false);
        pv.camera.aspect = w / h;
        pv.camera.updateProjectionMatrix();
    }
}
resizePreviews();

// ─── Panel click handlers ────────────────────────────────────────────────────

const panels = document.querySelectorAll('.scene-panel');

panels.forEach(panel => {
    panel.addEventListener('click', () => {
        const id = parseInt(panel.dataset.scene) - 1;
        if (id === activeScene) return;
        panels.forEach(p => p.classList.toggle('active', p === panel));
        loadMainScene(id);
        updateTimeline();
    });
});

// ─── Controls ────────────────────────────────────────────────────────────────

// Season slider
// ─── Timeline (year strip + month slider) ────────────────────────────────────

const TIMELINE_START = 2000;
const TIMELINE_END = 2030;
const HISTORICAL_END = 2021; // last year with real JRC data
let currentYear = 2020;

// Build year strip blocks
const yearStrip = document.getElementById('year-strip');
for (let y = TIMELINE_START; y <= TIMELINE_END; y++) {
    const block = document.createElement('div');
    block.className = `year-block ${y <= HISTORICAL_END ? 'historical' : 'projected'} ${y % 10 === 0 ? 'decade' : ''}`;
    if (y === currentYear) block.classList.add('active');
    block.dataset.year = y;
    block.innerHTML = `<span class="year-tip">${y}</span><span class="year-dot"></span>`;
    block.addEventListener('click', () => selectYear(y));
    yearStrip.appendChild(block);
}

const monthSlider = document.getElementById('month-slider');
const monthLabel = document.getElementById('month-label');
const timelineReadout = document.getElementById('timeline-readout');

function selectYear(year) {
    currentYear = year;
    // Update strip highlight
    yearStrip.querySelectorAll('.year-block').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.year) === year);
        b.classList.remove('scenario-cooperative', 'scenario-decline');
        if (parseInt(b.dataset.year) === year && year > HISTORICAL_END) {
            b.classList.add(`scenario-${activeScenario}`);
        }
    });
    // If entering projected range, activate scenario buttons
    const isProjected = year > HISTORICAL_END;
    document.querySelectorAll('.scenario-btn').forEach(b => {
        b.style.opacity = isProjected ? '1' : '0.4';
        b.style.pointerEvents = isProjected ? 'auto' : 'auto'; // always clickable but visually muted
    });
    document.querySelector('.scenario-label-text').textContent = isProjected ? 'Scenario' : 'Scenario';
    updateTimeline();
}

function updateTimeline() {
    const isProjected = currentYear > HISTORICAL_END;
    currentMonth = parseInt(monthSlider.value);
    monthLabel.textContent = MONTH_NAMES[currentMonth - 1];

    // Readout
    timelineReadout.textContent = `${MONTH_NAMES[currentMonth - 1]} ${currentYear}${isProjected ? ' (projected)' : ''}`;
    timelineReadout.className = `timeline-readout${isProjected ? ` projected-${activeScenario}` : ''}`;

    // Load the JRC texture for this year+month if historical
    updateWaterMonth(currentMonth);
    updateDataPanels();
    drawWaterExtentGraph();
}

monthSlider.addEventListener('input', () => updateTimeline());

// Echo mode is now automatic (Scene 2 swim animation controls it)

// Layer toggles
document.getElementById('layer-terrain').addEventListener('change', (e) => {
    terrainGroup.visible = e.target.checked;
});
document.getElementById('layer-water').addEventListener('change', (e) => {
    waterSurfaceGroup.visible = e.target.checked;
});
document.getElementById('layer-stations').addEventListener('change', (e) => {
    stationsGroup.visible = e.target.checked;
});

// ─── Station data panels ─────────────────────────────────────────────────────

// Map scene index → nearest station
const SCENE_STATIONS = ['kratie', 'stung_treng', 'chrouy_changvar', 'kampong_luong'];
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let stationDataCache = {};
let activeScenario = 'cooperative';

// Scenario modifiers: multipliers applied to baseline data
const SCENARIOS = {
    cooperative: {
        label: 'Cooperative Recovery',
        // Improvements: better water quality, more fish, less sediment disruption
        wq: { DO: 1.12, turbidity: 0.8, TSS: 0.75, nitrate: 0.85, pH: 1.0 },
        sediment: { ssc: 0.85, discharge: 1.0 },
        fisheries: { catch: 1.35, species: 1.2 },
    },
    decline: {
        label: 'Accelerated Decline',
        // Degradation: worse water quality, fewer fish, more sediment
        wq: { DO: 0.78, turbidity: 1.5, TSS: 1.6, nitrate: 1.4, pH: 0.97 },
        sediment: { ssc: 1.8, discharge: 0.7 },
        fisheries: { catch: 0.4, species: 0.6 },
    },
};

async function loadStationData(stationId) {
    if (stationDataCache[stationId]) return stationDataCache[stationId];
    try {
        const resp = await fetch(`../api/station-data/${stationId}.json`);
        if (!resp.ok) return null;
        const data = await resp.json();
        stationDataCache[stationId] = data;
        return data;
    } catch (_) { return null; }
}

function applyScenario(value, multiplier) {
    if (currentYear <= HISTORICAL_END) return value; // historical: no modification
    // Projected: scale effect by years into the future (linear ramp)
    const yearsOut = currentYear - HISTORICAL_END;
    const maxYears = TIMELINE_END - HISTORICAL_END; // 9 years
    const t = Math.min(1, yearsOut / maxYears);
    // Interpolate between 1.0 (baseline) and the scenario multiplier
    const effectiveMultiplier = 1.0 + (multiplier - 1.0) * t;
    return value * effectiveMultiplier;
}

function statusClass(value, threshMin, threshMax) {
    if (threshMin !== undefined && value < threshMin) return 'danger';
    if (threshMax !== undefined && value > threshMax) return 'warn';
    return 'ok';
}

function renderWaterQuality(data, month, scenario) {
    const el = document.getElementById('wq-body');
    if (!data?.water_quality?.monthly) { el.textContent = 'No data'; return; }
    const m = data.water_quality.monthly[month];
    if (!m) { el.textContent = 'No data'; return; }
    const sc = SCENARIOS[scenario].wq;
    const readings = m.readings;
    const params = [
        { key: 'DO', label: 'Dissolved O\u2082', mult: sc.DO },
        { key: 'pH', label: 'pH', mult: sc.pH },
        { key: 'turbidity', label: 'Turbidity', mult: sc.turbidity },
        { key: 'TSS', label: 'Susp. Solids', mult: sc.TSS },
        { key: 'nitrate', label: 'Nitrate', mult: sc.nitrate },
    ];
    let html = '';
    for (const p of params) {
        const r = readings[p.key];
        if (!r) continue;
        const val = applyScenario(r.value, p.mult);
        const cls = statusClass(val, r.threshold_min, r.threshold_max);
        html += `<div class="data-row">
            <span class="data-label">${p.label}</span>
            <span class="data-value ${cls}">${val.toFixed(1)}<span class="data-unit">${r.unit}</span></span>
        </div>`;
        // Bar showing where value sits between thresholds
        if (r.threshold_max) {
            const pct = Math.min(100, (val / r.threshold_max) * 100);
            const barColor = cls === 'ok' ? '#44ddaa' : cls === 'warn' ? '#ffaa44' : '#ff5544';
            html += `<div class="data-bar-row"><div class="data-bar"><div class="data-bar-fill" style="width:${pct}%;background:${barColor}"></div></div></div>`;
        }
    }
    el.innerHTML = html;
}

function renderSediment(data, month, scenario) {
    const el = document.getElementById('sed-body');
    if (!data?.sediment?.weekly) { el.textContent = 'No data'; return; }
    const sc = SCENARIOS[scenario].sediment;
    // Get weeks for this month (approx 4 weeks per month)
    const startWeek = month * 4 + 1;
    const weeks = data.sediment.weekly.filter(w => w.week >= startWeek && w.week < startWeek + 5);
    if (weeks.length === 0) { el.textContent = 'No data'; return; }
    // Average for the month
    const avgSSC = weeks.reduce((s, w) => s + w.ssc_mg_L, 0) / weeks.length;
    const avgQ = weeks.reduce((s, w) => s + w.discharge_m3_s, 0) / weeks.length;
    const ssc = applyScenario(avgSSC, sc.ssc);
    const discharge = applyScenario(avgQ, sc.discharge);
    const sscCls = ssc > 300 ? 'danger' : ssc > 150 ? 'warn' : 'ok';
    const maxSSC = 600;
    const sscPct = Math.min(100, (ssc / maxSSC) * 100);
    const barColor = sscCls === 'ok' ? '#44ddaa' : sscCls === 'warn' ? '#ffaa44' : '#ff5544';
    let html = `
        <div class="data-row">
            <span class="data-label">Susp. Sediment</span>
            <span class="data-value ${sscCls}">${ssc.toFixed(0)}<span class="data-unit">mg/L</span></span>
        </div>
        <div class="data-bar-row"><div class="data-bar"><div class="data-bar-fill" style="width:${sscPct}%;background:${barColor}"></div></div></div>
        <div class="data-row">
            <span class="data-label">Discharge</span>
            <span class="data-value ok">${(discharge/1000).toFixed(1)}<span class="data-unit">\u00d710\u00b3 m\u00b3/s</span></span>
        </div>
    `;
    // Sediment load
    const load = (ssc * discharge * 86.4) / 1e6; // tonnes/day approx
    html += `<div class="data-row">
        <span class="data-label">Load</span>
        <span class="data-value ok">${load.toFixed(0)}<span class="data-unit">t/day</span></span>
    </div>`;
    el.innerHTML = html;
}

function renderFisheries(data, month, scenario) {
    const el = document.getElementById('fish-body');
    if (!data?.fisheries?.monthly) { el.textContent = 'No data'; return; }
    const m = data.fisheries.monthly[month];
    if (!m) { el.textContent = 'No data'; return; }
    const sc = SCENARIOS[scenario].fisheries;
    const catchVal = applyScenario(m.total_catch_kg_day, sc.catch);
    const speciesVal = Math.round(applyScenario(m.n_species, sc.species));
    const catchCls = catchVal < 50 ? 'danger' : catchVal < 150 ? 'warn' : 'ok';
    const speciesCls = speciesVal < 10 ? 'danger' : speciesVal < 20 ? 'warn' : 'ok';
    let html = `
        <div class="data-row">
            <span class="data-label">Catch</span>
            <span class="data-value ${catchCls}">${catchVal.toFixed(0)}<span class="data-unit">kg/day</span></span>
        </div>
        <div class="data-row">
            <span class="data-label">Species</span>
            <span class="data-value ${speciesCls}">${speciesVal}</span>
        </div>
        <div class="data-row">
            <span class="data-label">Migration</span>
            <span class="data-value ok">${m.migration_type}</span>
        </div>
    `;
    // Key species presence
    if (m.key_species) {
        const names = {
            'Orcaella_brevirostris': 'Irrawaddy',
            'Pangasianodon_hypophthalmus': 'Pangasius',
            'Henicorhynchus_siamensis': 'Siamese mud',
            'Cirrhinus_microlepis': 'Small-scale mud',
            'Boesemania_microlepis': 'Croaker',
        };
        html += '<div class="species-row">';
        for (const [key, label] of Object.entries(names)) {
            let present = m.key_species[key];
            // In decline scenario, reduce species presence
            if (scenario === 'decline' && Math.random() > 0.5) present = false;
            if (scenario === 'cooperative') present = true; // recovery
            html += `<span class="species-tag ${present ? 'present' : ''}">${label}</span>`;
        }
        html += '</div>';
    }
    if (m.dai_season) {
        html += `<div class="scenario-label">Dai fishing season active</div>`;
    }
    el.innerHTML = html;
}

// ─── Scene 2 transit data panels ──────────────────────────────────────────────

function renderTransitPanels(pathT) {
    const sidebarHeader = document.querySelector('.data-sidebar-header span');
    sidebarHeader.textContent = 'Transit Survey';

    const d = transitData;
    const wq = d.liveWQ;

    // Water Quality panel → live readings
    const wqEl = document.getElementById('wq-body');
    const doCls = wq.DO < 5.0 ? 'danger' : wq.DO < 6.0 ? 'warn' : 'ok';
    const turbCls = wq.turbidity > 80 ? 'danger' : wq.turbidity > 50 ? 'warn' : 'ok';
    const tssCls = wq.TSS > 150 ? 'danger' : wq.TSS > 100 ? 'warn' : 'ok';
    const phCls = wq.pH < 6.5 || wq.pH > 8.5 ? 'danger' : wq.pH < 6.8 ? 'warn' : 'ok';
    wqEl.innerHTML = `
        <div class="data-row"><span class="data-label">Samples</span><span class="data-value ok">${d.samples}</span></div>
        <div class="data-row"><span class="data-label">Dissolved O\u2082</span><span class="data-value ${doCls}">${wq.DO.toFixed(1)}<span class="data-unit">mg/L</span></span></div>
        <div class="data-row"><span class="data-label">Turbidity</span><span class="data-value ${turbCls}">${wq.turbidity.toFixed(0)}<span class="data-unit">NTU</span></span></div>
        <div class="data-row"><span class="data-label">Susp. Solids</span><span class="data-value ${tssCls}">${wq.TSS.toFixed(0)}<span class="data-unit">mg/L</span></span></div>
        <div class="data-row"><span class="data-label">pH</span><span class="data-value ${phCls}">${wq.pH.toFixed(1)}</span></div>
        <div class="data-row"><span class="data-label">Temp</span><span class="data-value ok">${wq.temp.toFixed(1)}<span class="data-unit">\u00b0C</span></span></div>
    `;

    // Sediment panel → hazard detections
    const sedEl = document.getElementById('sed-body');
    const totalHazards = d.hazards.gillnet + d.hazards.trash + d.hazards.carcass + d.hazards.cargo_noise;
    const hazCls = totalHazards > 10 ? 'danger' : totalHazards > 5 ? 'warn' : 'ok';
    sedEl.innerHTML = `
        <div class="data-row"><span class="data-label">Total Detected</span><span class="data-value ${hazCls}">${totalHazards}</span></div>
        <div class="data-row"><span class="data-label">Gillnets</span><span class="data-value ${d.hazards.gillnet > 0 ? 'danger' : 'ok'}">${d.hazards.gillnet}</span></div>
        <div class="data-row"><span class="data-label">Debris/Trash</span><span class="data-value ${d.hazards.trash > 0 ? 'warn' : 'ok'}">${d.hazards.trash}</span></div>
        <div class="data-row"><span class="data-label">Carcasses</span><span class="data-value ${d.hazards.carcass > 0 ? 'danger' : 'ok'}">${d.hazards.carcass}</span></div>
        <div class="data-row"><span class="data-label">Noise Pollution</span><span class="data-value ${d.hazards.cargo_noise > 0 ? 'warn' : 'ok'}">${d.hazards.cargo_noise}</span></div>
    `;

    // Fisheries panel → survey progress
    const fishEl = document.getElementById('fish-body');
    const distKm = (d.distanceTravelled / 1000).toFixed(1);
    const pctComplete = (pathT * 100).toFixed(0);
    fishEl.innerHTML = `
        <div class="data-row"><span class="data-label">Progress</span><span class="data-value ok">${pctComplete}<span class="data-unit">%</span></span></div>
        <div class="data-bar-row"><div class="data-bar"><div class="data-bar-fill" style="width:${pctComplete}%;background:#4488ff"></div></div></div>
        <div class="data-row"><span class="data-label">Distance</span><span class="data-value ok">${distKm}<span class="data-unit">km</span></span></div>
        <div class="data-row"><span class="data-label">Dives</span><span class="data-value ok">${d.diveCount}</span></div>
        <div class="data-row"><span class="data-label">Depth</span><span class="data-value ok">${(-Math.min(0, transitData.lastPos?.y || 0)).toFixed(1)}<span class="data-unit">m</span></span></div>
    `;

    // Update panel titles
    document.querySelector('#panel-water-quality .data-panel-title').textContent = 'Water Quality (Live)';
    document.querySelector('#panel-sediment .data-panel-title').textContent = 'Hazard Detections';
    document.querySelector('#panel-fisheries .data-panel-title').textContent = 'Survey Progress';
}

function restoreStationPanels() {
    document.querySelector('.data-sidebar-header span').textContent = 'Station Data';
    document.querySelector('#panel-water-quality .data-panel-title').textContent = 'Water Quality';
    document.querySelector('#panel-sediment .data-panel-title').textContent = 'Sediment';
    document.querySelector('#panel-fisheries .data-panel-title').textContent = 'Fisheries';
    updateDataPanels();
}

// ─── Scene 3: Confluence panels — hazard report + karma ───────────────────
function renderConfluencePanels(karma) {
    const d = transitData;
    const totalHazards = d.hazards.gillnet + d.hazards.trash + d.hazards.carcass + d.hazards.cargo_noise;

    document.querySelector('.data-sidebar-header span').textContent = 'Hazard Report';

    // Water Quality panel → final survey readings
    const wqEl = document.getElementById('wq-body');
    wqEl.innerHTML = `
        <div class="data-row"><span class="data-label">Samples</span><span class="data-value ok">${d.samples}</span></div>
        <div class="data-row"><span class="data-label">Avg DO</span><span class="data-value ${d.liveWQ.DO < 4 ? 'danger' : d.liveWQ.DO < 6 ? 'warn' : 'ok'}">${d.liveWQ.DO.toFixed(1)}<span class="data-unit">mg/L</span></span></div>
        <div class="data-row"><span class="data-label">Avg Turbidity</span><span class="data-value ${d.liveWQ.turbidity > 100 ? 'danger' : d.liveWQ.turbidity > 50 ? 'warn' : 'ok'}">${d.liveWQ.turbidity.toFixed(0)}<span class="data-unit">NTU</span></span></div>
        <div class="data-row"><span class="data-label">Status</span><span class="data-value ok">Uploading</span></div>
    `;

    // Sediment panel → hazard summary
    const sedEl = document.getElementById('sed-body');
    const hazCls = totalHazards > 10 ? 'danger' : totalHazards > 5 ? 'warn' : 'ok';
    sedEl.innerHTML = `
        <div class="data-row"><span class="data-label">Total Hazards</span><span class="data-value ${hazCls}">${totalHazards}</span></div>
        <div class="data-row"><span class="data-label">Gillnets</span><span class="data-value ${d.hazards.gillnet > 0 ? 'danger' : 'ok'}">${d.hazards.gillnet}</span></div>
        <div class="data-row"><span class="data-label">Carcasses</span><span class="data-value ${d.hazards.carcass > 0 ? 'danger' : 'ok'}">${d.hazards.carcass}</span></div>
        <div class="data-row"><span class="data-label">Noise Sources</span><span class="data-value ${d.hazards.cargo_noise > 0 ? 'warn' : 'ok'}">${d.hazards.cargo_noise}</span></div>
        <div class="data-row"><span class="data-label">Debris</span><span class="data-value ${d.hazards.trash > 0 ? 'warn' : 'ok'}">${d.hazards.trash}</span></div>
    `;

    // Fisheries panel → karma + data sharing
    const fishEl = document.getElementById('fish-body');
    const karmaPct = (karma * 100).toFixed(0);
    const karmaColor = karma > 0.7 ? 'ok' : karma > 0.3 ? 'warn' : 'danger';
    fishEl.innerHTML = `
        <div class="data-row"><span class="data-label">Karma</span><span class="data-value ${karmaColor}" style="color:#ffd700">${karmaPct}<span class="data-unit">%</span></span></div>
        <div class="data-bar-row"><div class="data-bar"><div class="data-bar-fill" style="width:${karmaPct}%;background:linear-gradient(90deg,#b8860b,#ffd700)"></div></div></div>
        <div class="data-row"><span class="data-label">Boats Receiving</span><span class="data-value ok">6</span></div>
        <div class="data-row"><span class="data-label">Data Shared</span><span class="data-value ok">${totalHazards > 0 ? 'Active' : 'Pending'}</span></div>
        <div class="data-row"><span class="data-label">Distance Surveyed</span><span class="data-value ok">${(d.distanceTravelled / 1000).toFixed(1)}<span class="data-unit">km</span></span></div>
    `;

    document.querySelector('#panel-water-quality .data-panel-title').textContent = 'Survey Data';
    document.querySelector('#panel-sediment .data-panel-title').textContent = 'Hazard Report';
    document.querySelector('#panel-fisheries .data-panel-title').textContent = 'Karma & Sharing';
}

// ─── Dolphin karma glow: grey → golden transition ─────────────────────────
function updateKarmaGlow(sceneContent, time) {
    if (!sceneContent.userData.karmaDolphin) return;
    const dolph = sceneContent.userData.karmaDolphin;

    // Initialize karma start time
    if (sceneContent.userData.karmaStart === null) {
        sceneContent.userData.karmaStart = time;
    }

    // Karma grows from 0 to 1 over 10 seconds
    const elapsed = time - sceneContent.userData.karmaStart;
    const karma = Math.min(elapsed / 10.0, 1.0);
    sceneContent.userData.karma = karma;

    // Lerp dolphin material from grey to gold
    const greyColor = new THREE.Color(0x667788);
    const goldColor = new THREE.Color(0xe8b830);  // warm gold
    const emissiveGold = new THREE.Color(0x9a7520);
    const targetColor = greyColor.clone().lerp(goldColor, karma);
    const targetEmissive = new THREE.Color(0x000000).lerp(emissiveGold, karma * 0.5);

    dolph.traverse(child => {
        if (child.isMesh && child.material) {
            if (child.material.color) child.material.color.copy(targetColor);
            if (child.material.emissive) {
                child.material.emissive.copy(targetEmissive);
                child.material.emissiveIntensity = karma * 0.8;
            }
        }
    });

    return karma;
}

// ─── Scene 4: Homecoming panels — pod status + karma ──────────────────────
function renderHomecomingPanels() {
    const d = transitData;
    const totalHazards = d.hazards.gillnet + d.hazards.trash + d.hazards.carcass + d.hazards.cargo_noise;

    document.querySelector('.data-sidebar-header span').textContent = 'Homecoming';

    // Water Quality panel → family + pod + livelihood
    const wqEl = document.getElementById('wq-body');
    wqEl.innerHTML = `
        <div class="data-row"><span class="data-label">Household</span><span class="data-value ok">Sok Family</span></div>
        <div class="data-row"><span class="data-label">Members</span><span class="data-value ok">7</span></div>
        <div class="data-row"><span class="data-label">Grandpa Sok</span><span class="data-value ok">72<span class="data-unit">yr</span></span></div>
        <div class="data-row"><span class="data-label">Grandma Leap</span><span class="data-value ok">68<span class="data-unit">yr</span></span></div>
        <div class="data-row"><span class="data-label">Dara</span><span class="data-value ok">14<span class="data-unit">yr · in school</span></span></div>
        <div class="data-row"><span class="data-label">Chanthou</span><span class="data-value ok">11<span class="data-unit">yr · in school</span></span></div>
        <div class="data-row"><span class="data-label">Kosal</span><span class="data-value ok">7<span class="data-unit">yr · in school</span></span></div>
        <div class="data-row"><span class="data-label">Generations Here</span><span class="data-value ok">4</span></div>
        <div style="margin:4px 0;border-top:1px solid var(--color-border)"></div>
        <div class="data-row"><span class="data-label">Pod Size</span><span class="data-value ok">6</span></div>
        <div class="data-row"><span class="data-label">Juveniles</span><span class="data-value ok">1</span></div>
        <div class="data-row"><span class="data-label">Species</span><span class="data-value ok">Irrawaddy</span></div>
        <div class="data-row"><span class="data-label">IUCN Status</span><span class="data-value danger">Endangered</span></div>
        <div class="data-row"><span class="data-label">Trend</span><span class="data-value warn">Declining</span></div>
        <div style="margin:4px 0;border-top:1px solid var(--color-border)"></div>
        <div class="data-row"><span class="data-label">Fishing Income</span><span class="data-value warn">$2.40<span class="data-unit">/day</span></span></div>
        <div class="data-row"><span class="data-label">Daily Catch</span><span class="data-value warn">3.2<span class="data-unit">kg</span></span></div>
        <div class="data-row"><span class="data-label">Co-fishing Days</span><span class="data-value ok">218<span class="data-unit">/yr</span></span></div>
        <div class="data-row"><span class="data-label">Hazard Reports</span><span class="data-value ok">$4.80<span class="data-unit">/day</span></span></div>
        <div class="data-row"><span class="data-label">Hazards This Year</span><span class="data-value warn">147</span></div>
    `;

    // Sediment panel → karma + coexistence + total income + bon
    const sedEl = document.getElementById('sed-body');
    sedEl.innerHTML = `
        <div class="data-row"><span class="data-label">Total Income</span><span class="data-value ok" style="color:#e8b830">$7.20<span class="data-unit">/day</span></span></div>
        <div style="margin:4px 0;border-top:1px solid var(--color-border)"></div>
        <div class="data-row"><span class="data-label">Karma</span><span class="data-value ok" style="color:#e8b830">100<span class="data-unit">%</span></span></div>
        <div class="data-bar-row"><div class="data-bar"><div class="data-bar-fill" style="width:100%;background:linear-gradient(90deg,#b8860b,#e8b830)"></div></div></div>
        <div class="data-row"><span class="data-label">Bon</span><span class="data-value ok" style="color:#e8b830">Accumulated</span></div>
        <div class="data-bar-row"><div class="data-bar"><div class="data-bar-fill" style="width:100%;background:linear-gradient(90deg,#e8b830,#ffd700)"></div></div></div>
        <div class="data-row"><span class="data-label">Next Lifetime</span><span class="data-value ok" style="color:#e8b830;font-style:italic">Auspicious</span></div>
    `;

    // Fisheries panel → empty (content moved up)
    const fishEl = document.getElementById('fish-body');
    fishEl.innerHTML = '';

    document.querySelector('#panel-water-quality .data-panel-title').textContent = 'Stilt House Family';
    document.querySelector('#panel-sediment .data-panel-title').textContent = 'Lifecycle Harmony';
    document.querySelector('#panel-fisheries .data-panel-title').textContent = '';
}

// ─── Water extent line graph ─────────────────────────────────────────────────

let waterExtentData = null;
const extentCanvas = document.getElementById('water-extent-graph');
const extentCtx = extentCanvas.getContext('2d');

async function loadWaterExtent() {
    try {
        const resp = await fetch('../api/water-extent.json');
        if (!resp.ok) return;
        waterExtentData = await resp.json();
        drawWaterExtentGraph();
    } catch (_) {}
}

function drawWaterExtentGraph() {
    if (!waterExtentData?.months) return;
    const canvas = extentCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = extentCtx;
    ctx.scale(dpr, dpr);

    const data = waterExtentData.months;
    const maxPct = Math.max(...data.map(d => d.water_pct), 1);
    const totalMonths = (TIMELINE_END - TIMELINE_START + 1) * 12;
    const histMonths = (HISTORICAL_END - TIMELINE_START + 1) * 12;

    // Padding
    const pad = { top: 4, bottom: 14, left: 2, right: 2 };
    const gw = w - pad.left - pad.right;
    const gh = h - pad.top - pad.bottom;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background split: historical (grey) vs projected (green tint)
    const histWidth = (histMonths / totalMonths) * gw;
    ctx.fillStyle = 'rgba(139, 148, 158, 0.05)';
    ctx.fillRect(pad.left, pad.top, histWidth, gh);
    ctx.fillStyle = 'rgba(68, 221, 170, 0.05)';
    ctx.fillRect(pad.left + histWidth, pad.top, gw - histWidth, gh);

    // Divider line at 2021→2022
    ctx.strokeStyle = 'rgba(68, 221, 170, 0.3)';
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(pad.left + histWidth, pad.top);
    ctx.lineTo(pad.left + histWidth, pad.top + gh);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw historical line
    ctx.strokeStyle = '#8b949e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const monthIdx = (d.year - TIMELINE_START) * 12 + (d.month - 1);
        const x = pad.left + (monthIdx / totalMonths) * gw;
        const y = pad.top + gh - (d.water_pct / maxPct) * gh;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under the historical line
    if (data.length > 0) {
        const lastD = data[data.length - 1];
        const lastMonthIdx = (lastD.year - TIMELINE_START) * 12 + (lastD.month - 1);
        const lastX = pad.left + (lastMonthIdx / totalMonths) * gw;
        ctx.lineTo(lastX, pad.top + gh);
        const firstD = data[0];
        const firstMonthIdx = (firstD.year - TIMELINE_START) * 12 + (firstD.month - 1);
        const firstX = pad.left + (firstMonthIdx / totalMonths) * gw;
        ctx.lineTo(firstX, pad.top + gh);
        ctx.closePath();
        ctx.fillStyle = 'rgba(139, 148, 158, 0.1)';
        ctx.fill();
    }

    // Compute monthly averages from last 5 years for projections
    const recentYears = data.filter(d => d.year >= HISTORICAL_END - 4);
    const monthlyAvg = new Array(12).fill(0);
    const monthlyCnt = new Array(12).fill(0);
    for (const d of recentYears) {
        monthlyAvg[d.month - 1] += d.water_pct;
        monthlyCnt[d.month - 1]++;
    }
    for (let i = 0; i < 12; i++) {
        if (monthlyCnt[i] > 0) monthlyAvg[i] /= monthlyCnt[i];
    }

    // Draw BOTH projected scenario lines
    const scenarioDefs = [
        { key: 'cooperative', mult: 1.15, color: '#44ddaa', fillColor: 'rgba(68, 221, 170, 0.08)' },
        { key: 'decline', mult: 0.7, color: '#ee6644', fillColor: 'rgba(238, 102, 68, 0.08)' },
    ];

    for (const sc of scenarioDefs) {
        const isActive = activeScenario === sc.key;
        ctx.strokeStyle = sc.color;
        ctx.lineWidth = isActive ? 1.5 : 0.8;
        ctx.globalAlpha = isActive ? 1.0 : 0.4;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        let projStarted = false;
        const fillPoints = [];
        for (let y = HISTORICAL_END + 1; y <= TIMELINE_END; y++) {
            const yearsOut = y - HISTORICAL_END;
            const maxYrs = TIMELINE_END - HISTORICAL_END;
            const t = yearsOut / maxYrs;
            const mult = 1.0 + (sc.mult - 1.0) * t;
            for (let m = 0; m < 12; m++) {
                const val = monthlyAvg[m] * mult;
                const monthIdx = (y - TIMELINE_START) * 12 + m;
                const x = pad.left + (monthIdx / totalMonths) * gw;
                const yPos = pad.top + gh - (val / maxPct) * gh;
                fillPoints.push({ x, y: yPos });
                if (!projStarted) { ctx.moveTo(x, yPos); projStarted = true; }
                else ctx.lineTo(x, yPos);
            }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Fill under active scenario line
        if (isActive && fillPoints.length > 1) {
            ctx.beginPath();
            ctx.moveTo(fillPoints[0].x, fillPoints[0].y);
            for (let i = 1; i < fillPoints.length; i++) ctx.lineTo(fillPoints[i].x, fillPoints[i].y);
            ctx.lineTo(fillPoints[fillPoints.length - 1].x, pad.top + gh);
            ctx.lineTo(fillPoints[0].x, pad.top + gh);
            ctx.closePath();
            ctx.fillStyle = sc.fillColor;
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;
    }

    // Current position marker
    const curMonthIdx = (currentYear - TIMELINE_START) * 12 + (currentMonth - 1);
    const curX = pad.left + (curMonthIdx / totalMonths) * gw;
    ctx.strokeStyle = 'rgba(191, 202, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(curX, pad.top);
    ctx.lineTo(curX, pad.top + gh);
    ctx.stroke();

    // Small dot at current value
    let curVal = 0;
    if (currentYear <= HISTORICAL_END) {
        const match = data.find(d => d.year === currentYear && d.month === currentMonth);
        if (match) curVal = match.water_pct;
    } else {
        const sMult = activeScenario === 'decline' ? 0.7 : 1.15;
        const yOut = currentYear - HISTORICAL_END;
        const t2 = yOut / (TIMELINE_END - HISTORICAL_END);
        curVal = monthlyAvg[currentMonth - 1] * (1.0 + (sMult - 1.0) * t2);
    }
    const curY = pad.top + gh - (curVal / maxPct) * gh;
    const dotColor = currentYear > HISTORICAL_END
        ? (activeScenario === 'decline' ? '#ee6644' : '#44ddaa')
        : '#bfcaff';
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(curX, curY, 3, 0, Math.PI * 2);
    ctx.fill();

    // Value readout
    ctx.fillStyle = dotColor;
    ctx.font = '9px Roboto Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${curVal.toFixed(1)}%`, w - pad.right, pad.top + 10);

    // Axis labels
    ctx.fillStyle = 'rgba(139, 148, 158, 0.6)';
    ctx.font = '8px Roboto Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('2000', pad.left, h - 2);
    ctx.textAlign = 'center';
    ctx.fillText('2010', pad.left + (10 * 12 / totalMonths) * gw, h - 2);
    ctx.fillText('2020', pad.left + (20 * 12 / totalMonths) * gw, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText('2030', w - pad.right, h - 2);
}

async function updateDataPanels() {
    const stationId = SCENE_STATIONS[activeScene] || 'kratie';
    const data = await loadStationData(stationId);
    if (!data) {
        document.getElementById('wq-body').textContent = 'No data';
        document.getElementById('sed-body').textContent = 'No data';
        document.getElementById('fish-body').textContent = 'No data';
        return;
    }
    const month = currentMonth - 1; // 0-indexed
    renderWaterQuality(data, month, activeScenario);
    renderSediment(data, month, activeScenario);
    renderFisheries(data, month, activeScenario);
}

// Info popover toggle
const infoBtn = document.getElementById('info-btn');
const infoPopover = document.getElementById('info-popover');
infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    infoPopover.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
    if (!infoPopover.contains(e.target) && e.target !== infoBtn) {
        infoPopover.classList.add('hidden');
    }
});

// Scenario toggle
document.querySelectorAll('.scenario-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        activeScenario = btn.dataset.scenario;
        document.querySelectorAll('.scenario-btn').forEach(b => b.classList.toggle('active', b === btn));
        selectYear(currentYear);
    });
});

// Update panels when scene changes or season changes
const origLoadMainScene = loadMainScene;
// We'll call updateDataPanels after scene loads — hook it via a wrapper
// (loadMainScene is already defined, so we patch the call sites)

// ─── Dolphin transform controls ──────────────────────────────────────────────

const transformControls = new TransformControls(camera, canvas);
transformControls.setSize(0.8);
scene.add(transformControls.getHelper());

// Disable orbit when dragging transform gizmo
transformControls.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
});

let selectedDolphin = null;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Info panel (fixed bottom-right)
const infoPanel = document.createElement('div');
infoPanel.id = 'dolphin-info';
infoPanel.style.cssText = `
    position: fixed; bottom: 316px; right: 12px; z-index: 30;
    background: rgba(22,27,34,0.95); border: 1px solid #30363d;
    border-radius: 6px; padding: 10px 12px; font-family: var(--font-mono);
    font-size: 10px; color: #d0d0d0; display: none; min-width: 200px;
`;
document.body.appendChild(infoPanel);

function selectDolphin(group) {
    if (selectedDolphin === group) return;
    selectedDolphin = group;
    transformControls.attach(group);
    updateInfoPanel();
    infoPanel.style.display = 'block';
}

function deselectDolphin() {
    selectedDolphin = null;
    transformControls.detach();
    infoPanel.style.display = 'none';
}

function updateInfoPanel() {
    if (!selectedDolphin) return;
    const p = selectedDolphin.position;
    const r = selectedDolphin.rotation;
    const s = selectedDolphin.scale.x;
    infoPanel.innerHTML = `
        <div style="color:#bfcaff; margin-bottom:4px;">DOLPHIN ${selectedDolphin.userData.dolphinId}</div>
        <div>pos: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})</div>
        <div>rot: (${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)})</div>
        <div>scale: ${s.toFixed(2)}</div>
        <div style="margin-top:6px; display:flex; gap:4px; flex-wrap:wrap;">
            <button id="tf-translate" class="toggle-btn active" style="font-size:9px;">Move</button>
            <button id="tf-rotate" class="toggle-btn" style="font-size:9px;">Rotate</button>
            <button id="tf-scale" class="toggle-btn" style="font-size:9px;">Scale</button>
            <button id="tf-copy" class="toggle-btn" style="font-size:9px; color:#0f0;">Copy All</button>
            <button id="tf-deselect" class="toggle-btn" style="font-size:9px; color:#f66;">Deselect</button>
        </div>
    `;
    document.getElementById('tf-translate').onclick = () => { transformControls.setMode('translate'); setActiveBtn('tf-translate'); };
    document.getElementById('tf-rotate').onclick = () => { transformControls.setMode('rotate'); setActiveBtn('tf-rotate'); };
    document.getElementById('tf-scale').onclick = () => { transformControls.setMode('scale'); setActiveBtn('tf-scale'); };
    document.getElementById('tf-copy').onclick = copyAllDolphins;
    document.getElementById('tf-deselect').onclick = deselectDolphin;
}

function setActiveBtn(activeId) {
    ['tf-translate', 'tf-rotate', 'tf-scale'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', id === activeId);
    });
}

transformControls.addEventListener('objectChange', updateInfoPanel);

function copyAllDolphins() {
    const dolphins = [];
    mainSceneContent.traverse(child => {
        if (child.userData.isDolphin) {
            const p = child.position;
            const r = child.rotation;
            const s = child.scale.x;
            dolphins.push(`// dolphin ${child.userData.dolphinId}\nconst d = cloneDolphin();\nd.position.set(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)});\nd.rotation.set(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)});\n${s !== 1 ? `d.scale.setScalar(${s.toFixed(2)});\n` : ''}s.add(d);`);
        }
    });
    const text = dolphins.join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('tf-copy');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy All', 1500); }
    });
    console.log('Dolphin positions:\n' + text);
}

// Click to select dolphin
canvas.addEventListener('click', (e) => {
    // Skip if transform controls are active (dragging)
    if (transformControls.dragging) return;

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(mainSceneContent.children, true);

    for (const hit of hits) {
        // Walk up to find dolphin group
        let obj = hit.object;
        while (obj) {
            if (obj.userData.dolphinGroup) { selectDolphin(obj.userData.dolphinGroup); return; }
            if (obj.userData.isDolphin) { selectDolphin(obj); return; }
            obj = obj.parent;
        }
    }
    // Clicked nothing — deselect
    deselectDolphin();
}, false);

// Keyboard shortcuts: T=translate, R=rotate, S=scale, Escape=deselect
window.addEventListener('keydown', (e) => {
    if (!selectedDolphin) return;
    if (e.key === 't') { transformControls.setMode('translate'); setActiveBtn('tf-translate'); }
    if (e.key === 'r') { transformControls.setMode('rotate'); setActiveBtn('tf-rotate'); }
    if (e.key === 's') { transformControls.setMode('scale'); setActiveBtn('tf-scale'); }
    if (e.key === 'Escape') deselectDolphin();
});

// ─── Resize ──────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
    const { w, h } = canvasSize();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    resizeMinimap();
    resizePreviews();
});

// ─── Init ────────────────────────────────────────────────────────────────────

// Load everything, then set up the first scene
await loadTerrain();
addTerrainToMinimap();
loadMainScene(0);
loadWaterExtent();
selectYear(2020);
updateTimeline();

// Load additional layers in parallel (non-blocking)
Promise.all([
    loadWaterSurface(),
    loadStations(),
]).then(() => {
    console.log('All layers loaded');
    addWaterToMinimap();
});

// ─── Render loop ─────────────────────────────────────────────────────────────

function animate() {
    requestAnimationFrame(animate);
    controls.update();

    const t = performance.now() / 1000;

    // ─── Swim animation (Scene 2) ────────────────────────────────────────
    // Main scene
    if (activeScene === 1 && mainSceneContent.userData.swimAnim) {
        updateSwimAnimation(mainSceneContent, t, true);
    }
    // Always update dolphin POV camera + sonar for preview panel (even if scene 2 isn't active)
    if (activeScene !== 1 && previews[1] && previews[1].scene.userData.swimAnim) {
        const swim2 = previews[1].scene.userData.swimAnim;
        const t2 = (t / swim2.cycleDuration) % 1.0;
        const pos2 = swim2.path.getPointAt(t2);
        const tan2 = swim2.path.getTangentAt(t2);
        const povOff2 = tan2.clone().multiplyScalar(35);
        dolphinPOVCamera.position.set(pos2.x + povOff2.x, pos2.y + 8, pos2.z + povOff2.z);
        const look2 = pos2.clone().add(tan2.clone().multiplyScalar(500));
        look2.y = pos2.y;
        dolphinPOVCamera.lookAt(look2);
        dolphinPOVUnderwater = pos2.y < 0;

        // Update sonar state for preview echo visuals
        if (dolphinPOVUnderwater) {
            if (!swim2._prevEcho) {
                swim2._prevEcho = true;
                swim2._prevEchoStart = t;
            }
            sonarUniforms.pulseOrigin.value.set(pos2.x, pos2.y, pos2.z);
            sonarUniforms.echoActive.value = 1.0;
            const echoEl = t - swim2._prevEchoStart;
            sonarUniforms.time.value = echoEl % 6.0;
            // Animate sonar rings for preview
            sonarRingGroup.position.set(pos2.x, pos2.y, pos2.z);
            const pulseCycle = 3.0;
            for (let ri = 0; ri < SONAR_RING_COUNT; ri++) {
                const phase = ((echoEl / pulseCycle) + ri / SONAR_RING_COUNT) % 1.0;
                const radius = phase * 15000;
                sonarRings[ri].mesh.scale.set(radius, radius, radius);
                const fadeIn = Math.min(phase * 5.0, 1.0);
                const fadeOut = 1.0 - Math.pow(phase, 0.5);
                sonarRings[ri].mat.opacity = fadeIn * fadeOut * 0.6;
            }
        } else {
            swim2._prevEcho = false;
            sonarUniforms.echoActive.value = 0.0;
        }
    }
    // Preview panels (always animate for non-Scene2 previews)
    for (let pi = 0; pi < previews.length; pi++) {
        const pv = previews[pi];
        if (pi === 1) continue; // Scene 2 preview uses main scene + POV camera
        if (pv.scene.userData.swimAnim) {
            updateSwimAnimation(pv.scene, t, false);
        }
    }

    // ─── Echo transition (smooth lerp for water/background) ──────────────
    updateEchoTransition();

    // ─── Cargo noise emission rings (always animate) ─────────────────────
    corridorHazardsGroup.traverse(child => {
        if (child.userData.noiseRings) {
            const rings = child.userData.noiseRings;
            const scale = child.userData.noiseScale || 60;
            const maxRadius = scale * 8;
            const pulseCycle = 2.0;
            for (let ri = 0; ri < rings.length; ri++) {
                const phase = ((t / pulseCycle) + ri / rings.length) % 1.0;
                const radius = phase * maxRadius;
                rings[ri].mesh.scale.set(radius, radius, radius);
                const fadeIn = Math.min(phase * 4.0, 1.0);
                const fadeOut = 1.0 - phase;
                rings[ri].mat.opacity = fadeIn * fadeOut * 0.4;
            }
        }
    });

    // ─── Data transfer particles ────────────────────────────────────────
    if (mainSceneContent.userData.dataTransfer) {
        updateDataTransfer(mainSceneContent.userData.dataTransfer, t);
    }
    if (mainSceneContent.userData.boatTransfers) {
        for (const bt of mainSceneContent.userData.boatTransfers) {
            updateDataTransfer(bt, t);
        }
    }
    for (const pv of previews) {
        if (pv.scene.userData.dataTransfer) {
            updateDataTransfer(pv.scene.userData.dataTransfer, t);
        }
        if (pv.scene.userData.boatTransfers) {
            for (const bt of pv.scene.userData.boatTransfers) {
                updateDataTransfer(bt, t);
            }
        }
    }

    // ─── Scene 3: Karma glow + confluence panels ─────────────────────────
    if (activeScene === 2) {
        const karma = updateKarmaGlow(mainSceneContent, t);
        if (!mainSceneContent.userData._confluenceFrame) mainSceneContent.userData._confluenceFrame = 0;
        if (++mainSceneContent.userData._confluenceFrame % 30 === 0) {
            renderConfluencePanels(karma || 0);
        }
    }
    // Scene 4: Homecoming panels + golden shimmer + water shader
    if (activeScene === 3) {
        if (!mainSceneContent.userData._homeFrame) mainSceneContent.userData._homeFrame = 0;
        if (++mainSceneContent.userData._homeFrame % 60 === 0) {
            renderHomecomingPanels();
        }
        // Animate golden water shader
        mainSceneContent.traverse(c => {
            if (c.userData.goldenWater && c.material.uniforms) {
                c.material.uniforms.uTime.value = t;
            }
        });
        // Animate golden shimmer particles
        const shimmer = mainSceneContent.userData.goldenShimmer;
        if (shimmer) {
            const { phases, center } = shimmer.userData.shimmer;
            const pos = shimmer.geometry.attributes.position.array;
            for (let i = 0; i < phases.length; i++) {
                const p = phases[i];
                const angle = t * 0.3 + p * Math.PI * 2;
                const radius = 1.2 + Math.sin(t * 0.7 + p * 10) * 0.5;
                pos[i * 3] = center.x + Math.cos(angle) * radius * (1 + Math.sin(p * 20) * 0.5);
                pos[i * 3 + 1] = center.y + (Math.sin(t * 1.5 + p * 8) * 0.5 + 0.5) * 1.2;
                pos[i * 3 + 2] = center.z + Math.sin(angle) * radius * (1 + Math.cos(p * 15) * 0.5);
            }
            shimmer.geometry.attributes.position.needsUpdate = true;
            shimmer.material.opacity = 0.4 + 0.3 * Math.sin(t * 2);
        }
    }
    // Also animate golden water + shimmer in Scene 4 preview
    for (const pv of previews) {
        if (pv.scene.userData.goldenShimmer) {
            const shimmer = pv.scene.userData.goldenShimmer;
            const { phases, center } = shimmer.userData.shimmer;
            const pos = shimmer.geometry.attributes.position.array;
            for (let i = 0; i < phases.length; i++) {
                const p = phases[i];
                const angle = t * 0.3 + p * Math.PI * 2;
                const radius = 1.2 + Math.sin(t * 0.7 + p * 10) * 0.5;
                pos[i * 3] = center.x + Math.cos(angle) * radius * (1 + Math.sin(p * 20) * 0.5);
                pos[i * 3 + 1] = center.y + (Math.sin(t * 1.5 + p * 8) * 0.5 + 0.5) * 1.2;
                pos[i * 3 + 2] = center.z + Math.sin(angle) * radius * (1 + Math.cos(p * 15) * 0.5);
            }
            shimmer.geometry.attributes.position.needsUpdate = true;
            shimmer.material.opacity = 0.4 + 0.3 * Math.sin(t * 2);
            pv.scene.traverse(c => {
                if (c.userData.goldenWater && c.material.uniforms) {
                    c.material.uniforms.uTime.value = t;
                }
            });
        }
    }
    // Also animate karma glow in Scene 3 preview panel
    for (const pv of previews) {
        if (pv.scene.userData.karmaDolphin) {
            updateKarmaGlow(pv.scene, t);
        }
    }

    // ─── Render ──────────────────────────────────────────────────────────
    renderer.render(scene, camera);
    minimapRenderer.render(minimapScene, minimapCamera);

    for (let i = 0; i < previews.length; i++) {
        const pv = previews[i];
        if (i === 1 && terrainLoaded) {
            // Scene 2 preview: render main scene from dolphin's first-person POV
            const w = pv.canvas.clientWidth;
            const h = pv.canvas.clientHeight;
            if (w > 0 && h > 0) {
                dolphinPOVCamera.aspect = w / h;
                dolphinPOVCamera.updateProjectionMatrix();
            }
            // Save scene state, then temporarily enable echo visuals for preview
            const hazardsWereVisible = corridorHazardsGroup.visible;
            const ringsWereVisible = sonarRingGroup.visible;
            const prevBg = scene.background;
            const prevTerrainVis = terrainGroup.visible;
            const prevWaterVis = waterSurfaceGroup.visible;
            corridorHazardsGroup.visible = true;
            if (dolphinPOVUnderwater) {
                sonarRingGroup.visible = true;
                scene.background = null;
                terrainGroup.visible = false;
                waterSurfaceGroup.visible = false;
                pv.renderer.setClearColor(0x000204);
            } else {
                pv.renderer.setClearColor(0x0d1117);
            }
            pv.renderer.render(scene, dolphinPOVCamera);
            // Restore scene state
            corridorHazardsGroup.visible = hazardsWereVisible;
            sonarRingGroup.visible = ringsWereVisible;
            scene.background = prevBg;
            terrainGroup.visible = prevTerrainVis;
            waterSurfaceGroup.visible = prevWaterVis;
        } else {
            pv.renderer.render(pv.scene, pv.camera);
        }
    }
}
animate();
