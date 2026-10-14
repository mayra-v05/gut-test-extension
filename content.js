// Gut Test Extension — autoscroll content script.
//
// background.js re-injects this file via chrome.scripting.executeScript
// every time it (re)starts autoscroll on a tab, as a safety net for tabs
// whose automatic (manifest) content-script injection hasn't happened yet
// (e.g. the tab was already open before the extension loaded). Without this
// guard, each re-injection is a *fresh* top-level script execution — and
// since this file's top-level `let`/`const` were already declared by the
// first run, redeclaring them throws "Identifier 'x' has already been
// declared", which aborts the whole re-injected script silently. Wrapping
// everything in this IIFE keeps those bindings function-scoped, so a
// re-injection just creates fresh local variables and no-ops past the guard
// instead of throwing — the original run's listeners keep handling
// scrolling for the lifetime of the page.
(() => {
  if (window.__gteContentScriptLoaded) return;
  window.__gteContentScriptLoaded = true;

let isScrolling = false;
let animationFrameId = null;
let targetScrollSpeed = 0;
let lastTimestamp = 0;
let delayTimeoutId = null;

let scrollTargetElement = null;
let lastScrollPos = 0;
let stuckCounter = 0;
const STUCK_THRESHOLD = 3;
let currentScrollStatus = 'unknown';

// Some sites (a lot of the polished, award-winning "siteinspire"-style
// portfolios and brand sites) disable native document scrolling entirely
// and instead drive a JS "smooth scroll" library (Lenis, Locomotive Scroll,
// GSAP ScrollSmoother, or a bespoke equivalent) off real wheel/touch events.
// On those pages document/body scrollHeight never exceeds clientHeight, so
// the normal height-based detection below correctly finds "nothing to
// scroll" — there just isn't a native scrollable box. As a best-effort
// fallback we dispatch synthetic wheel events instead, which most of those
// libraries react to exactly like a real scroll. It won't work on every
// site (a few explicitly ignore untrusted events), but it recovers a good
// chunk of them without needing any extra permissions.
let usingSyntheticWheel = false;

// --- Function to find the primary scrollable element ---
function findScrollableElement() {
    const docElement = document.documentElement;
    if (docElement.scrollHeight > docElement.clientHeight + 2) {
        return docElement;
    }
    const bodyElement = document.body;
    if (bodyElement && bodyElement.scrollHeight > bodyElement.clientHeight + 2) {
        return bodyElement;
    }

    const potentialElements = document.querySelectorAll('div, main, section, article');
    let bestCandidate = null;
    let maxVisibleScrollableHeight = 0;

    for (const el of potentialElements) {
        try {
            const style = window.getComputedStyle(el);
            const isScrollable = style.overflowY === 'scroll' || style.overflowY === 'auto';
            const scrollHeight = el.scrollHeight;
            const clientHeight = el.clientHeight;

            if (isScrollable && scrollHeight > clientHeight + 5) {
                if (el.offsetParent !== null && clientHeight > 100 && el.offsetWidth > 50) {
                     if (clientHeight > maxVisibleScrollableHeight) {
                         maxVisibleScrollableHeight = clientHeight;
                         bestCandidate = el;
                     }
                }
            }
        } catch (e) {
            // Ignore errors from accessing properties (e.g., SVG)
        }
    }
    return bestCandidate || docElement;
}

// --- Smooth Scrolling Logic ---
function scrollStep(timestamp) {
  if (!isScrolling || currentScrollStatus !== 'scrollable' || (!usingSyntheticWheel && !scrollTargetElement)) {
      animationFrameId = null; return;
  }

  if (usingSyntheticWheel) {
    if (lastTimestamp === 0) {
      lastTimestamp = timestamp;
      animationFrameId = requestAnimationFrame(scrollStep);
      return;
    }
    const elapsed = Math.min(timestamp - lastTimestamp, 100);
    lastTimestamp = timestamp;
    dispatchSyntheticWheel((targetScrollSpeed * elapsed) / 1000);
    if (isScrolling) animationFrameId = requestAnimationFrame(scrollStep);
    else animationFrameId = null;
    return;
  }

  const currentScrollPos = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? window.scrollY : scrollTargetElement.scrollTop;

  if (lastTimestamp === 0) {
    lastTimestamp = timestamp;
    lastScrollPos = currentScrollPos;
    stuckCounter = 0;
    animationFrameId = requestAnimationFrame(scrollStep);
    return;
  }

  const elapsedMilliseconds = timestamp - lastTimestamp;
  lastTimestamp = timestamp;
  const safeElapsedMilliseconds = Math.min(elapsedMilliseconds, 100);
  const scrollAmount = (targetScrollSpeed * safeElapsedMilliseconds) / 1000;

  const scrollYBefore = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? window.scrollY : scrollTargetElement.scrollTop;

  if (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) {
    window.scrollBy(0, scrollAmount);
  } else {
    try { scrollTargetElement.scrollTop += scrollAmount; }
    catch(e){ console.warn("Error setting scrollTop", e); stopScrollingInternal(); return; }
  }

  const scrollPosAfter = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? window.scrollY : scrollTargetElement.scrollTop;
  const actualScroll = scrollPosAfter - scrollYBefore;

  const scrollHeight = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) : scrollTargetElement.scrollHeight;
  const clientHeight = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? window.innerHeight : scrollTargetElement.clientHeight;
  const scrollableHeight = scrollHeight - clientHeight;
  const nearBottom = scrollPosAfter >= scrollableHeight - 2;

  if (scrollAmount > 0.1 && Math.abs(actualScroll) < 1) { stuckCounter++; }
  else { stuckCounter = 0; }
  const isStuck = stuckCounter >= STUCK_THRESHOLD;

  lastScrollPos = scrollPosAfter;

  if (nearBottom || isStuck) {
    stopScrollingInternal();
  }
  else if (isScrolling) {
    animationFrameId = requestAnimationFrame(scrollStep);
  } else {
    animationFrameId = null;
  }
}

// --- Scroll Initiation and Animation ---
function isNativeScrollLikelyBlocked() {
    try {
        const bodyStyle = window.getComputedStyle(document.body);
        const htmlStyle = window.getComputedStyle(document.documentElement);
        return bodyStyle.overflowY === 'hidden' || bodyStyle.overflowY === 'clip' ||
               htmlStyle.overflowY === 'hidden' || htmlStyle.overflowY === 'clip';
    } catch (e) { return false; }
}

function dispatchSyntheticWheel(deltaY) {
    if (!deltaY || deltaY <= 0) return;
    const cx = Math.floor(window.innerWidth / 2);
    const cy = Math.floor(window.innerHeight / 2);
    let target;
    try { target = document.elementFromPoint(cx, cy) || document.body; }
    catch (e) { target = document.body; }
    if (!target) return;
    try {
        const evt = new WheelEvent('wheel', {
            deltaY, deltaX: 0, deltaZ: 0, deltaMode: 0,
            bubbles: true, cancelable: true, composed: true,
            clientX: cx, clientY: cy, view: window
        });
        // Marked so our own manual-interaction listener (below) doesn't
        // mistake this for the user scrolling and cancel autoscroll.
        evt.gteSynthetic = true;
        target.dispatchEvent(evt);
    } catch (e) { /* ignore */ }
}

function initiateScrollingIfScrollable(speedSetting, delaySeconds) {
    scrollTargetElement = findScrollableElement();
    usingSyntheticWheel = false;

    let nativelyScrollable = false;
    if (scrollTargetElement) {
        const scrollHeight = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) : scrollTargetElement.scrollHeight;
        const clientHeight = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? window.innerHeight : scrollTargetElement.clientHeight;
        nativelyScrollable = scrollHeight > clientHeight + 5;
    }

    if (nativelyScrollable) {
        currentScrollStatus = 'scrollable';
    } else if (isNativeScrollLikelyBlocked()) {
        // Looks like a JS-driven "smooth scroll" page (Lenis/Locomotive/GSAP
        // ScrollSmoother/etc.) — see the note near the top of this file.
        usingSyntheticWheel = true;
        currentScrollStatus = 'scrollable';
    } else {
        currentScrollStatus = 'unscrollable';
    }

    chrome.runtime.sendMessage({ command: "updateScrollStatus", status: currentScrollStatus }).catch(e => {/* ignore error */});

    if (currentScrollStatus === 'scrollable') {
        if (!usingSyntheticWheel) {
            try {
                forceScrollToTopInternal();
            } catch (scrollError) {
                console.warn("Error scrolling to top:", scrollError);
                currentScrollStatus = 'unscrollable';
                chrome.runtime.sendMessage({ command: "updateScrollStatus", status: currentScrollStatus }).catch(e => {});
                return;
            }
        }

        const delayMilliseconds = (delaySeconds || 0) * 1000;
        if (delayMilliseconds > 0) {
            if(delayTimeoutId) clearTimeout(delayTimeoutId);
            delayTimeoutId = setTimeout(() => {
                if (delayTimeoutId !== null && currentScrollStatus === 'scrollable') {
                    startScrollAnimation(speedSetting);
                }
                delayTimeoutId = null;
            }, delayMilliseconds);
        } else {
            startScrollAnimation(speedSetting);
        }
    } else {
        stopScrollingInternal();
    }
}

