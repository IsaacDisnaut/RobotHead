// ฉาก 3 มิติของหุ่น "น้องมะลิ"
// - ลำตัว/โครงหัว โหลดจากไฟล์ STL จริงใน 3D_Print (ถ้าโหลดไม่ได้ใช้รูปทรงจำลองแทน)
// - หน้ากาก, ตา GC9A01 2 จอ, ปาก (Jawduino), เซอร์โวคอ Pan/Tilt สร้างด้วยโค้ด
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const deg = THREE.MathUtils.degToRad;

// ระยะต่างๆ (มม.) อ้างอิงจากขนาดชิ้นงาน STL และรูป robotface.png
const BODY_TOP = 100;        // ความสูงบ่าของลำตัว
const PAN_HEIGHT = 112;      // แกนหมุนซ้าย-ขวา
const TILT_HEIGHT = 168;     // แกนก้ม-เงย
const HEAD_CHIN = -6;        // คางเทียบกับแกน tilt
const EYE_Y = 114, EYE_DX = 31;   // ตำแหน่งจอตาในหัว
const MOUTH_Y = 44;
const FACE_Z = 0;                 // ศูนย์กลางหน้ากาก (ขอบหน้ากากชนขอบหน้าของโครงหัว STL)
const SKULL_Z = -126;           // เลื่อนโครงหัว STL ไปข้างหลัง
export const CAMERA_POS = new THREE.Vector3(0, 62, 88); // กล้องหน้าอก (แผ่น PCB สีเขียว)

