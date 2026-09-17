/*
  Page-to-page navigation feel for index.html <-> gallery.html.

  Four pieces make switching pages feel instant. Only the last lives here:

  1. <script type="speculationrules"> in each page's <head> prerenders the
     other page as soon as a link to it is hovered (or pressed, on touch), so
     the click swaps in a page that is already rendered.
  2. @view-transition in each page's CSS crossfades between pages with the
     header held in place.
  3. A tiny script at the top of each <head> applies the saved theme before
     the first paint, so switching pages never flashes the wrong theme.
  4. This file: when the next page is NOT ready, show the fox loader - but
     only after a short grace period, so a prerendered or cached page never
     produces a loader flash. It also restores a clean state when a page comes
     back from the back/forward cache, and prefetches on hover in browsers
     that do not support speculation rules.
*/
(function () {
  "use strict";

  // Below ~150ms a loader reads as a flicker rather than feedback. A
  // prerendered page activates well inside this window, so it never shows.
  var SHOW_AFTER = 160;
  // If the navigation was abandoned (the user pressed Stop, or it failed
  // silently), do not leave a full-screen sheet over a page that is still here.
  var GIVE_UP_AFTER = 12000;

  var loader = document.getElementById("loader");
  var showTimer = 0;
  var giveUpTimer = 0;

  function isPageLink(a, e) {
    if (!a || !a.getAttribute("href")) return false;
    if (e && (e.defaultPrevented || e.button !== 0 ||
              e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return false;
    if (a.target && a.target !== "_self") return false;
    if (a.hasAttribute("download")) return false;
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return false; }
    if (url.origin !== location.origin) return false;
    // Same document, including #hash jumps: nothing is loading.
    if (url.pathname === location.pathname) return false;
    // Pages only, never assets such as the portfolio PDF.
    return /(\.html|\/)$/.test(url.pathname) || !/\.[a-z0-9]+$/i.test(url.pathname);
  }

  function showLoader() {
    if (!loader) return;
    loader.classList.remove("is-instant");
    loader.classList.add("is-leaving");
    loader.setAttribute("aria-busy", "true");
    // Defined by the page. It swaps in the full fox animation only when that is
    // already in the browser cache (warmed after an earlier full page load), so
    // a slow switch animates at once and nothing is downloaded mid-navigation.
    if (window.__foxLoaderAnimate) window.__foxLoaderAnimate();
    clearTimeout(giveUpTimer);
    giveUpTimer = setTimeout(reset, GIVE_UP_AFTER);
  }

  function reset() {
    clearTimeout(showTimer);
    clearTimeout(giveUpTimer);
    showTimer = giveUpTimer = 0;
    if (!loader) return;
    loader.classList.remove("is-leaving");
    loader.classList.add("is-done", "is-instant");
    loader.removeAttribute("aria-busy");
  }

  // Bubble phase on document, so handlers that take over a link and call
  // preventDefault (the gallery's category links, the contact modal) run first.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!isPageLink(a, e)) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(showLoader, SHOW_AFTER);
  });

  // A page restored from the back/forward cache comes back exactly as it was
  // left - possibly mid-navigation with the loader up or a timer pending.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) reset();
  });

  // ---- hover prefetch where speculation rules are unsupported ---------------
  var supportsRules = window.HTMLScriptElement && HTMLScriptElement.supports &&
                      HTMLScriptElement.supports("speculationrules");
  if (supportsRules) return;

  var prefetched = {};
  function prefetch(e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!isPageLink(a)) return;
    var url = new URL(a.href, location.href);
    url.hash = "";
    if (prefetched[url.href]) return;
    prefetched[url.href] = true;
    var link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url.href;
    document.head.appendChild(link);
  }
  document.addEventListener("pointerover", prefetch, { passive: true });
  document.addEventListener("touchstart", prefetch, { passive: true });
  document.addEventListener("focusin", prefetch);
})();
