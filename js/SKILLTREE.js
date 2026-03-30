// ═══════════════════════════════════════════════════════════════
//  SKILL TREE — Schema-driven radial node-graph visualization
//
//  Architecture:
//    1. createSkillTree(cfg) — shared reusable core
//       Handles: modal open/close, multi-axis filter toggles,
//       collision resolution, pan/zoom, proximity glow,
//       entrance animation, edge SVG creation.
//
//    2. "radial" layout (registered via _registerVizLayout)
//       → _radialFactory(vizCfg, rawData, key)
//       Reads EVERYTHING from the data file's viz{} schema.
//       Zero adapter code per dataset.
//
//       To add a new radial viz:
//         1. Add JSON file with conforming viz{} + data sections
//         2. Add to SETTINGS.json data.sources
//         3. Add modal entry: { "type":"viz", "layout":"radial",
//            "dataSource":"FOO" }
//         — No engine code changes required.
//
//  Depends on: VIZ.JS  (initPanZoom, createFilterSystem,
//                        createExploreHint, animateCameraFit,
//                        createLayoutToggle, createCrossfader)
//              MODALS.JS (toggleModal, _registerVizLayout)
// ═══════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────
//  createSkillTree(cfg) → controller
//
//  cfg fields:
//    modal            – DOM .modal-overlay element
//    closeBtn         – DOM close button (optional if shellConfig provided)
//    shellConfig      – optional config object for buildVizShell(); if provided
//                       and no .viz-viewport exists, builds the shell internally.
//                       closeBtn falls back to shell.closeBtn.
//    edgeSvgSelector  – CSS selector for SVG edge layer (default ".kg-edges")
//    filterBtnClass   – CSS class on filter buttons (default "viz-filter")
//
//    filterAxes       – Array of {
//        key,           – string key used in node.filterKeys[key]
//        allValues,     – string[] of all possible values
//        allBtn,        – DOM element for "all" toggle (or null)
//        itemBtns       – NodeList of per-value toggle buttons
//      }
//
//    buildNodes       – fn(graphWorld, svgNS, helpers) → {
//        nodes:[], hubs:[], centerVirts:[]
//      }
//      Called once to create all DOM elements.
//      helpers = { addEdge(from,to,color,width), registerHover(el,nodeRef), glowFilterId }
//      Each node: { el, targetX, targetY, r, filterKeys:{axis→Set}, _hidden:false, … }
//      Each hub:  { el, targetX, targetY, r, _hidden:false, children:[] }
//      centerVirts: virtual center objects for collision (not pushed)
//
//    isNodeVisible    – fn(node, filterSets:{key→Set}) → bool
//    onClose          – fn() called when modal closes (optional)
//
//    minScale / maxScale / initialScale  – zoom limits (defaults 0.3/5/1)
//    collisionPadding / collisionIters   – physics (defaults 2/80)
//    ignoreSelector   – extra CSS selector to pass through clicks (optional)
//
//  Returns: { open, close, shell, getNodes, getHubs, getTransform, applyFilters, updateGlow }
// ─────────────────────────────────────────────────────────────

/* ── Shared text helpers ── */
const _emojiOnlyRe = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u;

function fitTextToCircle(layer, circleSize, maxFont) {
  if (!layer) return;
  var text = (layer.textContent || "").trim();
  if (!text) return;
  var isEmoji = _emojiOnlyRe.test(text);
  if (isEmoji) {
    layer.style.fontSize = Math.min(maxFont, circleSize * 0.35) + "px";
    return;
  }
  /* Split on <br> to get the actual lines we control.
     Size so the longest word fits the circle width
     AND all lines fit the circle height. */
  var html = layer.innerHTML || "";
  var words = html.replace(/<br\s*\/?>/gi, "\n").split(/\n/).map(function (w) { return w.trim(); }).filter(Boolean);
  var nLines = words.length || 1;
  var longest = Math.max.apply(null, words.map(function (w) { return w.length; })) || 1;
  /* Width constraint: longest word must fit the circle width.
     Padding is minimal (2px each side); text may touch the border.
     Each uppercase char is roughly 0.62em wide. */
  var innerW = circleSize - 4;
  var widthFs = innerW / (longest * 0.67);
  /* Height constraint: all lines must stack within ~70% of circle */
  var heightFs = (circleSize * 0.70) / (nLines * 1.15);
  var fs = Math.min(widthFs, heightFs, maxFont, circleSize * 0.33);
  fs = Math.max(fs, 5);
  layer.style.fontSize = Math.floor(fs) + "px";
}

