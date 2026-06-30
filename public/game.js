// ==================== COZYSTUDY 3D ENGINE ====================
import * as THREE from 'three';
import { GLTFLoader }       from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';

const MODEL_URL = '/models/character.glb';
const SPEED     = 4.5;
const SYNC_MS   = 50;
const H         = 4.0; // ceiling height

// Scene globals
let scene, camera, renderer, clock;
let playerGroup, playerMixer, idleAction, walkAction;
let isWalking = false;
let _isSitting = false, _sitYTarget = 0;
let _boxChar = null, _walkPhase = 0;
let candlePointLight, flameMesh, _flickerT = 0;
let _sitHintEl = null;
let composer;

const keys         = {};
const sitPoints    = []; // { pos:Vector3, ry:number }
const otherPlayers = {};
const loader       = new GLTFLoader();
let _socket, _roomId, _user;

// ==================== PUBLIC API ====================

export async function startGame(socket, roomId, user) {
  _socket = socket; _roomId = roomId; _user = user;
  try {
    _initRenderer();
    await _buildScene();
    await _spawnPlayer();
    _setupInput();
    _createSitHint();
    _startSync();
    renderer.setAnimationLoop(_tick);
    console.log('✅ CozyStudy 3D iniciado');
  } catch (e) {
    console.error('❌ Error iniciando Three.js:', e);
    throw e;
  }
}

export async function addOtherPlayer(user) {
  if (otherPlayers[user.id]) return;
  const group = new THREE.Group();
  const p = user.pos || { x: -5, z: -4, ry: 0 };
  group.position.set(p.x, 0, p.z);
  group.rotation.y = p.ry || 0;
  let mixer = null;
  try {
    const gltf = await loader.loadAsync(MODEL_URL);
    const model = gltf.scene; _prepModel(model); group.add(model);
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      const idleClip = _findAnim(gltf.animations, ['idle','stand','breath','bind','mixamo']);
      if (idleClip) mixer.clipAction(idleClip).play();
    }
  } catch { group.add(_buildBoxChar(user.character || {})); }
  group.add(_nameSprite(user.name, user.character?.outfit));
  scene.add(group);
  otherPlayers[user.id] = { group, mixer,
    targetPos: new THREE.Vector3(p.x, 0, p.z), targetRy: p.ry || 0 };
}

export function removeOtherPlayer(id) {
  if (!otherPlayers[id]) return;
  scene.remove(otherPlayers[id].group);
  delete otherPlayers[id];
}

export function moveOtherPlayer(id, x, z, ry) {
  const p = otherPlayers[id]; if (!p) return;
  p.targetPos.set(x, 0, z); p.targetRy = ry;
}

// ==================== RENDERER ====================

function _initRenderer() {
  const canvas = document.getElementById('game-canvas');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb); // sky blue like Sims outdoor
  scene.fog = new THREE.Fog(0x87ceeb, 40, 70);

  camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 80);
  camera.position.set(-5, 10, 4);
  camera.lookAt(-5, 0, -4);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  clock = new THREE.Clock();

  // Post-processing pipeline (bloom for cinematic glow)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.12, 0.7, 0.90);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  });
}

// ==================== LIGHTING ====================

function _buildLights() {
  scene.add(new THREE.AmbientLight(0xfff4e8, 2.0));

  // Living room ceiling
  const lv = new THREE.PointLight(0xffe8cc, 3.2, 14, 1.2);
  lv.position.set(-5, 3.6, -4.5); lv.castShadow = true;
  lv.shadow.mapSize.set(512, 512); scene.add(lv);

  // Dining room ceiling
  const dn = new THREE.PointLight(0xfff0dd, 3.0, 12, 1.2);
  dn.position.set(5, 3.6, -4.5); scene.add(dn);

  // Study desk lamp
  const st = new THREE.PointLight(0xffddaa, 3.2, 11, 1.2);
  st.position.set(-5, 2.5, 7); scene.add(st);

  // Bathroom
  const bt = new THREE.PointLight(0xe8f5ff, 2.5, 10, 1.2);
  bt.position.set(5, 3.6, 4.5); scene.add(bt);

  // Candle flicker
  candlePointLight = new THREE.PointLight(0xff9933, 1.4, 4.5, 2);
  candlePointLight.position.set(-7, 0.9, -2.5); scene.add(candlePointLight);

  // Moon through window
  const moon = new THREE.DirectionalLight(0x8899bb, 0.7);
  moon.position.set(-12, 8, -8); scene.add(moon);

  // Floor lamp glow
  const fl = new THREE.PointLight(0xffe0aa, 1.8, 5.5, 1.5);
  fl.position.set(-8.5, 2.0, -8); scene.add(fl);
}

// ==================== HOUSE ====================

// Room model path — user places their downloaded GLB here
const ROOM_URL = '/models/room.glb';

async function _buildScene() {
  _buildLights();
  const loaded = await _tryLoadRoom();
  if (!loaded) _buildHouse();
}

async function _tryLoadRoom() {
  try {
    const gltf = await loader.loadAsync(ROOM_URL);
    const room = gltf.scene;

    // Auto-scale: fit the model to ~22 units
    const box = new THREE.Box3().setFromObject(room);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.z);
    const scale = 22 / maxDim;
    room.scale.setScalar(scale);

    // Re-compute after scaling and seat floor at y=0
    box.setFromObject(room);
    room.position.y = -box.min.y;

    room.traverse(c => {
      if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
    });
    scene.add(room);

    // Generic sit / exploration points scattered inside the room
    [[-4,-3],[-4,1],[0,0],[4,-3],[4,1],[0,4]].forEach(([x,z]) =>
      sitPoints.push({ pos: new THREE.Vector3(x, 0, z), ry: 0 })
    );

    // Candle flicker light (always present)
    candlePointLight = new THREE.PointLight(0xff9933, 1.4, 5, 2);
    candlePointLight.position.set(-3, 1.0, -2); scene.add(candlePointLight);

    const box2 = new THREE.Box3().setFromObject(room);
    const rSize = box2.getSize(new THREE.Vector3());
    console.log(`✅ Sala cargada — tamaño final: ${rSize.x.toFixed(1)} × ${rSize.z.toFixed(1)} u`);
    return true;
  } catch {
    console.info('📦 room.glb no encontrado — generando sala procedural');
    return false;
  }
}

