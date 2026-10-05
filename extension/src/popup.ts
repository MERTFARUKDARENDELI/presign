import { DEFAULT_SETTINGS, type LogEntry, type Settings } from "./lib/store";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function getSettings(): Promise<Settings> {
  const v = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...((v.settings as Partial<Settings> | undefined) ?? {}) };
}

async function saveSettings(s: Settings) {
  await chrome.storage.local.set({ settings: s });
}

const LABEL: Record<string, string> = { signed: "SIGNED", cancelled: "CANCELLED", rejected: "REJECTED IN WALLET", blocked: "BLOCKED", passed: "NOT REVIEWED", expired: "EXPIRED", pending: "PENDING", forwarded: "IN WALLET" };

function renderLog(list: LogEntry[]) {
  const ul = $("log");
  ul.replaceChildren();
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "detail";
    li.textContent = "No requests yet.";
    ul.append(li);
    return;
  }
  for (const e of list.slice(0, 20)) {
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "top";
    const host = document.createElement("span");
    host.className = "host";
    try {
      host.textContent = new URL(e.origin).host;
    } catch {
      host.textContent = e.origin;
    }
    const badge = document.createElement("span");
    badge.className = `badge ${e.state}`;
    badge.textContent = `${LABEL[e.state] ?? e.state}${e.riskLevel ? ` · ${e.riskLevel}` : ""}`;
    top.append(host, badge);
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = `${e.method} · ${new Date(e.at).toLocaleTimeString()}${e.detail ? ` — ${e.detail}` : ""}`;
    li.append(top, detail);
    ul.append(li);
  }
}

async function main() {
  const s = await getSettings();
  const enabled = $<HTMLInputElement>("enabled");
  const site = $<HTMLInputElement>("site");
  const instance = $<HTMLSelectElement>("instance");
  const status = $("status");
  const statusText = $("status-text");

  let origin: string | null = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ? new URL(tab.url) : null;
    if (url && (url.protocol === "https:" || url.protocol === "http:")) origin = url.origin;
  } catch {
    origin = null;
  }

  const render = (x: Settings) => {
    enabled.checked = x.enabled;
    instance.value = x.instance;
    site.disabled = !origin || !x.enabled;
    site.checked = !!origin && !x.skipSites.includes(origin);
    $("site-host").textContent = origin ? new URL(origin).host : "Not a website";
    const on = x.enabled && !(origin && x.skipSites.includes(origin));
    status.classList.toggle("off", !on);
    statusText.textContent = !x.enabled ? "Protection off" : origin && x.skipSites.includes(origin) ? "Off for this site" : "Protection on";
  };
  render(s);

  enabled.addEventListener("change", async () => {
    s.enabled = enabled.checked;
    await saveSettings(s);
    render(s);
  });
  site.addEventListener("change", async () => {
    if (!origin) return;
    s.skipSites = site.checked ? s.skipSites.filter((o) => o !== origin) : [...new Set([...s.skipSites, origin])];
    await saveSettings(s);
    render(s);
  });
  instance.addEventListener("change", async () => {
    s.instance = instance.value === "local" ? "local" : "production";
    await saveSettings(s);
    render(s);
  });

  const v = await chrome.storage.local.get("log");
  renderLog((v.log as LogEntry[] | undefined) ?? []);
}

void main();
