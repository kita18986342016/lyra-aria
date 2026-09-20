// Ported from Mineradio 2.2.0, GPL-3.0, 05-playback/00-api-quality-output.js:335-992
// （音频输出/音频路由 Patch Bay UI 段整段照抄；该文件其余网络层部分不移植）
// 依赖补齐（08-account/01-login-modal-utils.js:2-54 原文照抄；仅这两函数被本段调用）
function openGsapModal(mask) {
  if (!mask) return;
  var panel = mask.querySelector('.modal');
  mask.classList.add('show');
  if (window.gsap) {
    window.gsap.killTweensOf(mask);
    if (panel) window.gsap.killTweensOf(panel);
    window.gsap.set(mask, { display: 'flex', visibility: 'visible' });
    window.gsap.fromTo(mask,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.38, ease: 'power2.out', overwrite: true }
    );
    if (panel) {
      window.gsap.fromTo(panel,
        { autoAlpha: 0, y: 26, scale: 0.965, filter: 'blur(12px)' },
        { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.68, ease: 'expo.out', overwrite: true }
      );
    }
  } else {
    mask.style.display = 'flex';
    mask.style.visibility = 'visible';
    mask.style.opacity = '1';
  }
}
function closeGsapModal(mask, afterClose) {
  if (!mask || !mask.classList.contains('show')) {
    if (afterClose) afterClose();
    return;
  }
  var panel = mask.querySelector('.modal');
  function finish() {
    mask.classList.remove('show');
    if (window.gsap) {
      window.gsap.set(mask, { clearProps: 'display,visibility,opacity' });
      if (panel) window.gsap.set(panel, { clearProps: 'opacity,visibility,transform,filter' });
    } else {
      mask.style.display = '';
      mask.style.visibility = '';
      mask.style.opacity = '';
    }
    if (afterClose) afterClose();
  }
  if (window.gsap) {
    window.gsap.killTweensOf(mask);
    if (panel) {
      window.gsap.killTweensOf(panel);
      window.gsap.to(panel, { autoAlpha: 0, y: 18, scale: 0.976, filter: 'blur(8px)', duration: 0.28, ease: 'power2.in', overwrite: true });
    }
    window.gsap.to(mask, { autoAlpha: 0, duration: 0.34, ease: 'power2.inOut', overwrite: true, onComplete: finish });
  } else {
    finish();
  }
}
var audioRouteWorkflowDrag = null;
function audioRoutePointForPort(port, root) {
  if (!port || !root) return null;
  var portRect = port.getBoundingClientRect();
  var rootRect = root.getBoundingClientRect();
  return {
    x: portRect.left + portRect.width / 2 - rootRect.left,
    y: portRect.top + portRect.height / 2 - rootRect.top
  };
}
function audioRoutePointFromEvent(e, root) {
  if (!e || !root) return null;
  var rootRect = root.getBoundingClientRect();
  return { x: e.clientX - rootRect.left, y: e.clientY - rootRect.top };
}
function audioRouteBezierPath(a, b) {
  var dx = Math.max(42, Math.abs(b.x - a.x) * 0.42);
  return 'M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
    ' C ' + (a.x + dx).toFixed(1) + ' ' + a.y.toFixed(1) +
    ', ' + (b.x - dx).toFixed(1) + ' ' + b.y.toFixed(1) +
    ', ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
}
function appendAudioRoutePath(svg, from, to, className) {
  if (!svg || !from || !to) return;
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', audioRouteBezierPath(from, to));
  path.setAttribute('class', className || 'workflow-link');
  svg.appendChild(path);
}
function audioRoutePortByAttr(root, attr, value) {
  var ports = root ? root.querySelectorAll('.flow-port.in[' + attr + ']') : [];
  value = String(value || '');
  for (var i = 0; i < ports.length; i += 1) {
    if (String(ports[i].getAttribute(attr) || '') === value) return ports[i];
  }
  return null;
}
function renderAudioRouteWorkflowEdgesForRoot(root, tempPoint) {
  if (!root) return;
  var svg = root.querySelector('#audio-route-workflow-svg');
  if (!svg) return;
  svg.setAttribute('viewBox', '0 0 ' + Math.max(1, root.clientWidth || 1) + ' ' + Math.max(1, root.clientHeight || 1));
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var sourceOut = root.querySelector('[data-audio-route-source="player"]');
  var sourcePoint = audioRoutePointForPort(sourceOut, root);
  var primaryPort = audioRoutePortByAttr(root, 'data-output-primary-target', audioOutputDeviceId || '');
  appendAudioRoutePath(svg, sourcePoint, audioRoutePointForPort(primaryPort, root), 'workflow-link active primary');
  normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).forEach(function (id) {
    if (!id || id === (audioOutputDeviceId || '')) return;
    appendAudioRoutePath(svg, sourcePoint, audioRoutePointForPort(audioRoutePortByAttr(root, 'data-output-mirror-target', id), root), audioOutputMirrorRouteClass(id));
  });
  if (audioInputBridgeState && audioInputBridgeState.enabled && audioInputBridgeState.deviceId) {
    appendAudioRoutePath(svg, sourcePoint, audioRoutePointForPort(audioRoutePortByAttr(root, 'data-input-bridge-target', audioInputBridgeState.deviceId), root), 'workflow-link active bridge');
  }
  if (audioRouteWorkflowDrag && audioRouteWorkflowDrag.root === root && tempPoint) {
    appendAudioRoutePath(svg, audioRoutePointForPort(audioRouteWorkflowDrag.port, root), tempPoint, 'workflow-link temp');
  }
}
function renderAudioRouteWorkflowEdges(tempPoint) {
  var roots = document.querySelectorAll('.audio-route-graph');
  Array.prototype.forEach.call(roots, function (root) {
    renderAudioRouteWorkflowEdgesForRoot(root, tempPoint);
  });
}
function finishAudioRouteWorkflowDrag(e) {
  if (!audioRouteWorkflowDrag) return;
  var root = audioRouteWorkflowDrag.root;
  var target = document.elementFromPoint(e.clientX, e.clientY);
  var port = target && target.closest ? target.closest('.flow-port.in') : null;
  if (root && port && root.contains(port)) {
    if (port.hasAttribute('data-output-primary-target')) {
      setAudioOutputDevice(port.getAttribute('data-output-primary-target') || '', true);
    } else if (port.hasAttribute('data-output-mirror-target')) {
      toggleAudioOutputMirrorDevice(port.getAttribute('data-output-mirror-target') || '');
    } else if (port.hasAttribute('data-input-bridge-target')) {
      setAudioInputBridgeDevice(port.getAttribute('data-input-bridge-target') || '', true);
    }
  }
  if (root) root.classList.remove('dragging-line');
  audioRouteWorkflowDrag = null;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { }
  requestAnimationFrame(renderAudioRouteWorkflowEdges);
}
function bindAudioRouteWorkflowPointerEvents(outputList) {
  if (!outputList || outputList._routeWorkflowBound) return;
  outputList._routeWorkflowBound = true;
  outputList.addEventListener('pointerdown', function (e) {
    var port = e.target && e.target.closest ? e.target.closest('.flow-port.out[data-audio-route-source]') : null;
    if (!port || !outputList.contains(port)) return;
    var root = port.closest('.audio-route-graph');
    audioRouteWorkflowDrag = { root: root, port: port };
    if (root) root.classList.add('dragging-line');
    try { outputList.setPointerCapture(e.pointerId); } catch (_) { }
    e.preventDefault();
    e.stopPropagation();
    renderAudioRouteWorkflowEdges(root ? audioRoutePointFromEvent(e, root) : null);
  });
  outputList.addEventListener('pointermove', function (e) {
    if (!audioRouteWorkflowDrag || !audioRouteWorkflowDrag.root) return;
    e.preventDefault();
    renderAudioRouteWorkflowEdges(audioRoutePointFromEvent(e, audioRouteWorkflowDrag.root));
  });
  outputList.addEventListener('pointerup', finishAudioRouteWorkflowDrag);
  outputList.addEventListener('pointercancel', function (e) {
    if (audioRouteWorkflowDrag && audioRouteWorkflowDrag.root) audioRouteWorkflowDrag.root.classList.remove('dragging-line');
    audioRouteWorkflowDrag = null;
    try { outputList.releasePointerCapture(e.pointerId); } catch (_) { }
    renderAudioRouteWorkflowEdges();
  });
  if (!bindAudioRouteWorkflowPointerEvents._resizeBound) {
    bindAudioRouteWorkflowPointerEvents._resizeBound = true;
    window.addEventListener('resize', function () { requestAnimationFrame(renderAudioRouteWorkflowEdges); });
    window.addEventListener('orientationchange', function () { requestAnimationFrame(renderAudioRouteWorkflowEdges); });
  }
}
function bindAudioRouteSelectionEvents(container) {
  if (container && !container._audioRouteSelectBound) {
    container._audioRouteSelectBound = true;
    container.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-output-primary],[data-output-mirror],[data-input-bridge]') : null;
      if (!btn || !container.contains(btn)) return;
      if (btn.hasAttribute('data-output-primary')) {
        setAudioOutputDevice(btn.getAttribute('data-output-primary') || '', true);
        return;
      }
      if (btn.hasAttribute('data-output-mirror')) {
        toggleAudioOutputMirrorDevice(btn.getAttribute('data-output-mirror') || '');
        return;
      }
      if (btn.hasAttribute('data-input-bridge')) {
        setAudioInputBridgeDevice(btn.getAttribute('data-input-bridge') || '', true);
      }
    });
  }
}
function bindAudioOutputControls() {
  var outputList = document.getElementById('audio-output-list');
  var workflowBody = document.getElementById('audio-output-workflow-body');
  bindAudioRouteSelectionEvents(outputList);
  bindAudioRouteSelectionEvents(workflowBody);
  bindAudioRouteWorkflowPointerEvents(outputList);
  bindAudioRouteWorkflowPointerEvents(workflowBody);
  renderAudioOutputDeviceUi();
  refreshAudioOutputDevices(false);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener && !bindAudioOutputControls._deviceChangeBound) {
    bindAudioOutputControls._deviceChangeBound = true;
    navigator.mediaDevices.addEventListener('devicechange', function () { refreshAudioOutputDevices(false); });
  }
}
function readAudioOutputDevicePreference() {
  try { return localStorage.getItem(AUDIO_OUTPUT_DEVICE_STORE_KEY) || ''; } catch (e) { return ''; }
}
function saveAudioOutputDevicePreference() {
  try { localStorage.setItem(AUDIO_OUTPUT_DEVICE_STORE_KEY, audioOutputDeviceId || ''); } catch (e) { }
}
function normalizeAudioOutputIdList(list) {
  var seen = {};
  return (Array.isArray(list) ? list : []).map(function (id) { return String(id || '').trim(); }).filter(function (id) {
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  }).slice(0, 4);
}
function readAudioOutputMirrorPreference() {
  try {
    return normalizeAudioOutputIdList(JSON.parse(localStorage.getItem(AUDIO_OUTPUT_MIRROR_STORE_KEY) || '[]'));
  } catch (e) { return []; }
}
function saveAudioOutputMirrorPreference() {
  try { localStorage.setItem(AUDIO_OUTPUT_MIRROR_STORE_KEY, JSON.stringify(normalizeAudioOutputIdList(audioOutputMirrorDeviceIds))); } catch (e) { }
}
function audioOutputMirrorSinkSupported() {
  return typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype && typeof HTMLMediaElement.prototype.setSinkId === 'function';
}
function audioOutputMirrorReadableError(e) {
  var name = e && e.name ? String(e.name) : '';
  if (name === 'NotAllowedError') return '没有输出权限';
  if (name === 'NotFoundError') return '设备不可用';
  if (name === 'AbortError') return '切换失败';
  if (name === 'NotSupportedError') return '内核不支持';
  return '播放失败';
}
function markAudioOutputMirrorRuntime(id, state, message) {
  id = String(id || '');
  if (!id) return;
  if (!audioOutputMirrorRuntime) audioOutputMirrorRuntime = {};
  var prev = audioOutputMirrorRuntime[id] || {};
  message = String(message || '');
  if (prev.state === state && prev.message === message) return;
  audioOutputMirrorRuntime[id] = { state: state, message: message, at: Date.now() };
  if (markAudioOutputMirrorRuntime.renderPending) return;
  markAudioOutputMirrorRuntime.renderPending = true;
  var schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
  schedule(function () {
    markAudioOutputMirrorRuntime.renderPending = false;
    renderAudioOutputDeviceUi();
    renderAudioRouteWorkflowEdges();
  });
}
function audioOutputMirrorRuntimeFor(id) {
  id = String(id || '');
  return audioOutputMirrorRuntime && audioOutputMirrorRuntime[id] || null;
}
function audioOutputMirrorConfirmedCount(ids) {
  return normalizeAudioOutputIdList(ids).filter(function (id) {
    var rt = audioOutputMirrorRuntimeFor(id);
    return rt && rt.state === 'playing';
  }).length;
}
function audioOutputMirrorRouteClass(id) {
  var rt = audioOutputMirrorRuntimeFor(id);
  if (rt && rt.state === 'playing') return 'workflow-link active mirror';
  return 'workflow-link pending mirror';
}
function audioOutputMirrorStatusText(id, active, disabled) {
  if (disabled) return '已作为主输出，不能再镜像';
  if (!active) return '实验：复制播放流，不是系统级路由';
  if (!audioOutputMirrorSinkSupported()) return '当前内核不支持镜像监听';
  var src = audio && (audio.currentSrc || audio.src || '');
  if (!audio || !src) return '待播放时尝试镜像';
  var rt = audioOutputMirrorRuntimeFor(id);
  if (!rt) return '待确认镜像监听';
  if (rt.state === 'playing') return '镜像监听已确认';
  if (rt.state === 'paused') return '随主播放器暂停';
  if (rt.state === 'sink-ready') return '设备已选，等待播放';
  if (rt.state === 'sink-pending' || rt.state === 'play-pending') return '正在尝试镜像监听';
  if (rt.state === 'waiting') return '待播放时尝试镜像';
  if (rt.state === 'sink-error' || rt.state === 'play-error' || rt.state === 'unsupported') return '镜像失败：' + (rt.message || '请换接口');
  return '待确认镜像监听';
}
function readAudioInputBridgePreference() {
  try {
    var parsed = JSON.parse(localStorage.getItem(AUDIO_INPUT_BRIDGE_STORE_KEY) || '{}');
    return { enabled: !!parsed.enabled, deviceId: String(parsed.deviceId || '') };
  } catch (e) {
    return { enabled: false, deviceId: '' };
  }
}
function saveAudioInputBridgePreference() {
  try { localStorage.setItem(AUDIO_INPUT_BRIDGE_STORE_KEY, JSON.stringify(audioInputBridgeState || { enabled: false, deviceId: '' })); } catch (e) { }
}
function audioOutputDeviceById(deviceId) {
  deviceId = String(deviceId || '');
  return (audioOutputDevices || []).filter(function (device) { return device && device.deviceId === deviceId; })[0] || null;
}
function isVirtualMicOutputDevice(device) {
  var label = String(device && device.label || '').toLowerCase();
  return /cable input|vb-audio|voicemeeter|virtual|loopback|blackhole|sonar|stereo mix|立体声混音|虚拟|线缆/.test(label);
}
function recommendedAudioInputBridgeDeviceId() {
  var selected = audioInputBridgeState && audioInputBridgeState.deviceId;
  if (selected && audioOutputDeviceById(selected)) return selected;
  var virtual = (audioOutputDevices || []).filter(isVirtualMicOutputDevice)[0];
  return virtual && virtual.deviceId || '';
}
function audioInputDeviceLabel(device, index) {
  if (!device || !device.deviceId) return '输入设备';
  return device.label || ('输入设备 ' + (index + 1));
}
function audioOutputDeviceStatusText() {
  if (audioInputBridgeState && audioInputBridgeState.enabled) {
    var bridgeDevice = audioOutputDeviceById(audioInputBridgeState.deviceId);
    return bridgeDevice ? ('已桥接到 ' + audioOutputDeviceLabel(bridgeDevice, 0)) : '输入桥接等待虚拟设备';
  }
  if (audioOutputDeviceId) {
    var primary = audioOutputDeviceById(audioOutputDeviceId);
    return primary ? ('当前输出 ' + audioOutputDeviceLabel(primary, 0)) : '当前输出设备待恢复';
  }
  return '当前输出系统默认';
}
function audioOutputDeviceLabel(device, index) {
  if (!device || !device.deviceId) return '系统默认';
  return device.label || ('输出设备 ' + (index + 1));
}
function renderAudioOutputDeviceUi() {
  var list = document.getElementById('audio-output-list');
  if (!list) return;
  var outputs = [{ deviceId: '', label: '系统默认' }].concat(audioOutputDevices || []);
  var bridgeId = recommendedAudioInputBridgeDeviceId();
  var bridgeEnabled = !!(audioInputBridgeState && audioInputBridgeState.enabled);
  var mirrorIds = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds);
  var outputItems = outputs.map(function (device, index) {
    return {
      device: device,
      index: index,
      id: device && device.deviceId ? String(device.deviceId) : '',
      label: audioOutputDeviceLabel(device, index)
    };
  });
  function sortedRouteItems(items, rank) {
    return items.slice().sort(function (a, b) {
      var ra = rank(a);
      var rb = rank(b);
      if (ra !== rb) return ra - rb;
      return String(a.label || '').localeCompare(String(b.label || ''), 'zh-Hans-CN');
    });
  }
  var primaryItems = sortedRouteItems(outputItems, function (item) {
    if (item.id === (audioOutputDeviceId || '')) return 0;
    if (!item.id) return 1;
    return 2;
  });
  var mirrorItems = sortedRouteItems(outputItems.filter(function (item) { return !!item.id; }), function (item) {
    if (mirrorIds.indexOf(item.id) >= 0 && item.id !== (audioOutputDeviceId || '')) return 0;
    if (isVirtualMicOutputDevice(item.device)) return 1;
    if (item.id === (audioOutputDeviceId || '')) return 3;
    return 2;
  });
  var primaryHtml = primaryItems.map(function (item) {
    var device = item.device;
    var index = item.index;
    var id = device && device.deviceId ? String(device.deviceId) : '';
    var active = id === (audioOutputDeviceId || '');
    var virtualClass = device && device.deviceId && isVirtualMicOutputDevice(device) ? ' virtual' : '';
    return '<button class="audio-route-node output workflow-node' + virtualClass + (active ? ' active connected' : '') + '" type="button" data-output-primary="' + escHtml(id) + '" title="' + escHtml(audioOutputDeviceLabel(device, index)) + '">' +
      '<span class="flow-port in" data-output-primary-target="' + escHtml(id) + '" title="连接为主输出"></span><span class="route-node-icon">' + (id ? 'OUT' : 'SYS') + '</span><span class="route-node-text"><b>' + escHtml(audioOutputDeviceLabel(device, index)) + '</b><small>' + (active ? '主输出已连接' : '拖线连接主输出') + '</small></span>' +
      '<span class="route-node-pulse"></span></button>';
  }).join('');
  var mirrorHtml = mirrorItems.map(function (item) {
    var device = item.device;
    var index = item.index;
    var id = String(device.deviceId || '');
    var disabled = id === (audioOutputDeviceId || '');
    var active = mirrorIds.indexOf(id) >= 0 && !disabled;
    var rt = audioOutputMirrorRuntimeFor(id);
    var pendingClass = active && (!rt || rt.state !== 'playing') ? ' pending' : '';
    var warningClass = active && rt && (rt.state === 'sink-error' || rt.state === 'play-error' || rt.state === 'unsupported') ? ' warning' : '';
    return '<button class="audio-route-node mirror workflow-node' + (active ? ' active connected' : '') + pendingClass + warningClass + (disabled ? ' disabled' : '') + '" type="button" data-output-mirror="' + escHtml(id) + '" title="' + escHtml(audioOutputDeviceLabel(device, index)) + '">' +
      '<span class="flow-port in" data-output-mirror-target="' + escHtml(id) + '" title="连接为实验镜像监听"></span><span class="route-node-icon">MON</span><span class="route-node-text"><b>' + escHtml(audioOutputDeviceLabel(device, index)) + '</b><small>' + escHtml(audioOutputMirrorStatusText(id, active, disabled)) + '</small></span>' +
      '<span class="route-node-pulse"></span></button>';
  }).join('');
  var bridgeDevice = bridgeId ? audioOutputDeviceById(bridgeId) : null;
  var bridgeLabel = bridgeDevice ? audioOutputDeviceLabel(bridgeDevice, 0) : '未检测到 VB-CABLE / VoiceMeeter';
  var inputHint = (audioInputDevices || []).slice(0, 2).map(function (device, index) { return audioInputDeviceLabel(device, index); }).join(' / ');
  var activePrimary = audioOutputDeviceId ? audioOutputDeviceById(audioOutputDeviceId) : null;
  var summaryText = audioOutputDeviceStatusText();
  var mirrorCount = mirrorIds.filter(function (id) { return id && id !== (audioOutputDeviceId || ''); }).length;
  var mirrorConfirmedCount = audioOutputMirrorConfirmedCount(mirrorIds);
  var mirrorStateLabel = mirrorCount ? (mirrorConfirmedCount ? ('已确认 ' + mirrorConfirmedCount + '/' + mirrorCount) : ('待确认 ' + mirrorCount + ' 路')) : '关闭';
  var workflowHtml =
    '<div class="audio-route-graph' + (bridgeEnabled ? ' bridge-on' : '') + '">' +
      '<svg id="audio-route-workflow-svg" class="workflow-link-layer audio-link-layer" aria-hidden="true"></svg>' +
      '<div class="audio-flow-source workflow-node" data-audio-node="player">' +
        '<span class="route-node-kicker">SOURCE</span><span class="route-node-icon">DSH</span><span class="route-node-text"><b>深空折韵 Player</b><small>' + escHtml(summaryText) + '</small></span><span class="audio-source-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="flow-port out" data-audio-route-source="player" title="深空折韵 输出"></span>' +
      '</div>' +
      '<div class="audio-route-status"><span class="route-energy-dot"></span><b>Patch Bay</b><small>' + escHtml(audioOutputDeviceId ? '主监听已指定' : '主监听跟随系统默认') + '</small></div>' +
      '<div class="audio-route-board">' +
        '<div class="audio-route-board-head">' +
          '<span class="route-board-title"><b>路由矩阵</b><small>Patch Bay</small></span>' +
          '<span class="route-board-badges"><span class="audio-route-chip active">主监听 ' + escHtml(activePrimary ? audioOutputDeviceLabel(activePrimary, 0) : '系统默认') + '</span>' +
          '<span class="audio-route-chip">镜像监听 ' + escHtml(mirrorStateLabel) + '</span>' +
          '<span class="audio-route-chip' + (bridgeEnabled ? ' active' : '') + '">虚拟麦克风 ' + (bridgeEnabled ? '已接入' : '未接入') + '</span></span>' +
        '</div>' +
        '<div class="audio-route-lanes">' +
          '<div class="route-lane primary"><div class="route-lane-head"><span class="route-lane-index">01</span><span><b>主监听</b><small>播放器默认输出端</small></span><em class="route-lane-state">' + escHtml(activePrimary ? '已指定' : '系统默认') + '</em></div><div class="route-node-grid">' + primaryHtml + '</div></div>' +
          '<div class="route-lane mirror"><div class="route-lane-head"><span class="route-lane-index">02</span><span><b>镜像监听</b><small>实验功能：复制播放流到另一输出</small></span><em class="route-lane-state">' + escHtml(mirrorStateLabel) + '</em></div><div class="route-node-grid mirror-grid">' + (mirrorHtml || '<div class="audio-route-empty">没有可镜像的输出设备</div>') + '</div><div class="audio-route-note">镜像监听不是系统级多输出，可能有轻微延迟或因平台音源失效；直播/语音输入建议走虚拟声卡桥接。</div></div>' +
          '<div class="route-lane bridge"><div class="route-lane-head"><span class="route-lane-index">03</span><span><b>虚拟麦克风</b><small>' + escHtml(inputHint || '游戏 / 语音软件从对应输入端接收') + '</small></span><em class="route-lane-state">' + escHtml(bridgeEnabled ? '已桥接' : '未接入') + '</em></div>' +
            '<div class="route-node-grid bridge-grid"><button class="audio-route-node bridge workflow-node' + (bridgeEnabled ? ' active connected' : '') + (!bridgeId ? ' disabled' : '') + '" type="button" data-input-bridge="' + escHtml(bridgeId) + '">' +
              '<span class="flow-port in" data-input-bridge-target="' + escHtml(bridgeId) + '" title="虚拟麦克风输入"></span><span class="route-node-icon">MIC</span><span class="route-node-text"><b>' + escHtml(bridgeLabel) + '</b><small>' + escHtml(bridgeEnabled ? '已送入虚拟输入链路' : (bridgeId ? '可接入虚拟输入链路' : '需要虚拟声卡线缆')) + '</small></span><span class="route-node-pulse"></span>' +
            '</button></div>' +
            '<div class="audio-route-note">' + escHtml(inputHint ? ('输入端: ' + inputHint) : '真实麦克风不能被直接写入；请在游戏或语音软件里选择虚拟声卡的输入端。') + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  var workflowSubtitle = document.getElementById('audio-output-workflow-subtitle');
  if (workflowSubtitle) workflowSubtitle.textContent = summaryText;
  list.innerHTML =
    '<button class="audio-output-summary-card" type="button" onclick="openAudioOutputWorkflowPanel()">' +
      '<span class="route-node-icon">DSH</span>' +
      '<span class="audio-output-summary-copy"><b>' + escHtml(summaryText) + '</b><small>' +
        escHtml((activePrimary ? '主输出已指定' : '主输出使用系统默认') + ' / 镜像监听 ' + mirrorStateLabel + ' / 桥接 ' + (bridgeEnabled ? '开启' : '关闭')) +
      '</small></span>' +
      '<span class="audio-output-summary-action">路由</span>' +
    '</button>';
  var workflowBody = document.getElementById('audio-output-workflow-body');
  if (workflowBody) workflowBody.innerHTML = workflowHtml;
  requestAnimationFrame(function () { renderAudioRouteWorkflowEdges(); });
}
function openAudioOutputWorkflowPanel() {
  var modal = document.getElementById('audio-output-workflow-modal');
  if (!modal) return;
  openGsapModal(modal);
  bindAudioOutputControls();
  renderAudioOutputDeviceUi();
  requestAnimationFrame(function () {
    renderAudioRouteWorkflowEdges();
    setTimeout(renderAudioRouteWorkflowEdges, 80);
  });
  refreshAudioOutputDevices(false);
}
function closeAudioOutputWorkflowPanel() {
  closeGsapModal(document.getElementById('audio-output-workflow-modal'));
}
async function refreshAudioOutputDevices(showNotice) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    audioOutputDevices = [];
    audioInputDevices = [];
    renderAudioOutputDeviceUi();
    if (showNotice) showToast('当前环境不支持输出接口选择');
    return;
  }
  try {
    var devices = await navigator.mediaDevices.enumerateDevices();
    audioOutputDevices = devices.filter(function (device) { return device && device.kind === 'audiooutput' && device.deviceId !== 'default'; });
    audioInputDevices = devices.filter(function (device) { return device && device.kind === 'audioinput' && device.deviceId !== 'default'; });
    if (audioInputBridgeState && audioInputBridgeState.enabled && audioInputBridgeState.deviceId && !audioOutputDeviceById(audioInputBridgeState.deviceId)) {
      audioInputBridgeState.enabled = false;
      saveAudioInputBridgePreference();
    }
    renderAudioOutputDeviceUi();
    if (showNotice) showToast('输出接口已刷新');
  } catch (e) {
    audioOutputDevices = [];
    audioInputDevices = [];
    renderAudioOutputDeviceUi();
    if (showNotice) showToast('输出接口读取失败');
  }
}
function bindAudioOutputMirrorEvents(media) {
  if (!media || media._mineradioAudioMirrorBound) return;
  media._mineradioAudioMirrorBound = true;
  ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'volumechange', 'emptied'].forEach(function (name) {
    media.addEventListener(name, function () { syncAudioOutputMirrors(name); });
  });
}
function removeAudioOutputMirror(id) {
  var mirror = audioOutputMirrorElements && audioOutputMirrorElements[id];
  if (mirror) {
    try { mirror.pause(); } catch (e) { }
    try { mirror.removeAttribute('src'); mirror.load(); } catch (e) { }
    delete audioOutputMirrorElements[id];
  }
  if (audioOutputMirrorRuntime && id) delete audioOutputMirrorRuntime[id];
}
function clearAudioOutputMirrors() {
  Object.keys(audioOutputMirrorElements || {}).forEach(removeAudioOutputMirror);
  if (audioOutputMirrorSyncTimer) {
    clearInterval(audioOutputMirrorSyncTimer);
    audioOutputMirrorSyncTimer = 0;
  }
}
async function applyAudioOutputMirrorSink(mirror, sinkId) {
  if (!mirror || typeof mirror.setSinkId !== 'function') {
    markAudioOutputMirrorRuntime(sinkId, 'unsupported', '内核不支持');
    return false;
  }
  try {
    markAudioOutputMirrorRuntime(sinkId, 'sink-pending', '正在选择设备');
    await mirror.setSinkId(sinkId);
    markAudioOutputMirrorRuntime(sinkId, 'sink-ready', '设备已选');
    return true;
  } catch (e) {
    markAudioOutputMirrorRuntime(sinkId, 'sink-error', audioOutputMirrorReadableError(e));
    console.warn('[AudioOutputMirror]', e);
    return false;
  }
}
function syncAudioOutputMirrors(reason) {
  var ids = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).filter(function (id) { return id && id !== (audioOutputDeviceId || ''); });
  var src = audio && (audio.currentSrc || audio.src || '');
  Object.keys(audioOutputMirrorRuntime || {}).forEach(function (id) {
    if (ids.indexOf(id) < 0) delete audioOutputMirrorRuntime[id];
  });
  if (!ids.length) {
    clearAudioOutputMirrors();
    return;
  }
  if (!audioOutputMirrorSinkSupported()) {
    clearAudioOutputMirrors();
    ids.forEach(function (id) { markAudioOutputMirrorRuntime(id, 'unsupported', '内核不支持'); });
    return;
  }
  if (!audio || !src) {
    clearAudioOutputMirrors();
    ids.forEach(function (id) { markAudioOutputMirrorRuntime(id, 'waiting', '待播放时尝试'); });
    return;
  }
  Object.keys(audioOutputMirrorElements || {}).forEach(function (id) {
    if (ids.indexOf(id) < 0) removeAudioOutputMirror(id);
  });
  ids.forEach(function (id) {
    var mirror = audioOutputMirrorElements[id];
    if (!mirror) {
      mirror = new Audio();
      mirror.crossOrigin = 'anonymous';
      mirror.preload = 'auto';
      mirror.muted = !!audio.muted;
      mirror.volume = audio.volume;
      mirror.playbackRate = audio.playbackRate || 1;
      audioOutputMirrorElements[id] = mirror;
    }
    if (mirror._mineradioSinkId !== id || !mirror._mineradioSinkReady) {
      mirror._mineradioSinkId = id;
      if (!mirror._mineradioSinkBusy) {
        mirror._mineradioSinkBusy = true;
        Promise.resolve(applyAudioOutputMirrorSink(mirror, id)).then(function (ok) {
          mirror._mineradioSinkBusy = false;
          mirror._mineradioSinkReady = !!ok;
          if (ok) syncAudioOutputMirrors('mirror-sink-ready');
        });
      }
    }
    if ((mirror.currentSrc || mirror.src || '') !== src) {
      try { mirror.src = src; mirror.load(); } catch (e) { }
    }
    try { mirror.muted = !!audio.muted; mirror.volume = audio.volume; mirror.playbackRate = audio.playbackRate || 1; } catch (e) { }
    try {
      if (isFinite(audio.currentTime) && Math.abs((mirror.currentTime || 0) - audio.currentTime) > 0.22) {
        mirror.currentTime = audio.currentTime;
      }
    } catch (e) { }
    if (!mirror._mineradioSinkReady) return;
    if (audio.paused || audio.ended) {
      try { mirror.pause(); } catch (e) { }
      markAudioOutputMirrorRuntime(id, 'paused', '随主播放器暂停');
    } else {
      var rt = audioOutputMirrorRuntimeFor(id);
      if (!rt || rt.state !== 'playing') markAudioOutputMirrorRuntime(id, 'play-pending', '正在播放');
      var p = mirror.play();
      if (p && p.then) {
        p.then(function () {
          markAudioOutputMirrorRuntime(id, 'playing', '已确认');
        }).catch(function (e) {
          markAudioOutputMirrorRuntime(id, 'play-error', audioOutputMirrorReadableError(e));
          console.warn('[AudioOutputMirror] play failed:', e);
        });
      } else {
        markAudioOutputMirrorRuntime(id, 'playing', '已确认');
      }
    }
  });
  if (!audioOutputMirrorSyncTimer) {
    audioOutputMirrorSyncTimer = setInterval(function () { syncAudioOutputMirrors('clock'); }, 2200);
  }
}
async function applyAudioOutputDevice(media) {
  var sinkId = audioOutputDeviceId || '';
  var hasTarget = !!(media || audioCtx || uiSfxCtx);
  var mediaResult = null;
  var contextResult = null;
  var sfxResult = null;
  var errors = [];
  async function applySink(target, label) {
    if (!target) return null;
    if (typeof target.setSinkId !== 'function') return false;
    try {
      await target.setSinkId(sinkId);
      return true;
    } catch (e) {
      errors.push({ label: label, error: e });
      return false;
    }
  }
  bindAudioOutputMirrorEvents(media);
  mediaResult = await applySink(media, 'audio');
  contextResult = await applySink(audioCtx, 'audio-context');
  sfxResult = await applySink(uiSfxCtx, 'ui-sfx');
  var webAudioRouteActive = !!(audioReady && audioCtx && gainNode);
  var ok = webAudioRouteActive ? contextResult === true : (mediaResult === true || contextResult === true);
  if (sfxResult === true && !webAudioRouteActive && !media) ok = true;
  syncAudioOutputMirrors('apply-device');
  if (ok) {
    renderAudioOutputDeviceUi();
    return true;
  }
  if (!hasTarget) {
    renderAudioOutputDeviceUi();
    return null;
  }
  if (errors.length) {
    console.warn('[AudioOutput]', errors);
    if (errors.some(function (item) { return item.error && item.error.name === 'NotFoundError'; })) {
      audioOutputDeviceId = '';
      saveAudioOutputDevicePreference();
    }
  }
  renderAudioOutputDeviceUi();
  return false;
}
function setAudioOutputDevice(deviceId, showNotice) {
  audioOutputDeviceId = String(deviceId || '');
  var requestedDeviceId = audioOutputDeviceId;
  if (!requestedDeviceId || requestedDeviceId !== (audioInputBridgeState && audioInputBridgeState.deviceId || '')) {
    if (audioInputBridgeState && audioInputBridgeState.enabled) {
      audioInputBridgeState.enabled = false;
      saveAudioInputBridgePreference();
    }
  }
  audioOutputMirrorDeviceIds = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).filter(function (id) { return id !== requestedDeviceId; });
  saveAudioOutputMirrorPreference();
  saveAudioOutputDevicePreference();
  renderAudioOutputDeviceUi();
  Promise.resolve(applyAudioOutputDevice(audio)).then(function (ok) {
    if (!showNotice) return;
    if (!requestedDeviceId) showToast('已切回系统默认输出');
    else if (ok === true) showToast('输出接口已切换');
    else if (ok === null) showToast('输出接口已保存，播放时自动启用');
    else if (audioReady && audioCtx && typeof audioCtx.setSinkId !== 'function') showToast('当前内核不支持频谱输出实时切换，已保存选择');
    else showToast('当前输出接口暂不可用，已保存选择');
  });
}
function toggleAudioOutputMirrorDevice(deviceId) {
  deviceId = String(deviceId || '');
  if (!deviceId) return;
  if (!audioOutputMirrorSinkSupported()) {
    markAudioOutputMirrorRuntime(deviceId, 'unsupported', '内核不支持');
    showToast('当前内核不支持实验镜像监听');
    return;
  }
  if (deviceId === (audioOutputDeviceId || '')) {
    showToast('这个接口已经是主输出');
    return;
  }
  var ids = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds);
  var pos = ids.indexOf(deviceId);
  if (pos >= 0) {
    ids.splice(pos, 1);
    removeAudioOutputMirror(deviceId);
    showToast('已关闭实验镜像监听');
  } else {
    ids.push(deviceId);
    markAudioOutputMirrorRuntime(deviceId, audio && (audio.currentSrc || audio.src || '') ? 'sink-pending' : 'waiting', audio && (audio.currentSrc || audio.src || '') ? '正在尝试' : '待播放时尝试');
    showToast(audio && (audio.currentSrc || audio.src || '') ? '正在尝试实验镜像监听' : '已保存实验镜像监听，播放时尝试启用');
  }
  audioOutputMirrorDeviceIds = normalizeAudioOutputIdList(ids);
  saveAudioOutputMirrorPreference();
  renderAudioOutputDeviceUi();
  syncAudioOutputMirrors('mirror-toggle');
}
function setAudioInputBridgeDevice(deviceId, showNotice) {
  deviceId = String(deviceId || '');
  if (!deviceId) {
    if (showNotice) showToast('未检测到虚拟麦克风线缆输出端');
    renderAudioOutputDeviceUi();
    return;
  }
  var wasEnabled = !!(audioInputBridgeState && audioInputBridgeState.enabled && audioInputBridgeState.deviceId === deviceId);
  audioInputBridgeState = { enabled: !wasEnabled, deviceId: deviceId };
  saveAudioInputBridgePreference();
  if (audioInputBridgeState.enabled) {
    audioOutputDeviceId = deviceId;
    audioOutputMirrorDeviceIds = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).filter(function (id) { return id !== deviceId; });
    saveAudioOutputMirrorPreference();
    saveAudioOutputDevicePreference();
    Promise.resolve(applyAudioOutputDevice(audio)).then(function () {
      if (showNotice) showToast('已连接到虚拟麦克风桥接');
    });
  } else {
    if (audioOutputDeviceId === deviceId) {
      audioOutputDeviceId = '';
      saveAudioOutputDevicePreference();
      Promise.resolve(applyAudioOutputDevice(audio));
    }
    if (showNotice) showToast('已关闭虚拟麦克风桥接');
  }
  renderAudioOutputDeviceUi();
}