function _buildHouse() {
  // Open loft — no exterior or interior walls, much more spacious
  const FW = 30, FD = 24, hw = 15, hd = 12;

  // Main floor — warm golden oak wood
  const floorM = mat(0xd0a068, 0.68);
  addPlane(FW, FD, floorM, 0, 0, 0, -Math.PI / 2, 0);

  // Wood plank lines (subtle grain)
  const plankM = mat(0xb88848, 0.82);
  for (let x = -hw + 0.7; x < hw; x += 0.9)
    addBox(0.032, 0.001, FD, x, 0.001, 0, plankM);

  // Floor border — very thin dark edge, no walls
  const edgeM = mat(0x140e04, 0.95);
  addBox(FW + 0.3, 0.055, 0.13, 0, 0.027, -hd, edgeM);
  addBox(FW + 0.3, 0.055, 0.13, 0, 0.027,  hd, edgeM);
  addBox(0.13, 0.055, FD, -hw, 0.027, 0, edgeM);
  addBox(0.13, 0.055, FD,  hw, 0.027, 0, edgeM);

  // Bathroom tile area (bottom-right) — different floor = subtle room definition
  addPlane(8, 7, mat(0xe6eded, 0.07, 0.06), 8, 0.003, 7.5, -Math.PI / 2, 0);

  // Glass privacy screen for bathroom (transparent, decorative)
  const glassM = new THREE.MeshStandardMaterial({
    color: 0x88aacc, roughness: 0.05, metalness: 0.1,
    transparent: true, opacity: 0.28
  });
  addBox(0.06, 2.0, 7, 4.1, 1.0, 7.5, glassM);
  addBox(7.7, 2.0, 0.06, 7.95, 1.0, 4.1, glassM);
  // Glass frame
  const frameM = mat(0x888888, 0.2, 0.9);
  addBox(0.04, 2.02, 7, 4.1, 1.01, 7.5, frameM);
  addBox(7.7, 2.02, 0.04, 7.95, 1.01, 4.1, frameM);

  // Zone rugs — define living areas without walls
  _addRoundRug(-8,  -5.5, 3.0, 0xcfb060); // living room (warm gold)
  _addRoundRug( 1,  -7.5, 2.4, 0xddd5a8); // dining (cream)
  _addRoundRug(-8,   6.0, 2.6, 0x7a8eaa); // bedroom (soft blue)
  _addRoundRug( 8,   1.0, 2.2, 0xaa9878); // study (warm beige)

  // Decorative elements along the edges (replace windows)
  _buildEdgePlants();

  _buildLivingRoom();
  _buildDiningRoom();
  _buildKitchen();
  _buildStudy();
  _buildBedroom();
  _buildBathroom();
}

function _addRoundRug(x, z, radius, color) {
  const rug = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), mat(color, 0.90));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(x, 0.003, z);
  rug.receiveShadow = true;
  scene.add(rug);
}

function _buildEdgePlants() {
  // Perimeter plants & decor that create a natural boundary instead of walls
  const spots = [
    [-14, -11], [-14, -6], [-14, -1], [-14, 4], [-14, 9],
    [ 14, -10], [ 14, -5], [ 14,  0], [ 14,  5], [ 14, 10],
    [-8,  -11], [ 0, -11], [  6, -11], [ 12, -11],
    [-10,  11], [-4,  11], [  2,  11],
  ];
  const sizes = [1.1, 0.85, 1.2, 0.9, 1.05, 0.8, 1.3, 0.95, 1.0, 0.88, 1.15, 0.92, 1.25];
  spots.forEach(([x, z], i) => _buildPlant(x, 0, z, sizes[i % sizes.length]));
}

function _buildWindow(x, y, z, isLeftWall) {
  const frameM = mat(0x5a4880, 0.4, 0.3);
  const glassM = new THREE.MeshStandardMaterial({
    color: 0x1a2866, roughness: 0, metalness: 0.2, transparent: true, opacity: 0.48 });

  if (isLeftWall) {
    addBox(0.18, 2.6, 2.2, x, y, z, frameM);
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.2), glassM);
    gl.rotation.y = Math.PI/2; gl.position.set(x+0.1, y, z); scene.add(gl);
    addBox(0.2, 0.06, 2.2, x, y, z, frameM);
    addBox(0.2, 2.6, 0.06, x, y, z, frameM);
  } else {
    addBox(2.2, 2.6, 0.18, x, y, z, frameM);
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.2), glassM);
    gl.position.set(x, y, z+0.1); scene.add(gl);
    addBox(2.2, 0.06, 0.2, x, y, z, frameM);
    addBox(0.06, 2.6, 0.2, x, y, z, frameM);
  }
  // Moon + stars
  const moonM = new THREE.MeshStandardMaterial({ emissive: 0xaabbee, emissiveIntensity: 1, color: 0x6688cc });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 12), moonM);
  moon.position.set(isLeftWall ? x-0.6 : x+0.5, y+0.5, isLeftWall ? z : z-0.6);
  scene.add(moon);
  const sg = new THREE.BufferGeometry();
  const sp = [];
  for (let i = 0; i < 60; i++) sp.push((Math.random()-0.5)*2.4,(Math.random()-0.5)*2.4,(Math.random()-0.5)*0.4);
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.035 }));
  stars.position.set(isLeftWall ? x-0.3 : x, y, isLeftWall ? z : z-0.3);
  scene.add(stars);
}

// ==================== LIVING ROOM ====================

