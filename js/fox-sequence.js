/*
  Fox mark build-up — scroll-scrubbed image sequence.

  Replaces the original approach of stacking every frame as an <img> and
  cross-fading opacity. That cost one composited layer per frame and, because
  the artwork has no fully opaque pixels, two half-faded frames washed each
  other out at every boundary — the visible flicker. Here a single <canvas>
  shows exactly one frame at a time with a hard cut.

  Four things keep it smooth, in rough order of how much they matter:

  1. Frames load middle-out, not front-to-back. The order is 0, last, midpoint,
     quarters, eighths... so at every instant the frames in hand are spread
     evenly across the whole build. The player draws the nearest loaded frame to
     the one it wants, which means a half-loaded sequence plays the complete
     animation at coarse resolution and simply refines as the rest arrive. It
     never freezes waiting for the next frame and never snaps forward when one
     lands. Loading front-to-back gives the opposite: the fox stalls partway
     through and then jumps.

  2. The scroll position is eased and speed-limited, not followed raw.
     Touch and trackpad scrolling arrive in coarse jumps and a wheel notch
     arrives all at once; easing turns them into continuous motion, and a
     limit of 60 sequence frames a second (one per 60Hz refresh) stops a
     flick or a fast wheel from racing through several frames per refresh.
     Only a big gap (a flick, a scrollbar drag, Page Down) is closed faster,
     as a short even fast-forward. Every step derives from elapsed time
     rather than callback count, so a 120Hz display plays it at the same
     speed as a 60Hz one.

  3. The canvas backing store matches the device pixels it occupies, so the
     browser resamples once, at drawImage, with high-quality filtering —
     instead of twice, the second time with the compositor's bilinear.

  4. Small screens load a smaller frame set. Eighty decoded 864x496 frames is
     ~137MB of bitmap; on a phone that risks the browser dropping and
     re-decoding them mid-scrub, which reads as a hitch.

  One layout hazard shapes several of the guards below: .fox-build-headline is
  position:fixed. Any path that stops the render loop while its opacity is
  still 1 leaves the hero text pinned over every section further down the page.
  Every exit — reduced motion, scrolling past the section, loading straight
  into a deep anchor — has to settle that opacity on the way out.
*/
(function () {
  "use strict";

  var SKIP = {};        // stands in for a frame that failed to load
  var MAX_BACKING = 1600;
  // Scroll pacing - see follow() in the scrub section.
  var RESPONSE = 0.38;  // ease: fraction of the remaining distance closed per 60Hz frame
  var MAX_FPS = 60;     // top build speed for ordinary scrolling, frames/s: one per 60Hz refresh
  var CATCH_UP = 300;   // ms: a gap bigger than MAX_FPS * CATCH_UP is closed at gap / CATCH_UP,
  var PEAK_FPS = 120;   // but never faster than this, frames/s: two per 60Hz refresh
  var SETTLE = 0.0002;  // scroll-fraction delta below which the loop parks
  var DECODE_TIMEOUT = 1200;
  var REQUEST_TIMEOUT = 12000;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function band(p, a, b) { return clamp01((p - a) / (b - a)); }

  /*
    Breadth-first midpoint order over [0, n-1]: 0, n-1, middle, then quarters,
    then eighths. Every prefix of this order is a roughly even sample of the
    whole sequence, which is what lets a partial load still play the full build.
  */
  function buildLoadOrder(n) {
    var order = [];
    var seen = new Uint8Array(n);
    function add(i) {
      if (i >= 0 && i < n && !seen[i]) { seen[i] = 1; order.push(i); }
    }
    add(0);
    add(n - 1);
    var level = [[0, n - 1]];
    while (level.length) {
      var next = [];
      for (var q = 0; q < level.length; q++) {
        var lo = level[q][0], hi = level[q][1];
        if (hi - lo < 2) continue;
        var mid = (lo + hi) >> 1;
        add(mid);
        next.push([lo, mid], [mid, hi]);
      }
      level = next;
    }
    return order;
  }

  /*
    cfg = {
      count:      number of frames,
      framesEnd:  scroll fraction at which the last frame lands,
      full:       { src: function (i) -> url, width, height },
      small:      { src: function (i) -> url, width, height },  // optional
      smallMedia: use `small` when this media query matches. Preferred: the page
                  can put the SAME query on its first-frame preload and poster,
                  so all three always pick the same tier,
      smallUpTo:  fallback - use `small` when displayed device-pixel width <= this,
      still:      url of a single non-WebP image, shown where WebP is unsupported,
      label:      function (i, count) -> stage caption
    }
  */
  window.initFoxSequence = function (cfg) {
    var section = document.getElementById("foxBuild");
    var rig = document.getElementById("fbRig");
    if (!section || !rig) return;

    var camera = document.getElementById("fbCamera");
    var ground = document.getElementById("fbGround");
    var headline = document.getElementById("fbHeadline");
    var stageLabel = document.getElementById("fbStageLabel");
    var progressFill = document.getElementById("fbProgressFill");
    var poster = rig.querySelector(".fb-poster");

    var COUNT = cfg.count;
    var LAST = COUNT - 1;
    var FRAMES_END = cfg.framesEnd || 0.86;
    var label = cfg.label || function (i) { return "Frame " + (i + 1); };

    function hidePoster() {
      if (poster) { poster.style.display = "none"; poster = null; }
    }

    // ---- pick a frame set -------------------------------------------
    // The rig is width-constrained (its box is 1264/840, the frames are wider
    // at 864/496), so the displayed width is the rig's width. Cap the DPR we
    // honour at 2: beyond that the extra pixels cost memory and bandwidth for
    // detail that is not there in an 864px-wide source anyway.
    function rigWidth() {
      return Math.round(rig.getBoundingClientRect().width) || 640;
    }
    // A media query when the page supplies one: the page's <link rel=preload>
    // and poster <source> carry the identical query, so the first frame is
    // never fetched from one tier while the player loads the other. (Choosing
    // by rig width here while the HTML chose by screen width downloaded the
    // first frame twice on ordinary 1x desktops.)
    var set;
    if (cfg.small && cfg.smallMedia && window.matchMedia) {
      set = window.matchMedia(cfg.smallMedia).matches ? cfg.small : cfg.full;
    } else {
      set = (cfg.small && rigWidth() * Math.min(window.devicePixelRatio || 1, 2)
               <= (cfg.smallUpTo || 620))
        ? cfg.small
        : cfg.full;
    }
    var ASPECT = set.width / set.height;

    // ---- canvas ------------------------------------------------------
    var canvas = document.createElement("canvas");
    canvas.className = "fb-canvas";
    canvas.setAttribute("aria-hidden", "true");
    rig.insertBefore(canvas, rig.firstChild);
    var ctx = canvas.getContext("2d");

    // Past ~1.5x the source width the extra backing pixels only re-interpolate
    // detail that is not in an 864px-wide source to begin with.
    var backingCap = Math.min(MAX_BACKING, Math.round(set.width * 1.5));

    var backingW = 0;
    function sizeCanvas() {
      // Match the device pixels the canvas actually occupies so the compositor
      // does not resample a second time on top of drawImage. Re-read the DPR
      // each time: dragging the window to a different monitor changes it.
      // Capped at 1.5, not 2: on a 3x-DPR phone the extra backing pixels cost
      // real decode/composite time every scroll frame for detail that is not
      // in an 864px-wide source anyway.
      var ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      var w = Math.max(1, Math.min(Math.round(rigWidth() * ratio), backingCap));
      if (w === backingW) return false;
      backingW = w;
      canvas.width = w;
      canvas.height = Math.max(1, Math.round(w / ASPECT));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      smoothQuality = "high"; // keep tick()'s tracker in sync after a reset
      return true; // caller must redraw: resizing clears the canvas
    }
    sizeCanvas();

    var frames = new Array(COUNT);
    var drawn = -1;

    // naturalWidth guards against an image that reported load but decoded to
    // nothing - drawImage on one of those throws and would blank the canvas.
    function real(i) {
      var f = frames[i];
      return f && f !== SKIP && f.naturalWidth > 0 ? f : null;
    }

    /* Nearest frame we actually hold. Walks outward, so a sparse set still
       renders something correct for every scroll position. */
    function nearestLoaded(i) {
      if (real(i)) return i;
      for (var d = 1; d < COUNT; d++) {
        if (real(i - d)) return i - d;
        if (real(i + d)) return i + d;
      }
      return -1;
    }

    function paint(i, force) {
      var pick = nearestLoaded(i);
      if (pick < 0) return;
      if (pick === drawn && !force) return;
      var img = real(pick);
      try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      } catch (e) {
        // Undecodable despite looking fine. Retire it and fall back a frame.
        frames[pick] = SKIP;
        drawn = -1;
        return;
      }
      drawn = pick;
      hidePoster();
    }

    // ---- non-WebP fallback -------------------------------------------
    function showStill(url) {
      if (!url) return;
      var img = new Image();
      img.onload = function () { frames[LAST] = img; paint(LAST, true); };
      img.src = url;
    }

    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- loading ----------------------------------------------------
    var order = buildLoadOrder(COUNT);
    var queued = 0;
    var inFlight = 0;
    var errors = 0;
    // Six is the HTTP/1.1 per-host ceiling. Measured on the live HTTP/2 site
    // (4 interleaved runs each), 10 and 16 were no faster than 6 once nothing
    // else competed for the connection - and more parallel requests split the
    // bandwidth, so the middle-out frames that matter first arrive later.
    var CONCURRENCY = 6;

    function settle(i, img) {
      frames[i] = img;
      if (img === SKIP) errors++;
      inFlight--;
      if (reduced) {
        if (img === SKIP) showStill(cfg.still);
        else paint(LAST, true);
        return;
      }
      // Every frame failed and nothing is in flight: this is a browser that
      // cannot decode WebP. Show the finished mark rather than an empty rig.
      if (errors === COUNT && inFlight === 0) { showStill(cfg.still); return; }
      pump();
      request();
    }

    function load(i) {
      inFlight++;
      var img = new Image();
      var finished = false;
      var timer;

      function done(value) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        settle(i, value);
      }

      // A hung socket must not hold a queue slot forever - six of them would
      // stop the sequence filling in at all.
      timer = setTimeout(function () {
        img.onload = img.onerror = null;
        img.src = "";
        done(SKIP);
      }, REQUEST_TIMEOUT);

      img.decoding = "async";
      img.onload = function () {
        // Decode off the main thread before the frame is eligible to draw:
        // drawImage on an undecoded bitmap blocks, which is the stall this
        // whole design exists to avoid. But decode() never settles while the
        // tab is hidden, so do not let it gate the queue indefinitely.
        if (!img.decode) { done(img); return; }
        var finish = function () { done(img); };
        img.decode().then(finish, finish);
        setTimeout(finish, DECODE_TIMEOUT);
      };
      img.onerror = function () { done(SKIP); };
      img.src = set.src(i);
    }

    function pump() {
      while (queued < COUNT && inFlight < CONCURRENCY) load(order[queued++]);
    }

    // ---- reduced motion: one frame, no loop --------------------------
    if (reduced) {
      load(LAST);
      queued = COUNT;
      if (ground) ground.style.opacity = "1";
      if (stageLabel) stageLabel.textContent = label(LAST, COUNT);
      if (progressFill) progressFill.style.height = "100%";
      // The headline is handled in CSS here, not JS: a
      // @media (prefers-reduced-motion: reduce) rule drops it out of the fixed
      // layer so it scrolls away with the section. Doing it with an observer
      // meant the headline stayed pinned over the page any time the callback
      // did not fire - a page restored into a background tab, for one.
      if (headline) headline.style.opacity = "1";
      return;
    }

    pump();

    // ---- scrub ------------------------------------------------------
    var target = 0;
    var current = 0;
    var running = false;
    var inView = true;
    var needsRead = true;
    var lastT = 0;
    var PER_FRAME = FRAMES_END / COUNT; // scroll fraction per sequence frame
    var catchFps = 0;   // catch-up speed held while a big gap closes, frames/s
    var primed = false; // false until the first scroll read

    function measure() {
      needsRead = true;
      if (sizeCanvas()) drawn = -1; // backing store was cleared
    }

    // Recomputed every read rather than cached. The section is sized in vh but
    // window.innerHeight changes as a mobile address bar hides and shows, often
    // without a resize event - a cached value there makes the scrub never quite
    // reach the last frame. getBoundingClientRect has already flushed layout,
    // so offsetHeight here costs nothing extra.
    function readScroll() {
      var top = section.getBoundingClientRect().top;
      var scrollable = section.offsetHeight - window.innerHeight;
      if (scrollable <= 0) return 0;
      return clamp01(-top / scrollable);
    }

    var lastScale = -1;
    var lastPct = -1;
    var lastLabel = null;
    var lastGround = -1;
    var lastHead = -1;

    function render() {
      var p = current;

      // Floor over COUNT equal bands, not round over LAST: rounding gives the
      // first and last frames half the scroll dwell of every frame between.
      var t = clamp01(p / FRAMES_END);
      var wanted = t >= 1 ? LAST : Math.min(LAST, Math.floor(t * COUNT));
      paint(wanted, false);

      if (camera) {
        var s = 1 + 0.035 * smooth(p);
        if (Math.abs(s - lastScale) > 0.0004) {
          camera.style.transform = "scale(" + s.toFixed(4) + ")";
          lastScale = s;
        }
      }

      if (ground) {
        var g = smooth(band(p, FRAMES_END * 0.94, FRAMES_END));
        if (Math.abs(g - lastGround) > 0.004) {
          ground.style.opacity = g.toFixed(3);
          lastGround = g;
        }
      }

      if (headline) {
        // Faded on the real scroll position too, not only the paced current:
        // the headline is position:fixed, and after a hard flick the fox can
        // still be finishing while the section scrolls away. It must not
        // linger over the next section meanwhile.
        var hp = Math.max(p, target);
        var h = hp < FRAMES_END ? 1 : 1 - smooth(band(hp, FRAMES_END, 1));
        if (Math.abs(h - lastHead) > 0.004) {
          headline.style.opacity = h.toFixed(3);
          lastHead = h;
        }
      }

      if (progressFill) {
        var pct = Math.round(p * 1000) / 10;
        if (pct !== lastPct) {
          progressFill.style.height = pct + "%";
          lastPct = pct;
        }
      }

      if (stageLabel) {
        var text = label(p >= FRAMES_END ? LAST : wanted, COUNT);
        if (text !== lastLabel) {
          stageLabel.textContent = text;
          lastLabel = text;
        }
      }
    }

    var smoothQuality = null; // tracks what ctx is currently set to, avoid redundant writes

    /*
      Where current goes this refresh. The ease alone plays the build exactly as
      fast as the page scrolls, so a wheel notch or a flick shot through two to
      twenty frames per refresh - the fox racing ahead. So the ease is held to
      MAX_FPS sequence frames a second: every frame is shown. A gap too big to
      close at that pace within CATCH_UP ms (a flick, a scrollbar drag, Page
      Down) raises the speed to gap / CATCH_UP, up to PEAK_FPS, and holds it
      until the gap closes: a jump is a short even fast-forward, not a lurch
      and not a crawl. No paint moves more than one 60Hz refresh's worth, so a
      refresh the browser dropped costs a little lag instead of a jump. Past
      FRAMES_END no frame changes, only the zoom and the headline fade, so
      nothing is paced there.
    */
    function follow(dt) {
      var next = current + (target - current) * (1 - Math.pow(1 - RESPONSE, dt / 16.667));
      var from = Math.min(current, FRAMES_END);
      var gap = Math.abs(Math.min(target, FRAMES_END) - from) / PER_FRAME;
      if (gap === 0) { catchFps = 0; return next; }
      catchFps = Math.max(catchFps, gap * 1000 / CATCH_UP);
      var fps = Math.min(Math.max(MAX_FPS, catchFps), PEAK_FPS);
      // x 0.999: a move of exactly N frames can straddle N + 1 frame
      // boundaries through floating-point rounding.
      var allow = fps * Math.min(dt, 16.667) / 1000 * PER_FRAME * 0.999;
      var moved = Math.min(next, FRAMES_END) - from;
      if (moved > allow) return from + allow;
      if (moved < -allow) return from - allow;
      // The ease has slowed below the held speed on the final approach: let the
      // held speed fall with it, so catch-up hands back to the ease smoothly.
      catchFps = Math.min(catchFps, Math.abs(moved) / PER_FRAME * 1000 / dt);
      return next;
    }

    function tick(now) {
      // Cleared first so a throw anywhere below cannot strand the flag as true
      // with no frame pending, which would kill the loop for good.
      running = false;

      // Elapsed time, not callback count, drives the motion - otherwise it
      // plays twice as fast on a 120Hz display as on a 60Hz one. Clamp the step
      // so a backgrounded tab does not resume with one huge jump. lastT is 0
      // only when the loop is (re)starting: drop any catch-up speed left over
      // from before it parked or the section was left.
      if (!lastT) catchFps = 0;
      var dt = lastT ? Math.min(now - lastT, 100) : 16.667;
      lastT = now;

      if (needsRead) {
        target = readScroll();
        needsRead = false;
        // Start where the page already is. Reloading mid-section would
        // otherwise fast-forward the build from frame 0 on its own.
        if (!primed) { current = target; primed = true; }
      }

      var moving = Math.abs(target - current) >= SETTLE;

      // High-quality resampling is the single most expensive part of each
      // drawImage call. Pay for it only on the settled frame the eye actually
      // rests on; use the cheap filter for the frames flying by mid-scroll,
      // where quality is invisible anyway.
      var wantQuality = moving ? "low" : "high";
      if (wantQuality !== smoothQuality) {
        ctx.imageSmoothingQuality = wantQuality;
        smoothQuality = wantQuality;
        // The frame the scroll comes to rest on was last drawn with the cheap
        // filter, and paint() skips a frame that is already on the canvas -
        // so without this the resting image never got the sharp resample.
        if (wantQuality === "high") drawn = -1;
      }

      if (!moving) { current = target; catchFps = 0; }
      else if (dt > 0) current = follow(dt);

      render();

      if (moving && inView) request();
      else lastT = 0;
    }

    function request() {
      if (running || !inView) return;
      running = true;
      requestAnimationFrame(tick);
    }

    function remeasure() { measure(); request(); }
    function onScroll() { needsRead = true; request(); }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", remeasure, { passive: true });
    window.addEventListener("orientationchange", remeasure);
    window.addEventListener("load", remeasure);

    // The canvas backing size goes stale on layout changes that never fire a
    // resize event: late webfonts, or the gallery's filter chips reflowing.
    if (window.ResizeObserver) {
      new ResizeObserver(remeasure).observe(rig);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(remeasure).catch(function () {});
    }

    // A hidden tab runs no animation frames and delivers no scroll events, so
    // the canvas can be stale coming back from a background tab or the
    // back/forward cache. drawn = -1 forces the repaint rather than letting the
    // memo short-circuit it.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { drawn = -1; remeasure(); }
    });
    window.addEventListener("pageshow", function () { drawn = -1; remeasure(); });
    // A page prerendered on hover runs no animation frames until the visitor
    // actually arrives. Frames keep loading meanwhile; paint the moment the
    // prerender is activated instead of waiting for the first scroll.
    document.addEventListener("prerenderingchange", function () { drawn = -1; remeasure(); });

    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        // Last entry, not first: a batched callback can carry several and the
        // first may be stale.
        var nowIn = entries[entries.length - 1].isIntersecting;
        var wasIn = inView;
        inView = nowIn;
        if (nowIn) {
          drawn = -1;
          remeasure();
        } else if (wasIn) {
          // Leaving the section stops the loop. Settle the terminal state
          // first, or the fixed-position headline is stranded mid-fade on top
          // of everything below it.
          target = readScroll();
          current = target;
          render();
        }
      }, { rootMargin: "20% 0px" }).observe(section);
    }

    measure();
    request();
  };
})();