// v1.4.2 3D 歌词舞台（第二期）。借鉴 Mineradio 11-lyrics-shaders.js / 13-lyrics-mesh-build.js /
// 14-stage-lyrics-rendering.js 思想，GPL-3.0（Ported from Mineradio 2.2.0, GPL-3.0, 11-lyrics-shaders.js 等）。
// 主窗内嵌 Three.js 画布：消费 karaoke.js 统一算法产出的行进度（wordFrontPx / lineProgress），
// shader 内 mix+uFeather 扫色（逐字 0.030 / LRC 0.055，MR 同款常量）。
// 纪律（MR LOW_SPEC 文档）：默认路径轻、不可见停帧、关=完整卸载并释放 WebGL 资源、挂载失败回退 DOM。
// DOM 方案保留：开关的关 + 本模块挂载失败的兜底 + 桌面歌词窗天生 DOM。
'use strict';
(function () {
  const Stage = {
    _THREE: null, _loading: null,      // 懒加载 three.js（~690KB，仅首次开启时拉取）
    _host: null, _renderer: null, _scene: null, _camera: null, _group: null,
    _slots: [],                        // 3 个行槽：prev / current / next
    _visible: false, _failed: false,
    _texts: ['', '', ''], _progress: 0, _hasNative: false,
    _lastRenderTs: 0, _lastRebuild: 0, _colors: null,
    CANVAS_W: 1600, CANVAS_H: 256, FONT_PX: 104, FEATHER_NATIVE: 0.030, FEATHER_LRC: 0.055,
  };

  const VERTEX = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  // 片元着色器：MR makeLyricShaderMaterial 的最小子集（去 glitch/sweep/shimmer，保留 mix+feather 扫色与边缘微光）
  const FRAGMENT = [
    'precision highp float;',
    'uniform sampler2D uMap;',
    'uniform float uProgress,uOpacity,uFeather,uTextMin,uTextMax,uDim;',
    'uniform vec3 uBase,uHi;',
    'varying vec2 vUv;',
    'void main(){',
    '  float mask = texture2D(uMap, vUv).a;',
    '  if (mask < 0.01) discard;',
    '  float denom = max(0.001, uTextMax - uTextMin);',
    '  float p = clamp((vUv.x - uTextMin) / denom, 0.0, 1.0);',
    '  float filled = 1.0 - smoothstep(uProgress, uProgress + uFeather, p);',
    '  float edge = (1.0 - smoothstep(0.0, uFeather * 2.8, abs(p - uProgress)));',
    '  vec3 color = mix(uBase * uDim, uHi, filled);',
    '  color += uHi * edge * 0.16 * uDim;',
    '  gl_FragColor = vec4(color, mask * uOpacity);',
    '}',
  ].join('\n');

  function ensureThree() {
    if (Stage._THREE) return Promise.resolve();
    if (!Stage._loading) {
      const url = new URL('vendor/three.module.js', location.href).href;
      Stage._loading = import(url).then((m) => { Stage._THREE = m; });
    }
    return Stage._loading;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  // 从 DOM 主题取色：已唱高亮=正文色（--text），未唱=弱化正文色；每次 rebuild 时刷新（跟随主题切换）
  function readColors() {
    const c = new (Stage._THREE.Color)();
    try { c.set(cssVar('--text', '#e8ecf4')); } catch { c.set('#e8ecf4'); }
    Stage._colors = { hi: c.clone(), base: c.clone().multiplyScalar(0.52) };
  }

  // 行文本 → 离屏 canvas alpha 纹理（白字，着色交给 shader）；过宽自动缩字号，不折行（3D 单行主视觉）
  function buildTexture(text) {
    const T = Stage._THREE;
    const cv = document.createElement('canvas');
    cv.width = Stage.CANVAS_W; cv.height = Stage.CANVAS_H;
    const ctx = cv.getContext('2d');
    const family = getComputedStyle(document.getElementById('lyricBox') || document.body).fontFamily;
    let px = Stage.FONT_PX;
    ctx.font = `600 ${px}px ${family}`;
    const PAD = 24;
    const maxW = Stage.CANVAS_W - PAD * 2;
    let w = ctx.measureText(text).width;
    if (w > maxW && w > 0) { px = Math.max(34, Math.floor(px * maxW / w)); ctx.font = `600 ${px}px ${family}`; w = ctx.measureText(text).width; }
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    const x = PAD + Math.max(0, (maxW - w) / 2);
    ctx.fillText(text, x, Stage.CANVAS_H / 2);
    const textMin = (x - 2) / Stage.CANVAS_W;
    const textMax = (x + Math.min(w, maxW) + 2) / Stage.CANVAS_W;
    const tex = new T.CanvasTexture(cv);
    tex.minFilter = T.LinearFilter; tex.magFilter = T.LinearFilter; tex.generateMipmaps = false;
    return { tex, textMin, textMax, cv };
  }

  function makeSlot(i) {
    const T = Stage._THREE;
    const geo = new T.PlaneGeometry(6.4, 1.024); // 与 canvas 同宽高比（1600x256）
    const mat = new T.ShaderMaterial({
      uniforms: {
        uMap: { value: null }, uProgress: { value: 0 }, uOpacity: { value: 0 },
        uFeather: { value: Stage.FEATHER_LRC }, uTextMin: { value: 0 }, uTextMax: { value: 1 },
        uDim: { value: 1 }, uBase: { value: new T.Color('#888') }, uHi: { value: new T.Color('#fff') },
      },
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      transparent: true, depthWrite: false, depthTest: false, side: T.DoubleSide,
    });
    const mesh = new T.Mesh(geo, mat);
    const slot = { mesh, mat, tex: null, cv: null, text: '' };
    Stage._group.add(mesh);
    Stage._slots[i] = slot;
    return slot;
  }

  // 三槽布局：当前行居中放大，前/后行上下退后压暗（透视纵深）；每组参数见 SLOT_LAYOUT
  const SLOT_LAYOUT = [
    { y: 1.15, z: -1.6, scale: 0.72, opacity: 0.30, dim: 0.85 },  // 上一句
    { y: 0,    z: 0,    scale: 1.0,  opacity: 1.0,  dim: 1.0 },   // 当前句
    { y: -1.35, z: -2.2, scale: 0.60, opacity: 0.22, dim: 0.85 }, // 下一句
  ];

  function rebuildSlot(i, text, native) {
    const slot = Stage._slots[i] || makeSlot(i);
    if (slot.text === text && slot._native === native) return;
    if (slot.tex) { slot.tex.dispose(); slot.tex = null; }
    slot.text = text; slot._native = native;
    const L = SLOT_LAYOUT[i];
    slot.mesh.position.set(0, L.y, L.z);
    slot.mesh.scale.setScalar(L.scale);
    if (!text) { slot.mat.uniforms.uOpacity.value = 0; slot.mat.uniforms.uMap.value = null; return; }
    const built = buildTexture(text);
    slot.tex = built.tex; slot.cv = built.cv;
    slot.mat.uniforms.uMap.value = built.tex;
    slot.mat.uniforms.uTextMin.value = built.textMin;
    slot.mat.uniforms.uTextMax.value = built.textMax;
    slot.mat.uniforms.uFeather.value = native ? Stage.FEATHER_NATIVE : Stage.FEATHER_LRC;
    slot.mat.uniforms.uOpacity.value = L.opacity;
    slot.mat.uniforms.uDim.value = L.dim;
    slot.mat.uniforms.uBase.value.copy(Stage._colors.base);
    slot.mat.uniforms.uHi.value.copy(Stage._colors.hi);
  }

  // ---------- 对外 API ----------

  // 挂载（幂等）：host=容器元素。失败抛错（调用方回退 DOM 并提示）。
  async function mount(host) {
    if (Stage._renderer && Stage._host === host) return;
    await ensureThree();
    const T = Stage._THREE;
    unmount(); // 防御：换容器时先完整释放旧资源
    Stage._host = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'stage3d-canvas';
    host.appendChild(canvas);
    let renderer;
    try {
      renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch (e) {
      canvas.remove();
      Stage._host = null;
      throw new Error('WEBGL_UNAVAILABLE');
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // 低配护栏：DPR 封顶 2
    Stage._renderer = renderer;
    Stage._scene = new T.Scene();
    Stage._camera = new T.PerspectiveCamera(42, 1, 0.1, 50);
    Stage._camera.position.set(0, 0.15, 5.4);
    Stage._camera.lookAt(0, 0, 0);
    Stage._group = new T.Group();
    Stage._group.rotation.x = -0.22; // 轻微后仰，行间有纵深
    Stage._scene.add(Stage._group);
    for (let i = 0; i < 3; i++) makeSlot(i);
    readColors();
    resize();
    Stage._failed = false;
  }

  function resize() {
    if (!Stage._renderer || !Stage._host) return;
    const w = Stage._host.clientWidth, h = Stage._host.clientHeight;
    if (!w || !h) return;
    Stage._renderer.setSize(w, h, false);
    Stage._camera.aspect = w / h;
    Stage._camera.updateProjectionMatrix();
  }

  // 供 karaokeLoop 每帧调用（needFrame/60fps 节流由调用方负责——面板不可见时自然停帧）
  // arg: { prev, text, next, progress(0..1), hasNative, lineT, dur, tAbs, playing }
  function update(arg) {
    if (!Stage._renderer) return;
    const texts = [arg.prev || '', arg.text || '', arg.next || ''];
    if (texts.some((t, i) => t !== Stage._texts[i]) || Stage._hasNative !== !!arg.hasNative || !Stage._colors) {
      Stage._texts = texts;
      Stage._hasNative = !!arg.hasNative;
      readColors();
      const now = performance.now();
      if (now - Stage._lastRebuild < 80) { /* 行切换风暴限频：80ms 内合并 */ }
      Stage._lastRebuild = now;
      for (let i = 0; i < 3; i++) rebuildSlot(i, texts[i], Stage._hasNative);
    }
    Stage._progress = Math.min(1, Math.max(0, arg.progress || 0));
    render(arg);
  }

  // 渲染一帧；暂停时冻结浮动动画（暂停即停，与桌面歌词一致）
  function render(arg) {
    const T = Stage._THREE;
    const now = arg && arg.now != null ? arg.now : performance.now();
    const cur = Stage._slots[1];
    if (cur) cur.mat.uniforms.uProgress.value = Stage._progress;
    // 前/后行静态呈现（不扫色，uProgress 恒 0/1 之外无意义）→ 保持 0
    if (arg && arg.playing) {
      const t = now / 1000;
      Stage._group.position.y = Math.sin(t * 0.5) * 0.05;
      Stage._group.position.x = Math.sin(t * 0.31) * 0.03;
    }
    Stage._renderer.render(Stage._scene, Stage._camera);
  }

  // 不可见：停帧（面板关闭/最小化时调用）；保留现场，重新可见即恢复
  function hide() { Stage._visible = false; }
  function show() { Stage._visible = true; }

  // 完整卸载：释放全部 GPU 资源（geometry/material/texture/renderer），移除 canvas（开关的"关"）
  function unmount() {
    const T = Stage._THREE;
    hide();
    for (const s of Stage._slots) {
      if (!s) continue;
      if (s.tex) s.tex.dispose();
      if (s.mat) s.mat.dispose();
      if (s.mesh) { Stage._group && Stage._group.remove(s.mesh); s.mesh.geometry && s.mesh.geometry.dispose(); }
    }
    Stage._slots = [];
    Stage._texts = ['', '', ''];
    if (Stage._renderer) {
      Stage._renderer.dispose();
      Stage._renderer.forceContextLoss && Stage._renderer.forceContextLoss();
    }
    if (Stage._host && Stage._host.querySelector('.stage3d-canvas')) Stage._host.querySelector('.stage3d-canvas').remove();
    Stage._renderer = null; Stage._scene = null; Stage._camera = null; Stage._group = null;
    Stage._host = null; Stage._colors = null;
    void T;
  }

  function active() { return !!Stage._renderer; }
  function failed() { return Stage._failed; }

  window.LyricStage3D = { mount, unmount, update, show, hide, active, resize, failed, markFailed() { Stage._failed = true; }, resetFailed() { Stage._failed = false; } };
})();