function _graphBreakText(text) {
  if (!text) return "";
  let s = text.replace(/\S+/g, w => w.length <= 4 ? w
    : w.replace(/([a-z])([A-Z])/g, "$1\x00$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\x00$2")
  );
  s = s.replace(/\s*&\s*/g, " &\x00");
  s = s.replace(/\s+/g, "\x00");
  s = s.replace(/\x00?\(/g, "\x00(");
  const tokens = s.split("\x00").filter(Boolean);
  return tokens.join("<br>");
}

/**
 * createNodeEl(opts) — shared DOM builder for kg-node elements.
 *
 *  opts.size       – circle diameter (px)
 *  opts.rgb        – comma-separated RGB string for --tc
 *  opts.label      – inner HTML for the name layer (may contain <br>)
 *  opts.whisper    – inner HTML for the whisper layer
 *  opts.onClick    – click handler (receives MouseEvent)
 *  opts.fitRatio   – fraction of circle for text fit (default 0.50)
 *
 * Returns the DOM element. Caller positions it (left/top) and appends
 * to graphWorld. Caller is responsible for hover registration.
 */
function createNodeEl(opts) {
  var size    = opts.size    || 60;
  var rgb     = opts.rgb     || '160,160,160';
  var label   = opts.label   || '';
  var whisper = opts.whisper  || label;
  var ratio   = opts.fitRatio || 0.50;

  var el = document.createElement("div");
  el.className = "kg-node";
  el.style.setProperty("--kg-size", size + "px");
  el.style.setProperty("--tc", rgb);

  var fontScale = Math.max(0.75, size / 80);
  el.style.setProperty("--kg-font", Math.round(8 * fontScale) + "px");
  el.style.setProperty("--kg-whisper", Math.round(7 * fontScale) + "px");

  el.innerHTML =
    '<div class="kg-node-accent" style="background:radial-gradient(circle at 30% 30%, rgba(' + rgb + ',0.15) 0%, transparent 70%);"></div>' +
    '<div class="kg-node-name">' +
      '<span class="kg-name-layer">' + label + '</span>' +
      '<span class="kg-name-layer kg-name-whisper kg-name-show">' + whisper + '</span>' +
      '<span class="kg-name-layer kg-name-whisper"></span>' +
    '</div>';

  if (opts.onClick) {
    el.addEventListener("click", function (e) { e.stopPropagation(); opts.onClick(e); });
  }

  var nameLayer     = el.querySelector(".kg-name-layer:not(.kg-name-whisper)");
  var whisperLayers = el.querySelectorAll(".kg-name-whisper");
  requestAnimationFrame(function () {
    fitTextToCircle(nameLayer, size, size * ratio);
    whisperLayers.forEach(function (wl) { fitTextToCircle(wl, size, size * ratio); });
  });

  // Attach references for crossfade consumers
  el._nameLayer     = nameLayer;
  el._whisperLayers = whisperLayers;

  return el;
}

function createSkillTree(cfg) {
  var modal    = cfg.modal;

  // Build viz shell internally if shellConfig is provided
  var _shell = null;
  if (cfg.shellConfig && !modal.querySelector(".viz-viewport")) {
    _shell = buildVizShell(modal, cfg.shellConfig);
  }
  var closeBtn = cfg.closeBtn || (_shell && _shell.closeBtn);
  if (!modal || !closeBtn) return null;

  /* ── State ───────────────────────────────────────────────── */
  var built       = false;
  var _nodes      = [];
  var _hubs       = [];
  var _threads    = [];      // { el (SVG path), from, to }
  var _transform  = { x: 0, y: 0, scale: cfg.initialScale || 1 };
  var _graphWorld = null;
  var _edgeSVG    = null;
  var _pz         = null;
  var _hoveredNode = null;

  var MIN_SCALE = cfg.minScale || 0.3;
  var MAX_SCALE = cfg.maxScale || 5;

  /* ── Filter state: one Set per axis ─────────────────────── */
  var _filterSets = {};
  var _axes = cfg.filterAxes || [];
  _axes.forEach(function (ax) {
    _filterSets[ax.key] = new Set(ax.allValues);
  });

  /* ── Reset all filter axes to "all" ──────────────────── */
  function _resetFilters() {
    _axes.forEach(function (ax) {
      ax.allValues.forEach(function (v) { _filterSets[ax.key].add(v); });
      if (ax._syncUI) ax._syncUI();
    });
    if (built) _applyFilters();
  }

  /* ── Open / close ───────────────────────────────────────── */
  var _stReg = registerModal(modal.id, {
    onOpen:  function () {
      _resetFilters();
      if (!built) {
        _build();
      } else {
        _updateTransform();
        requestAnimationFrame(function () { _animateEntrance(); });
      }
    },
    onClose: function () { if (cfg.onClose) cfg.onClose(); }
  });
  function open()  { _stReg.open(); }
  function close() { _stReg.close(); }

  /* ── Filter wiring ──────────────────────────────────────── */
  _axes.forEach(function (ax) {
    var active = _filterSets[ax.key];
    var all    = ax.allValues;

    function toggle(key) {
      if (key === "all") {
        all.forEach(function (k) { active.add(k); });
      } else if (active.has(key) && active.size === 1) {
        all.forEach(function (k) { active.add(k); });
      } else if (active.size === all.length) {
        active.clear(); active.add(key);
      } else if (active.has(key)) {
        active.delete(key);
      } else {
        active.add(key);
      }
    }

    function syncAxisUI() {
      if (ax.allBtn) ax.allBtn.classList.toggle("active", active.size === all.length);
      ax.itemBtns.forEach(function (b) {
        var val = b.dataset[ax.key] || b.dataset.filter;
        if (val && val !== "all") b.classList.toggle("active", active.has(val));
      });
    }

    if (ax.allBtn) ax.allBtn.addEventListener("click", function () {
      toggle("all"); syncAxisUI(); _applyFilters();
    });
    ax.itemBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var val = btn.dataset[ax.key] || btn.dataset.filter;
        toggle(val); syncAxisUI(); _applyFilters();
      });
    });

    ax._syncUI = syncAxisUI;
  });

  function _syncAllFilterUI() {
    _axes.forEach(function (ax) { if (ax._syncUI) ax._syncUI(); });
  }

  /* ── Apply filters ──────────────────────────────────────── */
  function _applyFilters() {
    var isVisible = cfg.isNodeVisible || _defaultVisible;
    _nodes.forEach(function (n) {
      var hide = !isVisible(n, _filterSets);
      n._hidden = hide;
      n.el.classList.toggle("kg-hidden", hide);
    });

    _hubs.forEach(function (h) {
      // Hide hub if its group is filtered out
      if (h._groupId && h._groupAxis && _filterSets[h._groupAxis] && !_filterSets[h._groupAxis].has(h._groupId)) {
        h._hidden = true;
        h.el.classList.add("kg-hidden");
        return;
      }
      if (!h.children || !h.children.length) return;
      var hasVis = h.children.some(function (c) { return !c._hidden; });
      h._hidden = !hasVis;
      h.el.classList.toggle("kg-hidden", !hasVis);
    });

    _threads.forEach(function (th) {
      var vis = !th.from._hidden && !th.to._hidden;
      th.el.classList.toggle("kg-thread-hidden", !vis);
      th.el.style.opacity = vis ? "1" : "";
    });

    _updateGlow();
    if (cfg.onFilterApplied) cfg.onFilterApplied();
  }

  function _defaultVisible(node, filterSets) {
    for (var key in filterSets) {
      var active = filterSets[key];
      var vals = node.filterKeys && node.filterKeys[key];
      if (!vals) continue;
      var arr = vals instanceof Set ? Array.from(vals) : (Array.isArray(vals) ? vals : [vals]);
      if (!arr.some(function (v) { return active.has(v); })) return false;
    }
    return true;
  }

  /* ── Proximity glow ─────────────────────────────────────── */
  var _glowRAF = 0;
  function _glowPass() {
    var vp = modal.querySelector(".viz-viewport");
    if (!vp) return;
    var vw = vp.clientWidth, vh = vp.clientHeight;
    var m = 0.40;
    var left = vw * m, right = vw * (1 - m), top = vh * m, bottom = vh * (1 - m);

    var all = _nodes.concat(_hubs);
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var sx = (n.targetX || 0) * _transform.scale + _transform.x;
      var sy = (n.targetY || 0) * _transform.scale + _transform.y;
      var inCenter = sx >= left && sx <= right && sy >= top && sy <= bottom;
      var hovered = n === _hoveredNode;
      var tourFocus = cfg.isTouring && cfg.isTouring() && !n.el.classList.contains("kg-hidden");
      var focused = (inCenter || hovered || tourFocus) && !n.el.classList.contains("kg-hidden");
      n.el.classList.toggle("kg-in-focus", focused);
    }
  }
  function _updateGlow() {
    // During touring, run synchronously so kg-in-focus is set in the
    // same paint frame as kg-hidden removal — prevents title flash.
    if (cfg.isTouring && cfg.isTouring()) {
      cancelAnimationFrame(_glowRAF);
      _glowPass();
      return;
    }
    cancelAnimationFrame(_glowRAF);
    _glowRAF = requestAnimationFrame(_glowPass);
  }

  /* ── Transform ──────────────────────────────────────────── */
  function _updateTransform() {
    if (!_graphWorld) return;
    if (_pz) { _pz.update(); return; }
    _graphWorld.style.transform = "translate(" + _transform.x + "px," + _transform.y + "px) scale(" + _transform.scale + ")";
    _updateGlow();
  }

  /* ── Build ──────────────────────────────────────────────── */
  function _build() {
    _graphWorld = modal.querySelector(".viz-world");
    _edgeSVG    = modal.querySelector(cfg.edgeSvgSelector || ".kg-edges");
    if (!_graphWorld || !_edgeSVG) return;

    // Clear previous
    _graphWorld.querySelectorAll(".kg-node").forEach(function (n) { n.remove(); });
    _edgeSVG.innerHTML = "";

    var svgNS = "http://www.w3.org/2000/svg";

    // SVG glow filter (unique per modal to avoid ID collisions)
    var glowId = "st-glow-" + modal.id;
    var defs = document.createElementNS(svgNS, "defs");
    var glow = document.createElementNS(svgNS, "filter");
    glow.setAttribute("id", glowId);
    glow.setAttribute("x", "-50%"); glow.setAttribute("y", "-50%");
    glow.setAttribute("width", "200%"); glow.setAttribute("height", "200%");
    var blur = document.createElementNS(svgNS, "feGaussianBlur");
    blur.setAttribute("stdDeviation", "2"); blur.setAttribute("result", "blur");
    var merge = document.createElementNS(svgNS, "feMerge");
    var mn1 = document.createElementNS(svgNS, "feMergeNode"); mn1.setAttribute("in", "blur");
    var mn2 = document.createElementNS(svgNS, "feMergeNode"); mn2.setAttribute("in", "SourceGraphic");
    merge.appendChild(mn1); merge.appendChild(mn2);
    glow.appendChild(blur); glow.appendChild(merge);
    defs.appendChild(glow);
    _edgeSVG.appendChild(defs);

    // Helpers passed to buildNodes callback
    var helpers = {
      glowFilterId: glowId,
      addEdge: function (from, to, color, width) {
        return _addEdge(svgNS, glowId, from, to, color, width);
      },
      registerHover: function (el, nodeRef) {
        el.addEventListener("mouseenter", function () {
          if (cfg.isTouring && cfg.isTouring()) return;
          _hoveredNode = nodeRef;
          _updateGlow();
          // Highlight connected arrows (mirroring MERMAID.JS)
          if (_graphWorld) _graphWorld.classList.add("kg-hovering");
          if (_edgeSVG) _edgeSVG.classList.add("kg-hovering");
          nodeRef.el.classList.add("kg-highlight");
          _threads.forEach(function (th) {
            if (th.from === nodeRef || th.to === nodeRef) {
              th.el.classList.add("kg-highlight");
              var peer = th.from === nodeRef ? th.to : th.from;
              if (peer && peer.el) peer.el.classList.add("kg-highlight");
            }
          });
        });
        el.addEventListener("mouseleave", function () {
          if (cfg.isTouring && cfg.isTouring()) return;
          if (_hoveredNode === nodeRef) { _hoveredNode = null; _updateGlow(); }
          // Clear all highlights
          if (_graphWorld) _graphWorld.classList.remove("kg-hovering");
          if (_edgeSVG) _edgeSVG.classList.remove("kg-hovering");
          if (_graphWorld) _graphWorld.querySelectorAll(".kg-highlight").forEach(function (e) { e.classList.remove("kg-highlight"); });
          if (_edgeSVG) _edgeSVG.querySelectorAll(".kg-highlight").forEach(function (e) { e.classList.remove("kg-highlight"); });
        });
      },
    };

    var result = cfg.buildNodes(_graphWorld, svgNS, helpers);
    _nodes   = result.nodes   || [];
    _hubs    = result.hubs    || [];
    // Consumer may return pre-built threads (portfolio) or none (mtg)
    if (result.threads && result.threads.length) {
      _threads = _threads.concat(result.threads);
    }
    var centerVirts = result.centerVirts || [];

    /* ── Collision resolution ─────────────────────────────── */
    var PADDING = cfg.collisionPadding || 2;
    var ITERS   = cfg.collisionIters   || 80;
    var immovable = centerVirts.concat(_hubs.filter(function (h) { return h._fixed !== false; }));

    for (var iter = 0; iter < ITERS; iter++) {
      var moved = false;
      for (var i = 0; i < _nodes.length; i++) {
        var a = _nodes[i];
        for (var j = 0; j < immovable.length; j++) {
          var b = immovable[j];
          var dx = a.targetX - b.targetX, dy = a.targetY - b.targetY;
          var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var minD = a.r + b.r + PADDING;
          if (d < minD) {
            var p = (minD - d) / d;
            a.targetX += dx * p; a.targetY += dy * p;
            moved = true;
          }
        }
        for (var k = i + 1; k < _nodes.length; k++) {
          var c = _nodes[k];
          var dx2 = c.targetX - a.targetX, dy2 = c.targetY - a.targetY;
          var d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 0.01;
          var minD2 = a.r + c.r + PADDING;
          if (d2 < minD2) {
            var o = (minD2 - d2) / 2;
            var nx = dx2 / d2, ny = dy2 / d2;
            a.targetX -= nx * o; a.targetY -= ny * o;
            c.targetX += nx * o; c.targetY += ny * o;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }

    // Finalize positions
    _nodes.forEach(function (n) {
      n.el.style.left = n.targetX + "px";
      n.el.style.top  = n.targetY + "px";
    });

    // Re-draw edges to final positions
    _threads.forEach(function (th) {
      var f = th.from, t = th.to;
      var dx = t.targetX - f.targetX, dy = t.targetY - f.targetY;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        var ux = dx / len, uy = dy / len;
        var x1 = f.targetX + ux * f.r, y1 = f.targetY + uy * f.r;
        var x2 = t.targetX - ux * t.r, y2 = t.targetY - uy * t.r;
        th.el.setAttribute("d", "M" + x1 + "," + y1 + " L" + x2 + "," + y2);
      }
    });

    // Center view
    var viewport = modal.querySelector(".viz-viewport");
    if (viewport) {
      requestAnimationFrame(function () {
        _transform.x = viewport.clientWidth / 2;
        _transform.y = viewport.clientHeight / 2;
        _transform.scale = cfg.initialScale || 1.0;
        _updateTransform();
      });
    }

    _initPanZoom();
    _syncAllFilterUI();
    built = true;
    requestAnimationFrame(function () { _animateEntrance(); });
  }

  /* ── Edge helper ────────────────────────────────────────── */
  function _addEdge(svgNS, glowId, from, to, color, width) {
    var dx = to.targetX - from.targetX, dy = to.targetY - from.targetY;
    var len = Math.sqrt(dx * dx + dy * dy);
    var fx = from.targetX, fy = from.targetY, tx = to.targetX, ty = to.targetY;
    if (len > 0) {
      var ux = dx / len, uy = dy / len;
      if (len > from.r + to.r) {
        fx += ux * from.r; fy += uy * from.r;
        tx -= ux * to.r;   ty -= uy * to.r;
      }
    }
    var path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", "M" + fx + "," + fy + " L" + tx + "," + ty);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "rgba(" + color + ",0.45)");
    path.setAttribute("stroke-width", String(width || 1));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("filter", "url(#" + glowId + ")");
    path.classList.add("kg-thread");
    path.style.opacity = "0";
    _edgeSVG.appendChild(path);
    var thread = { el: path, from: from, to: to };
    _threads.push(thread);
    return thread;
  }

  /* ── Pan & zoom ─────────────────────────────────────────── */
  function _initPanZoom() {
    var vp = modal.querySelector(".viz-viewport");
    if (!vp) return;
    var ignore = ".kg-node, .viz-explore-hint";
    if (cfg.ignoreSelector) ignore += ", " + cfg.ignoreSelector;
    _pz = initPanZoom(vp, _graphWorld, _transform, {
      minScale: MIN_SCALE, maxScale: MAX_SCALE,
      zoomStep: [0.9, 1.1],
      bounceCurve: "cubic-bezier(0.34,1.56,0.64,1)",
      bounceDuration: 380,
      rubberBandDrag: false,
      ignoreSelector: ignore,
      onUpdate: function () { _updateGlow(); },
      getBounds: function () {
        var vp2 = modal.querySelector(".viz-viewport");
        if (!vp2) return null;
        var all = _nodes.concat(_hubs);
        if (!all.length) return null;
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        all.forEach(function (n) {
          if (n.targetX < x0) x0 = n.targetX;
          if (n.targetX > x1) x1 = n.targetX;
          if (n.targetY < y0) y0 = n.targetY;
          if (n.targetY > y1) y1 = n.targetY;
        });
        var m = 100; x0 -= m; x1 += m; y0 -= m; y1 += m;
        var s = _transform.scale, pad = 0.48;
        return {
          minX: vp2.clientWidth  * pad - x1 * s, maxX: vp2.clientWidth  * (1 - pad) - x0 * s,
          minY: vp2.clientHeight * pad - y1 * s, maxY: vp2.clientHeight * (1 - pad) - y0 * s,
        };
      },
    });
  }

  /* ── Entrance animation ─────────────────────────────────── */
  function _animateEntrance() {
    var all = _hubs.concat(_nodes);
    all.forEach(function (n) {
      n.el.style.left = "0px"; n.el.style.top = "0px";
      n.el.style.opacity = "0";
      n.el.style.transform = "translate(-50%,-50%) scale(0.3)";
    });
    _threads.forEach(function (th) { th.el.style.opacity = "0"; });

    var dists = all.map(function (n) { return Math.sqrt((n.targetX||0)*(n.targetX||0) + (n.targetY||0)*(n.targetY||0)); });
    var maxDist = Math.max.apply(null, [1].concat(dists));
    var MAX_DELAY = 700;

    all.forEach(function (n, i) {
      var frac = Math.sqrt((n.targetX||0)*(n.targetX||0) + (n.targetY||0)*(n.targetY||0)) / maxDist;
      var delay = frac * MAX_DELAY + i * 2;
      setTimeout(function () {
        n.el.style.transition = "left 0.6s cubic-bezier(0.34,1.56,0.64,1),top 0.6s cubic-bezier(0.34,1.56,0.64,1),opacity 0.4s ease,transform 0.5s cubic-bezier(0.34,1.56,0.64,1)";
        n.el.style.left    = n.targetX + "px";
        n.el.style.top     = n.targetY + "px";
        n.el.style.opacity = "";
        n.el.style.transform = "translate(-50%,-50%) scale(1)";
        setTimeout(function () { n.el.style.transition = ""; }, 700);
      }, delay);
    });

    // Fade threads
    var fadeDur = 500, fadeStart = performance.now() + 350;
    function fadeThreads(now) {
      var t = Math.max(0, Math.min(1, (now - fadeStart) / fadeDur));
      var o = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      _threads.forEach(function (th) {
        if (!th.el.classList.contains("kg-thread-hidden")) th.el.style.opacity = String(o);
      });
      if (t < 1) requestAnimationFrame(fadeThreads);
    }
    requestAnimationFrame(fadeThreads);

    var vp = modal.querySelector(".viz-viewport");
    if (vp) requestAnimationFrame(function () {
      _transform.x = vp.clientWidth / 2;
      _transform.y = vp.clientHeight / 2;
      _transform.scale = cfg.initialScale || 1.0;
      _updateTransform();
    });

    setTimeout(function () { _updateGlow(); }, MAX_DELAY + all.length * 2 + 700);
  }

  /* ── Animate nodes to new targetX/Y positions ───────────── */
  function _animateToPositions(duration) {
    var dur = duration || 600;
    var ease = "cubic-bezier(0.34,1.56,0.64,1)";
    _nodes.concat(_hubs).forEach(function (n) {
      n.el.style.transition = "left " + dur + "ms " + ease + ",top " + dur + "ms " + ease;
      n.el.style.left = n.targetX + "px";
      n.el.style.top  = n.targetY + "px";
      setTimeout(function () { n.el.style.transition = ""; }, dur + 50);
    });
    // Redraw edges
    _threads.forEach(function (th) {
      var f = th.from, t = th.to;
      var dx = t.targetX - f.targetX, dy = t.targetY - f.targetY;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        var ux = dx / len, uy = dy / len;
        var x1 = f.targetX + ux * f.r, y1 = f.targetY + uy * f.r;
        var x2 = t.targetX - ux * t.r, y2 = t.targetY - uy * t.r;
        th.el.setAttribute("d", "M" + x1 + "," + y1 + " L" + x2 + "," + y2);
      }
    });
    setTimeout(function () { _updateGlow(); }, dur + 100);
  }

  /* ── Public API ─────────────────────────────────────────── */
  return {
    open:          open,
    close:         close,
    shell:         _shell,
    getNodes:      function () { return _nodes; },
    getHubs:       function () { return _hubs; },
    getThreads:    function () { return _threads; },
    getTransform:  function () { return _transform; },
    applyFilters:  _applyFilters,
    resetFilters:  _resetFilters,
    getFilterSets: function () { return _filterSets; },
    syncFilterUI:  _syncAllFilterUI,
    updateGlow:    _updateGlow,
    updateTransform: _updateTransform,
    animateToPositions: _animateToPositions,
  };
}


