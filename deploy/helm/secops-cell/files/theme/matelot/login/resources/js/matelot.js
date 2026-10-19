// Matelot login theme — two touches the stock template has no setting for:
//  * the card heading of the sign-in page reads "Sign in to <tenant>" (the stock "Sign in to your account");
//    the tenant name is what the brand band shows (realm displayNameHtml). Only on the sign-in page and only for
//    English pages, so other pages (OTP, reset, consent, errors) and other locales keep Keycloak's own wording;
//  * an apple-touch-icon link next to the favicon.
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
    var icon = document.querySelector('link[rel="icon"]');
    if (icon && !document.querySelector('link[rel="apple-touch-icon"]')) {
      var touch = document.createElement('link');
      touch.rel = 'apple-touch-icon';
      touch.href = icon.getAttribute('href').replace(/favicon\.ico$/, 'apple-touch-icon.png');
      document.head.appendChild(touch);
    }
  });
})();
