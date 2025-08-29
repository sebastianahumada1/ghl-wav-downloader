import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticator } from 'otplib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Helpers =====
function envInt(name, def) {
  const v = process.env[name];
  const n = Number.isFinite(+v) ? +v : def;
  return n;
}
const isHttp = (u) => /^https?:/i.test(u);
const isBlob = (u) => /^blob:/i.test(u);

// === Config ===
const TARGET_URL     = process.env.TARGET_URL || 'https://app.gohighlevel.com/';
const MIN_MB         = envInt('MIN_MB', 1);
const MIN_BYTES      = MIN_MB * 1024 * 1024;
const WAIT_FOR       = process.env.WAIT_FOR || 'load';    // evita 'networkidle'
const TIMEOUT_MS     = envInt('TIMEOUT_MS', 180000);
const DL_TIMEOUT_MS  = envInt('DL_TIMEOUT_MS', 180000);
const HEADLESS       = (process.env.HEADLESS ?? 'true') !== 'false';
const SCROLL_ROUNDS  = envInt('SCROLL_ROUNDS', 2);
const PAUSE_BETWEEN  = envInt('PAUSE_BETWEEN', 1200);
const START_DELAY_MS = envInt('START_DELAY_MS', 10000);
const COLLECT_RETRY  = envInt('COLLECT_RETRY', 1);
const COLLECT_RETRY_DELAY_MS = envInt('COLLECT_RETRY_DELAY_MS', 5000);

// Credenciales / sesión
const GHL_EMAIL    = process.env.GHL_EMAIL || '';
const GHL_PASSWORD = process.env.GHL_PASSWORD || '';
const TOTP_SECRET  = process.env.TOTP_SECRET || '';
const STORAGE_STATE_BASE64 = process.env.STORAGE_STATE_BASE64 || '';

const outDir = path.join(process.cwd(), 'outputs', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.promises.mkdir(outDir, { recursive: true });

function sanitize(name) {
  const n = name || 'audio.wav';
  return n.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
}

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
  if (/gohighlevel\.com/i.test(page.url()) && !/login|signin/i.test(page.url())) return;

  const emailSel  = 'input[type="email"], input[name="email"], input#email';
  const passSel   = 'input[type="password"], input[name="password"], input#password';
  const submitSel = 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Iniciar")';

  if (GHL_EMAIL && GHL_PASSWORD) {
    try { await page.waitForSelector(emailSel, { timeout: 19000 }); } catch {}
    const emailEl = await page.$(emailSel);
    const passEl  = await page.$(passSel);
    if (emailEl && passEl) {
      await emailEl.fill(GHL_EMAIL, { timeout: 19000 });
      await passEl.fill(GHL_PASSWORD);
      const btn = await page.$(submitSel);
      if (btn) await Promise.all([page.waitForLoadState('load').catch(()=>{}), btn.click()]);
    }
    if (TOTP_SECRET) {
      const otpSel = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[type="tel"]';
      try {
        await page.waitForSelector(otpSel, { timeout: 16000 });
        const code = authenticator.generate(TOTP_SECRET);
        await page.fill(otpSel, code);
        const btn = await page.$(submitSel);
        if (btn) await Promise.all([page.waitForLoadState('load').catch(()=>{}), btn.click()]);
      } catch {}
    }
  }

  await gotoWithRetries(page, TARGET_URL, WAIT_FOR, TIMEOUT_MS);
}

async function ensureReady(page) {
  if (!['load','domcontentloaded','networkidle'].includes(WAIT_FOR) && WAIT_FOR) {
    try { await page.waitForSelector(WAIT_FOR, { timeout: TIMEOUT_MS }); } catch {}
  }
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
  const ok = await page.waitForFunction(() => {
    const hasAudio = document.querySelectorAll('audio, source').length > 0;
    const hasWavAttr = !!document.querySelector('[href$=".wav"], [src$=".wav"], [data-url$=".wav"], [data-href$=".wav"], [data-download$=".wav"], [data-src$=".wav"]');
    const hasRows = document.querySelectorAll('.ant-table-row, .ag-center-cols-container .ag-row, table tr').length > 1;
    return hasAudio || hasWavAttr || hasRows;
  }, { timeout: TIMEOUT_MS }).catch(() => false);

  if (!ok) console.warn('[WAIT] No se detectó contenido aún.');
  if (START_DELAY_MS > 0) await page.waitForTimeout(START_DELAY_MS);
}

