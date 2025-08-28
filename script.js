import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticator } from 'otplib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Config por variables de entorno ===
const TARGET_URL   = process.env.TARGET_URL || 'https://app.gohighlevel.com/'; // URL de Call Reporting en tu subcuenta
const MIN_MB       = +process.env.MIN_MB || 1;                // tamaño mínimo (MB) -> default 1 MB
const MIN_BYTES    = MIN_MB * 1024 * 1024;
const WAIT_FOR     = process.env.WAIT_FOR || 'networkidle';   // 'networkidle' | 'load' | 'domcontentloaded' | selector CSS
const TIMEOUT_MS   = +process.env.TIMEOUT_MS || 45000;
const DL_TIMEOUT_MS= +process.env.DL_TIMEOUT_MS || 60000;
const HEADLESS     = (process.env.HEADLESS ?? 'true') !== 'false';
const SCROLL_ROUNDS= +process.env.SCROLL_ROUNDS || 0;         // si la página tiene “infinite scroll”
const PAUSE_BETWEEN= +process.env.PAUSE_BETWEEN || 900;       // ms entre descargas para no saturar

// Credenciales (opcional si usas STORAGE_STATE_BASE64)
const GHL_EMAIL    = process.env.GHL_EMAIL || '';
const GHL_PASSWORD = process.env.GHL_PASSWORD || '';
const TOTP_SECRET  = process.env.TOTP_SECRET || '';           // si tu cuenta tiene 2FA por TOTP

// Opcional: estado de sesión guardado (cookies/localStorage) en Base64 (string del JSON de storageState)
const STORAGE_STATE_BASE64 = process.env.STORAGE_STATE_BASE64 || '';

const outDir = path.join(process.cwd(), 'outputs', new Date().toISOString().replace(/[:.]/g,'-'));
await fs.promises.mkdir(outDir, { recursive: true });

function sanitize(name) {
  const n = name || 'audio.wav';
  return n.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
}

async function loginIfNeeded(page) {
  // Si ya estás en la app no hacemos nada
  if (/gohighlevel\.com/i.test(page.url()) && !/login|signin/i.test(page.url())) return;

  // Rellena formulario típico de GHL
  const emailSel = 'input[type="email"], input[name="email"], input#email';
  const passSel  = 'input[type="password"], input[name="password"], input#password';
  const submitSel= 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Iniciar")';

  if (GHL_EMAIL && GHL_PASSWORD) {
    try { await page.waitForSelector(emailSel, { timeout: 15000 }); } catch {}
    const emailEl = await page.$(emailSel);
    const passEl  = await page.$(passSel);

    if (emailEl && passEl) {
      await emailEl.fill(GHL_EMAIL, { timeout: 15000 });
      await passEl.fill(GHL_PASSWORD);
      const btn = await page.$(submitSel);
      if (btn) await Promise.all([
        page.waitForLoadState('networkidle').catch(()=>{}),
        btn.click()
      ]);
    }

    if (TOTP_SECRET) {
      const otpSel = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[type="tel"]';
      try {
        await page.waitForSelector(otpSel, { timeout: 8000 });
        const code = authenticator.generate(TOTP_SECRET);
        await page.fill(otpSel, code);
        const btn = await page.$(submitSel);
        if (btn) await Promise.all([
          page.waitForLoadState('networkidle').catch(()=>{}),
          btn.click()
        ]);
      } catch {}
    }
  }

  // Ir a la URL objetivo por si el login nos dejó en dashboard
  await page.goto(TARGET_URL, { waitUntil: ['load','domcontentloaded','networkidle'].includes(WAIT_FOR) ? WAIT_FOR : 'load', timeout: TIMEOUT_MS });
}

async function ensureReady(page) {
  if (!['load','domcontentloaded','networkidle'].includes(WAIT_FOR)) {
    await page.waitForSelector(WAIT_FOR, { timeout: TIMEOUT_MS }).catch(()=>{});
  }
  // Scroll para cargar más rows si aplica
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
}