// ═══════════════════════════════════════════════════════════════
//  RADIAL VIZ — The single public layout engine
//
//  SETTINGS.json → { "type": "viz", "layout": "radial", "dataSource": "PORTFOLIO" }
//  Reads viz{} from DATA_REGISTRY[dataSource] at boot time.
//
//  Adding a new radial viz to the site:
//    1. Add a JSON file with a conforming "viz" block + data sections
//    2. Add it to SETTINGS.json data.sources
//    3. Add a modal entry: { "type": "viz", "layout": "radial", "dataSource": "FOO" }
//    — Zero engine code changes required.
// ═══════════════════════════════════════════════════════════════
window._registerVizLayout("radial", function (schema, key) {
  var sourceKey = (schema.dataSource || "").toLowerCase();
  var elementId = key.replace(/([A-Z])/g, function (m) { return '-' + m.toLowerCase(); });
  var modal = ensureModalOverlay(elementId, { ariaLabel: schema.ariaLabel || key });

  var _inner = null;
  var _bootAttempted = false;

  function _ensureBoot() {
    if (_inner) return true;
    if (_bootAttempted) return false;
    var rawData = DATA_REGISTRY[sourceKey];
    if (!rawData || !rawData.viz) return false;
    _bootAttempted = true;
    _inner = _radialFactory(rawData.viz, rawData, key);
    return !!_inner;
  }

  _ensureBoot();
  if (!_inner) {
    window.addEventListener("portfolioDataReady", function handler() {
      window.removeEventListener("portfolioDataReady", handler);
      _ensureBoot();
    });
  }

  return {
    el: modal,
    open: function () {
      if (_ensureBoot() && _inner.open) {
        _inner.open.apply(null, arguments);
      } else {
        var args = Array.prototype.slice.call(arguments);
        window.addEventListener("portfolioDataReady", function h() {
          window.removeEventListener("portfolioDataReady", h);
          if (_ensureBoot() && _inner.open) _inner.open.apply(null, args);
        });
      }
    },
    close: function () {
      if (_inner && _inner.close) _inner.close();
    }
  };
});