function startScrollAnimation(speedSetting) {
     if (!isScrolling && scrollTargetElement && currentScrollStatus === 'scrollable') {
         isScrolling = true;
         lastTimestamp = 0;
         stuckCounter = 0;
         if (animationFrameId) cancelAnimationFrame(animationFrameId);
         lastScrollPos = (scrollTargetElement === document.documentElement || scrollTargetElement === document.body) ? window.scrollY : scrollTargetElement.scrollTop;
         animationFrameId = requestAnimationFrame(scrollStep);
     }
     const baseSpeed = 13;      // was 10 originally, +30%, +30%, -20%, -10%
     const speedMultiplier = 37; // was 30 originally, +30%, +30%, -20%, -10%
     targetScrollSpeed = baseSpeed + Math.max(0, speedSetting - 1) * speedMultiplier;
}

function stopScrollingInternal() {
    if (delayTimeoutId) {
        clearTimeout(delayTimeoutId);
        delayTimeoutId = null;
    }
    isScrolling = false;
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    lastTimestamp = 0;
    stuckCounter = 0;
}

// --- Force Scroll to Top ---
function forceScrollToTopInternal() {
    const elementToScroll = scrollTargetElement || findScrollableElement();
    if (!elementToScroll) return;

    try {
        if (elementToScroll === document.documentElement || elementToScroll === document.body) {
            window.scrollTo({ top: 0, behavior: 'instant' });
        } else {
            elementToScroll.scrollTop = 0;
        }
    } catch (scrollError) {
        console.warn("Content Script: Error forcing scroll to top:", scrollError);
    }
}


// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) { return false; }

  switch (request.command) {
      case "startScroll":
        stopScrollingInternal();
        initiateScrollingIfScrollable(request.speed, request.delay);
        break;

      case "stopScroll":
        stopScrollingInternal();
        break;

      case "forceScrollTop":
        stopScrollingInternal();
        forceScrollToTopInternal();
        break;

      // Pause/resume are deliberately lighter than stop/startScroll: they
      // freeze and continue the animation in place (no jump back to the
      // top, no re-running the "wait at the top" delay), so a client who
      // hits pause and resume doesn't lose their scroll position.
      case "pauseScroll":
        if (delayTimeoutId) { clearTimeout(delayTimeoutId); delayTimeoutId = null; }
        if (isScrolling) {
          isScrolling = false;
          if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
        }
        break;

      case "resumeScroll":
        if (!isScrolling && currentScrollStatus === 'scrollable' && (scrollTargetElement || usingSyntheticWheel)) {
          isScrolling = true;
          lastTimestamp = 0;
          stuckCounter = 0;
          if (animationFrameId) cancelAnimationFrame(animationFrameId);
          animationFrameId = requestAnimationFrame(scrollStep);
        }
        break;

      default:
        return false;
  }

  return false;
});


// --- Manual Interaction Handling ---
let userInteractionTimeout = null;
function handleManualInteraction(event) {
    if (event && event.gteSynthetic) { return; } // our own dispatched wheel events, not a real user action
    if (!isScrolling && delayTimeoutId === null) { return; }

    if (scrollTargetElement && scrollTargetElement !== document.documentElement && scrollTargetElement !== document.body) {
        if (!event.target || !scrollTargetElement.contains(event.target)) {
            return;
        }
    }

    clearTimeout(userInteractionTimeout);
    userInteractionTimeout = setTimeout(() => {
        console.log("User manually interacted. Stopping autoscroll.");
        stopScrollingInternal();
    }, 150);
}
window.addEventListener('wheel', handleManualInteraction, { passive: true, capture: true });
window.addEventListener('touchmove', handleManualInteraction, { passive: true, capture: true });
window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Home', 'End'].includes(e.key)) {
        handleManualInteraction(e);
    }
}, { passive: true, capture: true });


console.log("Gut Test content script (content.js) loaded.");
window.addEventListener('beforeunload', () => {
    stopScrollingInternal();
});

})();
