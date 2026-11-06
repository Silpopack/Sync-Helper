const KEY_MAT = "brAInfection_local_key_v1";

async function deriveKey() {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    "raw", enc.encode(KEY_MAT), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("brAInfection_salt"), iterations: 120000,
      hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

export async function seal(obj) {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: [...iv], ct: btoa(String.fromCharCode(...new Uint8Array(ct))) };
}

export async function unseal(blob) {
  const key = await deriveKey();
  const iv = new Uint8Array(blob.iv);
  const raw = Uint8Array.from(atob(blob.ct), c => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, raw);
  return JSON.parse(new TextDecoder().decode(pt));
}

export async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}