export class Robot3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1f27);
    this.scene.fog = new THREE.Fog(0x1b1f27, 2500, 6000);

    this.camera = new THREE.PerspectiveCamera(35, 1, 5, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.setView('angle');
    this.controls.enableDamping = true;
    this.controls.minDistance = 150;
    this.controls.maxDistance = 4000;

    this.buildLights();
    this.buildTable();
    this.buildRobot();
    this.buildCustomer();

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2f28, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(300, 600, 500);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -400, right: 400, top: 400, bottom: -400, near: 10, far: 2000 });
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
    rim.position.set(-400, 300, -400);
    this.scene.add(rim);
  }

  buildTable() {
    const tex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      const g = c.getContext('2d');
      g.fillStyle = '#b89a76'; g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 90; i++) {
        g.strokeStyle = `rgba(90,60,30,${Math.random() * 0.12})`;
        g.lineWidth = 1 + Math.random() * 3;
        const y = Math.random() * 512;
        g.beginPath(); g.moveTo(0, y);
        g.bezierCurveTo(170, y + rand(-8, 8), 340, y + rand(-8, 8), 512, y + rand(-6, 6));
        g.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(1600, 30, 1100),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 })
    );
    table.position.y = -15;
    table.receiveShadow = true;
    this.scene.add(table);
  }

  buildRobot() {
    const plastic = new THREE.MeshStandardMaterial({ color: 0xe8d2b4, roughness: 0.55, metalness: 0.02 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.5 });
    const servoMat = new THREE.MeshStandardMaterial({ color: 0x15223d, roughness: 0.45 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xc8202a, roughness: 0.45 });
    this.mats = { plastic, dark };

    this.robot = new THREE.Group();
    this.scene.add(this.robot);

    // ----- ลำตัว (procedural สำรอง) -----
    this.bodyFallback = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(70, 98, BODY_TOP, 6, 1), plastic);
    torso.scale.set(1, 1, 0.72);
    torso.rotation.y = Math.PI / 6;
    torso.position.y = BODY_TOP / 2;
    torso.castShadow = torso.receiveShadow = true;
    this.bodyFallback.add(torso);
    this.robot.add(this.bodyFallback);

    // กล้อง (PCB สีเขียวที่หน้าอก)
    const pcb = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(32, 26, 2),
      new THREE.MeshStandardMaterial({ color: 0x1f7a3a, roughness: 0.6 }));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(5, 6, 6, 24), dark);
    lens.rotation.x = Math.PI / 2; lens.position.z = 3;
    const glass = new THREE.Mesh(new THREE.CircleGeometry(3.2, 24),
      new THREE.MeshStandardMaterial({ color: 0x223355, metalness: 0.9, roughness: 0.1 }));
    glass.position.z = 6.1;
    pcb.add(board, lens, glass);
    pcb.position.copy(CAMERA_POS);
    pcb.rotation.x = -0.32;
    this.cameraBoard = pcb;
    this.robot.add(pcb);

    // ----- คอ: เซอร์โว Pan บนลำตัว -----
    const panBase = new THREE.Mesh(new THREE.BoxGeometry(40, 38, 21), servoMat);
    panBase.position.set(0, BODY_TOP + 2, -6);
    panBase.castShadow = true;
    this.robot.add(panBase);

    this.panGroup = new THREE.Group();
    this.panGroup.position.set(0, PAN_HEIGHT, 0);
    this.robot.add(this.panGroup);

    const horn = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 4, 24), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    horn.position.y = 9;
    const neck = new THREE.Mesh(new THREE.BoxGeometry(26, TILT_HEIGHT - PAN_HEIGHT - 10, 18), dark);
    neck.position.y = (TILT_HEIGHT - PAN_HEIGHT) / 2 + 4;
    const tiltServo = new THREE.Mesh(new THREE.BoxGeometry(21, 38, 40), redMat);
    tiltServo.position.set(0, TILT_HEIGHT - PAN_HEIGHT, 0);
    const bracketL = new THREE.Mesh(new THREE.BoxGeometry(3, 34, 30), dark);
    bracketL.position.set(-26, TILT_HEIGHT - PAN_HEIGHT + 8, 0);
    const bracketR = bracketL.clone(); bracketR.position.x = 26;
    [horn, neck, tiltServo, bracketL, bracketR].forEach((m) => { m.castShadow = true; this.panGroup.add(m); });

    this.tiltGroup = new THREE.Group();
    this.tiltGroup.position.set(0, TILT_HEIGHT - PAN_HEIGHT, 0);
    this.panGroup.add(this.tiltGroup);

    this.head = new THREE.Group();
    this.head.position.y = HEAD_CHIN;
    this.tiltGroup.add(this.head);

    // โครงหัวสำรอง (ถ้า STL โหลดไม่ได้)
    this.skullFallback = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 30, 0, Math.PI * 2, 0, Math.PI), plastic);
    this.skullFallback.scale.set(66, 96, 70);
    this.skullFallback.position.set(0, 100, -40);
    this.skullFallback.castShadow = true;
    this.head.add(this.skullFallback);

    this.buildFace();
    this.buildCables();
    this.loadStl();
  }

  // ===== หน้ากากใบหน้า (ปั้นจากทรงกลมแล้วดัดจุด) =====
  buildFace() {
    const skin = new THREE.MeshPhysicalMaterial({
      color: 0xf0d2b6, roughness: 0.48, clearcoat: 0.25, clearcoatRoughness: 0.6, sheen: 0.3, sheenColor: 0xffc9b0,
    });
    this.skinMat = skin;
    // ครึ่งหน้าของทรงกลม (three.js: +Z อยู่ที่ phi = π/2)
    const geo = new THREE.SphereGeometry(1, 96, 96, Math.PI / 2 - 1.3, 2.6, 0.05, Math.PI - 0.12);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    const bump = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const y = v.y;                       // -1 คาง ... 1 หน้าผาก
      // คางแคบ หน้าผากกว้าง
      const width = 0.68 + 0.3 * THREE.MathUtils.smoothstep(y, -1, 0.15) - 0.08 * THREE.MathUtils.smoothstep(y, 0.5, 1);
      v.x *= width;
      v.z *= 0.9 + 0.1 * THREE.MathUtils.smoothstep(y, -1, -0.2);
      const front = Math.max(0, v.z);
      // เบ้าตา
      const eyeY = (EYE_Y - 96) / 96;
      v.z -= 0.13 * front * (bump(v.x, y, 0.33, eyeY, 0.17, 0.11) + bump(v.x, y, -0.33, eyeY, 0.17, 0.11));
      // คิ้ว/สันจมูก/จมูก
      v.z += 0.05 * front * (bump(v.x, y, 0.33, eyeY + 0.18, 0.22, 0.06) + bump(v.x, y, -0.33, eyeY + 0.18, 0.22, 0.06));
      v.z += 0.07 * front * bump(v.x, y, 0, eyeY - 0.12, 0.05, 0.16);
      v.z += 0.1 * front * bump(v.x, y, 0, eyeY - 0.34, 0.08, 0.09);
      // ช่วงปาก-คางยื่นออกมา (ทรงกลมล้วนจะยุบเข้าไปมากเกิน)
      v.z += 0.16 * front * bump(v.x, y, 0, -0.62, 0.38, 0.32);
      // แก้ม
      v.z += 0.05 * front * (bump(v.x, y, 0.45, -0.25, 0.2, 0.2) + bump(v.x, y, -0.45, -0.25, 0.2, 0.2));
      // ร่องปาก
      v.z -= 0.035 * front * bump(v.x, y, 0, (MOUTH_Y - 96) / 96, 0.2, 0.05);
      // คาง
      v.z += 0.1 * front * bump(v.x, y, 0, -0.88, 0.2, 0.1);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const face = new THREE.Mesh(geo, skin);
    face.scale.set(72, 96, 80);
    face.position.set(0, 98, FACE_Z);
    face.castShadow = true;
    this.faceMesh = face;
    this.head.add(face);

    // หาความลึกผิวหน้ากากที่ตำแหน่ง (x,y) เพื่อวางตา/ปากให้แนบพอดี
    this.scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const surface = (x, y) => {
      const o = this.head.localToWorld(new THREE.Vector3(x, y, 400));
      const dir = this.head.localToWorld(new THREE.Vector3(x, y, 0)).sub(o).normalize();
      ray.set(o, dir);
      const hit = ray.intersectObject(face)[0];
      return hit ? this.head.worldToLocal(hit.point.clone()).z : 60;
    };

    // ----- ตา: จอกลม GC9A01 2 จอ มองผ่านช่องตาของหน้ากาก -----
    this.eyeCanvases = [document.createElement('canvas'), document.createElement('canvas')];
    this.eyeTextures = [];
    this.eyeCanvases.forEach((c, i) => {
      c.width = c.height = 240;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      // เห็นแค่ส่วนกลางของจอ (พื้นที่ภาพตา 160px) ผ่านช่องตา
      tex.repeat.set(0.56, 0.56);
      tex.offset.set(0.22, 0.22);
      this.eyeTextures.push(tex);
      const x = i === 0 ? -EYE_DX : EYE_DX;   // จอ 0 = ตาขวาของหุ่น (ฝั่งซ้ายคนดู)
      const z = surface(x, EYE_Y) + 0.6;
      const eye = new THREE.Group();
      eye.position.set(x, EYE_Y, z);
      eye.rotation.y = Math.sign(x) * 0.2;
      // ช่องตาทรงอัลมอนด์ (UV อิงตำแหน่งจริง ภาพตาจึงไม่บิด)
      const R = 14;
      const opening = new THREE.Shape(); opening.absellipse(0, 0, R, R * 0.66, 0, Math.PI * 2);
      const sg = new THREE.ShapeGeometry(opening, 32);
      const p = sg.attributes.position, uv = sg.attributes.uv;
      for (let k = 0; k < p.count; k++) uv.setXY(k, p.getX(k) / (2 * R) + 0.5, p.getY(k) / (2 * R) + 0.5);
      const screen = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      const rimShape = new THREE.Shape(); rimShape.absellipse(0, 0, R + 2.5, R * 0.66 + 2.5, 0, Math.PI * 2);
      const hole = new THREE.Path(); hole.absellipse(0, 0, R, R * 0.66, 0, Math.PI * 2, true);
      rimShape.holes.push(hole);
      const lid = new THREE.Mesh(new THREE.ShapeGeometry(rimShape, 32),
        new THREE.MeshStandardMaterial({ color: 0xc9a58c, roughness: 0.6 }));
      lid.position.z = 0.2;
      eye.add(screen, lid);
      this.head.add(eye);
    });

    // ----- ปาก -----
    const lipMat = new THREE.MeshPhysicalMaterial({ color: 0xd2786e, roughness: 0.35, clearcoat: 0.5 });
    const lipGeo = new THREE.CapsuleGeometry(3.4, 19, 8, 16);
    lipGeo.rotateZ(Math.PI / 2);
    const mouthZ = surface(0, MOUTH_Y);
    const upper = new THREE.Mesh(lipGeo, lipMat);
    upper.scale.set(1, 0.95, 0.55);
    upper.position.set(0, MOUTH_Y + 4.5, surface(0, MOUTH_Y + 4.5) + 0.5);
    this.head.add(upper);

    this.mouthInside = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0x3a1214 }));
    this.mouthInside.position.set(0, MOUTH_Y, mouthZ + 0.8);
    this.head.add(this.mouthInside);

    // ขากรรไกร (เซอร์โว MG90S ของ Jawduino) หมุนรอบจุดหลังปาก
    this.jaw = new THREE.Group();
    this.jaw.position.set(0, MOUTH_Y + 2, mouthZ - 45);
    this.head.add(this.jaw);
    const lower = new THREE.Mesh(lipGeo, lipMat);
    lower.scale.set(0.95, 1.1, 0.6);
    lower.position.set(0, -6.5, surface(0, MOUTH_Y - 4.5) - (mouthZ - 45) + 0.5);
    this.jaw.add(lower);
  }

  buildCables() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });
    [-1, 1].forEach((s) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(s * 60, BODY_TOP - 10, 30),
        new THREE.Vector3(s * 70, BODY_TOP + 30, 20),
        new THREE.Vector3(s * 62, TILT_HEIGHT + 20, 0),
        new THREE.Vector3(s * 66, TILT_HEIGHT + 70, -15),
      ]);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 3.2, 8), mat);
      tube.castShadow = true;
      this.robot.add(tube);
    });
  }

  loadStl() {
    const loader = new STLLoader();
    const mat = this.mats.plastic;
    loader.load('/models/body.stl', (geo) => {
      // STL ลำตัว: Z ขึ้น, ด้านหน้า = -Y, รูคออยู่ที่ (110,125)
      geo.rotateX(-Math.PI / 2);
      geo.translate(-110, 0, 125);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = m.receiveShadow = true;
      this.bodyStl = m;
      this.robot.add(m);
      this.bodyFallback.visible = false;
      this.onStatus?.('โหลด STL ลำตัวแล้ว');
    }, undefined, () => this.onStatus?.('โหลด STL ลำตัวไม่ได้ ใช้โมเดลจำลอง'));

    loader.load('/models/head.stl', (geo) => {
      // STL โครงหัว: Y ขึ้น (15..204), ด้านหน้าเปิดโล่งหันไป +Z (หน้ากากใส่ตรงนี้)
      geo.translate(-110, -15, SKULL_Z);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9cbb5, roughness: 0.6 }));
      m.castShadow = true;
      this.headStl = m;
      this.head.add(m);
      this.skullFallback.visible = false;
      this.onStatus?.('โหลด STL โครงหัวแล้ว');
    }, undefined, () => this.onStatus?.('โหลด STL โครงหัวไม่ได้ ใช้โมเดลจำลอง'));
  }

  setShowMask(show) {
    this.faceMesh.visible = show;
  }

  // ===== หุ่นโปร่งใสแสดงตำแหน่งคนที่กล้องคอมจริงเห็น =====
  buildCustomer() {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x5ab0ff, transparent: true, opacity: 0.35, depthWrite: false });
    const head = new THREE.Mesh(new THREE.SphereGeometry(80, 32, 24), mat);
    head.scale.set(1, 1.2, 1);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(150, 380, 8, 24), mat);
    body.position.y = -420;
    body.scale.z = 0.55;
    g.add(head, body);
    g.visible = false;
    this.customer = g;
    this.scene.add(g);
  }

  // norm_x, norm_y เป็นพิกัดภาพกล้องแบบกลับด้าน (เหมือน cv2.flip ใน robot_brain.py), ratio = กว้างหน้า/กว้างภาพ
  setCustomer(present, normX, normY, ratio) {
    this.customer.visible = present;
    if (!present) return;
    const hfov = deg(60), vfov = deg(46);
    const dist = 160 / (2 * Math.tan(hfov / 2) * Math.max(ratio, 0.03)); // หน้ากว้าง ~16 ซม.
    const x = (normX - 0.5) * 2 * Math.tan(hfov / 2) * dist;
    const y = CAMERA_POS.y + (0.5 - normY) * 2 * Math.tan(vfov / 2) * dist + Math.tan(0.32) * dist;
    this.customer.position.set(x, y, CAMERA_POS.z + dist);
  }

  // ===== วาดจอตา GC9A01 =====
  drawEyes(fw) {
    this.eyeCanvases.forEach((c, i) => drawEyeCanvas(c, fw, i));
    this.eyeTextures.forEach((t) => (t.needsUpdate = true));
  }

  update(fw, jaw) {
    // ค่าที่เซอร์โวได้รับจริง (หลัง constrain)
    this.panGroup.rotation.y = deg(fw.servoPan - 90);
    this.tiltGroup.rotation.x = -deg(fw.servoTilt - 90);
    const open = jaw.openness;
    this.jaw.rotation.x = deg(14) * open;
    this.mouthInside.scale.set(10 + 3 * open, 0.4 + 6.5 * open, 1);
    this.mouthInside.position.y = MOUTH_Y - 3 * open;
    this.drawEyes(fw);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resetView() { this.setView('angle'); }
  frontView() { this.setView('front'); }
  setView(name) {
    const views = {
      angle: [[420, 380, 820], [0, 170, 0]],
      front: [[0, 250, 820], [0, 200, 0]],
      side: [[850, 220, 0], [0, 180, 0]],
      back: [[0, 300, -800], [0, 180, 0]],
      top: [[0, 900, 1], [0, 150, 0]],
      wide: [[2300, 1300, 1400], [0, 250, 650]],
    };
    const [p, t] = views[name] || views.angle;
    this.camera.position.set(...p);
    this.controls.target.set(...t);
  }
}

