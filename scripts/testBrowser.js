import { chromium } from 'playwright';

(async () => {
  console.log('Launching browser...');
  try {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      
      page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
      page.on('pageerror', err => console.error('BROWSER ERROR:', err));
      page.on('response', response => {
        if (!response.ok()) {
            console.error('FAILED REQUEST:', response.url(), response.status());
        }
      });
    
      console.log('Navigating to local dev server...');
      await page.goto('http://localhost:5173', { waitUntil: 'networkidle' }).catch(e => {
        console.log('Vite server might be offline on 5173. Error:', e.message);
      });
      
      await new Promise(r => setTimeout(r, 2000));
      await browser.close();
      console.log('Test complete!');
  } catch (e) {
      console.error('Playwright error:', e.message);
  }
})();
