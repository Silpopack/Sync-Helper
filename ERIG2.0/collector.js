const DOMAINS = ["instagram.com", ".instagram.com", "www.instagram.com"];

function getAllCookies(domain) {
  return new Promise(r => chrome.cookies.getAll({ domain }, r));
}

function normalize(list) {
  const seen = new Map();
  for (const c of list) {
    const key = `${c.name}@${c.domain}${c.path}`;
    seen.set(key, {
      n: c.name, v: c.value, d: c.domain, p: c.path,
      e: c.expirationDate || null, h: c.httpOnly, s: c.secure, ss: c.sameSite
    });
  }
  return [...seen.values()];
}

export async function collect() {
  const buckets = await Promise.all(DOMAINS.map(getAllCookies));
  const all = normalize(buckets.flat().filter(Boolean));
  const critical = {};
  for (const c of all) {
    if (["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did"].includes(c.n)) {
      critical[c.n] = c.v;
    }
  }
  return { all, critical };
}

export async function fingerprint(cookies) {
  const { sha256 } = await import("./crypto.js");
  return sha256(JSON.stringify(cookies.all));
}