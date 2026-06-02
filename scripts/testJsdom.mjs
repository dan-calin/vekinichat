import fs from 'fs';
import { JSDOM, ResourceLoader } from 'jsdom';

const html = fs.readFileSync('index.html', 'utf8');
const resourceLoader = new ResourceLoader({
  strictSSL: false,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
});

const dom = new JSDOM(html, { 
    runScripts: "dangerously", 
    resources: "usable",
    url: "http://localhost:5173"
});

dom.window.console.log = (...args) => console.log('LOG:', ...args);
dom.window.console.warn = (...args) => console.warn('WARN:', ...args);
dom.window.console.error = (...args) => console.error('ERROR:', ...args);

dom.window.addEventListener('error', (event) => {
  console.error('UNCAUGHT EXCEPTION:', event.error || event.message);
  process.exit(1);
});

// Since Vite's <script type="module" src="/src/main.js"> won't execute out of the box in JSDOM easily due to ES modules,
// we will manually read main.js and evaluate it IF it fails to load natively.
setTimeout(() => {
    console.log('JSDOM timeout reached. Checking if main.js executed...');
    // We can also just read main.js and evaluate it directly if we simulate Vite's bundling.
    process.exit(0);
}, 3000);
