import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticator } from 'otplib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Helpers de entorno y tiempos =====
function envInt(name, def) {
  const v = process.env[name];
  const n = Number.isFinite(+v) ? +v : def;
  return n;
}

// === Config por variables de entorno ===
const TARGET_URL     = process.env.TARGET_URL || 'https://app.gohighlevel.com/'; // URL de Call Reporting en tu subcuenta
const MIN_MB         = envInt('MIN_MB', 1);                  // tamaño mínimo (MB) -> default 1 MB
const MIN_BYTES      = MIN_MB * 1024 * 1024;
const WAIT_FOR       = process.env.WAIT_FOR || 'load';       // 'load' | 'domcontentloaded' | selector CSS (evitar 'networkidle')
const TIMEOUT_MS     = envInt('TIMEOUT_MS', 180000);         // 3 min
const DL_TIMEOUT_MS  = envInt('DL_TIMEOUT_MS', 180000);      // 3 min
const HEADLESS       = (process.env.HEADLESS ?? 'true') !== 'false';
const SCROLL_ROUNDS  = envInt('SCROLL_ROUNDS', 2);           // scrolls para cargar más filas
const PAUSE_BETWEEN  = envInt('PAUSE_BETWEEN', 1200);        // ms entre descargas
const START_DELAY_MS = envInt('START_DELAY_MS', 10000);      // colchón antes del bookmarklet (p. ej. 10 s)
const COLLECT_RETRY  = envInt('COLLECT_RETRY', 1);           // reintentos si no encuentra URLs
const COLLECT_RETRY_DELAY_MS = envInt('COLLECT_RETRY_DELAY_MS', 5000);

// Credenciales (opcional si usas STORAGE_STATE_BASE64)
const GHL_EMAIL    = process.env.GHL_EMAIL || '';
const GHL_PASSWORD = process.env.GHL_PASSWORD || '';
const TOTP_SECRET  = process.env.TOTP_SECRET || '';          // si tu cuenta tiene 2FA por TOTP

// Opcional: estado de sesión guardado (cookies/localStorage) en Base64 (string del JSON de storageState)
const STORAGE_STATE_BASE64 = process.env.STORAGE_STATE_BASE64 || '';

const outDir = path.join(process.cwd(), 'outputs', new Date().toISOString().replace(/[:.]/g,'-'));
await fs.promises.mkdir(outDir, { recursive: true });

function sanitize(name) {
  const n = name || 'audio.wav';
  return n.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
}

// Navegación con reintentos y espera razonable (evita 'networkidle')
async function gotoWithRetries(page, url, waitFor, timeoutMs, tries = 3) {
  const waitState = ['load','domcontentloaded'].includes(waitFor) ? waitFor : 'load';
  for (let t = 1; t <= tries; t++) {
    try {
      await page.goto(url, { waitUntil: waitState, timeout: timeoutMs });
      return;
    } catch (e) {
      console.warn(`[NAV] intento ${t}/${tries} falló: ${e.message}`);
      if (t === tries) throw e;
      await page.waitForTimeout(2000);
    }
  }
}

async function loginIfNeeded(page) {
  // Si ya estás en la app no hacemos nada
  if (/gohighlevel\.com/i.test(page.url()) && !/login|signin/i.test(page.url())) return;

  // Rellena formulario típico de GHL
  const emailSel = 'input[type="email"], input[name="email"], input#email';
  const passSel  = 'input[type="password"], input[name="password"], input#password';
  const submitSel= 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Iniciar")';

  if (GHL_EMAIL && GHL_PASSWORD) {
    try { await page.waitForSelector(emailSel, { timeout: 19000 }); } catch {}
    const emailEl = await page.$(emailSel);
    const passEl  = await page.$(passSel);

    if (emailEl && passEl) {
      await emailEl.fill(GHL_EMAIL, { timeout: 19000 });
      await passEl.fill(GHL_PASSWORD);
      const btn = await page.$(submitSel);
      if (btn) await Promise.all([
        page.waitForLoadState('load').catch(()=>{}),
        btn.click()
      ]);
    }

    if (TOTP_SECRET) {
      const otpSel = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[type="tel"]';
      try {
        await page.waitForSelector(otpSel, { timeout: 16000 });
        const code = authenticator.generate(TOTP_SECRET);
        await page.fill(otpSel, code);
        const btn = await page.$(submitSel);
        if (btn) await Promise.all([
          page.waitForLoadState('load').catch(()=>{}),
          btn.click()
        ]);
      } catch {}
    }
  }

  // Ir a la URL objetivo por si el login nos dejó en dashboard
  await gotoWithRetries(page, TARGET_URL, WAIT_FOR, TIMEOUT_MS);
}

