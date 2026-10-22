const hostedBase = '/vienna-ubahn-live-map/';
const appBase = window.location.protocol === 'file:'
  ? `https://salarshk.github.io${hostedBase}`
  : window.location.pathname.startsWith(hostedBase) ? hostedBase : '/';

document.querySelectorAll('[data-app-link]').forEach((link) => {
  link.setAttribute('href', appBase);
});

const menuButton = document.querySelector('.menu-toggle');
const siteNav = document.querySelector('#site-nav');

const closeMenu = () => {
  menuButton?.setAttribute('aria-expanded', 'false');
  menuButton?.setAttribute('aria-label', 'Open navigation');
  siteNav?.classList.remove('is-open');
};

menuButton?.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  menuButton.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
  siteNav?.classList.toggle('is-open', !isOpen);
});

siteNav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