function rand(a, b) { return a + Math.random() * (b - a); }

// วาดภาพบนจอตาให้คล้าย Uncanny Eyes (defaultEye) ที่ใช้ในเฟิร์มแวร์
const irisCache = new Map();
function irisPattern(size) {
  if (irisCache.has(size)) return irisCache.get(size);
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); const r = size / 2;
  const grad = g.createRadialGradient(r, r, r * 0.15, r, r, r);
  grad.addColorStop(0, '#2c3e4f'); grad.addColorStop(0.45, '#5b7f9a');
  grad.addColorStop(0.85, '#3f5f78'); grad.addColorStop(1, '#1b2833');
  g.fillStyle = grad; g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
  for (let a = 0; a < 220; a++) {
    const t = (a / 220) * Math.PI * 2 + Math.random() * 0.03;
    g.strokeStyle = `rgba(${150 + Math.random() * 80},${180 + Math.random() * 60},${200 + Math.random() * 55},${0.08 + Math.random() * 0.18})`;
    g.lineWidth = 0.6 + Math.random() * 1.2;
    g.beginPath();
    g.moveTo(r + Math.cos(t) * r * 0.25, r + Math.sin(t) * r * 0.25);
    g.lineTo(r + Math.cos(t) * r * (0.75 + Math.random() * 0.22), r + Math.sin(t) * r * (0.75 + Math.random() * 0.22));
    g.stroke();
  }
  irisCache.set(size, c);
  return c;
}

