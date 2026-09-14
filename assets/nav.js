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
