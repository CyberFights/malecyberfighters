'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/landing.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/landing.js'), 'utf8');
const appGateScript = fs.readFileSync(path.join(__dirname, '../public/js/landing.js'), 'utf8');

function loadPage() {
  const dom = new JSDOM(html, {
    url: 'https://male-cyber-fighters.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  const gate = window.document.getElementById('ageGate');
  gate.showModal = function () { this.setAttribute('open', ''); };
  gate.close = function () { this.removeAttribute('open'); };
  window.eval(script);
  return dom;
}

test('promotional page exposes its campaign, age gate, and no-JS entry links', () => {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  assert.match(document.querySelector('h1').textContent, /Your next\s+rival\s+is\s+waiting/i);
  assert.equal(document.querySelector('link[rel="canonical"]').href, 'https://male-cyber-fighters.com/');
  assert.ok(document.getElementById('ageGate'));
  assert.ok(document.querySelectorAll('.js-enter[href="/arena"]').length >= 3);
  assert.equal(document.getElementById('confirmBtn').getAttribute('href'), '/arena');
  dom.window.close();
});

test('confirmed entry hands the age decision to the app once', () => {
  const dom = loadPage();
  const { window } = dom;
  const confirm = window.document.getElementById('confirmBtn');
  confirm.addEventListener('click', event => event.preventDefault());
  confirm.click();
  assert.equal(window.sessionStorage.getItem('mcfAgeConfirmed'), 'true');
  const intro = window.document.getElementById('introGif');
  assert.equal(intro.hidden, false, 'the intro plays before opening the app');
  assert.equal(intro.querySelector('source').getAttribute('srcset'), '/images/intro.webp');
  assert.equal(intro.querySelector('img').getAttribute('src'), '/images/intro.gif');
  assert.equal(confirm.getAttribute('aria-disabled'), 'true');

  const app = new JSDOM('<div id="ageGate"></div><div id="introGif"></div><button id="confirmBtn"></button>', {
    url: 'https://male-cyber-fighters.test/arena',
    runScripts: 'outside-only'
  });
  app.window.sessionStorage.setItem('mcfAgeConfirmed', 'true');
  app.window.eval(appGateScript);
  app.window.document.dispatchEvent(new app.window.Event('DOMContentLoaded'));
  assert.equal(app.window.document.getElementById('ageGate').style.display, 'none');
  app.window.close();
  dom.window.close();
});

test('entry asks for age confirmation and decline closes the dialog', () => {
  const dom = loadPage();
  const { document } = dom.window;
  const gate = document.getElementById('ageGate');
  document.querySelector('.js-enter').click();
  assert.ok(gate.hasAttribute('open'));
  document.getElementById('declineBtn').click();
  assert.equal(gate.hasAttribute('open'), false);
  assert.match(document.getElementById('toast').textContent, /18 or older/);
  dom.window.close();
});

test('match-style tabs support click and arrow-key navigation', () => {
  const dom = loadPage();
  const { document, KeyboardEvent } = dom.window;
  const freeform = document.getElementById('freeformTab');
  const dice = document.getElementById('diceTab');
  dice.click();
  assert.equal(dice.getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('dicePanel').hidden, false);
  assert.equal(document.getElementById('freeformPanel').hidden, true);
  dice.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(freeform.getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('freeformPanel').hidden, false);
  dom.window.close();
});

test('mobile navigation reports and closes its expanded state', () => {
  const dom = loadPage();
  const { document, KeyboardEvent } = dom.window;
  const toggle = document.getElementById('navToggle');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  dom.window.close();
});

test('share fallback copies a ready-to-post caption and canonical site URL', async () => {
  const dom = loadPage();
  const { window } = dom;
  let clipboard = '';
  Object.defineProperty(window, 'isSecureContext', { value: true });
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async value => { clipboard = value; } }
  });
  window.document.querySelector('[data-share]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(clipboard, /Your next rival is waiting/);
  assert.match(clipboard, /https:\/\/male-cyber-fighters\.com\//);
  assert.match(window.document.getElementById('toast').textContent, /Promo post copied/);
  dom.window.close();
});