function _buildLivingRoom() {
  // Sofa along back wall (z≈-7.8), facing +z into room
  _buildCouch(-5.5, 0, -7.8, 0);

  // Coffee table
  addBox(1.6, 0.06, 0.75, -5.5, 0.36, -6.2, mat(0x3d2a10, 0.65));
  _buildCandle(-5.0, 0.36, -6.2);
  _buildCandle(-6.2, 0.36, -6.2);

  // TV on left wall
  addBox(0.08, 1.15, 1.9, -9.82, 1.75, -4.8, mat(0x111111, 0.3, 0.7));
  const scrM = new THREE.MeshStandardMaterial({ color: 0x0a1835, emissive: 0x0a1835, emissiveIntensity: 0.5, roughness: 0 });
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.78, 1.02), scrM);
  scr.rotation.y = Math.PI/2; scr.position.set(-9.74, 1.75, -4.8); scene.add(scr);
  addBox(0.35, 0.75, 0.55, -9.65, 0.375, -4.8, mat(0x1e1e1e, 0.5, 0.5));

  // Side table + lamp
  addBox(0.5, 0.45, 0.45, -9.55, 0.225, -2.2, mat(0x4a2c10, 0.8));
  const sLampSh = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.22, 10, 1, true), mat(0xf5e8d0, 0.6));
  sLampSh.position.set(-9.55, 0.72, -2.2); scene.add(sLampSh);
  const sLampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.02,0.28,6), mat(0x888888,0.3,0.8));
  sLampPole.position.set(-9.55, 0.59, -2.2); scene.add(sLampPole);

  _buildFloorLamp(-8.5, 0, -8.2);
  _buildPlant(-8.8, 0, -1.2, 1.1);
  _buildPlant(-1.8, 0, -8.5, 0.9);

  // Throw pillows on sofa
  addBox(0.32, 0.18, 0.3, -3.9, 0.71, -7.5, mat(0xc07840, 0.9));
  addBox(0.32, 0.18, 0.3, -7.1, 0.71, -7.5, mat(0x4070c0, 0.9));
}

// ==================== DINING ROOM ====================

function _buildDiningRoom() {
  // Round dining table — like in the reference image
  const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.09, 36), mat(0x7a5530, 0.52));
  tableTop.position.set(5, 0.9, -4.5); tableTop.castShadow = true; tableTop.receiveShadow = true; scene.add(tableTop);
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 0.85, 14), mat(0x3a2008, 0.85));
  pedestal.position.set(5, 0.45, -4.5); pedestal.castShadow = true; scene.add(pedestal);

  // 4 chairs with sit points
  const cs = [
    { x: 5,    z: -6.5, ry: 0 },
    { x: 5,    z: -2.5, ry: Math.PI },
    { x: 3.0,  z: -4.5, ry: Math.PI/2 },
    { x: 7.0,  z: -4.5, ry: -Math.PI/2 },
  ];
  cs.forEach(({ x, z, ry }) => {
    _buildChair(x, 0, z, ry);
    sitPoints.push({ pos: new THREE.Vector3(x, 0, z), ry });
  });

  // Pendant lamp above table
  addBox(0.07, 0.07, 0.07, 5, 2.0, -4.5, mat(0xffcc44, 0.1, 0.9));
  addBox(0.01, 1.6, 0.01, 5, 3.2, -4.5, mat(0x111111, 0.9));

  // Sideboard
  addBox(0.2, 0.9, 2.0, 9.7, 0.45, -5, mat(0x5a3e20, 0.7));
  addBox(0.22, 0.05, 2.0, 9.7, 0.92, -5, mat(0x4a2c10, 0.65));
  _buildPlant(9.6, 0.92, -4.2, 0.7);

  // Vase on sideboard
  const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.04, 0.2, 10), mat(0x8855aa, 0.25, 0.3));
  vase.position.set(9.6, 1.04, -5.8); scene.add(vase);

  _buildPlant(8.8, 0, -8.5, 1.0);
  _buildPlant(1.5, 0, -8.5, 0.85);
}

// ==================== STUDY ====================

function _buildStudy() {
  // Desk against back wall
  addBox(2.4, 0.09, 0.88, -5, 0.82, 7.9, mat(0x6b4c28, 0.62));
  for (const [dx, dz] of [[-1.1,-0.38],[1.1,-0.38],[-1.1,0.38],[1.1,0.38]])
    addBox(0.07, 0.82, 0.07, -5+dx, 0.41, 7.9+dz, mat(0x3a2008, 0.85));

  // Laptop
  addBox(0.7, 0.025, 0.5, -5, 0.878, 7.8, mat(0x111111, 0.25, 0.75));
  const scrM = new THREE.MeshStandardMaterial({ color: 0x1a3060, emissive: 0x112244, emissiveIntensity: 0.9, roughness: 0 });
  const scr = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.44, 0.02), scrM);
  scr.position.set(-5, 0.875+0.24, 7.8-0.25); scr.rotation.x = -0.22; scene.add(scr);

  // Desk chair
  _buildChair(-5, 0, 7.05, 0);
  sitPoints.push({ pos: new THREE.Vector3(-5, 0, 7.05), ry: 0 });

  // Desk lamp
  addBox(0.04, 0.52, 0.04, -3.6, 1.08, 7.8, mat(0x888888, 0.3, 0.8));
  addBox(0.28, 0.065, 0.14, -3.5, 1.36, 7.8, mat(0x888888, 0.3, 0.8));
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8),
    new THREE.MeshStandardMaterial({ emissive: 0xffe880, emissiveIntensity: 6, color: 0xffffff }));
  bulb.position.set(-3.5, 1.31, 7.8); scene.add(bulb);

  // Mug
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.048, 0.11, 10), mat(0xcc4444, 0.7));
  mug.position.set(-6, 0.882, 7.8); scene.add(mug);

  // Bookshelf on left wall
  _buildShelf(-9.4, 0, 4.5);

  // Bed
  _buildBed(-2.2, 0, 5);
  sitPoints.push({ pos: new THREE.Vector3(-2.5, 0, 5), ry: Math.PI/2 });

  // Nightstand
  addBox(0.48, 0.44, 0.44, -0.65, 0.22, 4, mat(0x4a2c10, 0.8));
  const nsShade = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.18, 8, 1, true), mat(0xf5e8d0, 0.6));
  nsShade.position.set(-0.65, 0.57, 4); scene.add(nsShade);
  const nsGlow = new THREE.PointLight(0xffe8aa, 1.2, 3, 2);
  nsGlow.position.set(-0.65, 0.65, 4); scene.add(nsGlow);

  _buildPlant(-8.8, 0, 8.2, 1.0);
  _buildPlant(-0.5, 0, 8.5, 0.85);
  _buildPlant(-0.5, 0, 0.5, 0.9);
}

// ==================== BATHROOM ====================

