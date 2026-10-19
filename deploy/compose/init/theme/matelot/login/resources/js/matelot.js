// Matelot login theme — two touches the stock template has no setting for:
//  * the card heading of the sign-in page reads "Sign in to <tenant>" (the stock "Sign in to your account");
//    the tenant name is what the brand band shows (realm displayNameHtml). Only on the sign-in page and only for
//    English pages, so other pages (OTP, reset, consent, errors) and other locales keep Keycloak's own wording;
//  * the favicon.svg (first) and apple-touch-icon links next to the stock favicon.ico link.
(function () {
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () {
    var brand = document.getElementById('kc-header-wrapper');
    var title = document.getElementById('kc-page-title');
    var tenant = brand ? brand.textContent.trim() : '';
    var english = (document.documentElement.lang || 'en').toLowerCase().indexOf('en') === 0;
    if (tenant && title && english && document.getElementById('kc-form-login') && /sign in to your account/i.test(title.textContent)) {
      title.textContent = 'Sign in to ' + tenant;
    }
    // the same icon set as the web app: favicon.svg first (modern browsers, follows prefers-color-scheme), the
    // stock link to favicon.ico stays as the fallback, apple-touch-icon after it
    var icon = document.querySelector('link[rel="icon"]');
    if (icon && !document.querySelector('link[type="image/svg+xml"]')) {
      var dir = icon.getAttribute('href').replace(/favicon\.ico$/, '');
      var svg = document.createElement('link'); svg.rel = 'icon'; svg.type = 'image/svg+xml'; svg.href = dir + 'favicon.svg';
      icon.parentNode.insertBefore(svg, icon);
      icon.setAttribute('sizes', '16x16 32x32 48x48');
      var touch = document.createElement('link'); touch.rel = 'apple-touch-icon'; touch.href = dir + 'apple-touch-icon.png';
      icon.parentNode.insertBefore(touch, icon.nextSibling);
    }
  });
})();