export function drawEyeCanvas(c, fw, index) {
  const g = c.getContext('2d');
  const W = c.width, cx = W / 2, cy = W / 2;
  const s = W / 240;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, W);
  // พื้นที่แสดงผล 160x160 กลางจอ (kEyeSize)
  g.save();
  g.beginPath(); g.rect(cx - 80 * s, cy - 80 * s, 160 * s, 160 * s); g.clip();

  // ตาขาว
  const sg = g.createRadialGradient(cx, cy, 10 * s, cx, cy, 95 * s);
  sg.addColorStop(0, '#fbf6f1'); sg.addColorStop(0.75, '#eadfd6'); sg.addColorStop(1, '#b89b90');
  g.fillStyle = sg; g.fillRect(0, 0, W, W);

  // ตำแหน่งตาดำ: x มาก = มองไปทางซ้ายของหุ่น (ขวาของคนดู), y มาก = มองล่าง
  const ix = cx + ((fw.eyeX - 512) / 512) * 46 * s;
  const iy = cy + ((fw.eyeY - 512) / 512) * 40 * s;
  const ir = 46 * s;
  g.drawImage(irisPattern(Math.round(ir * 2)), ix - ir, iy - ir, ir * 2, ir * 2);
  const pr = ir * (0.62 - (fw.iScale - 95) / 30 * 0.3);   // iScale มาก = รูม่านตาเล็ก
  g.fillStyle = '#05070a'; g.beginPath(); g.arc(ix, iy, pr, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath(); g.arc(ix - ir * 0.35, iy - ir * 0.4, ir * 0.13, 0, Math.PI * 2); g.fill();

  // เปลือกตา (เหมือน upper/lower threshold) + กะพริบ
  const open = fw.eyeOpen[index];
  const lidBase = 26 + fw.lidBias * 14;           // มองล่าง เปลือกตาบนลดลง
  const upperY = cy - 80 * s + (lidBase + (1 - open) * 70) * s;
  const lowerY = cy + 80 * s - (14 + (1 - open) * 60) * s;
  g.fillStyle = '#000';
  // เปลือกตาบน (โค้งต่างกันซ้าย/ขวา เพราะ lidX กลับด้านในตาซ้าย)
  const tilt = index === 0 ? 1 : -1;
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(W, 0);
  g.lineTo(W, upperY + 12 * s * tilt);
  g.quadraticCurveTo(cx, upperY - 26 * s, 0, upperY - 12 * s * tilt);
  g.closePath(); g.fill();
  g.beginPath();
  g.moveTo(0, W); g.lineTo(W, W);
  g.lineTo(W, lowerY);
  g.quadraticCurveTo(cx, lowerY + 22 * s, 0, lowerY);
  g.closePath(); g.fill();
  g.restore();
}