function _buildBathroom() {
  // Toilet + sit point
  _buildToilet(8.5, 0, 7.5);
  sitPoints.push({ pos: new THREE.Vector3(8.5, 0, 7.3), ry: Math.PI });

  // Bathtub
  _buildBathtub(9.0, 0, 2.5);

  // Sink
  _buildSink(1.6, 0, 7.8);

  // Mirror above sink
  const mirrorM = new THREE.MeshStandardMaterial({ color: 0xddeef0, roughness: 0, metalness: 0.9 });
  const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.95, 0.04), mirrorM);
  mirror.position.set(1.6, 1.9, 8.76); scene.add(mirror);

  // Bath mat
  addPlane(1.3, 0.95, mat(0xeeeeff, 0.9), 1.6, 0.004, 7.1, -Math.PI/2, 0);

  // Towel rack
  const trM = mat(0x999999, 0.15, 0.9);
  addBox(0.02, 0.04, 0.55, 0.35, 1.3, 5.5, trM);
  addBox(0.02, 0.55, 0.02, 0.35, 1.02, 5.22, trM);
  addBox(0.02, 0.55, 0.02, 0.35, 1.02, 5.78, trM);
  addBox(0.045, 0.48, 0.5, 0.35, 1.3, 5.5, mat(0x8899ee, 0.9)); // towel

  _buildPlant(1.2, 0, 0.4, 0.7);
}

// ==================== KITCHEN ====================

function _buildKitchen() {
  // Kitchen island counter (right side, back)
  addBox(2.8, 0.92, 1.1, 8, 0.46, -8.5, mat(0xf0ece4, 0.4, 0.05));
  addBox(2.9, 0.05, 1.2, 8, 0.94, -8.5, mat(0xd4c8a8, 0.25, 0.1));

  // Bar stools around island
  for (const dx of [-0.85, 0, 0.85])
    _buildChair(8 + dx, 0, -7.2, 0);

  // Overhead pendant for island
  addBox(0.045, 0.045, 0.045, 8, 2.2, -8.5, mat(0xffee88, 0.1, 0.9));
  addBox(0.01, 1.5, 0.01, 8, 3.3, -8.5, mat(0x111111, 0.9));
  scene.add(Object.assign(new THREE.PointLight(0xfff0cc, 2.8, 6, 1.5), { position: new THREE.Vector3(8, 2.2, -8.5) }));

  // Back counter against edge
  addBox(4.0, 0.88, 0.5, 10, 0.44, -10.8, mat(0x6b4c28, 0.7));
  addBox(4.0, 0.04, 0.52, 10, 0.9, -10.8, mat(0xeeeeee, 0.1, 0.05));

  // Small shelf
  addBox(2.5, 0.04, 0.28, 8, 1.8, -10.7, mat(0x8b6030, 0.7));
  addBox(2.5, 0.04, 0.28, 8, 2.3, -10.7, mat(0x8b6030, 0.7));

  // Plants on back counter top
  _buildPlant(9.2, 0.9, -10.7, 0.55);
  _buildPlant(11.2, 0, -9.5, 1.0);
  _buildPlant(5.8, 0, -10.5, 0.88);
}

// ==================== BEDROOM ====================

function _buildBedroom() {
  // Bed (left side, positive z zone)
  _buildBed(-8, 0, 6.5);
  sitPoints.push({ pos: new THREE.Vector3(-8.5, 0, 6.5), ry: Math.PI / 2 });

  // Nightstand
  addBox(0.48, 0.44, 0.44, -5.8, 0.22, 5.8, mat(0x4a2c10, 0.8));
  const nsShade = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.18, 8, 1, true), mat(0xf5e8d0, 0.6));
  nsShade.position.set(-5.8, 0.57, 5.8); scene.add(nsShade);
  const nsGlow = new THREE.PointLight(0xffe8aa, 1.0, 3, 2);
  nsGlow.position.set(-5.8, 0.65, 5.8); scene.add(nsGlow);

  // Dresser / wardrobe
  addBox(0.5, 1.8, 1.4, -13.2, 0.9, 7.5, mat(0x6b4c28, 0.65));
  addBox(0.52, 1.82, 1.42, -13.2, 0.91, 7.5, mat(0x3a2008, 0.9, 0.0));

  _buildPlant(-12, 0, 9.5, 1.2);
  _buildPlant(-5.5, 0, 9.5, 0.85);
}

// ==================== FURNITURE ====================

function _buildCouch(x, y, z, ry) {
  const g = new THREE.Group();
  const baseM = mat(0xe8734a, 0.80);  // warm orange sofa (Sims-style)
  const darkM = mat(0xc05a35, 0.85);
  const cushM = mat(0xf0956a, 0.75);

  // Base + back + arms
  const base = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.55, 1.0), baseM);
  base.position.y = 0.275; g.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.65, 0.24), darkM);
  back.position.set(0, 0.77, -0.4); g.add(back);
  for (const ax of [-1.7, 1.7]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 1.0), darkM);
    arm.position.set(ax, 0.675, 0); g.add(arm);
  }
  // Seat cushions
  for (let i = 0; i < 3; i++) {
    const cu = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.16, 0.78), cushM);
    cu.position.set(-1.04 + i * 1.04, 0.63, 0.06); g.add(cu);
  }

  // Register sit points (3 sofa seats)
  const ryRad = ry;
  const cos = Math.cos(ryRad), sin = Math.sin(ryRad);
  for (const ox of [-1, 0, 1]) {
    const wx = x + ox * 1.04 * cos;
    const wz = z + ox * 1.04 * (-sin); // rotate offset
    sitPoints.push({ pos: new THREE.Vector3(x + ox*1.04*Math.cos(0), y, z + 0.2), ry: ryRad });
  }

  g.position.set(x, y, z); g.rotation.y = ry;
  g.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  scene.add(g);
}

function _buildChair(x, y, z, ry) {
  const g = new THREE.Group();
  const sM = mat(0x4a88d0, 0.78);  // Sims-style teal/blue chair
  const lM = mat(0xd4a860, 0.85); // golden wood legs

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.09, 0.52), sM);
  seat.position.y = 0.48; g.add(seat);
  const cush = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.07, 0.48), mat(0x6ab8f0, 0.75));
  cush.position.y = 0.535; g.add(cush);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.09), sM);
  back.position.set(0, 0.79, -0.22); g.add(back);
  for (const [lx, lz] of [[-0.2,-0.2],[0.2,-0.2],[-0.2,0.2],[0.2,0.2]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.48, 6), lM);
    leg.position.set(lx, 0.24, lz); g.add(leg);
  }

  g.position.set(x, y, z); g.rotation.y = ry;
  g.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  scene.add(g);
}

