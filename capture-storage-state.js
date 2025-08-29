import { chromium } from 'playwright';
import fs from 'fs';
import readline from 'readline';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://app.gohighlevel.com/');
  console.log('1) Inicia sesión en GHL (incluye 2FA si aplica).');
  console.log('2) Navega hasta tu página de Call Reporting (la misma de TARGET_URL).');
  console.log('3) Vuelve a esta consola y presiona Enter para guardar el storage state.');
  await new Promise(res => readline.createInterface({ input: process.stdin, output: process.stdout })
    .question('Presiona Enter para guardar...', () => res()));
  const state = await context.storageState();
  fs.writeFileSync('storage.json', JSON.stringify(state, null, 2));
  const b64 = Buffer.from(JSON.stringify(state)).toString('base64');
  fs.writeFileSync('storage.b64.txt', b64);
  console.log('Listo: storage.json y storage.b64.txt creados.\nCopia TODO el contenido de storage.b64.txt al Secret STORAGE_STATE_BASE64.');
  await browser.close();
})();