// Espera real: selector + scrolls + validación de contenido y colchón adicional
async function ensureReady(page) {
  // 1) Si WAIT_FOR es selector, espéralo
  if (!['load','domcontentloaded','networkidle'].includes(WAIT_FOR) && WAIT_FOR) {
    try { await page.waitForSelector(WAIT_FOR, { timeout: TIMEOUT_MS }); } catch {}
  }

  // 2) Scroll para cargar más (infinite scroll)
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }

  // 3) Espera activa a que haya contenido útil (filas / audios / links .wav)
  const ok = await page.waitForFunction(() => {
    const hasAudio = document.querySelectorAll('audio, source').length > 0;
    const hasWavAttr = !!document.querySelector('[href$=".wav"], [src$=".wav"], [data-url$=".wav"], [data-href$=".wav"], [data-download$=".wav"], [data-src$=".wav"]');
    const hasRows = document.querySelectorAll('.ant-table-row, .ag-center-cols-container .ag-row, table tr').length > 1;
    return hasAudio || hasWavAttr || hasRows;
  }, { timeout: TIMEOUT_MS }).catch(() => false);

  if (!ok) console.warn('[WAIT] No se detectó contenido aún (audios/filas).');

  // 4) Colchón manual adicional antes del bookmarklet
  if (START_DELAY_MS > 0) {
    await page.waitForTimeout(START_DELAY_MS);
  }
}

// Ejecuta tu bookmarklet (adaptado para devolver URLs) y filtra por tamaño
async function collectUrlsWithBookmarklet(page) {
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
  const ctxOptions = {
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };
  if (STORAGE_STATE_BASE64) {
    const json = Buffer.from(STORAGE_STATE_BASE64, 'base64').toString('utf8');
    ctxOptions.storageState = JSON.parse(json);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext(ctxOptions);
  const page = await context.newPage();

  // Navega y loguea si es necesario (con reintentos)
  await gotoWithRetries(page, TARGET_URL, WAIT_FOR, TIMEOUT_MS);
  await loginIfNeeded(page);

  // Esperas realistas para renderizado de la tabla/listado en GHL
  await ensureReady(page);

  // Evidencias previas
  await page.screenshot({ path: path.join(outDir, '0_mid.png'), fullPage: true }).catch(()=>{});
  await page.screenshot({ path: path.join(outDir, '1_loaded.png'), fullPage: true }).catch(()=>{});
  await fs.promises.writeFile(path.join(outDir, 'page.html'), await page.content()).catch(()=>{});

  // Ejecuta el “bookmarklet” y recoge URLs que cumplan el tamaño
  let urls = await collectUrlsWithBookmarklet(page);

  // Reintento simple si vino vacío (ej. la tabla terminó de hidratarse tarde)
  if (urls.length === 0 && COLLECT_RETRY > 0) {
    console.warn(`[COLLECT] 0 URLs; reintentando en ${COLLECT_RETRY_DELAY_MS} ms…`);
    await page.waitForTimeout(COLLECT_RETRY_DELAY_MS);
    // Intento un par de scrolls extra por si aparecen más filas
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    urls = await collectUrlsWithBookmarklet(page);
  }

  console.log(`[INFO] Comenzando descargas: ${urls.length} archivos (>= ${MIN_MB} MB).`);

  // Descarga secuencial (evita bloqueos del servidor)
  await downloadUrls(page, context, urls);

  // Evidencia final
  await page.screenshot({ path: path.join(outDir, '2_done.png'), fullPage: true }).catch(()=>{});

  await browser.close();
})().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
