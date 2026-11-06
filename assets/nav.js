// First-touch UTM capture: records where a visitor first arrived from
// (utm_source/utm_medium/utm_campaign) so the signup form on any page can
// attribute a later signup back to the channel that actually brought them
// in, even if they land on a blog post or /links.html first and sign up
// from the homepage minutes later. First touch wins -- never overwritten
// by a later visit -- and expires after 30 days like a normal attribution
// window.
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    var source = params.get('utm_source');
    if (!source) return;
    var existing = null;
    try { existing = JSON.parse(localStorage.getItem('teracopia_utm') || 'null'); } catch (e) {}
    var THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (existing && existing.ts && (Date.now() - existing.ts) < THIRTY_DAYS) return;
    localStorage.setItem('teracopia_utm', JSON.stringify({
      source: source,
      medium: params.get('utm_medium') || '',
      campaign: params.get('utm_campaign') || '',
      ts: Date.now()
    }));
  } catch (e) {
    // localStorage unavailable (private mode, etc.) -- attribution is a
    // nice-to-have, never block anything on it.
  }
})();

(function () {
  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('nav-menu');
  if (!toggle || !menu) return;

  function closeMenu() {
    menu.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', function () {
    var isOpen = menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  menu.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', closeMenu);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 720) closeMenu();
  });

  // Tint the sticky nav bar to track the page's background gradient as you scroll,
  // so it reads as part of the page rather than a fixed overlay on top of it.
  var navBar = document.querySelector('.site-nav-bar');
  if (navBar) {
    var stops = [
      { pos: 0, r: 0x0B, g: 0x0E, b: 0x16 },
      { pos: 0.5, r: 0x0F, g: 0x19, b: 0x3A },
      { pos: 1, r: 0x13, g: 0x24, b: 0x5E }
    ];
    var ticking = false;

    function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

    function colorAt(fraction) {
      var seg = fraction < 0.5 ? [stops[0], stops[1]] : [stops[1], stops[2]];
      var segFraction = fraction < 0.5 ? fraction / 0.5 : (fraction - 0.5) / 0.5;
      return {
        r: lerp(seg[0].r, seg[1].r, segFraction),
        g: lerp(seg[0].g, seg[1].g, segFraction),
        b: lerp(seg[0].b, seg[1].b, segFraction)
      };
    }

    function updateNavTint() {
      ticking = false;
      var scrollable = document.documentElement.scrollHeight - window.innerHeight;
      var fraction = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
      var c = colorAt(fraction);
      navBar.style.background = 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', 0.82)';
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(updateNavTint);
      }
    }, { passive: true });

    window.addEventListener('resize', updateNavTint);
    updateNavTint();
  }
})();