// === Bookmarklet adaptado, pero por FRAME ===
async function collectFromFrame(frame, minBytes) {
  // Ejecuta tu lógica dentro del frame (maneja blob:, HEAD/Range, etc.)
  return await frame.evaluate(async (MIN) => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const S = new Set();

    // Tu código original, tal cual (sin el alert final)
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
          // blob: dentro del mismo frame sí se puede leer
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
      let sz = 0;
      try { sz = await sizeOf(u); } catch {}
      if (sz >= MIN) chosen.push({ url: u, bytes: sz });
      await wait(30);
    }
    return chosen; // [{url, bytes}]
  }, minBytes);
}

async function collectAllFrames(page, minBytes) {
  const frames = page.frames();
  const all = [];
  for (let idx = 0; idx < frames.length; idx++) {
    const f = frames[idx];
    try {
      const part = await collectFromFrame(f, minBytes);
      part.forEach(p => all.push({ ...p, frameIndex: idx }));
      console.log(`[COLLECT] Frame #${idx}: ${part.length} URLs >= ${minBytes} bytes`);
    } catch (e) {
      console.warn(`[COLLECT] Frame #${idx} error: ${e.message}`);
    }
  }
  // De-dup por URL (mantiene el primero)
  const seen = new Set();
  return all.filter(x => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

async function downloadFromFrame(frame, page, context, item, i) {
  const { url: u } = item;
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

  // 1) Intento principal: hacer el <a download> DENTRO DEL FRAME de origen
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: DL_TIMEOUT_MS }), // se emite a nivel de page
      frame.evaluate((u, i, fallbackName) => {
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
    return true;
  } catch (e) {
    console.warn('[WARN] Click download falló:', e.message);
  }

  // 2) Fallback: descarga por request (solo http/https, NO blob:)
  if (isHttp(u)) {
    try {
      const resp = await context.request.get(u, { timeout: DL_TIMEOUT_MS });
      if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
      const buf = Buffer.from(await resp.body());
      await fs.promises.writeFile(saveAsPath, buf);
      console.log('[OK] Descargado via request:', finalName, buf.length, 'bytes');
      return true;
    } catch (e) {
      console.error('[ERROR] Request fallback falló:', u, e.message);
    }
  } else {
    console.warn('[WARN] URL es blob: y no se pudo descargar por click (origen/permiso).');
  }

  return false;
}

(async () => {
  // Contexto/navegador
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

  // Navegación + login
  await gotoWithRetries(page, TARGET_URL, WAIT_FOR, TIMEOUT_MS);
  await loginIfNeeded(page);
  await ensureReady(page);

  // Evidencias previas
  await page.screenshot({ path: path.join(outDir, '0_mid.png'), fullPage: true }).catch(()=>{});
  await page.screenshot({ path: path.join(outDir, '1_loaded.png'), fullPage: true }).catch(()=>{});
  await fs.promises.writeFile(path.join(outDir, 'page.html'), await page.content()).catch(()=>{});

  // Recolección multi-frame
  let items = await collectAllFrames(page, MIN_BYTES);
  if (items.length === 0 && COLLECT_RETRY > 0) {
    console.warn(`[COLLECT] 0 URLs; reintento en ${COLLECT_RETRY_DELAY_MS} ms…`);
    await page.waitForTimeout(COLLECT_RETRY_DELAY_MS);
    // mini-scroll extra
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    items = await collectAllFrames(page, MIN_BYTES);
  }

  console.log(`[INFO] Descargas a intentar: ${items.length} archivos (>= ${MIN_MB} MB).`);

  // Descarga por frame de origen
  const frames = page.frames();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const frame = frames[it.frameIndex] || page.mainFrame();
    try {
      const ok = await downloadFromFrame(frame, page, context, it, i);
      if (!ok) console.warn('[WARN] No se pudo descargar:', it.url);
    } catch (e) {
      console.error('[ERROR] Descarga falló:', it.url, e.message);
    }
    await page.waitForTimeout(PAUSE_BETWEEN);
  }

  await page.screenshot({ path: path.join(outDir, '2_done.png'), fullPage: true }).catch(()=>{});
  await browser.close();
})().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
