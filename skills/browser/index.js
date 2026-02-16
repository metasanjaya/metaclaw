import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { resolve, join } from 'path';

const execAsync = promisify(exec);
const MAX_OUTPUT = 10240;

export default class BrowserSkill {
  constructor(context) {
    this.config = context.config;
    this.log = context.log;
    this.backend = null; // 'metapower' or 'puppeteer'
    this.metapowerPath = null;
    this.puppeteerPath = null;
  }

  async init() {
    // Detect MetaPower
    const mpPath = this.config.METAPOWER_PATH || '/root/metapower';
    const browseJs = join(mpPath, 'browse.js');
    const chromePath = join(mpPath, 'build', 'chrome');

    if (existsSync(browseJs) && existsSync(chromePath)) {
      this.backend = 'metapower';
      this.metapowerPath = mpPath;
      this.log(`Backend: MetaPower (${mpPath})`);
      return;
    }

    // Detect Puppeteer
    try {
      const { stdout } = await execAsync('which chromium-browser || which chromium || which google-chrome || echo ""', { timeout: 5000 });
      const chromeBin = stdout.trim();
      if (chromeBin) {
        this.backend = 'puppeteer';
        this.puppeteerPath = chromeBin;
        this.log(`Backend: Puppeteer (${chromeBin})`);
        return;
      }
    } catch {}

    // Check custom executable
    if (this.config.PUPPETEER_EXECUTABLE && existsSync(this.config.PUPPETEER_EXECUTABLE)) {
      this.backend = 'puppeteer';
      this.puppeteerPath = this.config.PUPPETEER_EXECUTABLE;
      this.log(`Backend: Puppeteer (${this.puppeteerPath})`);
      return;
    }

    this.log('⚠️ No browser backend found. Install MetaPower or Puppeteer.');
    this.backend = null;
  }

  async destroy() {
    this.log('Browser skill destroyed');
  }

  // ── Tools ──

  async browser_open({ url, mode = 'text' }) {
    if (!this.backend) return 'Error: No browser backend available. Install MetaPower or Puppeteer.';
    if (!url) return 'Error: URL is required';

    if (this.backend === 'metapower') {
      return this._metapowerOpen(url, mode);
    }
    return this._puppeteerOpen(url, mode);
  }

  async browser_act({ url, steps }) {
    if (!this.backend) return 'Error: No browser backend available.';
    if (!steps) return 'Error: steps parameter is required (JSON array)';

    // Validate JSON
    let stepsArr;
    try {
      stepsArr = typeof steps === 'string' ? JSON.parse(steps) : steps;
      if (!Array.isArray(stepsArr)) throw new Error('Steps must be an array');
    } catch (e) {
      return `Error: Invalid steps JSON: ${e.message}`;
    }

    if (this.backend === 'metapower') {
      return this._metapowerAct(url, stepsArr);
    }
    return this._puppeteerAct(url, stepsArr);
  }

  async browser_screenshot({ url, fullpage = 'false' }) {
    if (!this.backend) return 'Error: No browser backend available.';
    if (!url) return 'Error: URL is required';

    const outPath = `/tmp/screenshot_${Date.now()}.png`;

    if (this.backend === 'metapower') {
      return this._metapowerScreenshot(url, outPath);
    }
    return this._puppeteerScreenshot(url, outPath, fullpage === 'true');
  }

  // ── MetaPower Backend ──