// ═══════════════════════════════════════════════════════════════
//  _radialFactory — Schema-driven radial viz engine.
//
//  Reads EVERYTHING from the viz{} JSON schema.
//  Handles: shell, filters (grouped & independent), nodes
//  (modalState & sections), hubs, edges (thread & hub),
//  sizing, collision, camera, glow, tour, keyboard nav.
//
//  No per-dataset adapter code. A new JSON file with a
//  conforming viz{} block "just works".
// ═══════════════════════════════════════════════════════════════
function _radialFactory(V, rawData, key) {
  var nodeCfg    = V.nodes    || {};
  var sizeCfg    = V.sizing   || {};
  var camCfg     = V.camera   || {};
  var colCfg     = V.collision || {};
  var layCfg     = V.layout   || {};
  var edgeCfg    = V.edges    || {};
  var tourCfg    = V.tour     || {};
  var centerCfg  = V.center   || null;
  var filterDefs = V.filters  || [];

  var modal = ensureModalOverlay(V.id, { ariaLabel: V.ariaLabel });


  // ── Resolve filter pill items from itemsFrom config ──────────
  function _resolveFilterItems(fDef) {
    var items = [
      { value: "all", tc: "255,255,255", tcLight: "30,30,30", allIndicator: "⬜", emoji: "", active: true }
    ];
    var src = fDef.itemsFrom || "";

    if (src === "themes") {
      var all = (fDef.sectors || []).concat(fDef.overlays || []);
      all.forEach(function (k) {
        var t = VIZ_THEMES[k];
        if (t) items.push({ value: k, tc: t.color, dot: t.color, emoji: t.emoji, active: true });
      });
    } else if (src.indexOf("categories.") === 0) {
      var path = src.split(".");
      var catObj = rawData;
      for (var pi = 0; pi < path.length && catObj; pi++) catObj = catObj[path[pi]];
      if (catObj && typeof catObj === "object") {
        Object.keys(catObj).forEach(function (k) {
          var entry = catObj[k];
          var color = entry.accent != null ? VIZ_resolveAccent(entry.accent) : (entry.color || "160,160,160");
          items.push({ value: k, tc: color, dot: color, emoji: entry.icon || k, active: true });
        });
      }
    }
    return items;
  }

  // ── Build shell ─────────────────────────────────────────────
  var shellCfg = V.shell || {};
  var filterGroups = [];
  filterDefs.forEach(function (fDef) {
    if (fDef.separator) filterGroups.push({ separator: true, items: [] });
    filterGroups.push({
      btnClass: "viz-filter",
      dataAttr: fDef.dataAttr || fDef.key,
      items: _resolveFilterItems(fDef),
    });
  });
  shellCfg.filterGroups = filterGroups;
  var shell = buildVizShell(modal, shellCfg);
  var closeBtn = shell.closeBtn;

  // ── Sector directions (the axis with role "sector" or first filter) ──
  var sectorAxis = filterDefs.find(function (f) { return f.role === "sector"; }) || filterDefs[0] || {};
  var sectorKeys = sectorAxis.sectors || [];
  var overlayKeys = sectorAxis.overlays || [];
  if (!sectorKeys.length && sectorAxis.itemsFrom) {
    var si = _resolveFilterItems(sectorAxis);
    sectorKeys = si.filter(function (x) { return x.value !== "all"; }).map(function (x) { return x.value; });
  }

  var sectorDir = {};
  sectorKeys.forEach(function (k, i) {
    var angle = (2 * Math.PI * i / sectorKeys.length) - Math.PI / 2;
    sectorDir[k] = { angle: angle, x: Math.cos(angle), y: Math.sin(angle) };
  });

  // ── Sizing function ─────────────────────────────────────────
  var SIZE_MIN  = sizeCfg.min || 40;
  var SIZE_MAX  = sizeCfg.max || 100;
  var SIZE_FIELD = sizeCfg.field;
  var SIZE_MAX_VAL = sizeCfg.maxValue != null ? sizeCfg.maxValue : null;
  var SIZE_XFORM = sizeCfg.transform || "linear";

  function _computeSize(val, gMin, gMax) {
    if (gMax <= gMin) return (SIZE_MIN + SIZE_MAX) / 2;
    var t = Math.max(0, Math.min(1, (val - gMin) / (gMax - gMin)));
    if (SIZE_XFORM === "sqrt") t = Math.sqrt(t);
    else if (SIZE_XFORM === "pow") t = Math.pow(t, sizeCfg.exponent || 0.5);
    if (sizeCfg.invert) t = 1 - t;
    return SIZE_MIN + t * (SIZE_MAX - SIZE_MIN);
  }

  // ── Color function ──────────────────────────────────────────
  function _resolveColor(item, sectorKey) {
    var cs = nodeCfg.colorScale;
    if (cs) {
      var v = nodeCfg.colorField ? (item[nodeCfg.colorField] || 0) : 0;
      for (var ci = 0; ci < cs.length; ci++) {
        if (cs[ci].max == null || v <= cs[ci].max) return VIZ_resolveAccent(cs[ci].accent);
      }
      return VIZ_resolveAccent(cs[cs.length - 1].accent);
    }
    if (nodeCfg.colorSource === "themes") {
      var theme = VIZ_THEMES[sectorKey] || VIZ_THEMES[VIZ_SOURCE_MAP[item.ID]] || VIZ_THEMES[sectorKeys[0]];
      return theme ? theme.color : "160,160,160";
    }
    return "160,160,160";
  }

  // ── Label / whisper helpers ─────────────────────────────────
  function _resolveLabel(item) {
    var lbl = nodeCfg.labelField ? (item[nodeCfg.labelField] || VIZ_SHORTNAME_MAP[item.ID]) : VIZ_SHORTNAME_MAP[item.ID];
    if (lbl) return lbl;
    var raw = (item[nodeCfg.labelFallback || "NAME"] || "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
    return _graphBreakText(raw);
  }

  var _emojiRe = /^([\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+(?:\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+)*)\s*/u;

  function _resolveWhisper(item) {
    var w = VIZ_WHISPER_MAP[item.ID];
    if (w) return w;
    var raw = (item[nodeCfg.whisperField] || item[nodeCfg.labelFallback] || item["NAME"] || "").replace(/<[^>]+>/g, " ").trim();
    if (nodeCfg.whisperExtract === "firstEmoji") {
      var m = raw.match(_emojiRe);
      if (m) return m[1];
    } else {
      var m2 = raw.match(_emojiRe);
      if (m2) return m2[1];
    }
    return _resolveLabel(item).charAt(0);
  }

  // ── Duration sizing (for "duration" field on modalState items) ──
  function _computeDuration(item) {
    var s = VIZ_parseDateStart(item.DATE);
    var e = VIZ_parseDateEnd(item.DATE);
    if (s == null) return 3;
    return Math.max(3, (e || s) - s);
  }

  // ── Collect items from the appropriate data source ──────────
  function _collectItems() {
    var result = [];

    if (nodeCfg.source === "modalState") {
      var reqFields = nodeCfg.require || [];
      Object.keys(modalState).forEach(function (sectionId) {
        (modalState[sectionId] || []).forEach(function (item) {
          var ok = reqFields.every(function (f) { return item[f]; });
          if (!ok) return;
          var sector = item[nodeCfg.sectorField] || VIZ_QUADRANT_MAP[item.ID];
          if (!sector && nodeCfg.sectorFallback) {
            sector = item[nodeCfg.sectorFallback] || VIZ_SOURCE_MAP[item.ID] || VIZ_DOMAIN_MAP[item.ID];
          }
          if (sectorKeys.length && sectorKeys.indexOf(sector) === -1) {
            sector = sectorKeys[sectorKeys.length - 1];
          }
          result.push({ item: item, sectionId: sectionId, sector: sector });
        });
      });
    } else if (nodeCfg.source === "data") {
      var itemsPath = nodeCfg.itemsPath || "items";
      var arr = rawData[itemsPath] || [];
      var gField = nodeCfg.groupField || null;
      arr.forEach(function (item) {
        var groups = gField ? (item[gField] || []) : [];
        if (!Array.isArray(groups)) groups = [groups];
        var sector = item[nodeCfg.sectorField] || sectorKeys[0];
        result.push({ item: item, sectionId: groups[0] || "", sector: sector, _groupSet: groups.length ? new Set(groups) : null });
      });
    }

    return result;
  }

  // ── Sizing bounds ───────────────────────────────────────────
  function _sizeBounds(collected) {
    if (!SIZE_FIELD) return { min: 0, max: 1 };
    if (SIZE_MAX_VAL != null) return { min: 0, max: SIZE_MAX_VAL };
    var lo = Infinity, hi = -Infinity;
    collected.forEach(function (c) {
      var v = c._sizeVal;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    });
    if (lo === Infinity) { lo = 0; hi = 1; }
    return { min: lo, max: hi };
  }

  // ── Card detail modal (for onClick: "card") ─────────────────
  var _cardReg = null;
  function _openCardDetail(item) {
    // Lazy-create the detail overlay
    if (!_cardReg) {
      var detailId = V.id + "-card-detail";
      var el = ensureModalOverlay(detailId, { ariaLabel: "Card Detail" });
      el.innerHTML =
        '<div class="glass-tile modal-card kg-detail-card">' +
          '<div class="modal-sticky-bar"><div class="modal-sticky-group tl-glow">' +
            '<div class="kg-badges" id="' + detailId + '-badges"></div>' +
            '<button class="modal-close" aria-label="Close modal">&times;</button>' +
          '</div></div>' +
          '<img class="kg-detail-art" id="' + detailId + '-art" src="" alt="" />' +
        '</div>';
      _cardReg = registerModal(detailId);
    }

    var art = document.getElementById(V.id + "-card-detail-art");
    var badges = document.getElementById(V.id + "-card-detail-badges");

    if (art) {
      var tmpl = nodeCfg.artTemplate || "";
      art.src = tmpl.replace("{ID}", item.ID || "");
      art.alt = (item[nodeCfg.labelFallback || "NAME"] || "").replace(/<[^>]+>/g, "").trim();
      art.style.display = art.src ? "" : "none";
    }

    if (badges) {
      var html = "";
      filterDefs.forEach(function (fDef) {
        var val = item[fDef.key.toUpperCase()] || item[fDef.key] || "";
        var vals = Array.isArray(val) ? val : [val];
        vals.forEach(function (v) {
          if (!v) return;
          // Resolve color from filter items
          var fi = _resolveFilterItems(fDef);
          var match = fi.find(function (x) { return x.value === v; });
          var bc = match ? match.tc : "160,160,160";
          html += '<span class="kg-badge" style="--bc:' + bc + '">' + v + '</span>';
        });
      });
      badges.innerHTML = html;
    }

    _cardReg.open();
  }

  // ── Node click handler ──────────────────────────────────────
  function _handleClick(entry) {
    if (nodeCfg.onClick === "entry") {
      openEntry(entry.sectionId, entry.item.ID);
    } else if (nodeCfg.onClick === "card") {
      _openCardDetail(entry.item);
    }
  }

  // ── Build filter axes for createSkillTree ───────────────────
  var _filterAxes = [];
  filterDefs.forEach(function (fDef) {
    var items = _resolveFilterItems(fDef);
    var allValues = items.filter(function (x) { return x.value !== "all"; }).map(function (x) { return x.value; });
    var dataAttr = fDef.dataAttr || fDef.key;
    var allBtn   = modal.querySelector('.viz-filter[data-' + dataAttr + '="all"]');
    var itemBtns = Array.from(modal.querySelectorAll('.viz-filter[data-' + dataAttr + ']')).filter(function (b) {
      return b.dataset[dataAttr] !== "all";
    });

    _filterAxes.push({
      key: dataAttr,
      allValues: allValues,
      allBtn: allBtn,
      itemBtns: itemBtns,
      _fDef: fDef,
    });
  });

  // ── Grouped-mode custom visibility (sector/overlay logic) ──
  var _isGrouped = filterDefs.length === 1 && filterDefs[0].mode === "grouped";
  var _groupedOverlaySet = _isGrouped ? new Set(overlayKeys) : null;

  function _groupedVisible(node, filterSets) {
    var active = filterSets[_filterAxes[0].key];
    if (!active) return true;
    var sectorOn = active.has(node._sector);
    var nodeTheme = node._theme;
    var isOverlay = _groupedOverlaySet.has(nodeTheme);
    var anySectorOn = sectorKeys.some(function (q) { return active.has(q); });
    if (isOverlay) {
      return active.has(nodeTheme) && (!anySectorOn || sectorOn);
    }
    return sectorOn;
  }

  // ── Bézier helpers (for thread edges) ───────────────────────
  function _bezierCtrl(x1, y1, x2, y2, idx) {
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var px = -dy / len, py = dx / len;
    var sign = (idx % 2 === 0) ? 1 : -1;
    return { x: mx + px * len * 0.18 * sign, y: my + py * len * 0.18 * sign };
  }

  function _curveD(x1, y1, cx, cy, x2, y2) {
    return "M" + x1 + "," + y1 + " Q" + cx + "," + cy + " " + x2 + "," + y2;
  }

  // ── Emoji splitter for multi-value fields ──────────────────
  var _splitEmojis = {};
  filterDefs.forEach(function (fDef) {
    if (fDef.splitField) {
      var catObj = rawData.categories && rawData.categories[fDef.key];
      if (catObj) {
        var keys = Object.keys(catObj);
        keys.sort(function (a, b) { return b.length - a.length; });
        _splitEmojis[fDef.key] = keys;
      }
    }
  });

  function _splitEmojiValues(str, tokens) {
    var result = [];
    var rem = str;
    while (rem.length) {
      var matched = false;
      for (var i = 0; i < tokens.length; i++) {
        if (rem.indexOf(tokens[i]) === 0) {
          result.push(tokens[i]);
          rem = rem.slice(tokens[i].length);
          matched = true;
          break;
        }
      }
      if (!matched) rem = rem.slice(1);
    }
    return result;
  }

  // ── Shared radial position calculator (DRY: used by both initial layout & relayout) ──
  var _LAY_MIN  = layCfg.minDist || 80;
  var _LAY_MAX  = layCfg.maxDist || 400;
  var _LAY_SPREAD = 2 * Math.PI / Math.max(1, sectorKeys.length) * (layCfg.spreadFactor || 0.6);

  function _radialPosition(t, idx, groupLen, baseAngle) {
    if (SIZE_XFORM === "sqrt") t = Math.sqrt(t);
    var dist = _LAY_MIN + t * (_LAY_MAX - _LAY_MIN);
    var angle;
    if (groupLen === 1) { angle = baseAngle; }
    else {
      var frac = idx / (groupLen - 1);
      angle = baseAngle + _LAY_SPREAD * (frac - 0.5);
    }
    var s1 = Math.sin(idx * 7.3 + baseAngle * 13.7);
    var s2 = Math.sin(idx * 11.1 + baseAngle * 5.3);
    dist *= (1 + s1 * 0.06);
    angle += s2 * 0.06;
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
  }

  // ── Derive group axis key from filterDefs ───────────────────
  var _groupAxisKey = "";
  filterDefs.forEach(function (fd) {
    if (fd.fromGroups) _groupAxisKey = fd.dataAttr || fd.key;
  });

  // ── buildNodes callback for createSkillTree ─────────────────
  var _hubRefs = {};
  var _localThreads = [];
  var _centerVirtual = null;

  function _buildNodes(graphWorld, svgNS, helpers) {
    var nodes = [], hubs = [], centerVirts = [];
    _localThreads = [];
    _hubRefs = {};

    var collected = _collectItems();
    if (collected.length === 0) return { nodes: nodes, hubs: hubs, centerVirts: centerVirts };

    // ── Center node ─────────────────────────────────────────
    var CENTER_R = 0;
    if (centerCfg) {
      CENTER_R = centerCfg.size / 2;
      var cEl = document.createElement("div");
      cEl.className = "kg-node kg-node-center";
      cEl.style.setProperty("--kg-size", centerCfg.size + "px");
      cEl.innerHTML = '<div class="kg-node-icon">' + (centerCfg.icon || "⭐") + '</div>';
      cEl.style.left = "0px"; cEl.style.top = "0px"; cEl.style.cursor = "pointer";
      cEl.addEventListener("click", function (e) {
        e.stopPropagation();
        if (centerCfg.action) openModal(centerCfg.action);
      });
      graphWorld.appendChild(cEl);
      _centerVirtual = { targetX: 0, targetY: 0, _newX: 0, _newY: 0, r: CENTER_R, _hidden: false };
      centerVirts.push(_centerVirtual);
    }

    // ── Hub nodes (for "hub" edge mode) ─────────────────────
    if (edgeCfg.connect === "hub" && nodeCfg.hubField) {
      var hubGap  = nodeCfg.hubGap || 75;
      var hubSize = nodeCfg.hubSize || 120;
      // Discover unique hub IDs from data
      var hubIds = [];
      collected.forEach(function (c) {
        var groups = c._groupSet ? Array.from(c._groupSet) : [];
        if (groups.length) {
          groups.forEach(function (d) { if (hubIds.indexOf(d) === -1) hubIds.push(d); });
        } else {
          var hid = c.sectionId || c.item[nodeCfg.hubField] || "";
          if (hid && hubIds.indexOf(hid) === -1) hubIds.push(hid);
        }
      });

      // Resolve hub metadata from categories
      var hubCatKey = _groupAxisKey || "";
      var hubCat = {};
      if (hubCatKey && rawData.categories && rawData.categories[hubCatKey]) hubCat = rawData.categories[hubCatKey];

      // Commander cards (if commanderCategory is set)
      var cmdCat = nodeCfg.commanderCategory;
      var cmdCards = {};
      if (cmdCat) {
        collected.forEach(function (c) {
          var cat = c.item[nodeCfg.fieldMap && nodeCfg.fieldMap.category ? nodeCfg.fieldMap.category : "CATEGORY"] || c.item.category || "";
          if (cat === cmdCat) {
            var groups = c._groupSet ? Array.from(c._groupSet) : [c.sectionId || ""];
            groups.forEach(function (d) { cmdCards[d] = c; });
          }
        });
      }

      hubIds.forEach(function (hid, i) {
        var angle = (2 * Math.PI * i / hubIds.length) - Math.PI / 2;
        var hx = Math.cos(angle) * hubGap;
        var hy = Math.sin(angle) * hubGap;
        var meta = hubCat[hid] || {};
        var color = meta.accent != null ? VIZ_resolveAccent(meta.accent) : (meta.color || "160,160,160");
        var icon  = meta.icon || hid.charAt(0).toUpperCase();
        var label = meta.label || hid;

        var hubEl = document.createElement("div");
        hubEl.className = "kg-node kg-hub";
        hubEl.style.setProperty("--kg-size", hubSize + "px");
        hubEl.style.setProperty("--tc", color);
        hubEl.style.left = hx + "px"; hubEl.style.top = hy + "px";
        hubEl.innerHTML = '<div class="kg-node-icon">' + icon + '</div>' +
          '<div class="kg-node-name"><span class="kg-name-layer kg-name-show" style="font-size:9px">' + label + '</span></div>';

        // Commander click
        var cmd = cmdCards[hid];
        if (cmd) {
          hubEl.style.cursor = "pointer";
          hubEl.addEventListener("click", function (e) { e.stopPropagation(); _handleClick(cmd); });
        }

        graphWorld.appendChild(hubEl);
        var hubRef = { el: hubEl, targetX: hx, targetY: hy, r: hubSize / 2, _hidden: false, _fixed: true, _groupId: hid, _groupAxis: _groupAxisKey, children: [] };
        hubs.push(hubRef);
        _hubRefs[hid] = hubRef;
      });

      CENTER_R = Math.max(CENTER_R, hubSize / 2 + hubGap);
      if (_centerVirtual) _centerVirtual.r = CENTER_R;
    }

    // ── Compute sizing values ─────────────────────────────────
    if (SIZE_FIELD === "duration") {
      collected.forEach(function (c) { c._sizeVal = _computeDuration(c.item); });
    } else if (SIZE_FIELD) {
      collected.forEach(function (c) { c._sizeVal = c.item[SIZE_FIELD] || 0; });
    } else {
      collected.forEach(function (c) { c._sizeVal = 1; });
    }
    var sb = _sizeBounds(collected);
    collected.forEach(function (c) {
      c._size = _computeSize(c._sizeVal, sb.min, sb.max);
      c._r = c._size / 2;
    });

    // ── Group by sector, compute initial positions ────────────
    var groups = {};
    sectorKeys.forEach(function (k) { groups[k] = []; });
    collected.forEach(function (c) {
      if (!groups[c.sector]) groups[c.sector] = [];
      groups[c.sector].push(c);
    });

    // Sort within each group
    Object.keys(groups).forEach(function (gk) {
      groups[gk].sort(function (a, b) {
        var da = a.item.DATE ? VIZ_parseDateStart(a.item.DATE) : null;
        var db = b.item.DATE ? VIZ_parseDateStart(b.item.DATE) : null;
        if (da != null && db != null) return da - db;
        return (b._sizeVal || 0) - (a._sizeVal || 0);
      });
    });

    sectorKeys.forEach(function (sk) {
      var group = groups[sk] || [];
      if (!group.length) return;
      var dir = sectorDir[sk];
      var baseAngle = dir ? dir.angle : 0;

      group.forEach(function (c, idx) {
        var t = sb.max > sb.min ? (c._sizeVal - sb.min) / (sb.max - sb.min) : 0.5;
        var pos = _radialPosition(t, idx, group.length, baseAngle);
        c._x = pos.x;
        c._y = pos.y;
      });
    });

    // ── Skip commanders in hub mode (they live on hub nodes) ──
    var cmdCat2 = nodeCfg.commanderCategory;
    var fmCat   = nodeCfg.fieldMap && nodeCfg.fieldMap.category ? nodeCfg.fieldMap.category : "CATEGORY";

    // ── Deduplicate & skip commanders ──────────────────────────
    var deduped = [];
    collected.forEach(function (c) {
      var catVal = c.item[fmCat] || c.item.category || "";
      if (cmdCat2 && catVal === cmdCat2) return;
      deduped.push(c);
    });

    // ── Create DOM nodes ──────────────────────────────────────
    deduped.forEach(function (c) {
      var rgb = _resolveColor(c.item, c.sector);
      var lbl = _resolveLabel(c.item);
      var wsp = _resolveWhisper(c.item);

      var el = createNodeEl({
        size:    c._size,
        rgb:     rgb,
        label:   lbl,
        whisper: wsp,
        fitRatio: nodeCfg.fitRatio || 0.50,
        onClick: function () { _handleClick(c); },
      });

      el.style.left = c._x + "px";
      el.style.top  = c._y + "px";
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", (c.item[nodeCfg.labelFallback || "NAME"] || "").replace(/<[^>]+>/g, "").trim());

      graphWorld.appendChild(el);

      // Build filterKeys for multi-axis intersection
      var filterKeys = {};
      filterDefs.forEach(function (fDef) {
        var attr = fDef.dataAttr || fDef.key;
        if (fDef.mode === "grouped") {
          // Grouped: resolve from VIZ metadata or fall back to sector
          var src = VIZ_SOURCE_MAP[c.item.ID] || VIZ_DOMAIN_MAP[c.item.ID] || c.sector;
          filterKeys[attr] = new Set([src]);
        } else if (fDef.fromGroups && c._groupSet) {
          filterKeys[attr] = c._groupSet;
        } else if (fDef.splitField && _splitEmojis[fDef.key]) {
          var rawSplit = c.item[fDef.splitField] || "";
          var splitVals = _splitEmojiValues(rawSplit, _splitEmojis[fDef.key]);
          filterKeys[attr] = new Set(splitVals.length ? splitVals : [rawSplit || ""]);
        } else {
          var rawVal = c.item[fDef.key.toUpperCase()] || c.item[fDef.key] || c.sector;
          var arrVal = Array.isArray(rawVal) ? rawVal : [rawVal];
          filterKeys[attr] = new Set(arrVal);
        }
      });

      var wList = [wsp];
      var nodeRef = {
        el: el,
        targetX: c._x, targetY: c._y,
        r: c._r,
        _hidden: false,
        filterKeys: filterKeys,
        _entry: c,
        _sector: c.sector,
        _theme: VIZ_SOURCE_MAP[c.item.ID] || VIZ_DOMAIN_MAP[c.item.ID] || c.sector,
        absMonth: c.item.DATE ? VIZ_parseDateStart(c.item.DATE) : 0,
        endMonth: c.item.DATE ? VIZ_parseDateEnd(c.item.DATE) : 0,
        dist: Math.sqrt(c._x * c._x + c._y * c._y),
        whispers: wList,
        nameLayer: el._nameLayer,
        whisperLayers: Array.from(el._whisperLayers),
        activeWhisper: 0, lastWhisperIdx: -1, wasFocused: false,
      };

      helpers.registerHover(el, nodeRef);

      // Hub edges
      if (edgeCfg.connect === "hub" && nodeCfg.hubField) {
        var groupIds = c._groupSet || new Set([c.sectionId]);
        groupIds.forEach(function (did) {
          var hub = _hubRefs[did];
          if (hub) {
            helpers.addEdge(hub, nodeRef, rgb, 0.7);
            hub.children.push(nodeRef);
          }
        });
      }

      nodes.push(nodeRef);
    });

    // ── Thread edges (for "thread" mode — bézier by overlay×sector) ──
    if (edgeCfg.connect === "thread" && overlayKeys.length) {
      var defs = graphWorld.closest(".modal-overlay").querySelector("." + (shellCfg.svgClass || "kg-edges") + " defs");
      if (!defs) {
        var svgEl = graphWorld.closest(".modal-overlay").querySelector("." + (shellCfg.svgClass || "kg-edges"));
        defs = document.createElementNS(svgNS, "defs");
        if (svgEl) svgEl.prepend(defs);
      }

      // Glow filter
      var glowF = document.createElementNS(svgNS, "filter");
      glowF.setAttribute("id", "thread-glow");
      glowF.setAttribute("x", "-50%"); glowF.setAttribute("y", "-50%");
      glowF.setAttribute("width", "200%"); glowF.setAttribute("height", "200%");
      var feB = document.createElementNS(svgNS, "feGaussianBlur");
      feB.setAttribute("stdDeviation", "2.5"); feB.setAttribute("result", "blur");
      var feM = document.createElementNS(svgNS, "feMerge");
      var mn1 = document.createElementNS(svgNS, "feMergeNode"); mn1.setAttribute("in", "blur");
      var mn2 = document.createElementNS(svgNS, "feMergeNode"); mn2.setAttribute("in", "SourceGraphic");
      feM.appendChild(mn1); feM.appendChild(mn2);
      glowF.appendChild(feB); glowF.appendChild(feM);
      if (defs) defs.appendChild(glowF);

      // Arrow markers per theme
      overlayKeys.concat(sectorKeys).forEach(function (themeKey) {
        var src = VIZ_THEMES[themeKey];
        if (!src) return;
        var marker = document.createElementNS(svgNS, "marker");
        marker.setAttribute("id", "thread-arrow-" + themeKey);
        marker.setAttribute("viewBox", "0 0 10 10");
        marker.setAttribute("refX", "10"); marker.setAttribute("refY", "5");
        marker.setAttribute("markerWidth", "4"); marker.setAttribute("markerHeight", "4");
        marker.setAttribute("orient", "auto-start-reverse");
        marker.setAttribute("markerUnits", "userSpaceOnUse");
        var arrowPath = document.createElementNS(svgNS, "path");
        arrowPath.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
        arrowPath.setAttribute("fill", "rgb(" + src.color + ")");
        marker.appendChild(arrowPath);
        if (defs) defs.appendChild(marker);
      });

      // Build threads: one per overlay-theme × sector
      var edgeSVG = graphWorld.closest(".modal-overlay").querySelector("." + (shellCfg.svgClass || "kg-edges"));

      overlayKeys.forEach(function (theme) {
        var src = VIZ_THEMES[theme];
        if (!src) return;

        sectorKeys.forEach(function (qKey) {
          var threadNodes = nodes.filter(function (n) {
            return n._theme === theme && n._sector === qKey;
          });
          if (threadNodes.length < 1) return;

          threadNodes.sort(function (a, b) { return (a.endMonth || 0) - (b.endMonth || 0); });

          var chain = _centerVirtual ? [_centerVirtual].concat(threadNodes) : threadNodes;
          var segments = [];
          for (var si = 1; si < chain.length; si++) {
            var from = chain[si - 1], to = chain[si];
            var fx = from.targetX, fy = from.targetY, tx = to.targetX, ty = to.targetY;
            var dx = tx - fx, dy = ty - fy, len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0) {
              var ux = dx / len, uy = dy / len;
              var fR = from.r || 30, tR = to.r || 30;
              if (len > fR + tR) { fx += ux * fR; fy += uy * fR; tx -= ux * tR; ty -= uy * tR; }
            }

            var cp = _bezierCtrl(fx, fy, tx, ty, si);
            var path = document.createElementNS(svgNS, "path");
            path.setAttribute("d", _curveD(fx, fy, cp.x, cp.y, tx, ty));
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", "rgb(" + src.color + ")");
            path.setAttribute("stroke-width", "1");
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("filter", "url(#thread-glow)");
            if (edgeCfg.markers) path.setAttribute("marker-end", "url(#thread-arrow-" + theme + ")");
            path.classList.add("kg-thread");
            path.style.opacity = "0";
            path.dataset.theme = theme;
            path.dataset.sector = qKey;
            path._cx1 = fx; path._cy1 = fy;
            path._ccx = cp.x; path._ccy = cp.y;
            path._cx2 = tx; path._cy2 = ty;
            if (edgeSVG) edgeSVG.appendChild(path);
            segments.push(path);
          }
          _localThreads.push({ theme: theme, sector: qKey, segments: segments, nodes: chain });
        });
      });
    }

    return { nodes: nodes, hubs: hubs, centerVirts: centerVirts, threads: [] };
  }

  // ── createSkillTree with all schema-derived config ──────────
  var _tree = null;
  var _tour = null;
  var _layoutToggle = null;

  function _initTree() {
    if (_tree) return;

    _tree = createSkillTree({
      modal:            modal,
      closeBtn:         closeBtn,
      edgeSvgSelector:  "." + (shellCfg.svgClass || "kg-edges"),
      filterAxes:       _filterAxes,
      buildNodes:       _buildNodes,
      isNodeVisible:    _isGrouped ? _groupedVisible : null,
      initialScale:     camCfg.initialScale || 1,
      minScale:         camCfg.minScale || 0.3,
      maxScale:         camCfg.maxScale || 4,
      collisionPadding: colCfg.padding || 2,
      collisionIters:   colCfg.iterations || 60,
      isTouring:        function () { return _tour && _tour.isTouring(); },
      onClose:          function () {
        if (_cardReg) _cardReg.close();
        if (_tour && _tour.isTouring()) _tour.stop();
      },
      onFilterApplied:  function () {
        // Thread visibility for grouped mode
        if (edgeCfg.connect === "thread" && _localThreads.length) {
          var fs = _tree.getFilterSets();
          var fKey = _filterAxes[0] ? _filterAxes[0].key : "filter";
          var active = fs[fKey];
          var activeOverlays = overlayKeys.filter(function (f) { return active && active.has(f); });
          var singleOverlay = activeOverlays.length === 1;

          _localThreads.forEach(function (th) {
            var themeOn    = active && active.has(th.theme);
            var sectorOn   = active && active.has(th.sector);
            var visible = themeOn && sectorOn;
            th.segments.forEach(function (seg) {
              seg.classList.toggle("kg-thread-hidden", !visible);
              seg.style.opacity = visible ? "1" : "";
              if (visible && edgeCfg.dynamicColor) {
                var useSectorColor = singleOverlay;
                var tc = VIZ_THEMES[useSectorColor ? th.sector : th.theme];
                if (tc) {
                  seg.setAttribute("stroke", "rgb(" + tc.color + ")");
                  seg.setAttribute("marker-end", "url(#thread-arrow-" + (useSectorColor ? th.sector : th.theme) + ")");
                }
              }
            });
          });
        }

        // Relayout if dynamic layout toggle
        if (_layoutToggle && !_layoutToggle.isStatic()) {
          _relayoutDynamic();
        }

        // Camera fit
        if (!_tour || !_tour.isTouring()) {
          var settleDelay = (_layoutToggle && !_layoutToggle.isStatic()) ? 700 : 80;
          setTimeout(function () { _fitVisibleNodes(true); }, settleDelay);
        }
      },
    });

    if (!_tree) return;

    // ── Layout toggle ─────────────────────────────────────────
    _layoutToggle = createLayoutToggle({
      btn: shellCfg.toggleId || "vizLayoutToggle",
      onDynamic: function () { if (_tree) _relayoutDynamic(); },
    });

    // ── Keyboard nav ──────────────────────────────────────────
    initVizKeyboardNav({
      modal: modal,
      getNodes: function () { return _tree.getNodes(); },
      onFocus: function (n) { _tree.updateGlow(); },
      onActivate: function (n) { _handleClick(n._entry); },
      liveRegionId: (shellCfg.accessibility && shellCfg.accessibility.liveRegionId) || null,
    });

    // ── Tour ──────────────────────────────────────────────────
    var tourSteps = tourCfg.steps && tourCfg.steps.length ? tourCfg.steps : null;

    // Auto-generate steps for multi-axis vizzes with no explicit steps
    if (!tourSteps && filterDefs.length > 1) {
      tourSteps = [];
      _filterAxes.forEach(function (ax) {
        ax.allValues.forEach(function (v) {
          var step = { label: v, filters: {} };
          step.filters[ax.key] = [v];
          tourSteps.push(step);
        });
      });
      if (!tourSteps.length) tourSteps = null;
    }

    if (tourSteps) {
      _tour = createTourEngine({
        modal:     modal,
        viewport:  modal.querySelector(".viz-viewport"),
        hintLabel: tourCfg.hintLabel || '<strong>Traverse</strong><span class="scroll-arrow">\uD83D\uDD2D</span>',
        steps:     tourSteps,
        stepDelay: tourCfg.stepDelay || 2000,
        applyStep: function (step) {
          if (!_tree) return;
          var fs = _tree.getFilterSets();
          if (Array.isArray(step.filters)) {
            var fKey = _filterAxes[0] ? _filterAxes[0].key : "filter";
            var active = fs[fKey];
            if (active) {
              var allVals = _filterAxes[0] ? _filterAxes[0].allValues : [];
              allVals.forEach(function (v) { active.delete(v); });
              (Array.isArray(step.filters) ? step.filters : []).forEach(function (f) { active.add(f); });
            }
          } else if (step.filters) {
            _filterAxes.forEach(function (ax) {
              var vals = step.filters[ax.key];
              fs[ax.key].clear();
              if (vals) { vals.forEach(function (v) { fs[ax.key].add(v); }); }
              else { ax.allValues.forEach(function (v) { fs[ax.key].add(v); }); }
            });
          }
          _tree.syncFilterUI();
          _tree.applyFilters();
        },
        resetAll:  function () { if (_tree) _tree.resetFilters(); },
        fitCamera: function () { _fitVisibleNodes(true); },
        setShowNames: function (show) {
          var vp = modal.querySelector(".viz-viewport");
          if (vp) vp.classList.toggle("kg-tour-show-names", !!show);
          if (_tree) _tree.updateGlow();
        },
        updateGlow: function () { if (_tree) _tree.updateGlow(); },
        glowPills: function () {
          modal.querySelectorAll(".viz-filter-glow").forEach(function (el) { el.classList.remove("viz-filter-glow"); });
          var fs = _tree.getFilterSets();
          _filterAxes.forEach(function (ax) {
            if (fs[ax.key].size < ax.allValues.length) {
              fs[ax.key].forEach(function (v) {
                var pill = modal.querySelector('.viz-filter[data-' + ax.key + '="' + v + '"]');
                if (pill) { void pill.offsetWidth; pill.classList.add("viz-filter-glow"); }
              });
            }
          });
        },
        clearPillGlow: function () {
          modal.querySelectorAll(".viz-filter-glow").forEach(function (el) { el.classList.remove("viz-filter-glow"); });
        },
      });
      _tour.createHint();
    }

    // Stop tour on manual filter clicks
    modal.querySelectorAll(".viz-filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (_tour && _tour.isTouring()) _tour.stop();
      });
    });
  }

  // ── Dynamic relayout (recalculate positions for visible nodes) ──
  function _relayoutDynamic() {
    if (!_tree) return;
    var allNodes = _tree.getNodes();
    var visible = allNodes.filter(function (n) { return !n._hidden; });
    if (visible.length === 0) return;

    var groups = {};
    sectorKeys.forEach(function (k) { groups[k] = []; });
    visible.forEach(function (n) {
      var sk = n._sector;
      if (groups[sk]) groups[sk].push(n);
    });

    var CENTER_R2 = _centerVirtual ? _centerVirtual.r : 50;
    var PADDING2  = colCfg.padding || 2;
    var ITERS2    = colCfg.iterations || 60;

    // Compute global size range for visible nodes
    var visVals = visible.map(function (v) { return v._entry ? (v._entry._sizeVal || 0) : 0; });
    var gMin = Math.min.apply(null, visVals), gMax = Math.max.apply(null, visVals);
    var gRange = Math.max(1, gMax - gMin);

    var movable = [];
    Object.keys(groups).forEach(function (sk) {
      var group = groups[sk];
      if (!group.length) return;
      var dir = sectorDir[sk];
      var baseAngle = dir ? dir.angle : 0;

      group.sort(function (a, b) { return (a.absMonth || 0) - (b.absMonth || 0); });

      group.forEach(function (n, idx) {
        var t = (n._entry && n._entry._sizeVal != null)
          ? (gRange > 0 ? ((n._entry._sizeVal || 0) - gMin) / gRange : 0.5)
          : 0.5;
        var pos = _radialPosition(t, idx, group.length, baseAngle);
        n._newX = pos.x;
        n._newY = pos.y;
        movable.push(n);
      });
    });

    // Collision
    for (var iter = 0; iter < ITERS2; iter++) {
      var anyMoved = false;
      for (var i = 0; i < movable.length; i++) {
        var a = movable[i];
        var dcx = a._newX, dcy = a._newY;
        var distC = Math.sqrt(dcx * dcx + dcy * dcy) || 0.01;
        var minDC = a.r + CENTER_R2 + PADDING2;
        if (distC < minDC) {
          var push = (minDC - distC) / distC;
          a._newX += dcx * push; a._newY += dcy * push;
          anyMoved = true;
        }
        for (var j = i + 1; j < movable.length; j++) {
          var b = movable[j];
          var dx = b._newX - a._newX, dy = b._newY - a._newY;
          var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var minD = a.r + b.r + PADDING2;
          if (d < minD) {
            var ov = (minD - d) / 2;
            var nx = dx / d, ny = dy / d;
            a._newX -= nx * ov; a._newY -= ny * ov;
            b._newX += nx * ov; b._newY += ny * ov;
            anyMoved = true;
          }
        }
      }
      if (!anyMoved) break;
    }

    movable.forEach(function (n) {
      n.targetX = n._newX;
      n.targetY = n._newY;
    });

    _tree.animateToPositions(600);

    // Animate threads to new positions
    if (edgeCfg.connect === "thread" && _localThreads.length) {
      var fs = _tree.getFilterSets();
      var fKey = _filterAxes[0] ? _filterAxes[0].key : "filter";
      var active = fs[fKey];

      _localThreads.forEach(function (th) {
        var themeOn    = active && active.has(th.theme);
        var sectorOn   = active && active.has(th.sector);
        if (!themeOn || !sectorOn) return;

        th.segments.forEach(function (seg, si) {
          var fromNode = th.nodes[si];
          var toNode   = th.nodes[si + 1];
          if (!fromNode || !toNode || fromNode._hidden || toNode._hidden) return;

          var nx1 = fromNode._newX || fromNode.targetX;
          var ny1 = fromNode._newY || fromNode.targetY;
          var nx2 = toNode._newX || toNode.targetX;
          var ny2 = toNode._newY || toNode.targetY;
          var dx2 = nx2 - nx1, dy2 = ny2 - ny1, len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
          if (len2 > 0) {
            var ux2 = dx2 / len2, uy2 = dy2 / len2;
            var fR2 = fromNode.r || 30, tR2 = toNode.r || 30;
            if (len2 > fR2 + tR2) { nx1 += ux2 * fR2; ny1 += uy2 * fR2; nx2 -= ux2 * tR2; ny2 -= uy2 * tR2; }
          }
          var ncp = _bezierCtrl(nx1, ny1, nx2, ny2, si);
          var ox1 = seg._cx1 || 0, oy1 = seg._cy1 || 0;
          var ocx = seg._ccx || 0, ocy = seg._ccy || 0;
          var ox2 = seg._cx2 || 0, oy2 = seg._cy2 || 0;

          var dur = 550, start = performance.now() + 50;
          function animSeg(now) {
            var t = Math.min(1, (now - start) / dur);
            if (t < 0) t = 0;
            var ease = t < 1 ? 1 - Math.pow(1 - t, 3) * (1 + 2.5 * (1 - t) * Math.sin(t * Math.PI)) : 1;
            seg.setAttribute("d", _curveD(
              ox1 + (nx1 - ox1) * ease, oy1 + (ny1 - oy1) * ease,
              ocx + (ncp.x - ocx) * ease, ocy + (ncp.y - ocy) * ease,
              ox2 + (nx2 - ox2) * ease, oy2 + (ny2 - oy2) * ease
            ));
            if (t < 1) requestAnimationFrame(animSeg);
          }
          requestAnimationFrame(animSeg);
          seg._cx1 = nx1; seg._cy1 = ny1;
          seg._ccx = ncp.x; seg._ccy = ncp.y;
          seg._cx2 = nx2; seg._cy2 = ny2;
        });
      });
    }
  }

  // ── Camera fit ──────────────────────────────────────────────
  var _cameraHandle = null;

  function _fitVisibleNodes(animate) {
    if (!_tree) return;
    var viewport = modal.querySelector(".viz-viewport");
    if (!viewport) return;
    var allNodes = _tree.getNodes();
    var visible = allNodes.filter(function (n) { return !n._hidden; });
    if (visible.length === 0) return;

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    visible.forEach(function (n) {
      var r = n.r || 30;
      if (n.targetX - r < minX) minX = n.targetX - r;
      if (n.targetX + r > maxX) maxX = n.targetX + r;
      if (n.targetY - r < minY) minY = n.targetY - r;
      if (n.targetY + r > maxY) maxY = n.targetY + r;
    });

    // Include center in bounds
    var cR = _centerVirtual ? _centerVirtual.r : 0;
    if (cR) {
      if (-cR < minX) minX = -cR;
      if (cR > maxX)  maxX = cR;
      if (-cR < minY) minY = -cR;
      if (cR > maxY)  maxY = cR;
    }

    if (_cameraHandle) { _cameraHandle.cancel(); _cameraHandle = null; }

    var transform = _tree.getTransform();
    _cameraHandle = animateCameraFit(transform, function () {
      _tree.updateTransform();
    }, {
      vpWidth:  viewport.clientWidth,
      vpHeight: viewport.clientHeight,
      bounds:   { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      minScale: camCfg.minScale || 0.3,
      maxScale: camCfg.maxScale || 4,
      padding:  50,
      duration: animate !== false ? 500 : 0,
      animate:  animate !== false,
    });
  }

  // ── Boot ────────────────────────────────────────────────────
  // Data is already loaded by the time _radialFactory is called
  // (the outer _registerVizLayout wrapper handles async loading).
  _initTree();

  return {
    el: modal,
    open: function () {
      if (_tree) _tree.open();
      else _initTree();
    },
    close: function () {
      if (_tree) _tree.close();
    }
  };
}