function _buildBed(x, y, z) {
  const g = new THREE.Group();
  const fM = mat(0x4a2c10, 0.8);
  const maM = mat(0xddd0e8, 0.88);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.28, 2.2), fM);
  frame.position.y = 0.14; g.add(frame);
  const hb = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.7, 0.11), fM);
  hb.position.set(0, 0.49, -1.07); g.add(hb);
  const ft = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.28, 0.1), fM);
  ft.position.set(0, 0.28, 1.07); g.add(ft);
  const matt = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.17, 2.0), maM);
  matt.position.y = 0.375; g.add(matt);
  const blank = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.1, 1.28), mat(0x48a870, 0.82));
  blank.position.set(0, 0.51, 0.32); g.add(blank);
  const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.09, 0.36), mat(0xfff8ff, 0.82));
  pillow.position.set(0, 0.51, -0.75); g.add(pillow);

  g.position.set(x, y, z); g.rotation.y = Math.PI/2;
  g.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  scene.add(g);
}

function _buildToilet(x, y, z) {
  const pM = mat(0xf2f2f2, 0.08, 0.1);
  const g = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.2), pM);
  tank.position.set(0, 0.72, -0.22); g.add(tank);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.17, 0.24, 10), pM);
  bowl.position.set(0, 0.34, 0); g.add(bowl);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 0.38), mat(0xe8e8e8, 0.25));
  seat.position.set(0, 0.48, 0.01); g.add(seat);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.17, 0.33), pM);
  base.position.set(0, 0.085, 0); g.add(base);
  g.position.set(x, y, z);
  g.traverse(c => { if (c.isMesh) c.castShadow = true; });
  scene.add(g);
}

function _buildSink(x, y, z) {
  const pM = mat(0xf5f5f5, 0.08, 0.1);
  const mM = mat(0xbbbbbb, 0.08, 0.9);
  const g = new THREE.Group();
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.84, 0.44), mat(0xddd0c0, 0.5));
  cab.position.set(0, 0.42, 0.2); g.add(cab);
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.13, 12), pM);
  basin.position.set(0, 0.9, 0.1); g.add(basin);
  const faucet = new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.02,0.13,6), mM);
  faucet.position.set(0, 1.0, -0.06); g.add(faucet);
  const spout = new THREE.Mesh(new THREE.BoxGeometry(0.11,0.02,0.025), mM);
  spout.position.set(0, 1.13, 0.01); g.add(spout);
  g.position.set(x, y, z); scene.add(g);
}

function _buildBathtub(x, y, z) {
  const tM = mat(0xf8f8f8, 0.08, 0.05);
  const g = new THREE.Group();
  const outer = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.54, 1.8), tM);
  outer.position.set(0, 0.27, 0); g.add(outer);
  const inner = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 1.6), mat(0xe0f4f8, 0.04, 0.1));
  inner.position.set(0, 0.44, 0); g.add(inner);
  const faucet = new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.025,0.13,6), mat(0xbbb,0.08,0.9));
  faucet.position.set(-0.3, 0.62, -0.8); g.add(faucet);
  g.position.set(x, y, z); g.rotation.y = Math.PI/2;
  g.traverse(c => { if (c.isMesh) c.castShadow = true; });
  scene.add(g);
}

function _buildShelf(x, y, z) {
  const wM = mat(0x4a2c00, 0.8);
  const g = new THREE.Group();
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.28, 3.8, 2.0), wM);
  back.position.y = 1.9; g.add(back);
  for (let i = 0; i < 4; i++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.05, 2.0), mat(0x3a1f00, 0.9));
    shelf.position.y = 0.4 + i*1.05; g.add(shelf);
  }
  const cols = [0x8B3A3A,0x2E5B32,0x4A1580,0xBF4810,0x0D479A,0x880E50,0x5D4037,0x00838F,0xC2185B,0x283593];
  for (let s = 0; s < 3; s++) {
    let bz = -0.88;
    for (let b = 0; b < 7; b++) {
      const bh = 0.27+Math.random()*0.24, bw = 0.09+Math.random()*0.06;
      const book = new THREE.Mesh(new THREE.BoxGeometry(0.17, bh, bw), mat(cols[(s*7+b)%cols.length], 0.9));
      book.position.set(0.02, 0.4+s*1.05+bh/2, bz+bw/2); g.add(book); bz += bw+0.01;
    }
  }
  _buildPlant(x+0.02, y+3.8, z-0.7, 0.75);
  g.position.set(x, y, z); g.rotation.y = Math.PI/2;
  g.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  scene.add(g);
}

function _buildCandle(x, y, z) {
  const wax = new THREE.Mesh(new THREE.CylinderGeometry(0.033,0.033,0.28,8), mat(0xf5edc0, 0.9));
  wax.position.set(x, y+0.14, z); scene.add(wax);
  flameMesh = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6),
    new THREE.MeshStandardMaterial({ emissive: 0xff8c00, emissiveIntensity: 4, color: 0xffcc44 }));
  flameMesh.position.set(x, y+0.31, z);
  flameMesh.userData.isFlame = true; scene.add(flameMesh);
}

function _buildFloorLamp(x, y, z) {
  addBox(0.05, 1.8, 0.05, x, y+0.9, z, mat(0x888888, 0.3, 0.8));
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.28, 12, 1, true), mat(0xf5e8d0, 0.65));
  shade.position.set(x, y+1.9, z); scene.add(shade);
}

function _buildPlant(x, y, z, s = 1.0) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.11,0.08,0.2,10), mat(0x8B5E3C,0.85));
  pot.position.y = 0.1; g.add(pot);
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.105,0.105,0.035,10), mat(0x3B2A1A,0.95));
  soil.position.y = 0.22; g.add(soil);
  for (let i = 0; i < 3; i++) {
    const a = (i/3)*Math.PI*2;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.16,7,5), mat(0x2E6B2E,0.78));
    leaf.position.set(Math.cos(a)*0.09, 0.5+i*0.11, Math.sin(a)*0.09);
    leaf.scale.set(0.8, 1.1, 0.8); g.add(leaf);
  }
  g.scale.setScalar(s); g.position.set(x, y, z);
  g.traverse(c => { if (c.isMesh) c.castShadow = true; });
  scene.add(g);
}

