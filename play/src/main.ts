import { h, render } from 'preact';
import { joinTrystero } from './transport.js';
import { App, applyTheme, readTheme } from './ui.js';

const mount = document.getElementById('app');
if (!mount) throw new Error('no #app element to render into');

// Before the first render, because shade() reads --dot-floor off computed style.
applyTheme(readTheme());
render(h(App, { loadRoom: joinTrystero }), mount);
