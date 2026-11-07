(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(tab, false); });
    tab.addEventListener('keydown', function (e) {
      var n = null;
      if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') n = tabs[0];
      else if (e.key === 'End') n = tabs[tabs.length - 1];
      if (n) { e.preventDefault(); select(n, true); }
    });
  });

  function flash(btn) {
    var label = btn.querySelector('.copy-t');
    var old = label.textContent;
    btn.classList.add('done');
    label.textContent = 'Copied';
    setTimeout(function () { btn.classList.remove('done'); label.textContent = old; }, 1600);
  }
  function fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) {}
    document.body.removeChild(ta);
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var text = btn.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash(btn); }, function () { fallback(text); flash(btn); });
    } else {
      fallback(text);
      flash(btn);
    }
  });

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var bars = document.querySelector('.bars');
  if (bars) {
    if (reduce || !('IntersectionObserver' in window)) bars.classList.add('in');
    else {
      var io = new IntersectionObserver(function (en) {
        if (en[0].isIntersecting) { bars.classList.add('in'); io.disconnect(); }
      }, { threshold: 0.3 });
      io.observe(bars);
    }
  }

  var video = document.querySelector('.hero video');
  if (video && reduce) { video.removeAttribute('autoplay'); video.pause(); }
})();