// ==================== CHARACTER ====================

export function buildBoxChar(char = {}) { return _buildBoxChar(char); }

function _buildBoxChar(char = {}) {
  const g = new THREE.Group();
  const skinC  = new THREE.Color(char.skin      || '#FDBCB4');
  const hairC  = new THREE.Color(char.hairColor  || '#1C0A00');
  const outfitC= new THREE.Color(char.outfit     || '#5C6BC0');

  function sm(c, rough = 0.72, metal = 0) {
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: rough, metalness: metal });
  }
  function part(geo, m, x=0, y=0, z=0, rz=0, rx=0) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    if (rz) mesh.rotation.z = rz;
    if (rx) mesh.rotation.x = rx;
    mesh.castShadow = true;
    g.add(mesh); return mesh;
  }

  const mSkin   = sm(skinC, 0.68);
  const mHair   = sm(hairC, 0.88);
  const mOutfit = sm(outfitC, 0.58, 0.08);
  const mPants  = sm(new THREE.Color(outfitC).lerp(new THREE.Color(0x111122), 0.55), 0.82);
  const mShoe   = sm(0x0d0d0d, 0.82);
  const mEye    = sm(0x050510, 0.15);
  const mWhite  = sm(0xffffff, 0.0);
  const mBrow   = sm(new THREE.Color(hairC).lerp(new THREE.Color(0x000000), 0.3), 0.9);

  // ── Shoes (rounded box) ──
  const shoeL = part(new THREE.BoxGeometry(0.15, 0.085, 0.28), mShoe, -0.095, 0.042, 0.02);
  const shoeR = part(new THREE.BoxGeometry(0.15, 0.085, 0.28), mShoe,  0.095, 0.042, 0.02);

  // ── Legs — pivot groups for walk animation ──
  const legPivotL = new THREE.Group(); legPivotL.position.set(-0.095, 0.60, 0); g.add(legPivotL);
  const legPivotR = new THREE.Group(); legPivotR.position.set( 0.095, 0.60, 0); g.add(legPivotR);
  const legMeshL = new THREE.Mesh(new THREE.CapsuleGeometry(0.076, 0.38, 4, 8), mPants);
  legMeshL.position.set(0, -0.19, 0); legMeshL.castShadow = true; legPivotL.add(legMeshL);
  const legMeshR = new THREE.Mesh(new THREE.CapsuleGeometry(0.076, 0.38, 4, 8), mPants);
  legMeshR.position.set(0, -0.19, 0); legMeshR.castShadow = true; legPivotR.add(legMeshR);

  // ── Torso — slightly tapered ──
  part(new THREE.CapsuleGeometry(0.148, 0.26, 4, 10), mOutfit, 0, 0.82, 0);

  // Belt line detail
  part(new THREE.CylinderGeometry(0.152, 0.152, 0.03, 14), sm(new THREE.Color(outfitC).lerp(new THREE.Color(0x000000), 0.4), 0.85), 0, 0.66, 0);

  // ── Arms — pivot groups for walk animation ──
  const armPivotL = new THREE.Group(); armPivotL.position.set(-0.228, 0.94, 0); g.add(armPivotL);
  const armPivotR = new THREE.Group(); armPivotR.position.set( 0.228, 0.94, 0); g.add(armPivotR);
  const armMeshL = new THREE.Mesh(new THREE.CapsuleGeometry(0.056, 0.28, 3, 8), mSkin);
  armMeshL.position.set(-0.03, -0.14, 0); armMeshL.rotation.z = 0.16; armMeshL.castShadow = true; armPivotL.add(armMeshL);
  const armMeshR = new THREE.Mesh(new THREE.CapsuleGeometry(0.056, 0.28, 3, 8), mSkin);
  armMeshR.position.set( 0.03, -0.14, 0); armMeshR.rotation.z = -0.16; armMeshR.castShadow = true; armPivotR.add(armMeshR);

  // Hands
  part(new THREE.SphereGeometry(0.058, 10, 8), mSkin, -0.264, 0.62, 0);
  part(new THREE.SphereGeometry(0.058, 10, 8), mSkin,  0.264, 0.62, 0);

  // ── Neck ──
  part(new THREE.CylinderGeometry(0.050, 0.062, 0.10, 10), mSkin, 0, 1.10, 0);

  // ── Head ──
  const head = part(new THREE.SphereGeometry(0.148, 18, 14), mSkin, 0, 1.285, 0);
  head.scale.set(1.06, 1.18, 1.02);

  // Ears
  part(new THREE.SphereGeometry(0.036, 8, 6), mSkin, -0.163, 1.278, 0.012);
  part(new THREE.SphereGeometry(0.036, 8, 6), mSkin,  0.163, 1.278, 0.012);

  // Eyes
  for (const ex of [-0.060, 0.060]) {
    part(new THREE.SphereGeometry(0.026, 10, 8), mEye, ex, 1.296, 0.136);
    part(new THREE.SphereGeometry(0.009, 5, 4), mWhite, ex+0.01, 1.305, 0.152);
  }

  // Eyebrows
  const browL = part(new THREE.BoxGeometry(0.044, 0.010, 0.008), mBrow, -0.060, 1.326, 0.136);
  browL.rotation.z =  0.12;
  const browR = part(new THREE.BoxGeometry(0.044, 0.010, 0.008), mBrow,  0.060, 1.326, 0.136);
  browR.rotation.z = -0.12;

  // Nose — bridge + tip
  part(new THREE.CylinderGeometry(0.011, 0.016, 0.046, 6), mSkin, 0, 1.258, 0.148);
  part(new THREE.SphereGeometry(0.018, 8, 6), mSkin, 0, 1.234, 0.155);

  // Mouth
  const mouthC = new THREE.Color(skinC).lerp(new THREE.Color(0x7a2525), 0.42);
  const mouth = part(new THREE.SphereGeometry(0.018, 8, 4), sm(mouthC, 1.0), 0, 1.206, 0.148);
  mouth.scale.set(2.2, 0.38, 0.5);

  // ── Hair ──
  const style = char.hairStyle || 'short';
  const cap = part(new THREE.SphereGeometry(0.158, 16, 12), mHair, 0, 1.378, -0.006);
  cap.scale.set(1.10, 0.50, 1.08);

  if (style === 'long') {
    part(new THREE.CapsuleGeometry(0.050, 0.46, 3, 6), mHair, -0.14, 1.10, -0.042);
    part(new THREE.CapsuleGeometry(0.050, 0.46, 3, 6), mHair,  0.14, 1.10, -0.042);
    part(new THREE.CapsuleGeometry(0.062, 0.36, 3, 6), mHair, 0, 1.09, -0.10);
  } else if (style === 'bun') {
    part(new THREE.SphereGeometry(0.092, 10, 8), mHair, 0, 1.545, -0.058);
    part(new THREE.SphereGeometry(0.056, 8, 6),  mHair, 0, 1.390, -0.14);
  } else if (style === 'curly') {
    const puff = part(new THREE.SphereGeometry(0.188, 12, 9), mHair, 0, 1.375, -0.012);
    puff.scale.set(1.1, 1.02, 1.0);
    part(new THREE.SphereGeometry(0.118, 9, 7), mHair, -0.168, 1.288, 0.010);
    part(new THREE.SphereGeometry(0.118, 9, 7), mHair,  0.168, 1.288, 0.010);
  }

  // ── Accessories ──
  const acc = char.accessory;
  if (acc === 'glasses') {
    const gM = sm(0x1a1a1a, 0.18, 0.95);
    for (const ex of [-0.060, 0.060]) {
      const lens = part(new THREE.TorusGeometry(0.044, 0.008, 6, 14), gM, ex, 1.296, 0.143);
      lens.rotation.x = Math.PI / 2;
    }
    part(new THREE.BoxGeometry(0.020, 0.006, 0.006), gM, 0, 1.296, 0.143);
  } else if (acc === 'hat') {
    const hM = sm(new THREE.Color(hairC).multiplyScalar(0.72), 0.88);
    part(new THREE.CylinderGeometry(0.265, 0.265, 0.030, 14), hM, 0, 1.462, 0);
    part(new THREE.CylinderGeometry(0.178, 0.192, 0.186, 14), hM, 0, 1.558, 0);
  } else if (acc === 'headphones') {
    const hM = sm(0x1a1a1a, 0.22, 0.88);
    part(new THREE.SphereGeometry(0.062, 10, 8), hM, -0.212, 1.282, 0);
    part(new THREE.SphereGeometry(0.062, 10, 8), hM,  0.212, 1.282, 0);
    const band = part(new THREE.TorusGeometry(0.216, 0.014, 6, 18, Math.PI), hM, 0, 1.310, 0);
    band.rotation.z = -Math.PI / 2;
  }

  // Store limb pivot groups for walk animation
  g.userData.walkParts = { legPivotL, legPivotR, armPivotL, armPivotR };
  return g;
}

