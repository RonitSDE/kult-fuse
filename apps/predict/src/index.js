import './polyfills.js';
import './styles.css';
import('./ui.js').catch(e=>{document.getElementById('statusText').textContent='Initialization failed: '+e.message;console.error(e);});