  async _metapowerOpen(url, mode) {
    const browseJs = join(this.metapowerPath, 'browse.js');
    const flags = {
      text: '',
      html: '--html',
      status: '--status',
      screenshot: `--screenshot /tmp/mp_${Date.now()}.png`,
      pdf: `--pdf /tmp/mp_${Date.now()}.pdf`,
    };
    const flag = flags[mode] || '';
    const cmd = `cd ${this.metapowerPath} && node browse.js '${this._escapeShell(url)}' ${flag} --wait 3000 --timeout 30000`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 45000, maxBuffer: 1024 * 1024 });
      const output = (stdout || '').trim();
      if (mode === 'screenshot' || mode === 'pdf') {
        const match = output.match(/saved to (.+)/i) || output.match(/(\/tmp\/\S+)/);
        return match ? `File saved: ${match[1]}` : output.slice(0, MAX_OUTPUT);
      }
      return output.slice(0, MAX_OUTPUT) || '(empty page)';
    } catch (err) {
      return `Error: ${err.message?.slice(0, 500)}`;
    }
  }

  async _metapowerAct(url, steps) {
    const browseJs = join(this.metapowerPath, 'browse.js');
    const stepsJson = JSON.stringify(steps).replace(/'/g, "'\\''");
    const urlPart = url ? `'${this._escapeShell(url)}'` : "'about:blank'";
    const cmd = `cd ${this.metapowerPath} && node browse.js ${urlPart} --script '${stepsJson}' --timeout 30000`;

    try {
      const { stdout } = await execAsync(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 });
      return (stdout || '').trim().slice(0, MAX_OUTPUT) || '(done, no output)';
    } catch (err) {
      return `Error: ${err.message?.slice(0, 500)}`;
    }
  }

  async _metapowerScreenshot(url, outPath) {
    const cmd = `cd ${this.metapowerPath} && node browse.js '${this._escapeShell(url)}' --screenshot '${outPath}' --wait 3000 --timeout 30000`;
    try {
      await execAsync(cmd, { timeout: 45000 });
      return `Screenshot saved: ${outPath}`;
    } catch (err) {
      return `Error: ${err.message?.slice(0, 500)}`;
    }
  }

  // ── Puppeteer Backend ──
  // Uses inline Node.js script via shell (avoids importing puppeteer in MetaClaw process)

  async _puppeteerOpen(url, mode) {
    const script = `
      const puppeteer = require('puppeteer');
      (async () => {
        const browser = await puppeteer.launch({
          executablePath: '${this.puppeteerPath}',
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.goto('${this._escapeJs(url)}', { waitUntil: 'networkidle2', timeout: 30000 });
        ${mode === 'html' ? 'console.log(await page.content());' :
          mode === 'status' ? 'console.log(page.url());' :
          mode === 'screenshot' ? `await page.screenshot({ path: '/tmp/pup_${Date.now()}.png', fullPage: true }); console.log('Screenshot saved: /tmp/pup_${Date.now()}.png');` :
          mode === 'pdf' ? `await page.pdf({ path: '/tmp/pup_${Date.now()}.pdf' }); console.log('PDF saved: /tmp/pup_${Date.now()}.pdf');` :
          `const text = await page.evaluate(() => document.body.innerText); console.log(text);`}
        await browser.close();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `;

    try {
      const { stdout } = await execAsync(`node -e "${this._escapeShell(script)}"`, { timeout: 45000, maxBuffer: 1024 * 1024 });
      return (stdout || '').trim().slice(0, MAX_OUTPUT) || '(empty page)';
    } catch (err) {
      return `Error: ${err.message?.slice(0, 500)}`;
    }
  }

  async _puppeteerAct(url, steps) {
    // Build Puppeteer automation script from steps
    let actions = '';
    for (const step of steps) {
      switch (step.action) {
        case 'click': actions += `await page.click('${this._escapeJs(step.selector)}');\n`; break;
        case 'type': actions += `await page.type('${this._escapeJs(step.selector)}', '${this._escapeJs(step.text)}');\n`; break;
        case 'wait': actions += `await new Promise(r => setTimeout(r, ${parseInt(step.ms) || 1000}));\n`; break;
        case 'waitFor': actions += `await page.waitForSelector('${this._escapeJs(step.selector)}', { timeout: 10000 });\n`; break;
        case 'screenshot': actions += `await page.screenshot({ path: '${step.path || '/tmp/act_screenshot.png'}' }); console.log('Screenshot: ${step.path || '/tmp/act_screenshot.png'}');\n`; break;
        case 'scroll': actions += `await page.evaluate((y) => window.scrollBy(0, y), ${parseInt(step.y) || 500});\n`; break;
        case 'goto': actions += `await page.goto('${this._escapeJs(step.url)}', { waitUntil: 'networkidle2', timeout: 30000 });\n`; break;
        case 'text': actions += `{ const el = await page.$('${this._escapeJs(step.selector)}'); if(el) { const t = await el.evaluate(e => e.innerText); console.log(t); } }\n`; break;
        case 'eval': actions += `{ const r = await page.evaluate(() => { ${step.js} }); if(r) console.log(r); }\n`; break;
        case 'select': actions += `await page.select('${this._escapeJs(step.selector)}', '${this._escapeJs(step.value)}');\n`; break;
        case 'hover': actions += `await page.hover('${this._escapeJs(step.selector)}');\n`; break;
        default: actions += `// Unknown action: ${step.action}\n`;
      }
    }

    const script = `
      const puppeteer = require('puppeteer');
      (async () => {
        const browser = await puppeteer.launch({
          executablePath: '${this.puppeteerPath}',
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        ${url ? `await page.goto('${this._escapeJs(url)}', { waitUntil: 'networkidle2', timeout: 30000 });` : ''}
        ${actions}
        const text = await page.evaluate(() => document.body.innerText);
        console.log(text.substring(0, 5000));
        await browser.close();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `;

    try {
      const { stdout } = await execAsync(`node -e "${this._escapeShell(script)}"`, { timeout: 60000, maxBuffer: 1024 * 1024 });
      return (stdout || '').trim().slice(0, MAX_OUTPUT) || '(done, no output)';
    } catch (err) {
      return `Error: ${err.message?.slice(0, 500)}`;
    }
  }

  async _puppeteerScreenshot(url, outPath, fullPage = false) {
    const script = `
      const puppeteer = require('puppeteer');
      (async () => {
        const browser = await puppeteer.launch({
          executablePath: '${this.puppeteerPath}',
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
        });
        const page = await browser.newPage();
        await page.goto('${this._escapeJs(url)}', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: '${outPath}', fullPage: ${fullPage} });
        console.log('Screenshot saved: ${outPath}');
        await browser.close();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `;

    try {
      const { stdout } = await execAsync(`node -e "${this._escapeShell(script)}"`, { timeout: 45000 });
      return (stdout || '').trim() || `Screenshot saved: ${outPath}`;
    } catch (err) {
      return `Error: ${err.message?.slice(0, 500)}`;
    }
  }

  // ── Helpers ──

  _escapeShell(str) {
    return (str || '').replace(/'/g, "'\\''");
  }

  _escapeJs(str) {
    return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  }
}
