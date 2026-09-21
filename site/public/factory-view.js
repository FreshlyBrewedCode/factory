/*!
 * Vendored from the sibling `factory-3d` project: `bun run build:embed` →
 * dist/factory-view.js (IIFE exposing globalThis.FactoryView, resolving THREE
 * lazily from globalThis.THREE). Refresh it by rebuilding there and copying
 * over this file.
 */
(() => {
  var __defProp = Object.defineProperty;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // src/factory-view.js
  var exports_factory_view = {};
  __export(exports_factory_view, {
    DIMS: () => DIMS,
    EFFECTS: () => EFFECTS,
    FactoryView: () => FactoryView,
    PALETTE: () => PALETTE,
    resetDimensions: () => resetDimensions,
    resetEffects: () => resetEffects,
    resetTheme: () => resetTheme,
    setColor: () => setColor,
    setDimension: () => setDimension,
    setEffect: () => setEffect,
    setThree: () => setThree
  });

  // src/three.js
  var injected = null;
  function setThree(three) {
    if (!three || typeof three !== "object")
      throw new TypeError("setThree expects a THREE namespace object");
    injected = three;
  }
  function getThree() {
    const three = injected ?? globalThis.THREE ?? null;
    if (!three) {
      throw new Error("three.js not found: load it so window.THREE exists, or pass it to the FactoryView constructor as { three }");
    }
    return three;
  }
  var THREE = new Proxy(Object.prototype, {
    get(_, prop) {
      return getThree()[prop];
    },
    has(_, prop) {
      return prop in getThree();
    }
  });

  // src/palette.js
  var PALETTE = {
    paper: 16777215,
    floor: 15132390,
    grid: 15132390,
    keyLight: 16777215,
    beltDark: 10395294,
    beltFrame: 15263976,
    beltFrameShade: 14472645,
    stationBody: 11908533,
    stationPanel: 14606046,
    stationDark: 7368816,
    stationAccent: 8882055,
    lampIdle: 11908533,
    lampBusy: 14967886,
    lampPass: 4633692,
    lampFail: 14693419,
    cardboard: 15640623,
    cardboardFlap: 13083218,
    cardboardDark: 12490305,
    tape: 15260868,
    label: 16249574,
    stamp: 13132095,
    rocketShell: 15855593,
    rocketPaint: 15748899,
    rocketTrim: 9408399,
    rocketWindow: 10477275,
    armBody: 16513265,
    armJoint: 4014931
  };

  // src/theme.js
  var bindings = new Map;
  var DEFAULTS = { ...PALETTE };
  function bind(key, apply) {
    if (!(key in PALETTE))
      throw new Error(`unknown palette key: ${key}`);
    if (!bindings.has(key))
      bindings.set(key, []);
    const list = bindings.get(key);
    list.push(apply);
    apply(PALETTE[key]);
    return () => {
      const i = list.indexOf(apply);
      if (i !== -1)
        list.splice(i, 1);
    };
  }
  function bindColor(key, target, prop = "color") {
    return bind(key, (hex) => target[prop].setHex(hex));
  }
  function standardMaterial(key, params = {}) {
    const material = new THREE.MeshStandardMaterial(params);
    bindColor(key, material);
    return material;
  }
  function basicMaterial(key, params = {}) {
    const material = new THREE.MeshBasicMaterial(params);
    bindColor(key, material);
    return material;
  }
  function setColor(key, hex) {
    PALETTE[key] = hex;
    for (const apply of bindings.get(key) ?? [])
      apply(hex);
  }
  function resetTheme() {
    for (const [key, hex] of Object.entries(DEFAULTS))
      setColor(key, hex);
  }

  // src/dimensions.js
  var DIMS = {
    beltWidth: 1.05,
    beltHeight: 0.94,
    deckThickness: 0.26,
    frameDrop: 0.27,
    cornerRadius: 3.1,
    stationWidth: 2.25,
    stationHeight: 2.6,
    stationSpan: 2.25,
    tunnelTop: 2,
    tunnelClearance: 0.36,
    boxWidth: 1,
    boxHeight: 0.82,
    boxDepth: 1
  };
  var DEFAULTS2 = { ...DIMS };
  var listeners = new Set;
  function onDimensionsChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function setDimension(key, value) {
    if (!(key in DIMS))
      throw new Error(`unknown dimension: ${key}`);
    DIMS[key] = value;
    for (const fn of listeners)
      fn();
  }
  function resetDimensions() {
    Object.assign(DIMS, DEFAULTS2);
    for (const fn of listeners)
      fn();
  }
  function beltMetrics() {
    const deckTop = DIMS.beltHeight;
    const deckBottom = deckTop - DIMS.deckThickness;
    const frameBottom = Math.max(0.02, deckBottom - DIMS.frameDrop);
    return {
      width: DIMS.beltWidth,
      halfWidth: DIMS.beltWidth / 2,
      frameHalf: DIMS.beltWidth / 2 + 0.07,
      deckTop,
      deckBottom,
      frameBottom
    };
  }
  function stationMetrics() {
    const width = DIMS.stationWidth;
    const height = DIMS.stationHeight;
    const tunnelWidth = Math.min(DIMS.beltWidth + DIMS.tunnelClearance, width - 0.3);
    const tunnelTop = Math.min(Math.max(DIMS.tunnelTop, DIMS.beltHeight + 0.3), height - 0.2);
    const wallWidth = (width - tunnelWidth) / 2;
    return {
      width,
      height,
      span: DIMS.stationSpan,
      tunnelWidth,
      tunnelTop,
      wallWidth,
      wallX: tunnelWidth / 2 + wallWidth / 2
    };
  }
  function boxMetrics() {
    return { w: DIMS.boxWidth, h: DIMS.boxHeight, d: DIMS.boxDepth };
  }

  // src/path.js
  class ConveyorPath {
    constructor(polyline, radius, step = 0.12, { closed = false, filleted = true } = {}) {
      this.closed = closed;
      this.raw = filleted ? filletPolyline(polyline, radius, closed) : polyline.map((p) => p.isVector3 ? p.clone() : new THREE.Vector3(p[0], 0, p[1]));
      const resampled = resample(this.raw, step, closed);
      this.points = resampled.points;
      this.length = resampled.total;
      this.step = resampled.step;
    }
    clampDistance(distance) {
      return this.closed ? wrap(distance, this.length) : THREE.MathUtils.clamp(distance, 0, this.length);
    }
    indexAt(distance) {
      const d = this.clampDistance(distance);
      const last = this.closed ? this.points.length - 1 : this.points.length - 2;
      return Math.min(Math.floor(d / this.step), last);
    }
    positionAt(distance, target = new THREE.Vector3) {
      const d = this.clampDistance(distance);
      const i = this.indexAt(d);
      const j = (i + 1) % this.points.length;
      const t = (d - i * this.step) / this.step;
      return target.copy(this.points[i]).lerp(this.points[j], THREE.MathUtils.clamp(t, 0, 1));
    }
    tangentAt(distance, target = new THREE.Vector3) {
      const i = this.indexAt(distance);
      const n = this.points.length;
      const a = this.points[this.closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
      const b = this.points[this.closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
      return target.subVectors(b, a).normalize();
    }
    headingAt(distance) {
      const t = this.tangentAt(distance, tmpTangent());
      return Math.atan2(t.x, t.z);
    }
    delta(a, b) {
      if (!this.closed)
        return b - a;
      let d = wrap(b - a, this.length);
      if (d > this.length / 2)
        d -= this.length;
      return d;
    }
    subpath(from, to) {
      const pts = [];
      for (let d = from;d < to; d += this.step)
        pts.push(this.positionAt(d, new THREE.Vector3));
      pts.push(this.positionAt(to, new THREE.Vector3));
      return new ConveyorPath(pts, 0, this.step, { filleted: false });
    }
    curvatureAround(distance, halfWindow) {
      const samples = 9;
      let worst = 0;
      const base = this.tangentAt(distance, new THREE.Vector3);
      for (let i = 0;i <= samples; i++) {
        const d = distance + THREE.MathUtils.lerp(-halfWindow, halfWindow, i / samples);
        const t = this.tangentAt(d, tmpTangent());
        worst = Math.max(worst, base.angleTo(t));
      }
      return worst;
    }
    straightestSpot(halfWindow, from = 0, to = this.length, tolerance = 0.04) {
      const probe = 0.2;
      let best = { start: 0, end: -1 };
      let run = null;
      let fallback = { d: (from + to) / 2, curve: Infinity };
      for (let d = from;d <= to; d += probe) {
        const curve = this.curvatureAround(d, halfWindow);
        if (curve < fallback.curve)
          fallback = { d, curve };
        if (curve <= tolerance) {
          run ??= { start: d, end: d };
          run.end = d;
        } else if (run) {
          if (run.end - run.start > best.end - best.start)
            best = run;
          run = null;
        }
      }
      if (run && run.end - run.start > best.end - best.start)
        best = run;
      return best.end >= best.start ? (best.start + best.end) / 2 : fallback.d;
    }
  }
  var _tmpTangent = null;
  function tmpTangent() {
    return _tmpTangent ??= new THREE.Vector3;
  }
  function wrap(v, len) {
    return (v % len + len) % len;
  }
  function norm2(x, y) {
    const l = Math.hypot(x, y) || 1;
    return { x: x / l, y: y / l };
  }
  function dist2(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  function filletPolyline(polyline, radius, closed, arcSegments = 20) {
    const n = polyline.length;
    const pts = [];
    if (!closed)
      pts.push(new THREE.Vector3(polyline[0][0], 0, polyline[0][1]));
    const first = closed ? 0 : 1;
    const last = closed ? n - 1 : n - 2;
    for (let i = first;i <= last; i++) {
      const prev = polyline[(i - 1 + n) % n];
      const curr = polyline[i];
      const next = polyline[(i + 1) % n];
      const d1 = norm2(prev[0] - curr[0], prev[1] - curr[1]);
      const d2 = norm2(next[0] - curr[0], next[1] - curr[1]);
      const len1 = dist2(prev, curr);
      const len2 = dist2(curr, next);
      const angle = Math.acos(THREE.MathUtils.clamp(d1.x * d2.x + d1.y * d2.y, -1, 1));
      const half = angle / 2;
      let tangentLen = radius / Math.tan(half);
      tangentLen = Math.min(tangentLen, len1 * 0.5, len2 * 0.5);
      const r = tangentLen * Math.tan(half);
      const t1 = { x: curr[0] + d1.x * tangentLen, y: curr[1] + d1.y * tangentLen };
      const t2 = { x: curr[0] + d2.x * tangentLen, y: curr[1] + d2.y * tangentLen };
      if (!Number.isFinite(r) || r < 0.0001) {
        pts.push(new THREE.Vector3(curr[0], 0, curr[1]));
        continue;
      }
      const bis = norm2(d1.x + d2.x, d1.y + d2.y);
      const c = { x: curr[0] + bis.x * (r / Math.sin(half)), y: curr[1] + bis.y * (r / Math.sin(half)) };
      let a0 = Math.atan2(t1.y - c.y, t1.x - c.x);
      const a1 = Math.atan2(t2.y - c.y, t2.x - c.x);
      let sweep = a1 - a0;
      while (sweep > Math.PI)
        sweep -= Math.PI * 2;
      while (sweep < -Math.PI)
        sweep += Math.PI * 2;
      for (let s = 0;s <= arcSegments; s++) {
        const a = a0 + sweep * s / arcSegments;
        pts.push(new THREE.Vector3(c.x + Math.cos(a) * r, 0, c.y + Math.sin(a) * r));
      }
    }
    if (!closed)
      pts.push(new THREE.Vector3(polyline[n - 1][0], 0, polyline[n - 1][1]));
    return pts;
  }
  function resample(raw, step, closed) {
    const segCount = closed ? raw.length : raw.length - 1;
    const segLen = [];
    let total = 0;
    for (let i = 0;i < segCount; i++) {
      const l = raw[i].distanceTo(raw[(i + 1) % raw.length]);
      segLen.push(l);
      total += l;
    }
    const count = Math.max(8, Math.round(total / step));
    const exact = total / count;
    const points = [];
    let seg = 0;
    let along = 0;
    const emit = closed ? count : count + 1;
    for (let i = 0;i < emit; i++) {
      const target = i * exact;
      while (along + segLen[seg] < target && seg < segLen.length - 1) {
        along += segLen[seg];
        seg++;
      }
      const t = segLen[seg] > 0.000000001 ? (target - along) / segLen[seg] : 0;
      const a = raw[seg];
      const b = raw[(seg + 1) % raw.length];
      points.push(new THREE.Vector3().copy(a).lerp(b, THREE.MathUtils.clamp(t, 0, 1)));
    }
    return { points, total: count * exact, step: exact };
  }

  // src/geometry.js
  function sweepProfile(path, profile) {
    const pts = path.points;
    const rings = pts.length;
    const n = profile.length;
    const closed = path.closed;
    const positions = new Float32Array(rings * n * 3);
    const uvs = new Float32Array(rings * n * 2);
    const vCoord = [0];
    for (let j = 1;j < n; j++) {
      vCoord[j] = vCoord[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]);
    }
    const tangent = new THREE.Vector3;
    const across = new THREE.Vector3;
    for (let i = 0;i < rings; i++) {
      const p = pts[i];
      const prev = pts[closed ? (i - 1 + rings) % rings : Math.max(i - 1, 0)];
      const next = pts[closed ? (i + 1) % rings : Math.min(i + 1, rings - 1)];
      tangent.subVectors(next, prev).normalize();
      across.set(-tangent.z, 0, tangent.x);
      for (let j = 0;j < n; j++) {
        const [a, h] = profile[j];
        const o = (i * n + j) * 3;
        positions[o] = p.x + across.x * a;
        positions[o + 1] = h;
        positions[o + 2] = p.z + across.z * a;
        uvs[(i * n + j) * 2] = i * path.step;
        uvs[(i * n + j) * 2 + 1] = vCoord[j];
      }
    }
    const indices = [];
    const ringCount = closed ? rings : rings - 1;
    for (let i = 0;i < ringCount; i++) {
      const i2 = (i + 1) % rings;
      for (let j = 0;j < n; j++) {
        const j2 = (j + 1) % n;
        const a = i * n + j;
        const b = i * n + j2;
        const c = i2 * n + j2;
        const d = i2 * n + j;
        indices.push(a, d, c, a, c, b);
      }
    }
    if (!closed) {
      const lastRing = (rings - 1) * n;
      for (let j = 1;j < n - 1; j++) {
        indices.push(0, j, j + 1);
        indices.push(lastRing, lastRing + j + 1, lastRing + j);
      }
    }
    const geo = new THREE.BufferGeometry;
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // src/belt.js
  var LEG_SPACING = 3;
  var TREAD_REPEAT = 0.55;
  function buildConveyor(path) {
    const group = new THREE.Group;
    group.name = "conveyor";
    const belt = beltMetrics();
    const { deckTop, deckBottom, frameBottom, halfWidth: hw, frameHalf: fw } = belt;
    const deck = new THREE.Mesh(sweepProfile(path, [
      [-hw, deckBottom],
      [hw, deckBottom],
      [hw, deckTop],
      [-hw, deckTop]
    ]), standardMaterial("beltDark", { roughness: 0.85, map: treadTexture(belt.width) }));
    group.add(deck);
    const frame = new THREE.Mesh(sweepProfile(path, [
      [-fw, frameBottom],
      [fw, frameBottom],
      [fw, deckBottom + Math.min(0.07, (deckTop - deckBottom) * 0.7)],
      [-fw, deckBottom + Math.min(0.07, (deckTop - deckBottom) * 0.7)]
    ]), standardMaterial("beltFrame", { roughness: 0.95 }));
    group.add(frame);
    group.add(buildLegs(path, frameBottom));
    return {
      group,
      deck,
      update(scroll) {
        deck.material.map.offset.x = -scroll / TREAD_REPEAT;
      }
    };
  }
  function treadTexture(beltWidth) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 4;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 64, 4);
    ctx.fillStyle = "#c9ccd6";
    ctx.fillRect(0, 0, 5, 4);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.repeat.set(1 / TREAD_REPEAT, 1 / beltWidth);
    tex.anisotropy = 4;
    return tex;
  }
  function buildLegs(path, frameBottom) {
    const height = frameBottom;
    const geo = new THREE.BoxGeometry(0.16, height, 0.16);
    geo.translate(0, height / 2, 0);
    const mat = standardMaterial("beltFrameShade", { roughness: 0.95 });
    const count = Math.max(2, Math.round(path.length / LEG_SPACING));
    const spacing = path.length / (path.closed ? count : count - 1);
    const inset = Math.max(0.12, beltMetrics().halfWidth - 0.27);
    const pos = new THREE.Vector3;
    const tangent = new THREE.Vector3;
    const mesh = new THREE.InstancedMesh(geo, mat, count * 2);
    const dummy = new THREE.Object3D;
    let n = 0;
    for (let i = 0;i < count; i++) {
      const d = i * spacing;
      path.positionAt(d, pos);
      path.tangentAt(d, tangent);
      for (const side of [1, -1]) {
        dummy.position.set(pos.x - tangent.z * inset * side, 0, pos.z + tangent.x * inset * side);
        dummy.rotation.y = Math.atan2(tangent.x, tangent.z);
        dummy.updateMatrix();
        mesh.setMatrixAt(n++, dummy.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  // src/station.js
  var _materials = null;
  function sharedMaterials() {
    return _materials ??= {
      body: standardMaterial("stationBody", { roughness: 0.93 }),
      panel: standardMaterial("stationPanel", { roughness: 0.95 }),
      dark: standardMaterial("stationDark", { roughness: 0.9 }),
      accent: standardMaterial("stationAccent", { roughness: 0.6 }),
      cavity: standardMaterial("stationDark", { roughness: 1, side: THREE.BackSide })
    };
  }
  function createStation(index, { qa = false, sidePort = 0 } = {}) {
    const materials = sharedMaterials();
    const group = new THREE.Group;
    group.name = `station-${index + 1}`;
    const S = stationMetrics();
    const belt = beltMetrics();
    const cavityBottom = belt.deckBottom - 0.04;
    const mouths = [1, -1];
    const k = Math.min(S.width / 2.9, S.height / 2.6);
    const portZ = DIMS.beltWidth + 0.3;
    const portTop = S.tunnelTop;
    const portSeg = (S.span - portZ) / 2;
    for (const s of [1, -1]) {
      if (s === sidePort) {
        for (const z of [-(portZ + portSeg) / 2, (portZ + portSeg) / 2]) {
          const seg = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth, S.height, portSeg), materials.body);
          seg.position.set(s * S.wallX, S.height / 2, z);
          group.add(seg);
        }
        const lintel = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth, S.height - portTop, portZ), materials.body);
        lintel.position.set(s * S.wallX, portTop + (S.height - portTop) / 2, 0);
        group.add(lintel);
      } else {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth, S.height, S.span), materials.body);
        wall.position.set(s * S.wallX, S.height / 2, 0);
        group.add(wall);
      }
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth + 0.14, 0.18, S.span + 0.14), materials.dark);
      plinth.position.set(s * S.wallX, 0.09, 0);
      group.add(plinth);
      const band = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth + 0.04, 0.08, S.span + 0.04), materials.accent);
      band.position.set(s * S.wallX, S.tunnelTop + (S.height - S.tunnelTop) * 0.2, 0);
      group.add(band);
    }
    const roofH = S.height - S.tunnelTop;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(S.width, roofH, S.span), materials.body);
    roof.position.set(0, S.tunnelTop + roofH / 2, 0);
    group.add(roof);
    const cavity = new THREE.Mesh(new THREE.BoxGeometry(S.tunnelWidth - 0.02, S.tunnelTop - cavityBottom, S.span * 0.99), materials.cavity);
    cavity.position.y = cavityBottom + (S.tunnelTop - cavityBottom) / 2;
    group.add(cavity);
    for (const s of mouths) {
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(S.tunnelWidth, 0.08, 0.09), materials.dark);
      lintel.position.set(0, S.tunnelTop - 0.04, s * S.span / 2 - 0.045);
      group.add(lintel);
    }
    if (sidePort) {
      const surround = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth + 0.06, 0.08, portZ + 0.08), materials.dark);
      surround.position.set(sidePort * S.wallX, portTop - 0.04, 0);
      group.add(surround);
      for (const z of [-1, 1]) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth + 0.06, portTop, 0.08), materials.dark);
        jamb.position.set(sidePort * S.wallX, portTop / 2, z * (portZ / 2 + 0.04));
        group.add(jamb);
      }
    }
    const faceS = sidePort === 1 ? -1 : 1;
    const faceX = faceS * (S.wallX + S.wallWidth / 2);
    const faceH = Math.min(1 * k, S.tunnelTop * 0.8);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.06, faceH, Math.min(1.25 * k, S.span * 0.6)), materials.panel);
    face.position.set(faceX, S.tunnelTop * 0.66, 0);
    group.add(face);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.05, faceH * 0.36, faceH * 0.55), materials.dark);
    screen.position.set(faceX + faceS * 0.04, S.tunnelTop * 0.66 + faceH * 0.24, 0.2 * k);
    group.add(screen);
    for (let i = 0;i < 3; i++) {
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.1), i === 0 ? materials.accent : materials.dark);
      knob.position.set(faceX + faceS * 0.04, S.tunnelTop * 0.66 - faceH * 0.28, (-0.26 + i * 0.22) * k);
      group.add(knob);
    }
    const duct = new THREE.Mesh(new THREE.BoxGeometry(0.44 * k, 0.52 * k, 0.44 * k), materials.panel);
    duct.position.set(-S.width * 0.25, S.height + 0.26 * k, -S.span * 0.19);
    group.add(duct);
    const ductCap = new THREE.Mesh(new THREE.BoxGeometry(0.62 * k, 0.12 * k, 0.62 * k), materials.body);
    ductCap.position.set(-S.width * 0.25, S.height + 0.58 * k, -S.span * 0.19);
    group.add(ductCap);
    let lampMat = null;
    if (!qa) {
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34 * k, 0.07), materials.dark);
      mast.position.set(S.width * 0.3, S.height + 0.17 * k, S.span * 0.24);
      group.add(mast);
      lampMat = new THREE.MeshStandardMaterial({
        color: PALETTE.lampIdle,
        emissive: new THREE.Color(PALETTE.lampBusy),
        emissiveIntensity: 0,
        roughness: 0.4
      });
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2 * k, 0.2 * k, 0.2 * k), lampMat);
      lamp.position.set(S.width * 0.3, S.height + 0.44 * k, S.span * 0.24);
      group.add(lamp);
    }
    let qaGreen = null;
    let qaRed = null;
    if (qa) {
      const towerMast = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34 * k, 0.07), materials.dark);
      towerMast.position.set(S.width * 0.3, S.height + 0.17 * k, -S.span * 0.32);
      group.add(towerMast);
      const lampGeo = new THREE.BoxGeometry(0.18 * k, 0.18 * k, 0.18 * k);
      const make = (hex) => new THREE.MeshStandardMaterial({
        color: PALETTE.lampIdle,
        emissive: new THREE.Color(hex),
        emissiveIntensity: 0,
        roughness: 0.4
      });
      qaGreen = { mesh: new THREE.Mesh(lampGeo, make(PALETTE.lampPass)), pulse: 0 };
      qaGreen.mesh.position.set(S.width * 0.3, S.height + 0.43 * k, -S.span * 0.32);
      qaRed = { mesh: new THREE.Mesh(lampGeo, make(PALETTE.lampFail)), pulse: 0 };
      qaRed.mesh.position.set(S.width * 0.3, S.height + 0.63 * k, -S.span * 0.32);
      group.add(qaGreen.mesh, qaRed.mesh);
    }
    const pressHalf = 0.11 * k;
    const cartonTop = belt.deckTop + DIMS.boxHeight * 1.06 + 0.06 * 1.06 + 0.015;
    const restY = Math.min(S.height - 0.71 * k, Math.max(S.tunnelTop - 0.1 + pressHalf, cartonTop + pressHalf + 0.02));
    const press = new THREE.Group;
    const pressBody = new THREE.Mesh(new THREE.BoxGeometry(S.tunnelWidth * 0.56, 0.22 * k, S.span * 0.22), materials.panel);
    press.add(pressBody);
    for (const s of [1, -1]) {
      const rod = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.6 * k, 0.07), materials.dark);
      rod.position.set(s * S.tunnelWidth * 0.17, 0.41 * k, 0);
      press.add(rod);
    }
    press.position.y = restY;
    group.add(press);
    for (let i = 0;i <= index; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, S.span * 0.26), materials.accent);
      stripe.position.set(-S.width / 2 + 0.38 + i * 0.22, S.height + 0.01, S.span * 0.16);
      group.add(stripe);
    }
    let busyPulse = 0;
    return {
      group,
      update(elapsed, workY = null, qaState = "idle") {
        const busy = workY != null;
        busyPulse += ((busy ? 1 : 0) - busyPulse) * 0.12;
        if (lampMat) {
          lampMat.emissiveIntensity = busyPulse * (0.55 + 0.45 * Math.sin(elapsed * 7));
          lampMat.emissive.setHex(PALETTE.lampBusy);
          lampMat.color.setHex(busyPulse > 0.5 ? PALETTE.lampBusy : PALETTE.lampIdle);
        }
        if (qaGreen && qaRed) {
          for (const [lampPair, on, hex] of [
            [qaGreen, qaState === "pass", "lampPass"],
            [qaRed, qaState === "fail", "lampFail"]
          ]) {
            lampPair.pulse += ((on ? 1 : 0) - lampPair.pulse) * 0.16;
            lampPair.mesh.material.emissive.setHex(PALETTE[hex]);
            lampPair.mesh.material.emissiveIntensity = lampPair.pulse * 1.25;
            lampPair.mesh.material.color.setHex(lampPair.pulse > 0.5 ? PALETTE[hex] : PALETTE.lampIdle);
          }
        }
        const reach = busy ? Math.max(0, restY - pressHalf - workY - 0.02) : 0;
        const stroke = busyPulse * reach * (0.5 + 0.5 * Math.sin(elapsed * 6 - Math.PI / 2));
        press.position.y = restY - stroke;
      }
    };
  }
  function createFeeder() {
    const materials = sharedMaterials();
    const group = new THREE.Group;
    group.name = "feeder";
    const S = stationMetrics();
    const belt = beltMetrics();
    const span = S.span * 0.74;
    const height = Math.max(S.tunnelTop + 0.35, S.height * 0.85);
    const k = Math.min(S.width / 2.9, S.height / 2.6);
    for (const s of [1, -1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth, height, span), materials.body);
      wall.position.set(s * S.wallX, height / 2, 0);
      group.add(wall);
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(S.wallWidth + 0.14, 0.18, span + 0.14), materials.dark);
      plinth.position.set(s * S.wallX, 0.09, 0);
      group.add(plinth);
    }
    const roofH = height - S.tunnelTop;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(S.width, roofH, span), materials.body);
    roof.position.set(0, S.tunnelTop + roofH / 2, 0);
    group.add(roof);
    const cavityBottom = belt.deckBottom - 0.04;
    const cavity = new THREE.Mesh(new THREE.BoxGeometry(S.tunnelWidth - 0.02, S.tunnelTop - cavityBottom, span * 0.99), materials.cavity);
    cavity.position.y = cavityBottom + (S.tunnelTop - cavityBottom) / 2;
    group.add(cavity);
    const back = new THREE.Mesh(new THREE.BoxGeometry(S.tunnelWidth, S.tunnelTop, 0.18), materials.body);
    back.position.set(0, S.tunnelTop / 2, -span / 2 + 0.09);
    group.add(back);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(S.tunnelWidth, 0.08, 0.09), materials.dark);
    lintel.position.set(0, S.tunnelTop - 0.04, span / 2 - 0.045);
    group.add(lintel);
    for (let i = 0;i < 3; i++) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.5 * k, 0.34 * k, 0.5 * k), materials.panel);
      crate.position.set((-0.36 + i % 2 * 0.58) * k, height + (0.17 + Math.floor(i / 2) * 0.34) * k, 0.08 * i * k);
      crate.rotation.y = (i - 1) * 0.12;
      group.add(crate);
    }
    return { group, span };
  }

  // src/rocket.js
  var RAMP_ANGLE = 15 * (Math.PI / 180);
  var RAMP_RISE = 1;
  var _materials2 = null;
  function sharedMaterials2() {
    return _materials2 ??= {
      shell: standardMaterial("rocketShell", { roughness: 0.85 }),
      paint: standardMaterial("rocketPaint", { roughness: 0.7 }),
      trim: standardMaterial("rocketTrim", { roughness: 0.85 }),
      window: standardMaterial("rocketWindow", { roughness: 0.35 })
    };
  }
  function createRocketLoader(belt) {
    const group = new THREE.Group;
    group.name = "loader";
    const y0 = belt.deckTop;
    const cos = Math.cos(RAMP_ANGLE);
    const sin = Math.sin(RAMP_ANGLE);
    const run = RAMP_RISE / Math.tan(RAMP_ANGLE);
    const len = run / cos + 0.5;
    const bodyR = 1.32;
    const rocketZ = run + bodyR + 0.5;
    const ramp = buildRamp(group, belt, y0, len);
    buildRocket(group, rocketZ);
    return {
      group,
      ramp: {
        angle: RAMP_ANGLE,
        cos,
        sin,
        y0,
        len,
        loadAt: (run + 1.2) / cos
      },
      update(scroll) {
        ramp.deck.material.map.offset.x = -scroll / TREAD_REPEAT;
      }
    };
  }
  function buildRamp(group, belt, y0, len) {
    const hw = belt.halfWidth;
    const cos = Math.cos(RAMP_ANGLE);
    const sin = Math.sin(RAMP_ANGLE);
    const tc = len / 2;
    const deckGeo = new THREE.BoxGeometry(hw * 2, 0.14, len + 0.3);
    const uv = deckGeo.attributes.uv;
    const pos = deckGeo.attributes.position;
    for (let i = 0;i < uv.count; i++)
      uv.setXY(i, pos.getZ(i), pos.getX(i));
    const deck = new THREE.Mesh(deckGeo, standardMaterial("beltDark", { roughness: 0.85, map: treadTexture(belt.width) }));
    deck.position.set(0, y0 + tc * sin, tc * cos).add(new THREE.Vector3(0, -Math.cos(RAMP_ANGLE), Math.sin(RAMP_ANGLE)).multiplyScalar(0.07));
    deck.rotation.x = -RAMP_ANGLE;
    group.add(deck);
    const railGeo = new THREE.BoxGeometry(0.1, 0.3, len + 0.25);
    const railMat = standardMaterial("beltFrame", { roughness: 0.95 });
    for (const side of [1, -1]) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(side * (hw + 0.06), y0 + tc * sin - 0.19, tc * cos);
      rail.rotation.x = -RAMP_ANGLE;
      group.add(rail);
    }
    const legMat = standardMaterial("beltFrameShade", { roughness: 0.95 });
    for (const t of [0.7, 2, 3.1]) {
      if (t > len - 0.4)
        break;
      const height = y0 + t * sin - 0.16;
      const legGeo = new THREE.BoxGeometry(0.12, height, 0.12);
      for (const side of [1, -1]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(side * (hw + 0.06), height / 2, t * cos);
        group.add(leg);
      }
    }
    return { deck };
  }
  function buildRocket(group, z) {
    const materials = sharedMaterials2();
    const hull = new THREE.Group;
    hull.position.set(0, 0, z);
    group.add(hull);
    const profile = [
      [0.01, 0.56],
      [0.72, 0.5],
      [0.98, 0.95],
      [1.18, 1.55],
      [1.3, 2.15],
      [1.32, 2.55],
      [1.24, 3.1],
      [1.05, 3.65],
      [0.82, 4.1],
      [0.62, 4.32]
    ].map(([x, y]) => new THREE.Vector2(x, y));
    hull.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 14), materials.shell));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.3, 14), materials.paint);
    nose.position.y = 4.9;
    hull.add(nose);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.92, 0.62, 14), materials.trim);
    skirt.position.y = 0.31;
    hull.add(skirt);
    const finGeo = new THREE.ExtrudeGeometry(finShape(), { depth: 0.1, bevelEnabled: false });
    for (const azimuth of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) {
      const fin = new THREE.Mesh(finGeo, materials.paint);
      fin.rotation.y = -azimuth;
      hull.add(fin);
    }
    addPorthole(hull, Math.PI / 2, 2.72, 1.31);
  }
  function finShape() {
    const s = new THREE.Shape;
    s.moveTo(0.45, 1.75);
    s.quadraticCurveTo(1.55, 1.15, 1.68, 0.02);
    s.lineTo(0.95, 0.02);
    s.quadraticCurveTo(1, 0.85, 0.45, 1.75);
    return s;
  }
  function addPorthole(hull, azimuth, y, r) {
    const materials = sharedMaterials2();
    const pocket = new THREE.Group;
    pocket.position.set(Math.cos(azimuth) * r, y, Math.sin(azimuth) * r);
    pocket.rotation.y = Math.PI / 2 - azimuth;
    hull.add(pocket);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.075, 8, 18), materials.trim);
    ring.position.z = 0.02;
    pocket.add(ring);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.27, 16), materials.window);
    glass.position.z = 0.045;
    pocket.add(glass);
  }

  // src/box.js
  var shared = null;
  function materials() {
    shared ??= {
      body: standardMaterial("cardboard", { roughness: 0.94 }),
      flap: standardMaterial("cardboardFlap", { roughness: 0.95 }),
      seam: standardMaterial("cardboardDark", { roughness: 0.95 }),
      tape: standardMaterial("tape", { roughness: 0.6 }),
      label: standardMaterial("label", { roughness: 0.9 }),
      stamp: standardMaterial("stamp", { roughness: 0.9 })
    };
    return shared;
  }
  function createBox() {
    const m = materials();
    const B = boxMetrics();
    const group = new THREE.Group;
    group.rotation.order = "YXZ";
    const body = new THREE.Mesh(new THREE.BoxGeometry(B.w, B.h, B.d), m.body);
    group.add(body);
    const flapGeo = new THREE.BoxGeometry(B.w * 0.99, 0.04, B.d * 0.48);
    for (const s of [1, -1]) {
      const flap = new THREE.Mesh(flapGeo, m.flap);
      flap.position.set(0, B.h / 2 + 0.02, s * B.d / 4.1);
      group.add(flap);
    }
    const seam = new THREE.Mesh(new THREE.BoxGeometry(B.w * 0.99, 0.014, 0.03), m.seam);
    seam.position.set(0, B.h / 2 + 0.045, 0);
    group.add(seam);
    const label = new THREE.Mesh(new THREE.BoxGeometry(B.w * 0.42, B.h * 0.34, 0.01), m.label);
    label.position.set(B.w * 0.08, B.h * 0.05, B.d / 2 + 0.005);
    group.add(label);
    const tape = new THREE.Group;
    const tapeTop = new THREE.Mesh(new THREE.BoxGeometry(B.w * 0.99, 0.012, B.d * 0.18), m.tape);
    tapeTop.position.y = B.h / 2 + 0.046;
    tape.add(tapeTop);
    for (const s of [1, -1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(B.w * 0.99, B.h * 0.17, 0.012), m.tape);
      side.position.set(0, B.h / 2 - B.h * 0.07, s * B.d / 2 + 0.004);
      tape.add(side);
    }
    group.add(tape);
    const stamp = new THREE.Mesh(new THREE.BoxGeometry(B.w * 0.2, B.w * 0.2, 0.01), m.stamp);
    stamp.rotation.z = Math.PI / 4;
    stamp.position.set(-B.w * 0.27, -B.h * 0.17, B.d / 2 + 0.006);
    group.add(stamp);
    const stages = [[label], [tape, stamp]];
    const api = {
      group,
      height: B.h,
      stage: 0,
      setStage(stage) {
        if (api.stage === stage)
          return;
        api.stage = stage;
        stages.forEach((parts, i) => {
          for (const p of parts)
            p.visible = i < stage;
        });
      }
    };
    api.setStage(0);
    return api;
  }

  // src/floor.js
  function buildFloor({ size = 90, cell = 2.5 } = {}) {
    const group = new THREE.Group;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), standardMaterial("floor", {
      roughness: 1,
      transparent: true,
      alphaMap: fadeTexture(),
      depthWrite: false
    }));
    ground.rotation.x = -Math.PI / 2;
    group.add(ground);
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(size, size), basicMaterial("grid", { map: gridTexture(size, cell), transparent: true, depthWrite: false }));
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = 0.012;
    grid.renderOrder = 1;
    group.add(grid);
    return group;
  }
  function fadeTexture() {
    const res = 512;
    const canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext("2d");
    const ramp = ctx.createRadialGradient(res / 2, res / 2, res * 0.1, res / 2, res / 2, res * 0.5);
    ramp.addColorStop(0, "#ffffff");
    ramp.addColorStop(0.62, "#d8d8d8");
    ramp.addColorStop(1, "#000000");
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, res, res);
    return new THREE.CanvasTexture(canvas);
  }
  function gridTexture(size, cell) {
    const res = 2048;
    const pxPerUnit = res / size;
    const canvas = document.createElement("canvas");
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = "#ffffff";
    const draw = (every, width) => {
      ctx.lineWidth = Math.max(1, pxPerUnit * width);
      ctx.beginPath();
      for (let i = 0;i <= Math.round(size / cell); i += every) {
        const p = Math.round(i * cell * pxPerUnit) + 0.5;
        ctx.moveTo(p, 0);
        ctx.lineTo(p, res);
        ctx.moveTo(0, p);
        ctx.lineTo(res, p);
      }
      ctx.stroke();
    };
    draw(1, 0.035);
    draw(4, 0.07);
    const fade = ctx.createRadialGradient(res / 2, res / 2, res * 0.06, res / 2, res / 2, res * 0.46);
    fade.addColorStop(0, "rgba(0,0,0,1)");
    fade.addColorStop(0.55, "rgba(0,0,0,0.75)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, res, res);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  // src/effects.js
  var EFFECTS = {
    tiltShift: 0.28,
    tiltBand: 0.06
  };
  var DEFAULTS3 = { ...EFFECTS };
  function setEffect(key, value) {
    if (!(key in EFFECTS))
      throw new Error(`unknown effect: ${key}`);
    EFFECTS[key] = value;
  }
  function resetEffects() {
    Object.assign(EFFECTS, DEFAULTS3);
  }
  var TiltShiftShader = {
    name: "TiltShiftShader",
    vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
    fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float band;
    uniform vec2 texel;
    varying vec2 vUv;

    // Fixed 12-point disk; organic spread without a visible ring pattern.
    const vec2 DISK[12] = vec2[12](
      vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457),
      vec2(-0.203, 0.621), vec2(0.962, -0.195), vec2(0.473, -0.480),
      vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064),
      vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(0.772, -0.715)
    );

    void main() {
      vec4 sharp = texture2D(tDiffuse, vUv);
      if (strength <= 0.0) {
        gl_FragColor = sharp;
        #include <colorspace_fragment>
        return;
      }

      float d = abs(vUv.y - 0.5);
      float t = smoothstep(band, min(band + 0.22, 0.5), d);
      t *= t; // quadratic ramp: gentle near the focus line, deep at the edges

      float radius = t * strength * 22.0;
      vec2 offsetScale = texel * radius;
      vec4 blur = sharp;
      for (int i = 0; i < 12; i++) blur += texture2D(tDiffuse, vUv + DISK[i] * offsetScale);
      blur /= 13.0;

      vec4 color = mix(sharp, blur, t);

      // Miniatures read oversaturated at the focal plane; fade to neutral in
      // the blur so the eye stays on the line.
      float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      color.rgb = mix(vec3(luma), color.rgb, 1.0 + 0.12 * (1.0 - t));

      gl_FragColor = color;
      #include <colorspace_fragment>
    }
  `
  };
  function createPostFX(renderer, scene, camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2);
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4
    });
    const uniforms = {
      tDiffuse: { value: null },
      strength: { value: 0 },
      band: { value: 0.24 },
      texel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) }
    };
    const material = new THREE.ShaderMaterial({
      name: TiltShiftShader.name,
      uniforms,
      vertexShader: TiltShiftShader.vertexShader,
      fragmentShader: TiltShiftShader.fragmentShader,
      depthTest: false,
      depthWrite: false
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene;
    quadScene.add(quad);
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return {
      setSize() {
        const buf = renderer.getDrawingBufferSize(new THREE.Vector2);
        target.setSize(buf.x, buf.y);
        uniforms.texel.value.set(1 / buf.x, 1 / buf.y);
      },
      render(effects) {
        uniforms.strength.value = effects.tiltShift;
        uniforms.band.value = effects.tiltBand;
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        uniforms.tDiffuse.value = target.texture;
        renderer.render(quadScene, quadCamera);
      },
      dispose() {
        target.dispose();
        geometry.dispose();
        material.dispose();
      }
    };
  }

  // src/factory-view.js
  var DEFAULT_CONFIG = {
    outline: [
      [-21, -9],
      [-7, -9],
      [-7, 8],
      [7, 8],
      [7, -9],
      [17.5, -9]
    ],
    beltSpeed: 1.9,
    boxSpacing: 6.13,
    boxDwell: 0.9,
    viewSize: 33,
    rejectChance: 0.25,
    boxQueueGap: 1.95
  };
  var DEFAULT_HOME = { target: [4.4, 3.2, -5.9], distance: 120 };
  var EASE = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  class FactoryView {
    constructor(container, options = {}) {
      if (!container)
        throw new TypeError("FactoryView needs a container element");
      if (options.three)
        setThree(options.three);
      else
        getThree();
      this.options = options;
      this.config = { ...DEFAULT_CONFIG, ...options.config };
      this.focusDuration = options.focusDuration ?? 0.8;
      this.zoomRange = options.zoomRange ?? [0.3, 16];
      this.interactive = options.interactive !== false;
      this.onStats = options.onStats ?? null;
      this.root = document.createElement("div");
      this.root.style.cssText = "position:absolute;inset:0;overflow:hidden";
      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:none";
      this.anchorLayer = document.createElement("div");
      this.anchorLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
      this.root.append(this.canvas, this.anchorLayer);
      this._container = container;
      this._containerWasStatic = getComputedStyle(container).position === "static";
      if (this._containerWasStatic)
        container.style.position = "relative";
      container.append(this.root);
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.shadowMap.enabled = false;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.scene = new THREE.Scene;
      this.scene.background = new THREE.Color;
      this._unbind = [bind("paper", (hex) => this.scene.background.setHex(hex))];
      this.isoDir = new THREE.Vector3(1, 1, 1).normalize();
      this.home = {
        target: new THREE.Vector3(...options.homeTarget ?? DEFAULT_HOME.target),
        distance: DEFAULT_HOME.distance
      };
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
      if (options.tiltShift === false)
        EFFECTS.tiltShift = 0;
      else if (typeof options.tiltShift === "number")
        EFFECTS.tiltShift = options.tiltShift;
      this.postfx = createPostFX(this.renderer, this.scene, this.camera);
      this.zoom = this._clampedZoom(options.zoom ?? 1);
      this.target = this.home.target.clone();
      this.desiredTarget = this.target.clone();
      this.desiredZoom = this.zoom;
      this.tween = null;
      this.damping = options.damping ?? 14;
      const lights = buildLights();
      this._unbind.push(lights.unbind);
      this.scene.add(lights.group, buildFloor());
      this.world = { group: null };
      this.pool = [];
      this.active = [];
      this.namedPoints = new Map;
      this._spawnTimer = 0;
      this._boxIdSeq = 0;
      this._tmpVec = new THREE.Vector3;
      this.elapsed = 0;
      this.processed = 0;
      this.paused = false;
      this.buildWorld();
      this._rebuildQueued = false;
      this._unsubDimensions = onDimensionsChange(() => {
        if (this._rebuildQueued)
          return;
        this._rebuildQueued = true;
        requestAnimationFrame(() => {
          this._rebuildQueued = false;
          this.buildWorld();
        });
      });
      this._pointers = new Map;
      this._listeners = [];
      this._anchors = new Set;
      if (this.interactive)
        this._bindPointerControls();
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.root);
      this.resize();
      this.timer = new THREE.Timer;
      this._raf = requestAnimationFrame(this._frame);
    }
    get speed() {
      return this.config.beltSpeed;
    }
    set speed(value) {
      this.config.beltSpeed = value;
    }
    get processedCount() {
      return this.processed;
    }
    getElementIds() {
      const ids = ["home", "feeder"];
      this.world.stations.forEach((_, i) => ids.push(`machine-${i + 1}`));
      ids.push("return", "rocket");
      return ids;
    }
    getElements() {
      return [
        { id: "home", type: "view", label: "Full line" },
        { id: "feeder", type: "machine", label: "Feeder" },
        ...this.world.stations.map((_, i) => ({ id: `machine-${i + 1}`, type: "machine", label: `Machine ${i + 1}` })),
        { id: "return", type: "belt", label: "Return lane" },
        { id: "rocket", type: "rocket", label: "Rocket" }
      ];
    }
    getBoxes({ onlyOnScreen = true } = {}) {
      const out = [];
      for (const box of this.active) {
        const screen = this.getScreenPosition(box.id);
        if (!screen)
          continue;
        if (onlyOnScreen && !screen.onScreen)
          continue;
        const onLane = box.track === "return";
        out.push({
          id: box.id,
          distance: box.distance,
          progress: onLane ? box.distance / this.world.returnPath.length : box.distance / this.world.path.length,
          stage: onLane ? 0 : box.distance >= this.world.ramp.from ? 3 : box.stage,
          belt: box.track,
          working: box.dwell > 0,
          position: {
            x: box.group.position.x,
            y: box.group.position.y,
            z: box.group.position.z
          },
          screen
        });
      }
      out.sort((a, b) => a.distance - b.distance);
      return out;
    }
    getScreenPosition(id) {
      const point = this.resolvePoint(id);
      if (!point)
        return null;
      this.camera.updateMatrixWorld();
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      const v = point.applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix);
      return {
        x: (v.x + 1) / 2 * this.root.clientWidth,
        y: (1 - v.y) / 2 * this.root.clientHeight,
        onScreen: Math.abs(v.x) <= 1.02 && Math.abs(v.y) <= 1.02 && v.z < 1
      };
    }
    resolvePoint(id) {
      if (id && typeof id === "object" && "id" in id)
        id = id.id;
      if (typeof id === "number") {
        const box = this.active.find((b) => b.id === id);
        return box ? box.group.position.clone() : null;
      }
      if (id === "home" || id === "line" || id === "all")
        return this.home.target.clone();
      if (id === "loader")
        id = "rocket";
      return this.namedPoints.get(id)?.clone() ?? null;
    }
    createAnchor(id, { offsetX = 0, offsetY = 0, className = "" } = {}) {
      if (!this.resolvePoint(id))
        throw new Error(`FactoryView: unknown anchor target "${id}"`);
      const node = document.createElement("div");
      if (className)
        node.className = className;
      node.style.cssText = "position:absolute;left:0;top:0;display:none;will-change:transform";
      node.dataset.factoryAnchor = String(id);
      this.anchorLayer.append(node);
      this._anchors.add({ id, offsetX, offsetY, node });
      return node;
    }
    removeAnchor(node) {
      for (const anchor of this._anchors) {
        if (anchor.node === node) {
          anchor.node.remove();
          this._anchors.delete(anchor);
          return true;
        }
      }
      return false;
    }
    pause() {
      this.paused = true;
    }
    resume() {
      this.paused = false;
    }
    togglePaused() {
      this.paused = !this.paused;
      return this.paused;
    }
    advance(seconds = 1 / 60) {
      let left = Math.max(0, Math.min(seconds, 60));
      while (left > 0) {
        const dt = Math.min(left, 1 / 60);
        this._simulate(dt);
        left -= dt;
      }
    }
    panBy(dx, dy, { smooth = true, duration = this.focusDuration } = {}) {
      const { right, up } = this._screenBasis();
      const w = this.root.clientWidth;
      const h = this.root.clientHeight;
      const px = typeof dx === "string" ? parseFloat(dx) / 100 * w : Number(dx) || 0;
      const py = typeof dy === "string" ? parseFloat(dy) / 100 * h : Number(dy) || 0;
      const spp = this._worldPerPixel(this.desiredZoom);
      const to = this.desiredTarget.clone().addScaledVector(right, -px * spp).addScaledVector(up, py * spp);
      this._moveTo(to, this.desiredZoom, smooth, duration);
    }
    panTo(x, z, { smooth = true, duration = this.focusDuration } = {}) {
      this._moveTo(new THREE.Vector3(x, this.target.y, z), this.desiredZoom, smooth, duration);
    }
    get zoomLevel() {
      return this.zoom;
    }
    set zoomLevel(value) {
      this.zoomTo(value);
    }
    zoomTo(value, { smooth = true, duration = 0.35 } = {}) {
      this._moveTo(this.desiredTarget, this._clampedZoom(value), smooth, smooth ? duration : 0);
    }
    zoomBy(factor, { smooth = true } = {}) {
      this.zoomTo(this.desiredZoom * factor, { smooth });
    }
    focusOn(id, { smooth = true, duration, offset, zoom } = {}) {
      const point = this.resolvePoint(id);
      if (!point)
        return false;
      const ox = parsePercent(offset?.x) ?? 0;
      const oy = parsePercent(offset?.y) ?? 0;
      const toZoom = this._clampedZoom(zoom ?? this.desiredZoom);
      const { right, up } = this._screenBasis();
      const worldHeight = this.config.viewSize / toZoom;
      const worldWidth = worldHeight * (this.root.clientWidth / Math.max(1, this.root.clientHeight));
      const to = point.clone().addScaledVector(right, -ox / 100 * worldWidth).addScaledVector(up, oy / 100 * worldHeight);
      this._moveTo(to, toZoom, smooth, duration ?? this.focusDuration);
      return true;
    }
    resetView(opts = {}) {
      return this.focusOn("home", { zoom: this.options.zoom ?? 1, ...opts });
    }
    resize() {
      const w = this.root.clientWidth || 1;
      const h = this.root.clientHeight || 1;
      const half = this.config.viewSize / 2;
      this.camera.left = -half * (w / h);
      this.camera.right = half * (w / h);
      this.camera.top = half;
      this.camera.bottom = -half;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      this.postfx.setSize();
    }
    dispose() {
      cancelAnimationFrame(this._raf);
      this._resizeObserver.disconnect();
      for (const [node, type, fn, opts] of this._listeners)
        node.removeEventListener(type, fn, opts);
      this._unsubDimensions();
      for (const off of this._unbind)
        off();
      if (this.world.group) {
        this.scene.remove(this.world.group);
        disposeGroup(this.world.group);
      }
      for (const box of [...this.active, ...this.pool])
        disposeGroup(box.group);
      this.active.length = 0;
      this.pool.length = 0;
      for (const anchor of this._anchors)
        anchor.node.remove();
      this._anchors.clear();
      this.postfx.dispose();
      disposeGroup(this.scene);
      this.renderer.dispose();
      this.root.remove();
      if (this._containerWasStatic)
        this._container.style.position = "";
    }
    _clampedZoom(value) {
      return Math.min(this.zoomRange[1], Math.max(this.zoomRange[0], value));
    }
    buildWorld() {
      if (this.world.group) {
        this.scene.remove(this.world.group);
        disposeGroup(this.world.group);
      }
      for (const box of [...this.active, ...this.pool])
        disposeGroup(box.group);
      this.active.length = 0;
      this.pool.length = 0;
      this.namedPoints.clear();
      const config = this.config;
      const group = new THREE.Group;
      group.name = "line";
      const path = new ConveyorPath(config.outline, DIMS.cornerRadius, 0.12, { closed: false });
      const feeder = createFeeder();
      const feederCentre = feeder.span / 2 - 0.35;
      const feederMouth = feederCentre + feeder.span / 2;
      placeOnPath(path, feeder.group, feederCentre);
      group.add(feeder.group);
      const S = stationMetrics();
      const halfSpan = S.span / 2;
      const feederExit = feederMouth - 0.3;
      const spots = [
        path.straightestSpot(halfSpan * 1.15, feederExit + halfSpan + 0.5, path.length * 0.42),
        path.straightestSpot(halfSpan * 1.15, path.length * 0.45, path.length - halfSpan * 4.4)
      ];
      const p1 = path.positionAt(spots[0], new THREE.Vector3);
      const p2 = path.positionAt(spots[1], new THREE.Vector3);
      const ports = spots.map((distance, i) => {
        const h = path.headingAt(distance);
        const nx = Math.cos(h);
        const nz = -Math.sin(h);
        const mine = i === 0 ? p1 : p2;
        const other = i === 0 ? p2 : p1;
        return nx * (other.x - mine.x) + nz * (other.z - mine.z) > 0 ? 1 : -1;
      });
      const stations = spots.map((distance, i) => {
        const station = createStation(i, { qa: i === 1, sidePort: ports[i] });
        placeOnPath(path, station.group, distance);
        station.distance = distance;
        group.add(station.group);
        return station;
      });
      const m1Distance = spots[0];
      const conveyorFeed = buildConveyor(path.subpath(0, m1Distance));
      const conveyorRun = buildConveyor(path.subpath(m1Distance, path.length));
      group.add(conveyorFeed.group, conveyorRun.group);
      const lane = new THREE.Vector3().subVectors(p1, p2).setY(0);
      const laneLength = lane.length();
      lane.multiplyScalar(1 / laneLength);
      const returnPath = new ConveyorPath([
        [p2.x, p2.z],
        [p1.x, p1.z]
      ], DIMS.cornerRadius, 0.12, { closed: false });
      const ext = 0.4;
      const returnBelt = buildConveyor(new ConveyorPath([
        [p2.x - lane.x * ext, p2.z - lane.z * ext],
        [p1.x + lane.x * ext, p1.z + lane.z * ext]
      ], DIMS.cornerRadius, 0.12, { closed: false }));
      returnBelt.group.position.y -= 0.006;
      group.add(returnBelt.group);
      const portHold = S.wallX + S.wallWidth / 2 + 0.3;
      const loader = createRocketLoader(beltMetrics());
      placeOnPath(path, loader.group, path.length);
      group.add(loader.group);
      const endTangent = path.tangentAt(path.length, new THREE.Vector3);
      const endBase = path.positionAt(path.length, new THREE.Vector3);
      const ramp = {
        ...loader.ramp,
        from: path.length,
        dir: endTangent,
        normal: new THREE.Vector3(-endTangent.x * loader.ramp.sin, loader.ramp.cos, -endTangent.z * loader.ramp.sin),
        base: endBase
      };
      this.world = {
        group,
        path,
        conveyorFeed,
        conveyorRun,
        feeder,
        feederMouth,
        feederExit,
        stations,
        loader,
        ramp,
        endHeading: path.headingAt(path.length),
        halfSpan,
        returnBelt,
        returnPath,
        portHold
      };
      this._phase = { feed: 0, run: 0, lane: 0 };
      this._qa = { state: "idle", timer: 0 };
      this.scene.add(group);
      this.scene.updateMatrixWorld(true);
      const box3 = new THREE.Box3;
      const centre = (object) => box3.setFromObject(object).getCenter(new THREE.Vector3);
      this.namedPoints.set("feeder", centre(feeder.group));
      stations.forEach((s, i) => this.namedPoints.set(`machine-${i + 1}`, centre(s.group)));
      this.namedPoints.set("return", centre(returnBelt.group));
      this.namedPoints.set("rocket", centre(loader.group));
      this._spawnTimer = 0;
      const m1 = stations[0];
      const m2 = stations[1];
      const firstSpawn = feederMouth - DIMS.boxDepth * 0.86 / 2;
      for (let d = firstSpawn;d < ramp.from + ramp.loadAt; d += config.boxSpacing) {
        const box = this._spawnBox(d);
        box.visits = d > m2.distance ? 1 : 0;
        box.setStage((d > m1.distance ? 1 : 0) + (d > m2.distance ? 1 : 0));
      }
      const seeded = this._spawnBox(returnPath.length * 0.5);
      seeded.track = "return";
      seeded.visits = 1;
      seeded.setStage(0);
    }
    _spawnBox(distance = null) {
      const box = this.pool.pop() ?? createBox();
      const size = 0.86 + Math.random() * 0.2;
      box.group.scale.setScalar(size);
      box.group.visible = false;
      box.id = ++this._boxIdSeq;
      box.distance = distance ?? this.world.feederMouth - DIMS.boxDepth * size / 2;
      box.spawn = box.distance;
      box.size = size;
      box.yaw = (Math.random() - 0.5) * 0.07;
      box.lift = box.height / 2 * size + 0.015;
      box.dwell = 0;
      box.work = null;
      box.track = "main";
      box.visits = 0;
      box.qa = null;
      box.setStage(0);
      this.scene.add(box.group);
      this.active.push(box);
      return box;
    }
    _retireBox(box) {
      this.scene.remove(box.group);
      this.pool.push(box);
    }
    _simulate(dt) {
      const config = this.config;
      const world = this.world;
      this.elapsed += dt;
      const ramp = world.ramp;
      const tmpPos = this._tmpVec;
      const stations = world.stations;
      const m1 = stations[0];
      const m2 = stations[1];
      const laneLength = world.returnPath.length;
      const hold = world.portHold;
      for (const box of this.active) {
        if (box.dwell <= 0)
          continue;
        box.dwell = Math.max(0, box.dwell - dt);
        if (box.dwell > 0)
          continue;
        const station = box.work;
        box.work = null;
        if (station === m1) {
          if (box.track === "return") {
            box.track = "main";
            box.distance = m1.distance;
          }
          box.setStage(1);
        } else if (box.qa === "fail") {
          let rear = Infinity;
          for (const b of this.active)
            if (b.track === "return")
              rear = Math.min(rear, b.distance);
          if (rear >= config.boxQueueGap) {
            box.track = "return";
            box.distance = 0;
            box.qa = null;
            box.setStage(0);
          } else {
            box.dwell = 0.2;
            box.work = station;
          }
        } else
          box.setStage(2);
      }
      let m1Held = this.active.some((b) => b.work === m1);
      const heldAtStart = m1Held;
      const m2Held = this.active.some((b) => b.work === m2);
      if (!heldAtStart) {
        this._spawnTimer += dt;
        const spawnInterval = config.boxSpacing / config.beltSpeed;
        while (this._spawnTimer >= spawnInterval) {
          this._spawnTimer -= spawnInterval;
          this._spawnBox();
        }
      }
      const work = new Map;
      for (let i = this.active.length - 1;i >= 0; i--) {
        const box = this.active[i];
        if (box.track === "return") {
          const entry = laneLength - hold;
          if (box.dwell > 0) {} else if (box.work === m1) {
            box.distance = Math.min(box.distance + config.beltSpeed * dt, laneLength);
            if (box.distance >= laneLength - 0.000000001) {
              box.distance = laneLength;
              box.dwell = config.boxDwell;
            }
          } else if (m1Held) {
            box.distance = Math.min(box.distance, entry);
          } else {
            box.distance += config.beltSpeed * dt;
            if (box.distance >= entry) {
              m1Held = true;
              box.work = m1;
            }
          }
          world.returnPath.positionAt(box.distance, tmpPos);
          box.group.position.set(tmpPos.x, ramp.y0 + box.lift, tmpPos.z);
          box.group.rotation.set(0, world.returnPath.headingAt(box.distance) + box.yaw, 0);
          box.group.scale.setScalar(box.size);
          box.group.visible = true;
          if (box.work === m1 && box.dwell > 0)
            work.set(m1, ramp.y0 + box.size * (box.height + 0.06) + 0.015);
          continue;
        }
        const prev = box.distance;
        const feedEntry = m1.distance - hold;
        if (box.dwell <= 0) {
          if (box.distance >= m1.distance || box.work === m1 || !m1Held) {
            box.distance += config.beltSpeed * dt;
            if (!box.work && box.distance >= feedEntry && box.distance < m1.distance) {
              m1Held = true;
              box.work = m1;
            }
          } else {
            box.distance = Math.min(box.distance, feedEntry);
          }
        }
        if (box.work === m1 && box.dwell <= 0 && box.distance >= m1.distance) {
          box.distance = m1.distance;
          box.dwell = config.boxDwell;
        }
        if (box.distance >= ramp.from + ramp.loadAt) {
          this._retireBox(box);
          this.active.splice(i, 1);
          this.processed++;
          continue;
        }
        if (box.dwell <= 0 && !box.work) {
          if (m2Held && box.distance < m2.distance) {
            box.distance = Math.min(box.distance, m2.distance - hold);
          } else if (!m2Held && m2.distance > prev && m2.distance <= box.distance) {
            box.distance = m2.distance;
            box.dwell = config.boxDwell;
            box.work = m2;
            box.visits++;
            box.qa = box.visits === 1 && Math.random() < config.rejectChance ? "fail" : "pass";
          }
        }
        if (box.distance >= ramp.from) {
          const t = box.distance - ramp.from;
          tmpPos.copy(ramp.base).addScaledVector(ramp.dir, t * ramp.cos);
          tmpPos.y = ramp.y0 + t * ramp.sin;
          tmpPos.addScaledVector(ramp.normal, box.lift);
          box.group.position.copy(tmpPos);
          box.group.rotation.set(-ramp.angle, world.endHeading + box.yaw, 0);
          box.group.scale.setScalar(box.size * THREE.MathUtils.clamp((ramp.loadAt - t) / 0.95, 0.3, 1));
          box.group.visible = true;
          continue;
        }
        world.path.positionAt(box.distance, tmpPos);
        const emerge = THREE.MathUtils.clamp((box.distance - box.spawn) / 0.95, 0.3, 1);
        box.group.position.set(tmpPos.x, ramp.y0 + box.lift * emerge, tmpPos.z);
        box.group.rotation.set(0, world.path.headingAt(box.distance) + box.yaw, 0);
        box.group.scale.setScalar(box.size * emerge);
        box.group.visible = true;
        if (box.work && box.dwell > 0)
          work.set(box.work, ramp.y0 + box.size * (box.height + 0.06) + 0.015);
      }
      const underQA = this.active.find((b) => b.work === m2 && b.dwell > 0);
      if (underQA) {
        this._qa.state = underQA.qa;
        this._qa.timer = 0.7;
      } else if (this._qa.timer > 0) {
        this._qa.timer -= dt;
        if (this._qa.timer <= 0)
          this._qa.state = "idle";
      }
      this._phase.feed += (heldAtStart ? 0 : config.beltSpeed) * dt;
      this._phase.run += config.beltSpeed * dt;
      this._phase.lane += (heldAtStart ? 0 : config.beltSpeed) * dt;
      world.conveyorFeed.update(this._phase.feed);
      world.conveyorRun.update(this._phase.run);
      world.returnBelt.update(this._phase.lane);
      for (const s of stations)
        s.update(this.elapsed, work.get(s) ?? null, s === m2 ? this._qa.state : "idle");
      world.loader.update(this._phase.run);
    }
    _frame = (now) => {
      this._raf = requestAnimationFrame(this._frame);
      this.timer.update(now);
      const dt = Math.min(this.timer.getDelta(), 0.05);
      if (!this.paused)
        this._simulate(dt);
      this._updateCamera(dt);
      this._updateAnchors();
      this.onStats?.({ boxesOnLine: this.active.length, processed: this.processed, paused: this.paused });
      this.postfx.render(EFFECTS);
    };
    _updateCamera(dt) {
      if (this.tween) {
        this.tween.t += dt;
        const u = Math.min(1, this.tween.t / this.tween.duration);
        const e = EASE(u);
        this.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
        this.zoom = this.tween.fromZoom + (this.tween.toZoom - this.tween.fromZoom) * e;
        if (u >= 1)
          this.tween = null;
      } else {
        const k = 1 - Math.exp(-dt * this.damping);
        this.target.lerp(this.desiredTarget, k);
        this.zoom += (this.desiredZoom - this.zoom) * k;
      }
      this.camera.position.copy(this.target).addScaledVector(this.isoDir, this.home.distance);
      this.camera.lookAt(this.target);
      this.camera.zoom = this._clampedZoom(this.zoom);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
    }
    _screenBasis() {
      this._basis ??= { right: new THREE.Vector3, up: new THREE.Vector3 };
      this.camera.updateMatrixWorld();
      this._basis.right.setFromMatrixColumn(this.camera.matrix, 0);
      this._basis.up.setFromMatrixColumn(this.camera.matrix, 1);
      return this._basis;
    }
    _worldPerPixel(zoom = this.zoom) {
      return this.config.viewSize / zoom / Math.max(1, this.root.clientHeight);
    }
    _moveTo(toTarget, toZoom, smooth = true, duration = this.focusDuration) {
      if (!smooth || duration <= 0) {
        this.tween = null;
        this.target.copy(toTarget);
        this.desiredTarget.copy(toTarget);
        this.zoom = toZoom;
        this.desiredZoom = toZoom;
        return;
      }
      this.tween = {
        t: 0,
        duration,
        fromTarget: this.target.clone(),
        toTarget: toTarget.clone(),
        fromZoom: this.zoom,
        toZoom
      };
      this.desiredTarget.copy(toTarget);
      this.desiredZoom = toZoom;
    }
    _bindPointerControls() {
      const on = (node, type, fn, opts) => {
        node.addEventListener(type, fn, opts);
        this._listeners.push([node, type, fn, opts]);
      };
      on(this.canvas, "contextmenu", (e) => e.preventDefault());
      on(this.canvas, "wheel", (e) => {
        e.preventDefault();
        const line = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
        const delta = Math.max(-400, Math.min(400, -e.deltaY * line));
        const next = this._clampedZoom(this.desiredZoom * Math.exp(delta * 0.0018));
        if (next === this.desiredZoom)
          return;
        const rect = this.canvas.getBoundingClientRect();
        this._anchorZoomAround(e.clientX - rect.left, e.clientY - rect.top, next);
      }, { passive: false });
      on(this.canvas, "pointerdown", (e) => {
        this.canvas.setPointerCapture(e.pointerId);
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.tween = null;
      });
      on(this.canvas, "pointermove", (e) => {
        const prev = this._pointers.get(e.pointerId);
        if (!prev)
          return;
        const cur = { x: e.clientX, y: e.clientY };
        if (this._pointers.size === 1) {
          this._panPixels(cur.x - prev.x, cur.y - prev.y);
        } else if (this._pointers.size === 2) {
          const ids = [...this._pointers.keys()];
          const other = this._pointers.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
          const prevMid = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
          const curMid = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
          const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
          const curDist = Math.hypot(cur.x - other.x, cur.y - other.y);
          this._panPixels(curMid.x - prevMid.x, curMid.y - prevMid.y);
          if (prevDist > 0 && curDist > 0) {
            const next = this._clampedZoom(this.desiredZoom * (curDist / prevDist));
            const rect = this.canvas.getBoundingClientRect();
            this._anchorZoomAround(curMid.x - rect.left, curMid.y - rect.top, next);
          }
        }
        this._pointers.set(e.pointerId, cur);
      });
      const lift = (e) => this._pointers.delete(e.pointerId);
      on(this.canvas, "pointerup", lift);
      on(this.canvas, "pointercancel", lift);
    }
    _panPixels(dx, dy) {
      const { right, up } = this._screenBasis();
      const spp = this._worldPerPixel(this.desiredZoom);
      this.desiredTarget.addScaledVector(right, -dx * spp).addScaledVector(up, dy * spp);
    }
    _anchorZoomAround(px, py, next) {
      const { right, up } = this._screenBasis();
      const ox = px - this.root.clientWidth / 2;
      const oy = -(py - this.root.clientHeight / 2);
      const at = (z) => ox * this._worldPerPixel(z);
      const atY = (z) => oy * this._worldPerPixel(z);
      this.desiredTarget.addScaledVector(right, at(this.desiredZoom) - at(next));
      this.desiredTarget.addScaledVector(up, atY(this.desiredZoom) - atY(next));
      this.desiredZoom = next;
      this.tween = null;
    }
    _updateAnchors() {
      if (!this._anchors.size)
        return;
      for (const anchor of this._anchors) {
        const screen = this.getScreenPosition(anchor.id);
        if (!screen || !screen.onScreen) {
          anchor.node.style.display = "none";
          continue;
        }
        anchor.node.style.display = "";
        anchor.node.style.transform = `translate3d(${screen.x + anchor.offsetX}px, ${screen.y + anchor.offsetY}px, 0) translate(-50%, -50%)`;
      }
    }
  }
  function buildLights() {
    const group = new THREE.Group;
    group.name = "lights";
    group.add(new THREE.HemisphereLight(16777215, 12893094, 1.35));
    const key = new THREE.DirectionalLight(16777215, 2.1);
    key.position.set(0, 40, 0);
    const unbindKey = bindColor("keyLight", key);
    group.add(key, key.target);
    const fill = new THREE.DirectionalLight(14673392, 0.55);
    fill.position.set(22, 7, -12);
    group.add(fill);
    return { group, unbind: unbindKey ?? (() => {}) };
  }
  function placeOnPath(path, object, distance) {
    const p = path.positionAt(distance, new THREE.Vector3);
    object.position.set(p.x, 0, p.z);
    object.rotation.y = path.headingAt(distance);
  }
  function disposeGroup(group) {
    group?.traverse((node) => node.geometry?.dispose());
  }
  function parsePercent(value) {
    if (typeof value === "string" && value.trim().endsWith("%"))
      return Number(value.slice(0, -1));
    if (typeof value === "number" && Number.isFinite(value))
      return value;
    return null;
  }

  // src/embed-entry.js
  globalThis.FactoryView = Object.assign(FactoryView, exports_factory_view);
})();