// ==================== CHARACTER LOADING ====================

async function _spawnPlayer() {
  playerGroup = new THREE.Group();
  playerGroup.position.set(-5, 0, -4);

  try {
    const gltf = await loader.loadAsync(MODEL_URL);
    const model = gltf.scene; _prepModel(model); playerGroup.add(model);
    if (gltf.animations.length) {
      playerMixer = new THREE.AnimationMixer(model);
      const idleClip = _findAnim(gltf.animations, ['idle','stand','breath','bind','mixamo.com']);
      const walkClip = _findAnim(gltf.animations, ['walk','walking','run','jog']);
      if (idleClip) { idleAction = playerMixer.clipAction(idleClip); idleAction.play(); }
      if (walkClip) { walkAction = playerMixer.clipAction(walkClip); walkAction.weight = 0; walkAction.enabled = false; }
    }
  } catch {
    console.info('Modelo no encontrado — usando personaje 3D generado');
    _boxChar = _buildBoxChar(_user.character);
    playerGroup.add(_boxChar);
  }

  playerGroup.add(_nameSprite(_user.name, _user.character?.outfit, true));
  scene.add(playerGroup);
}

function _prepModel(model) {
  model.scale.setScalar(0.8);
  model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
}

function _findAnim(clips, keywords) {
  for (const kw of keywords) {
    const f = clips.find(c => c.name.toLowerCase().includes(kw));
    if (f) return f;
  }
  return clips[0] || null;
}