async function collectUrlsWithBookmarklet(page) {
  // Ejecuta tu bookmarklet (adaptado para devolver URLs en vez de alert)
  const chosen = await page.evaluate(async (MIN) => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const S = new Set();

    document.querySelectorAll('audio,source').forEach(el => { if (el.src) S.add(el.src); });
    document.querySelectorAll('*').forEach(el => {
      ['href','src','data-url','data-href','data-download','data-src'].forEach(k => {
        const v = el.getAttribute && el.getAttribute(k);
        if (v && (/\.wav(\?|#|$)/i.test(v) || /^blob:/i.test(v))) S.add(v);
      });
    });

    const urls = [...S];

    async function sizeOf(u) {
      try {
        if (u.startsWith('blob:')) {
          const r = await fetch(u);
          const b = await r.blob();
          return b.size;
        }
        let r = await fetch(u, { method: 'HEAD', credentials: 'include' });
        let n = +(r.headers.get('content-length') || 0);
        if (!n || Number.isNaN(n)) {
          r = await fetch(u, { headers: { 'Range': 'bytes=0-0' }, credentials: 'include' });
          const cr = r.headers.get('content-range');
          if (cr) {
            const m = /\/(\d+)\s*$/.exec(cr);
            if (m) n = +m[1];
          }
        }
        return n || 0;
      } catch (e) {
        return 0;
      }
    }

    const chosen = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const sz = await sizeOf(u);
      if (sz >= MIN) chosen.push(u);
      await wait(30);
    }

    console.log(`[Bookmarklet] URLs encontradas: ${urls.length}, >= ${MIN} bytes: ${chosen.length}`);
    return chosen;
  }, MIN_BYTES);

  return chosen;
}

async function downloadUrls(page, context, urls) {
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    const nameFromUrl = (() => {
      try {
        const end = decodeURIComponent(new URL(u, page.url()).pathname.split('/').pop() || '');
        return end || `audio_${i + 1}.wav`;
      } catch {
        return `audio_${i + 1}.wav`;
      }
    })();
    const finalName = sanitize(nameFromUrl);
    const saveAsPath = path.join(outDir, finalName);

    // 1) Intento principal: disparar la descarga desde el DOM (soporta blob:)
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: DL_TIMEOUT_MS }),
        page.evaluate((u, i, fallbackName) => {
          const a = document.createElement('a');
          a.href = u;
          a.download = fallbackName || (u.split('/').pop() || `audio_${i + 1}.wav`);
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, u, i, finalName)
      ]);
      const suggested = sanitize(download.suggestedFilename() || finalName);
      await download.saveAs(path.join(outDir, suggested));
      console.log('[OK] Descargado via click:', suggested);
      await page.waitForTimeout(PAUSE_BETWEEN);
      continue;
    } catch (e) {
      console.warn('[WARN] Click download falló, intentando request:', e.message);
    }

    // 2) Fallback: descarga por request con cookies del contexto (no funciona para blob:)
    try {
      const resp = await context.request.get(u, { timeout: DL_TIMEOUT_MS });
      if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
      const buf = Buffer.from(await resp.body());
      await fs.promises.writeFile(saveAsPath, buf);
      console.log('[OK] Descargado via request:', finalName, buf.length, 'bytes');
    } catch (e) {
      console.error('[ERROR] No se pudo descargar:', u, e.message);
    }

    await page.waitForTimeout(PAUSE_BETWEEN);
  }
}

(async () => {
  // Prepara browser/contexto
  const ctxOptions = { acceptDownloads: true };
  if (STORAGE_STATE_BASE64) {
    const json = Buffer.from(STORAGE_STATE_BASE64, 'base64').toString('utf8');
    ctxOptions.storageState = JSON.parse(json);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext(ctxOptions);
  const page = await context.newPage();

  // Ve a la página y loguea si es necesario
  await page.goto(TARGET_URL, { waitUntil: ['load','domcontentloaded','networkidle'].includes(WAIT_FOR) ? WAIT_FOR : 'load', timeout: TIMEOUT_MS });
  await loginIfNeeded(page);
  await ensureReady(page);

  // Evidencia: screenshot inicial
  await page.screenshot({ path: path.join(outDir, '1_loaded.png'), fullPage: true }).catch(()=>{});

  // Ejecuta el “bookmarklet” y recoge URLs que cumplan el tamaño
  const urls = await collectUrlsWithBookmarklet(page);
  console.log(`[INFO] Comenzando descargas: ${urls.length} archivos (>= ${MIN_MB} MB).`);

  // Descarga secuencial (evita bloqueos del servidor)
  await downloadUrls(page, context, urls);

  // Evidencia: screenshot final
  await page.screenshot({ path: path.join(outDir, '2_done.png'), fullPage: true }).catch(()=>{});

  await browser.close();
})().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