function _nameSprite(name, outfitColor, isPlayer = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 280; canvas.height = 72;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(12,8,28,0.80)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(6, 6, 268, 60, 14);
  else               ctx.rect(6, 6, 268, 60);
  ctx.fill();

  if (isPlayer) {
    ctx.strokeStyle = 'rgba(232,168,124,0.7)';
    ctx.lineWidth = 2; ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(6,6,268,60,14);
    else               ctx.rect(6,6,268,60);
    ctx.stroke();
  }

  const col = new THREE.Color(outfitColor || '#7c6bb5');
  ctx.fillStyle = `#${col.getHexString()}`;
  ctx.font = `bold 26px "Segoe UI",sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText((name || '?').substring(0, 14), 140, 36);

  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(2.0, 0.52, 1);
  sprite.position.set(0, 2.45, 0);
  sprite.renderOrder = 999;
  return sprite;
}

// ==================== SIT MECHANIC ====================

function _createSitHint() {
  _sitHintEl = document.createElement('div');
  Object.assign(_sitHintEl.style, {
    position: 'fixed', bottom: '130px', left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(20,15,40,0.88)', backdropFilter: 'blur(8px)',
    border: '1px solid rgba(180,140,220,0.35)', borderRadius: '12px',
    padding: '10px 22px', color: '#c9b8e8', fontSize: '14px',
    fontFamily: 'inherit', pointerEvents: 'none', zIndex: '20',
    opacity: '0', transition: 'opacity 0.25s', whiteSpace: 'nowrap',
  });
  document.body.appendChild(_sitHintEl);
}

function _toggleSit() {
  if (_isSitting) { _isSitting = false; _sitYTarget = 0; _hideSitHint(); return; }
  let nearest = null, nearestDist = 1.6;
  sitPoints.forEach((sp, i) => {
    const d = playerGroup.position.distanceTo(sp.pos);
    if (d < nearestDist) { nearest = i; nearestDist = d; }
  });
  if (nearest !== null) {
    _isSitting = true;
    const sp = sitPoints[nearest];
    playerGroup.position.copy(sp.pos);
    playerGroup.position.y = 0;
    playerGroup.rotation.y = sp.ry;
    _sitYTarget = -0.3;
    if (isWalking) {
      isWalking = false;
      if (idleAction && walkAction) { walkAction.fadeOut(0.2); idleAction.reset().fadeIn(0.2).play(); }
    }
  }
}

function _showSitHint(txt) {
  if (_sitHintEl) { _sitHintEl.textContent = txt; _sitHintEl.style.opacity = '1'; }
}
function _hideSitHint() {
  if (_sitHintEl) _sitHintEl.style.opacity = '0';
}

// ==================== INPUT ====================

function _setupInput() {
  document.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyE') _toggleSit();
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; });
}

// ==================== SYNC ====================

function _startSync() {
  setInterval(() => {
    if (!_socket || !_roomId || !playerGroup) return;
    _socket.emit('player-move', {
      x: playerGroup.position.x, z: playerGroup.position.z, ry: playerGroup.rotation.y
    });
  }, SYNC_MS);
}

// ==================== GAME LOOP ====================

function _tick() {
  const dt = clock.getDelta();

  _updateMovement(dt);

  // Smooth sit Y transition
  if (Math.abs(playerGroup.position.y - _sitYTarget) > 0.001)
    playerGroup.position.y = THREE.MathUtils.lerp(playerGroup.position.y, _sitYTarget, 0.14);

  // Sit hint proximity
  if (!_isSitting) {
    const near = sitPoints.some(sp => playerGroup.position.distanceTo(sp.pos) < 1.5);
    if (near) _showSitHint('Presioná E para sentarte');
    else _hideSitHint();
  }

  // Walk animation for box character (when no GLB model loaded)
  if (!playerMixer && _boxChar) {
    const parts = _boxChar.userData.walkParts;
    if (parts) {
      if (isWalking) {
        _walkPhase += dt * 9.5;
        const sw = Math.sin(_walkPhase);
        const cw = Math.cos(_walkPhase);
        parts.legPivotL.rotation.x =  sw * 0.52;
        parts.legPivotR.rotation.x = -sw * 0.52;
        parts.armPivotL.rotation.x = -sw * 0.38;
        parts.armPivotR.rotation.x =  sw * 0.38;
        // Subtle body bob
        _boxChar.position.y = Math.abs(cw) * 0.028;
      } else {
        parts.legPivotL.rotation.x = THREE.MathUtils.lerp(parts.legPivotL.rotation.x, 0, 0.18);
        parts.legPivotR.rotation.x = THREE.MathUtils.lerp(parts.legPivotR.rotation.x, 0, 0.18);
        parts.armPivotL.rotation.x = THREE.MathUtils.lerp(parts.armPivotL.rotation.x, 0, 0.18);
        parts.armPivotR.rotation.x = THREE.MathUtils.lerp(parts.armPivotR.rotation.x, 0, 0.18);
        _boxChar.position.y = THREE.MathUtils.lerp(_boxChar.position.y, 0, 0.18);
      }
    }
  }

  if (playerMixer) playerMixer.update(dt);
  Object.values(otherPlayers).forEach(p => {
    if (p.mixer) p.mixer.update(dt);
    if (p.group) {
      p.group.position.lerp(p.targetPos, 0.12);
      p.group.rotation.y = THREE.MathUtils.lerp(p.group.rotation.y, p.targetRy, 0.18);
    }
  });

  // Candle flicker
  _flickerT += dt * 7;
  if (candlePointLight)
    candlePointLight.intensity = 1.8 + Math.sin(_flickerT)*0.22 + Math.sin(_flickerT*2.7)*0.1;
  if (flameMesh)
    flameMesh.scale.set(1+Math.sin(_flickerT*1.3)*0.14, 1+Math.sin(_flickerT)*0.2, 1+Math.sin(_flickerT*0.9)*0.1);

  _updateCamera();
  composer.render();
}

function _updateMovement(dt) {
  if (!playerGroup || _isSitting) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  let dx = 0, dz = 0;
  if (keys['ArrowUp']    || keys['KeyW']) dz -= 1;
  if (keys['ArrowDown']  || keys['KeyS']) dz += 1;
  if (keys['ArrowLeft']  || keys['KeyA']) dx -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) dx += 1;

  const moving = dx !== 0 || dz !== 0;
  if (moving) {
    const len = Math.hypot(dx, dz);
    dx /= len; dz /= len;
    playerGroup.position.x = THREE.MathUtils.clamp(playerGroup.position.x + dx*SPEED*dt, -13.5, 13.5);
    playerGroup.position.z = THREE.MathUtils.clamp(playerGroup.position.z + dz*SPEED*dt, -10.5, 10.5);
    playerGroup.rotation.y = THREE.MathUtils.lerp(playerGroup.rotation.y, Math.atan2(dx, dz), 0.2);
    if (!isWalking) {
      isWalking = true;
      if (idleAction && walkAction) { idleAction.fadeOut(0.2); walkAction.reset().fadeIn(0.2).play(); }
    }
  } else if (isWalking) {
    isWalking = false;
    if (idleAction && walkAction) { walkAction.fadeOut(0.2); idleAction.reset().fadeIn(0.2).play(); }
  }
}

function _updateCamera() {
  if (!playerGroup) return;
  const tx = playerGroup.position.x, tz = playerGroup.position.z;
  camera.position.lerp(new THREE.Vector3(tx, 9.5, tz + 8), 0.07);
  camera.lookAt(tx, 0.9, tz);
}

// ==================== HELPERS ====================

function mat(color, roughness = 0.9, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addBox(w, h, d, x, y, z, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  scene.add(m); return m;
}

function addPlane(w, d, material, x, y, z, rx, ry) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  m.rotation.x = rx; m.rotation.y = ry; m.position.set(x, y, z);
  m.receiveShadow = true; scene.add(m); return m;
}
