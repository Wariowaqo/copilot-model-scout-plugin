// Model Scout widget. Runs inside the host's sandboxed iframe (Microsoft 365 Copilot,
// or any MCP Apps host). All Hugging Face text is inserted as text nodes, never as HTML.
//
// Rendering: each change re-runs a declarative view() and patches the live DOM in place
// (morph), so CSS transitions animate between states instead of the page being rebuilt.

import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import {
  checkFit,
  DEFAULT_QUANT,
  estimateMemory,
  findQuant,
  fmtBytes,
  fmtCount,
  fmtGB,
  fmtParams,
  FORMULA_TEXT,
  QUANT_LEVELS,
  type Estimate,
  type FitResult,
} from "../shared/estimate";
import type { ModelSummary, WidgetPayload } from "../shared/types";
import { isHubUrl } from "../shared/links";

declare global {
  interface Window {
    __MODEL_SCOUT_DEMO__?: { payload: WidgetPayload; theme?: "light" | "dark" };
    openai?: { toolOutput?: unknown };
  }
}

// ---------- state ----------

interface Machine { ramGB: number; vramGB: number; preset: string | null }
type CardTab = "overview" | "quant" | "fit";
type CompareTab = "models" | "tune" | "table";

const state = {
  tab: { card: "overview" as CardTab, compare: "models" as CompareTab },
  payload: null as WidgetPayload | null,
  /** In compare view, the model opened in detail, or null for the comparison. */
  focused: null as number | null,
  quant: DEFAULT_QUANT,
  context: 8192,
  machine: loadMachine(),
  busy: false,
};

const SYSTEM_RESERVE_GB = 2;
const CONTEXT_STEPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
/** Slider order: smallest on the left, original quality on the right. */
const SLIDER_LEVELS = [...QUANT_LEVELS].reverse();

const PRESETS: { id: string; label: string; spec: string; icon: IconName; ramGB: number; vramGB: number }[] = [
  { id: "laptop8", label: "Thin laptop", spec: "8 GB RAM", icon: "laptop", ramGB: 8, vramGB: 0 },
  { id: "laptop16", label: "Laptop", spec: "16 GB RAM", icon: "laptop", ramGB: 16, vramGB: 0 },
  { id: "mac32", label: "Mac", spec: "32 GB unified", icon: "laptop", ramGB: 32, vramGB: 0 },
  { id: "rtx12", label: "Gaming PC", spec: "32 GB + 12 GB GPU", icon: "gpu", ramGB: 32, vramGB: 12 },
  { id: "rtx24", label: "Workstation", spec: "64 GB + 24 GB GPU", icon: "gpu", ramGB: 64, vramGB: 24 },
  { id: "a100", label: "Server", spec: "256 GB + 80 GB GPU", icon: "server", ramGB: 256, vramGB: 80 },
];

function loadMachine(): Machine {
  try {
    const raw = localStorage.getItem("model-scout-machine");
    if (raw) {
      const m = JSON.parse(raw) as Partial<Machine>;
      if (typeof m.ramGB === "number" && typeof m.vramGB === "number") return { ramGB: m.ramGB, vramGB: m.vramGB, preset: m.preset ?? null };
    }
  } catch { /* storage can be unavailable in sandboxed frames */ }
  return { ramGB: 16, vramGB: 8, preset: null };
}

function saveMachine() {
  try { localStorage.setItem("model-scout-machine", JSON.stringify(state.machine)); } catch { /* ignore */ }
}

// ---------- host bridge ----------

let app: App | null = null;
let connected = false;

async function connectHost() {
  document.body.classList.add("viz-root"); // in case the host rebuilt <body> without its attributes
  const demo = window.__MODEL_SCOUT_DEMO__;
  if (demo) {
    if (demo.theme) applyDocumentTheme(demo.theme);
    setTimeout(() => setPayload(demo.payload), 350); // let the skeleton show briefly
    return;
  }
  app = new App({ name: "Model Scout", version: "0.2.0" }, {}, { autoResize: true });
  app.addEventListener("toolresult", (params) => handleToolResult(params as ToolResultLike));
  app.addEventListener("hostcontextchanged", (ctx) => applyHost(ctx as HostCtx));
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    connected = true;
    applyHost(app.getHostContext() as HostCtx | undefined);
  } catch (err) {
    console.warn("Model Scout: no MCP Apps host", err);
  }
  if (!state.payload && window.openai?.toolOutput) handleToolResult({ structuredContent: window.openai.toolOutput });
  if (!connected && !state.payload) {
    renderError("This widget needs an MCP Apps host such as Microsoft 365 Copilot. Open it from a Model Scout tool call.");
  }
}

interface HostCtx {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string>; css?: { fonts?: string } };
  displayMode?: string;
  availableDisplayModes?: string[];
}

function applyHost(ctx: HostCtx | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables as never);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (state.payload) render();
}

interface ToolResultLike {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

function handleToolResult(result: ToolResultLike) {
  if (result.isError) {
    const msg = result.content?.find((c) => c.type === "text")?.text ?? "The tool returned an error.";
    if (state.payload) toast(msg); else renderError(msg);
    return;
  }
  const p = result.structuredContent as WidgetPayload | undefined;
  if (!p || !Array.isArray(p.models) || p.models.length === 0) {
    if (!state.payload) renderError("No model details in this result.");
    return;
  }
  setPayload(p);
}

function setPayload(p: WidgetPayload) {
  const firstLoad = !state.payload;
  state.payload = p;
  if (firstLoad) {
    state.quant = findQuant(p.quant ?? DEFAULT_QUANT).id;
    state.context = p.contextLength ?? 8192;
    state.focused = null;
  }
  if (state.focused != null && state.focused >= p.models.length) state.focused = null;
  root().setAttribute("aria-busy", "false");
  render();
  pushModelContext();
}

async function refresh() {
  const p = state.payload;
  if (!p || !app || !connected || state.busy) return;
  state.busy = true;
  render();
  try {
    const args = { quantization: state.quant, context_length: state.context };
    const result = p.view === "compare"
      ? await app.callServerTool({ name: "compare_models", arguments: { model_ids: p.models.map((m) => m.id), ...args } })
      : await app.callServerTool({ name: "show_model_card", arguments: { model_id: p.models[0].id, ...args } });
    if (result.isError) toast(textOf(result));
    else { handleToolResult(result as ToolResultLike); toast("Updated with the latest numbers from Hugging Face"); }
  } catch (err) {
    toast("Refresh failed. The host may not allow calls from the widget.");
    console.warn(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function askDeploy(m: ModelSummary) {
  const q = findQuant(state.quant);
  const text = `How do I deploy ${m.id} on Azure? I'm considering ${q.label} with a ${state.context.toLocaleString("en-US")}-token context. Compare Azure AI Foundry and Azure Container Apps, and cite Microsoft Learn.`;
  if (!app || !connected) { toast("Sending a message needs a host such as Copilot."); return; }
  try {
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    toast(r.isError ? "The host didn't accept the message." : "Asked the agent how to deploy on Azure");
  } catch {
    toast("The host doesn't support sending messages from the widget.");
  }
}

async function openUrl(url: string) {
  if (!isHubUrl(url)) { toast("That link isn't a Hugging Face page, so it wasn't opened."); return; }
  if (app && connected) {
    try {
      const r = await app.openLink({ url });
      if (!r.isError) return;
    } catch { /* fall through */ }
  }
  toast(`Open ${url} in your browser`);
}

async function goFullscreen() {
  if (!app || !connected) return;
  try { await app.requestDisplayMode({ mode: "fullscreen" }); } catch { toast("Full screen isn't available here."); }
}

function canFullscreen(): boolean {
  if (!app || !connected) return false;
  const ctx = app.getHostContext() as HostCtx | undefined;
  if (ctx?.displayMode === "fullscreen") return false;
  // Copilot doesn't report availableDisplayModes; offer the button unless the host says no.
  return !ctx?.availableDisplayModes || ctx.availableDisplayModes.includes("fullscreen");
}

let contextTimer: ReturnType<typeof setTimeout> | undefined;
function pushModelContext() {
  if (!app || !connected || !state.payload) return;
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    const p = state.payload!;
    const q = findQuant(state.quant);
    const lines = p.models.map((m) => {
      const est = estimateFor(m);
      if (!est) return `- ${m.id}: parameter count unknown`;
      return `- ${m.id}: about ${fmtGB(est.totalGB)} → ${fitFor(est).headline}`;
    });
    const text = [
      `The user is looking at the Model Scout widget with ${q.label} selected and a ${state.context.toLocaleString("en-US")}-token context.`,
      `Their machine: ${state.machine.ramGB} GB RAM, ${state.machine.vramGB} GB GPU memory.`,
      ...lines,
    ].join("\n");
    app!.updateModelContext({ content: [{ type: "text", text }] }).catch(() => { /* optional feature */ });
  }, 700);
}

const textOf = (r: { content?: unknown }) =>
  (Array.isArray(r.content) ? (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text : undefined) ?? "Error";

// ---------- model helpers ----------

const estimateFor = (m: ModelSummary, quant = state.quant): Estimate | null =>
  m.parameters ? estimateMemory({ parameters: m.parameters, quant, contextLength: state.context, kv: m.kv }) : null;
const fitFor = (est: Estimate): FitResult => checkFit(est.totalGB, state.machine.ramGB, state.machine.vramGB);
const shortName = (m: ModelSummary) => m.id.split("/")[1] ?? m.id;
const org = (m: ModelSummary) => m.author ?? m.id.split("/")[0];
const fileFor = (m: ModelSummary, id: string) =>
  m.ggufFiles.find((f) => f.quant === id || (id === "F16" && (f.quant === "BF16" || f.quant === "FP16")));

function initials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

function fitLabel(fit: FitResult): string {
  if (fit.status === "fits-gpu") return "Fits on GPU";
  if (fit.status === "fits-cpu") return "Fits in RAM";
  if (fit.status === "no-fit") return "Won't fit";
  return fit.headline.startsWith("Runs, split") ? "Runs, split GPU + CPU" : "Runs on CPU, slower";
}

// ---------- icons ----------

const ICONS = {
  chip: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 9h6v6H9z",
  disk: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  lines: "M4 6h16M4 12h16M4 18h10",
  laptop: "M5 5h14v10H5zM2 19h20",
  gpu: "M2 7h18v10H2zM20 10h2M20 14h2M6 17v3M10 17v3M8 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  cloud: "M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 8v5M12 16.5v.01",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  feather: "M20 4C10 4 5 10 5 19M5 19l8-8M9 15h6",
  flame: "M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-3 5-3 8a6 6 0 0 0 6 6z",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  back: "M15 6l-6 6 6 6",
  scale: "M12 4v16M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z",
  sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  arrow: "M5 12h14M13 6l6 6-6 6",
  grid: "M4 4h16v16H4zM4 10h16M4 16h16M10 4v16",
  pie: "M12 3a9 9 0 1 0 9 9h-9zM15 3.5A9 9 0 0 1 20.5 9H15z",
} as const;
type IconName = keyof typeof ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ic");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", name);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.appendChild(path);
  return svg;
}

// ---------- DOM: declarative view + in-place morph ----------

type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (e: Event) => void;
type Attrs = Record<string, string | number | boolean | Handler | undefined | null>;
type Live = Element & { __on?: Record<string, Handler>; __bound?: Set<string>; __shown?: number; __tween?: number };

function bind(el: Live, on: Record<string, Handler> | undefined) {
  el.__on = on;
  if (!on) return;
  el.__bound ??= new Set();
  for (const type of Object.keys(on)) {
    if (el.__bound.has(type)) continue;
    el.__bound.add(type);
    el.addEventListener(type, (e) => el.__on?.[type]?.(e));
  }
}

function h(tag: string, attrs: Attrs | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  const on: Record<string, Handler> = {};
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") on[k.slice(2)] = v;
      else el.setAttribute(k === "class" ? "class" : k, v === true ? "" : String(v));
    }
  }
  if (Object.keys(on).length) bind(el as Live, on);
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (!(a instanceof Element) || !(b instanceof Element)) return true;
  return a.tagName === b.tagName && a.getAttribute("data-key") === b.getAttribute("data-key") && a.getAttribute("data-icon") === b.getAttribute("data-icon");
}

function morph(a: Node, b: Node) {
  if (!sameKind(a, b)) { a.parentNode?.replaceChild(b, a); return; }
  if (!(a instanceof Element)) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const ea = a as Live, eb = b as Live;
  for (const { name } of [...ea.attributes]) if (!eb.hasAttribute(name)) ea.removeAttribute(name);
  for (const { name, value } of [...eb.attributes]) if (ea.getAttribute(name) !== value) ea.setAttribute(name, value);
  if (ea instanceof HTMLInputElement && eb instanceof HTMLInputElement && ea !== document.activeElement && ea.value !== eb.value) ea.value = eb.value;
  if (ea instanceof HTMLDetailsElement && eb instanceof HTMLDetailsElement) ea.open = eb.open;
  bind(a as Live, (b as Live).__on);
  if (ea.hasAttribute("data-count")) return; // counters manage their own text
  const ac = [...ea.childNodes], bc = [...eb.childNodes];
  for (let i = 0; i < bc.length; i++) {
    if (i < ac.length) morph(ac[i], bc[i]);
    else ea.appendChild(bc[i]);
  }
  for (let i = bc.length; i < ac.length; i++) ac[i].remove();
  // `selected` attributes don't move a select the user already changed; sync the property.
  if (ea instanceof HTMLSelectElement && eb instanceof HTMLSelectElement && ea.value !== eb.value) ea.value = eb.value;
}

const FORMATS: Record<string, (n: number) => string> = {
  gb: (n) => fmtGB(n),
  params: (n) => fmtParams(n),
  count: (n) => fmtCount(Math.round(n)),
};
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Animates every [data-count] element from the value it last showed to its new value. */
function animateCounts(scope: Element) {
  scope.querySelectorAll<HTMLElement>("[data-count]").forEach((node) => {
    const el = node as unknown as Live & HTMLElement;
    const target = Number(el.dataset.count);
    const fmt = FORMATS[el.dataset.fmt ?? "gb"] ?? FORMATS.gb;
    if (!Number.isFinite(target)) return;
    const from = el.__shown ?? 0;
    if (el.__shown === target) return;
    if (el.__tween) cancelAnimationFrame(el.__tween);
    if (reduceMotion()) { el.textContent = fmt(target); el.__shown = target; return; }
    const start = performance.now();
    const dur = el.__shown === undefined ? 900 : 450;
    el.textContent = fmt(from);
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from + (target - from) * e;
      el.textContent = fmt(v);
      el.__shown = v;
      if (k < 1) el.__tween = requestAnimationFrame(step);
      else { el.__shown = target; el.textContent = fmt(target); }
    };
    el.__tween = requestAnimationFrame(step);
  });
}

const counter = (value: number, fmt: "gb" | "params" | "count", cls: string, label?: string) =>
  h("span", { class: cls, "data-count": value, "data-fmt": fmt, "aria-label": label ?? FORMATS[fmt](value) }, FORMATS[fmt](value));

const root = () => document.getElementById("app")!;

function renderError(message: string) {
  root().setAttribute("aria-busy", "false");
  root().replaceChildren(h("div", { class: "error", role: "alert" }, h("strong", null, "Model Scout: "), message));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

// ---------- render ----------

function render() {
  const p = state.payload;
  if (!p) return;
  const next = p.view === "compare" && state.focused == null ? compareView(p) : cardView(p, p.models[state.focused ?? 0]);
  const host = root();
  const current = host.firstElementChild;
  if (current && host.childElementCount === 1 && sameKind(current, next)) morph(current, next);
  else host.replaceChildren(next);
  animateCounts(host);
}

const rerender = () => { render(); pushModelContext(); };

// ---------- navigation ----------

interface TabDef<T extends string> { id: T; label: string; icon: IconName; badge?: string }

/** ARIA tabs: click, or Left/Right/Home/End when a tab has focus. */
function tabs<G extends keyof typeof state.tab>(group: G, defs: TabDef<(typeof state.tab)[G]>[]) {
  const active = state.tab[group];
  const i = Math.max(0, defs.findIndex((d) => d.id === active));
  const go = (id: (typeof state.tab)[G], focus = false) => {
    state.tab[group] = id;
    render();
    if (focus) document.getElementById(`tab-${id}`)?.focus();
  };
  return h("nav", { class: "tabs", role: "tablist", "aria-label": "Sections", style: `--n:${defs.length};--i:${i}` },
    defs.map((d, k) => h("button", {
      id: `tab-${d.id}`, class: "tab", role: "tab", type: "button", "data-key": d.id,
      "aria-selected": k === i ? "true" : "false", "aria-controls": "tabpanel", tabindex: k === i ? 0 : -1,
      onclick: () => go(d.id),
      onkeydown: (e) => {
        const key = (e as KeyboardEvent).key;
        const j = key === "ArrowRight" ? (k + 1) % defs.length : key === "ArrowLeft" ? (k - 1 + defs.length) % defs.length
          : key === "Home" ? 0 : key === "End" ? defs.length - 1 : -1;
        if (j >= 0) { e.preventDefault(); go(defs[j].id, true); }
      },
    }, icon(d.icon), h("span", null, d.label), d.badge ? h("span", { class: "tab-badge" }, d.badge) : null)));
}

const tabPanel = (id: string, children: Child[]) =>
  h("div", { id: "tabpanel", role: "tabpanel", class: "tabpanel stack", "aria-labelledby": `tab-${id}`, "data-key": `panel:${id}` }, children);

const quantShort = (id: string) => (id === "F16" ? "FP16" : id);
const machineShort = () => `${state.machine.ramGB}${state.machine.vramGB > 0 ? ` + ${state.machine.vramGB}` : ""} GB`;
function machineLabel(): string {
  const pr = PRESETS.find((x) => x.id === state.machine.preset);
  return pr ? `${pr.label} · ${pr.spec}` : `${state.machine.ramGB} GB RAM${state.machine.vramGB > 0 ? ` + ${state.machine.vramGB} GB GPU` : ""}`;
}

function crumbs(p: WidgetPayload, m: ModelSummary) {
  return h("nav", { class: "crumbs", "aria-label": "Breadcrumb" },
    h("button", { class: "crumb", type: "button", onclick: () => { state.focused = null; render(); } }, icon("back"), "All models"),
    h("span", { class: "switch", role: "group", "aria-label": "Switch model" },
      p.models.map((x, i) => h("button", {
        type: "button", "aria-pressed": x.id === m.id ? "true" : "false",
        onclick: () => { state.focused = i; render(); },
      }, shortName(x)))));
}

function breakdown(est: Estimate) {
  return [
    { cls: "w", name: "Weights", gb: est.weightsGB, note: "" },
    { cls: "k", name: "KV cache", gb: est.kvCacheGB, note: est.kvIsRough ? " (rough)" : "" },
    { cls: "o", name: "Overhead", gb: est.overheadGB, note: "" },
  ];
}

const jump = (onclick: () => void, ic: IconName, title: string, value: string, sub: string) =>
  h("button", { class: "jump", type: "button", onclick },
    h("span", { class: "jump-top" }, icon(ic), title),
    h("span", { class: "jump-value" }, value),
    h("span", { class: "jump-sub" }, sub),
    h("span", { class: "jump-go" }, "Open", icon("arrow")));

function overviewPanel(est: Estimate, fit: FitResult) {
  const q = findQuant(state.quant);
  const parts = breakdown(est);
  const go = (t: CardTab) => { state.tab.card = t; render(); document.getElementById(`tab-${t}`)?.focus({ preventScroll: true }); };
  return h("section", { class: "panel", "aria-labelledby": "otitle" },
    h("div", { class: "panel-head" },
      h("h2", { class: "panel-title", id: "otitle" }, icon("pie"), "Where the memory goes"),
      h("span", { class: "panel-sub" }, `${q.label} · ${fmtTokens(state.context)} context`)),
    h("div", { class: "stackbar", role: "img", "aria-label": `Memory breakdown: ${parts.map((x) => `${x.name} ${fmtGB(x.gb)}`).join(", ")}` },
      parts.map((x) => h("i", { class: `seg ${x.cls}`, style: `flex-grow:${Math.max(x.gb, 0.001)}`, "data-tip": `${x.name}: ${fmtGB(x.gb)}` }))),
    h("div", { class: "map-legend" },
      parts.map((x) => h("span", { class: "key" }, h("i", { class: `sw ${x.cls}` }), `${x.name} ${fmtGB(x.gb)}${x.note}`))),
    h("div", { class: "jump-grid" },
      jump(() => go("quant"), "sliders", "Quantization", q.label, q.explain),
      jump(() => go("fit"), "gpu", "Will it run on my machine?", machineLabel(), fit.headline)));
}

function quickBar() {
  const q = findQuant(state.quant);
  const idx = SLIDER_LEVELS.findIndex((l) => l.id === q.id);
  return h("div", { class: "quickbar" },
    h("div", { class: "quick" },
      h("span", { class: "quick-label" }, icon("sliders"), "Quantization"),
      h("input", {
        class: "range small", type: "range", min: 0, max: SLIDER_LEVELS.length - 1, step: 1, value: idx,
        style: `--pct:${(idx / (SLIDER_LEVELS.length - 1)) * 100}%`, "aria-label": "Quantization level", "aria-valuetext": q.label,
        oninput: (e) => { state.quant = SLIDER_LEVELS[Number((e.target as HTMLInputElement).value)].id; rerender(); },
      }),
      h("output", null, quantShort(q.id))),
    h("div", { class: "quick" },
      h("span", { class: "quick-label" }, icon("gpu"), "Machine"),
      h("select", {
        class: "select", "aria-label": "Machine preset",
        onchange: (e) => {
          const pr = PRESETS.find((x) => x.id === (e.target as HTMLSelectElement).value);
          if (pr) { state.machine = { ramGB: pr.ramGB, vramGB: pr.vramGB, preset: pr.id }; saveMachine(); rerender(); }
        },
      },
        state.machine.preset ? null : h("option", { value: "", selected: true }, `Custom · ${machineShort()}`),
        PRESETS.map((pr) => h("option", { value: pr.id, selected: pr.id === state.machine.preset }, `${pr.label} · ${pr.spec}`)))));
}

function resultStrip(p: WidgetPayload, ests: (Estimate | null)[], fits: (FitResult | null)[]) {
  return h("div", { class: "strip", role: "group", "aria-label": "Live results" },
    p.models.map((m, i) => h("div", { class: "strip-item", "data-key": m.id },
      h("div", { style: "min-width:0" },
        h("div", { class: "strip-name" }, shortName(m)),
        fits[i] ? pill(fits[i]!, true) : h("span", { class: "panel-sub" }, "parameters unknown")),
      ests[i] ? counter(ests[i]!.totalGB, "gb", "strip-num", `${shortName(m)} needs about ${fmtGB(ests[i]!.totalGB)}`) : null)));
}

// ---------- shared pieces ----------

function actionButtons(m: ModelSummary | null) {
  return h("div", { class: "actions" },
    connected && h("button", { class: `btn icon-only${state.busy ? " spin" : ""}`, onclick: () => refresh(), disabled: state.busy, title: "Refresh from Hugging Face", "aria-label": "Refresh from Hugging Face" }, icon("refresh")),
    canFullscreen() && h("button", { class: "btn icon-only", onclick: () => goFullscreen(), title: "Full screen", "aria-label": "Full screen" }, icon("expand")),
    m && h("button", { class: "btn", onclick: () => openUrl(m.url) }, icon("external"), "Hugging Face"),
    m && h("button", { class: "btn primary", onclick: () => askDeploy(m) }, icon("cloud"), "Deploy on Azure"),
  );
}

function pill(fit: FitResult, small = false) {
  const ic: IconName = fit.status === "no-fit" ? "x" : fit.status === "tight" ? "alert" : "check";
  return h("span", { class: `pill ${fit.status}${small ? " sm" : ""}`, title: fit.detail },
    h("span", { class: "dot", "aria-hidden": "true" }, icon(ic)), fitLabel(fit));
}

function quantPanel(models: ModelSummary[], step: number) {
  const q = findQuant(state.quant);
  const idx = SLIDER_LEVELS.findIndex((l) => l.id === q.id);
  const pct = `${(idx / (SLIDER_LEVELS.length - 1)) * 100}%`;
  const single = models.length === 1 ? models[0] : null;
  const setQuant = (id: string) => { state.quant = id; rerender(); };
  const fileHere = single ? fileFor(single, q.id) : null;
  const est = single ? estimateFor(single) : null;

  return h("section", { class: "panel", "aria-labelledby": "qtitle" },
    h("div", { class: "panel-head" },
      h("h2", { class: "panel-title", id: "qtitle" }, h("span", { class: "step" }, String(step)), "Pick a quantization"),
      h("span", { class: "panel-sub" }, "Fewer bits per weight: smaller and faster, with some quality loss")),
    h("div", { class: "quant-grid" },
      h("div", { class: "slider-block" },
        h("input", {
          id: "quant", class: "range", type: "range", min: 0, max: SLIDER_LEVELS.length - 1, step: 1, value: idx,
          style: `--pct:${pct}`, "aria-label": "Quantization level", "aria-valuetext": `${q.label}, about ${q.bitsPerWeight} bits per weight`,
          oninput: (e) => setQuant(SLIDER_LEVELS[Number((e.target as HTMLInputElement).value)].id),
        }),
        h("div", { class: "ticks" },
          SLIDER_LEVELS.map((l) => h("button", {
            class: `tick${l.id === q.id ? " on" : ""}`, tabindex: -1, onclick: () => setQuant(l.id),
            title: `${l.label}: ~${l.bitsPerWeight} bits per weight${single && fileFor(single, l.id) ? " · GGUF file in this repo" : ""}`,
          }, h("strong", null, l.id === "F16" ? "FP16" : l.id.replace("_K_M", "_K_M")), h("span", null, `${Math.round(l.bitsPerWeight * 10) / 10}b`),
            single && fileFor(single, l.id) ? h("i", { class: "gguf", "aria-hidden": "true" }) : null))),
        h("div", { class: "scale-ends" }, h("span", null, "← smaller, faster"), h("span", null, "original quality →"))),
      h("div", { class: "explainer" },
        h("div", { class: "explainer-head" },
          h("span", { class: "explainer-name" }, q.label),
          h("span", { class: "explainer-bits" }, `≈ ${q.bitsPerWeight} bits per weight`)),
        h("div", { class: "meters" },
          h("span", null, "Quality"),
          h("span", { class: "qbar", role: "img", "aria-label": `Quality ${q.quality} of 5` }, [1, 2, 3, 4, 5].map((i) => h("i", { class: i <= q.quality ? "on" : "" }))),
          h("span", null, "Size vs FP16"),
          h("span", { class: "sizebar", role: "img", "aria-label": `${Math.round((q.bitsPerWeight / 16) * 100)}% of FP16 size` },
            h("i", { style: `width:${(q.bitsPerWeight / 16) * 100}%` }))),
        h("p", null, q.explain),
        fileHere
          ? h("span", { class: "file-badge" }, icon("check"), `Ready-made GGUF file in this repo · ${fmtBytes(fileHere.sizeBytes)}`)
          : single && est
            ? h("span", { class: "file-badge" }, icon("file"), `Weights alone: ${fmtGB(est.weightsGB)}`)
            : null)),
  );
}

function machinePanel(maxContext: number | null, step: number, withMap: Estimate | null) {
  const steps = CONTEXT_STEPS.filter((s) => !maxContext || s <= maxContext);
  if (steps.length === 0) steps.push(CONTEXT_STEPS[0]);
  if (!steps.includes(state.context)) {
    state.context = steps.reduce((a, b) => (Math.abs(b - state.context) < Math.abs(a - state.context) ? b : a));
  }
  const idx = steps.indexOf(state.context);
  const numField = (id: string, label: string, value: number, set: (v: number) => void, ic: IconName) =>
    h("div", { class: "field" },
      h("label", { for: id }, label),
      h("div", { class: "field-row" },
        icon(ic),
        h("input", {
          id, class: "num", type: "number", min: 0, max: 4096, step: 1, value, inputmode: "numeric",
          oninput: (e) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v >= 0) { set(v); state.machine.preset = null; saveMachine(); rerender(); }
          },
        }),
        h("span", { class: "unit" }, "GB")));

  return h("section", { class: "panel", "aria-labelledby": "mtitle" },
    h("div", { class: "panel-head" },
      h("h2", { class: "panel-title", id: "mtitle" }, h("span", { class: "step" }, String(step)), "Will it run on my machine?"),
      h("span", { class: "panel-sub" }, "Pick a preset or type your own numbers")),
    h("div", { class: "presets", role: "group", "aria-label": "Machine presets" },
      PRESETS.map((pr) => h("button", {
        class: "preset", "aria-pressed": state.machine.preset === pr.id ? "true" : "false",
        onclick: () => { state.machine = { ramGB: pr.ramGB, vramGB: pr.vramGB, preset: pr.id }; saveMachine(); rerender(); },
      }, h("span", { class: "preset-top" }, icon(pr.icon), pr.label), h("span", { class: "preset-spec" }, pr.spec)))),
    h("div", { class: "inputs" },
      numField("ram", "System RAM", state.machine.ramGB, (v) => (state.machine.ramGB = v), "chip"),
      numField("vram", "GPU memory (0 if none)", state.machine.vramGB, (v) => (state.machine.vramGB = v), "gpu"),
      h("div", { class: "field" },
        h("label", { for: "ctx" }, "Context length (text kept in memory)"),
        h("div", { class: "field-row" },
          h("input", {
            id: "ctx", class: "range small", type: "range", min: 0, max: steps.length - 1, step: 1, value: idx,
            style: `--pct:${steps.length > 1 ? (idx / (steps.length - 1)) * 100 : 100}%`, "aria-valuetext": `${fmtTokens(state.context)} tokens`,
            oninput: (e) => { state.context = steps[Number((e.target as HTMLInputElement).value)]; rerender(); },
          }),
          h("output", { for: "ctx" }, fmtTokens(state.context))))),
    withMap ? memoryMap(withMap) : null,
  );
}

// ---------- memory map (waffle) ----------

function memoryMap(est: Estimate) {
  const { ramGB, vramGB } = state.machine;
  const need = est.totalGB;
  const freeRam = Math.max(0, ramGB - SYSTEM_RESERVE_GB);
  const fit = fitFor(est);
  const cap = Math.max(need, ramGB, vramGB, 1);
  const unit = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].find((u) => cap / u <= 40) ?? 64;
  const cols = Math.max(8, Math.ceil(Math.max(ramGB, vramGB, 1) / unit));
  const used = (gb: number, of: number, what: string) => (gb < 0.05 ? `not needed · ${fmtGB(of)} ${what}` : `${fmtGB(gb)} of ${fmtGB(of)} ${what}`);
  const bounds = [est.weightsGB, est.weightsGB + est.kvCacheGB, need];
  const seg = (x: number) => (x < bounds[0] ? "w" : x < bounds[1] ? "k" : x < bounds[2] ? "o" : "");

  // GPU first; if the model doesn't fit in VRAM, the rest spills into free RAM.
  const onGpu = vramGB > 0 ? Math.min(need, vramGB) : 0;
  const gpuOnly = vramGB > 0 && need <= vramGB * 0.95;
  const ramStart = gpuOnly ? need : onGpu;
  const onRam = gpuOnly ? 0 : Math.min(Math.max(0, need - onGpu), freeRam);
  const overflow = Math.max(0, need - onGpu - onRam);

  let n = 0;
  const cell = (cls: string, tip: string) => h("i", { class: `cell ${cls}`.trim(), style: `transition-delay:${Math.min(n++, 60) * 7}ms`, "data-tip": tip });
  const segName = (s: string) => (s === "w" ? "Weights" : s === "k" ? "KV cache" : s === "o" ? "Overhead" : "Free");

  const rows: HTMLElement[] = [];
  if (vramGB > 0) {
    const count = Math.max(1, Math.ceil(vramGB / unit));
    rows.push(h("div", { class: "map-row" },
      h("div", { class: "map-label" }, icon("gpu"), h("span", null, "GPU", h("small", null, used(onGpu, vramGB, "used")))),
      h("div", { class: "cells" }, Array.from({ length: count }, (_, i) => {
        const mid = (i + 0.5) * unit;
        const s = mid < onGpu ? seg(mid) : "";
        return cell(s, `GPU ${fmtGB(i * unit)}–${fmtGB(Math.min(vramGB, (i + 1) * unit))}: ${segName(s)}`);
      }))));
  }
  const ramCount = Math.max(1, Math.ceil(ramGB / unit));
  rows.push(h("div", { class: "map-row" },
    h("div", { class: "map-label" }, icon("chip"), h("span", null, "RAM", h("small", null, used(onRam, freeRam, "free")))),
    h("div", { class: "cells" }, Array.from({ length: ramCount }, (_, i) => {
      const lo = i * unit, mid = lo + 0.5 * unit;
      if (mid > freeRam) return cell("res", `RAM ${fmtGB(lo)}+: kept for the operating system`);
      const s = mid < onRam ? seg(ramStart + mid) : "";
      return cell(s, `RAM ${fmtGB(lo)}–${fmtGB(lo + unit)}: ${segName(s)}`);
    }))));
  if (overflow > 0.01) {
    const count = Math.min(cols, Math.max(1, Math.ceil(overflow / unit)));
    const start = onGpu + onRam;
    rows.push(h("div", { class: "map-row overflow" },
      h("div", { class: "map-label" }, icon("x"), h("span", null, "Doesn't fit", h("small", null, `${fmtGB(overflow)} short`))),
      h("div", { class: "cells" }, Array.from({ length: count }, (_, i) => {
        const s = seg(start + (i + 0.5) * unit) || "o";
        return cell(`${s} over`, `Missing memory: ${segName(s)}`);
      }))));
  }

  const parts = [
    { cls: "w", name: "Weights", gb: est.weightsGB },
    { cls: "k", name: "KV cache", gb: est.kvCacheGB, note: est.kvIsRough ? " (rough)" : "" },
    { cls: "o", name: "Overhead", gb: est.overheadGB },
  ];
  return h("div", { "data-key": "map" },
    h("div", {
      class: "map", role: "img", style: `--cols:${cols}`,
      "aria-label": `Memory map: needs ${fmtGB(need)} (weights ${fmtGB(est.weightsGB)}, KV cache ${fmtGB(est.kvCacheGB)}, overhead ${fmtGB(est.overheadGB)}). ${fmtGB(onGpu)} on GPU, ${fmtGB(onRam)} in RAM${overflow > 0.01 ? `, ${fmtGB(overflow)} short` : ""}.`,
    }, rows),
    h("div", { class: "map-legend" },
      parts.map((p) => h("span", { class: "key" }, h("i", { class: `sw ${p.cls}` }), `${p.name} ${fmtGB(p.gb)}${p.note ?? ""}`)),
      h("span", { class: "key" }, h("i", { class: "sw" }), "Free"),
      h("span", { class: "key" }, h("i", { class: "sw res" }), "Kept for system"),
      overflow > 0.01 ? h("span", { class: "key" }, h("i", { class: "sw over" }), "Missing") : null,
      h("span", { class: "unit-note" }, `1 square = ${fmtGB(unit)}`)),
    h("div", { class: "verdict" }, pill(fit), h("div", { class: "verdict-text" }, h("strong", null, fit.headline), fit.detail)),
  );
}

// ---------- card view ----------

function cardView(p: WidgetPayload, m: ModelSummary) {
  const est = estimateFor(m);
  const fit = est ? fitFor(est) : null;
  const q = findQuant(state.quant);
  const tab: CardTab = est ? state.tab.card : "overview";
  const body: Child[] =
    tab === "quant" && est ? [quantPanel([m], 1), quantTable(m)]
    : tab === "fit" && est ? [machinePanel(m.maxContext, 2, est)]
    : [
      tiles(m),
      est && fit ? overviewPanel(est, fit) : null,
      m.warnings.length ? h("ul", { class: "notes" }, m.warnings.map((w) => h("li", null, w))) : null,
    ];

  return h("div", { class: "stack enter", "data-key": `card:${m.id}` },
    p.view === "compare" ? crumbs(p, m) : null,
    h("header", { class: "hero" },
      h("div", { class: "hero-top" },
        h("div", { class: "identity" },
          h("div", { class: "monogram", "aria-hidden": "true" }, initials(org(m))),
          h("div", { style: "min-width:0" },
            h("div", { class: "eyebrow" }, h("span", null, `Hugging Face · ${org(m)}`), h("span", { class: "live" }, h("i", null), "live")),
            h("h1", { class: "model-name" }, shortName(m)))),
        actionButtons(m)),
      h("div", { class: "chips" },
        m.task && h("span", { class: "chip" }, icon("layers"), m.task),
        m.library && h("span", { class: "chip" }, m.library),
        h("span", { class: "chip", title: "License from the model card" }, icon("scale"), m.license ?? "license unknown"),
        m.gated && h("span", { class: "chip warn", title: "Accept the terms on Hugging Face before downloading" }, "Gated"),
        m.nativeDtype && h("span", { class: "chip" }, m.nativeDtype),
        m.architecture && h("span", { class: "chip hide-sm" }, m.architecture)),
      est && fit
        ? h("div", { class: "hero-metric" },
          counter(est.totalGB, "gb", "hero-number", `Needs about ${fmtGB(est.totalGB)}`),
          h("div", { class: "hero-caption" }, "memory needed at ", h("strong", null, q.label), " with ", h("strong", null, `${fmtTokens(state.context)}`), " context"),
          pill(fit))
        : h("div", { class: "hero-metric" }, h("div", { class: "hero-caption" }, "Parameter count unknown, so memory can't be estimated."))),
    est ? tabs("card", [
      { id: "overview", label: "Overview", icon: "layers" },
      { id: "quant", label: "Quantization", icon: "sliders", badge: quantShort(q.id) },
      { id: "fit", label: "Will it run?", icon: "gpu", badge: machineShort() },
    ]) : null,
    tabPanel(tab, body),
    footer(p),
  );
}

function tiles(m: ModelSummary) {
  const tile = (ic: IconName, label: string, value: Node | string, note?: string, tip?: string) =>
    h("div", { class: "tile", "data-tip": tip },
      h("div", { class: "tile-label" }, icon(ic), label),
      h("div", { class: "tile-value" }, value),
      note ? h("div", { class: "tile-note" }, note) : null);
  const paramNote = m.parametersSource === "name" ? "guessed from name" : m.parametersSource === "gguf" ? "from GGUF metadata" : m.parametersSource ? "from safetensors" : undefined;
  const smallest = m.ggufFiles.length ? m.ggufFiles[m.ggufFiles.length - 1] : null;
  return h("div", { class: "tiles" },
    tile("chip", "Parameters", m.parameters ? counter(m.parameters, "params", "") : "unknown", paramNote, m.parameters ? `${m.parameters.toLocaleString("en-US")} parameters` : undefined),
    m.weightsSizeBytes
      ? tile("disk", "Size on disk", counter(m.weightsSizeBytes / 1e9, "gb", ""), m.nativeDtype ? `original ${m.nativeDtype} weights` : "original weights")
      : smallest ? tile("disk", "Smallest file", fmtBytes(smallest.sizeBytes), `${smallest.quant} GGUF`) : tile("disk", "Size on disk", "unknown"),
    tile("download", "Downloads", m.downloads != null ? counter(m.downloads, "count", "") : "unknown", "last 30 days", m.downloads != null ? `${m.downloads.toLocaleString("en-US")} downloads in the last 30 days` : undefined),
    tile("heart", "Likes", m.likes != null ? counter(m.likes, "count", "") : "unknown"),
    tile("clock", "Updated", relativeDate(m.lastModified), m.lastModified?.slice(0, 10)),
    m.maxContext ? tile("lines", "Max context", fmtTokens(m.maxContext), "tokens") : null,
  );
}

function quantTable(m: ModelSummary) {
  const rows = QUANT_LEVELS.map((q) => ({ q, est: estimateFor(m, q.id)! }));
  const max = Math.max(...rows.map((r) => r.est.totalGB));
  const sel = findQuant(state.quant).id;
  const select = (id: string) => { state.quant = id; rerender(); };
  return h("section", { class: "panel", "aria-labelledby": "ltitle" },
    h("div", { class: "panel-head" },
      h("h2", { class: "panel-title", id: "ltitle" }, icon("grid"), "Every level at a glance"),
      h("span", { class: "panel-sub" }, "Select a row to use that level")),
    h("div", { class: "scroll-x" },
        h("table", { class: "qtable", "aria-label": "Memory needed at each quantization level" },
          h("thead", null, h("tr", null,
            h("th", null, "Level"), h("th", { class: "hide-sm" }, "Quality"), h("th", null, "Memory needed"), h("th", { class: "r" }, ""), h("th", null, "On your machine"))),
          h("tbody", null, rows.map(({ q, est }) => {
            const fit = fitFor(est);
            const file = fileFor(m, q.id);
            return h("tr", {
              class: "qrow", tabindex: 0, "aria-selected": q.id === sel ? "true" : "false", "data-key": q.id,
              onclick: () => select(q.id),
              onkeydown: (e) => { const k = (e as KeyboardEvent).key; if (k === "Enter" || k === " ") { e.preventDefault(); select(q.id); } },
            },
              h("td", null, h("div", { class: "qname" }, q.label), h("div", { class: "qsub" }, file ? `GGUF file · ${fmtBytes(file.sizeBytes)}` : `~${q.bitsPerWeight} bits/weight`)),
              h("td", { class: "hide-sm" }, h("span", { class: "dots", role: "img", "aria-label": `Quality ${q.quality} of 5` }, [1, 2, 3, 4, 5].map((i) => h("i", { class: i <= q.quality ? "on" : "" })))),
              h("td", { class: "bar-cell" }, h("div", { class: "hbar", style: `width:${(est.totalGB / max) * 100}%`, "data-tip": `${q.label}: weights ${fmtGB(est.weightsGB)} + KV cache ${fmtGB(est.kvCacheGB)} + overhead ${fmtGB(est.overheadGB)}` })),
              h("td", { class: "r" }, fmtGB(est.totalGB)),
              h("td", null, pill(fit, true)));
          })))));
}

// ---------- compare view ----------

function compareView(p: WidgetPayload) {
  const q = findQuant(state.quant);
  const ests = p.models.map((m) => estimateFor(m));
  const fits = ests.map((e) => (e ? fitFor(e) : null));
  const maxCtx = p.models.reduce<number | null>((acc, m) => (m.maxContext ? Math.max(acc ?? 0, m.maxContext) : acc), null);

  // Badges
  const idxMax = (vals: (number | null)[]) => {
    let best = -1;
    vals.forEach((v, i) => { if (v != null && (best < 0 || v > (vals[best] ?? -Infinity))) best = i; });
    return best;
  };
  const popular = idxMax(p.models.map((m) => m.downloads));
  const capable = idxMax(p.models.map((m) => m.parameters));
  const lightest = idxMax(ests.map((e) => (e ? -e.totalGB : null)));
  const rank = (f: FitResult | null) => (!f ? 0 : f.status === "fits-gpu" ? 4 : f.status === "fits-cpu" ? 3 : f.status === "tight" ? 2 : 1);
  let best = -1;
  p.models.forEach((m, i) => {
    if (rank(fits[i]) < 2) return;
    if (best < 0 || rank(fits[i]) > rank(fits[best]) || (rank(fits[i]) === rank(fits[best]) && (m.parameters ?? 0) > (p.models[best].parameters ?? 0))) best = i;
  });

  return h("div", { class: "stack enter", "data-key": "compare" },
    h("header", { class: "hero" },
      h("div", { class: "hero-top" },
        h("div", { class: "identity" },
          h("div", { class: "monogram", "aria-hidden": "true" }, "VS"),
          h("div", { style: "min-width:0" },
            h("div", { class: "eyebrow" }, h("span", null, "Hugging Face · head-to-head"), h("span", { class: "live" }, h("i", null), "live")),
            h("h1", { class: "model-name" }, `Comparing ${p.models.length} models`))),
        actionButtons(null)),
      h("div", { class: "hero-metric" },
        best >= 0
          ? [h("div", { class: "hero-caption" }, "Best fit for your machine: ", h("strong", null, shortName(p.models[best])), ` at ${q.label}`), pill(fits[best]!)]
          : h("div", { class: "hero-caption" }, `None of these fit your machine at ${q.label}. Try a smaller quantization or more memory.`))),
    tabs("compare", [
      { id: "models", label: "Head-to-head", icon: "star" },
      { id: "tune", label: "Tune settings", icon: "sliders", badge: `${quantShort(q.id)} · ${machineShort()}` },
      { id: "table", label: "Table", icon: "grid" },
    ]),
    tabPanel(state.tab.compare, compareBody(p, ests, fits, maxCtx, { best, popular, capable, lightest })),
    footer(p),
  );
}

function compareBody(
  p: WidgetPayload, ests: (Estimate | null)[], fits: (FitResult | null)[], maxCtx: number | null,
  r: { best: number; popular: number; capable: number; lightest: number },
): Child[] {
  const many = p.models.length > 1;
  if (state.tab.compare === "tune") return [resultStrip(p, ests, fits), quantPanel(p.models, 1), machinePanel(maxCtx, 2, null)];
  if (state.tab.compare === "table") return [compareTable(p)];
  const notes = p.models.flatMap((m) => m.warnings.map((w) => `${m.id}: ${w}`));
  return [
    quickBar(),
    h("section", { class: "podium", "aria-label": "Models" }, p.models.map((m, i) => modelCard(m, i, ests[i], fits[i], {
      best: i === r.best, popular: many && i === r.popular, capable: many && i === r.capable, lightest: many && i === r.lightest,
    }))),
    notes.length ? h("ul", { class: "notes" }, notes.map((w) => h("li", null, w))) : null,
  ];
}

function modelCard(m: ModelSummary, i: number, est: Estimate | null, fit: FitResult | null, b: { best: boolean; popular: boolean; capable: boolean; lightest: boolean }) {
  const { ramGB, vramGB } = state.machine;
  const capacity = vramGB > 0 && fit?.status === "fits-gpu" ? vramGB : vramGB > 0 ? vramGB + Math.max(0, ramGB - SYSTEM_RESERVE_GB) : Math.max(0.1, ramGB - SYSTEM_RESERVE_GB);
  const capLabel = vramGB > 0 && fit?.status === "fits-gpu" ? `of ${fmtGB(vramGB)} GPU` : vramGB > 0 ? `of ${fmtGB(capacity)} GPU + free RAM` : `of ${fmtGB(capacity)} free RAM`;
  const open = () => { state.focused = i; render(); };
  return h("article", { class: `mcard${b.best ? " best" : ""}`, "data-key": m.id },
    h("div", { class: "mcard-head" },
      h("div", { class: "monogram sm", "aria-hidden": "true" }, initials(org(m))),
      h("div", { style: "min-width:0" }, h("div", { class: "mcard-name" }, shortName(m)), h("div", { class: "mcard-org" }, org(m)))),
    h("div", { class: "badges" },
      b.best && h("span", { class: "badge best" }, icon("star"), "Best fit for you"),
      b.popular && h("span", { class: "badge" }, icon("flame"), "Most popular"),
      b.lightest && h("span", { class: "badge" }, icon("feather"), "Lightest"),
      b.capable && h("span", { class: "badge" }, icon("bolt"), "Most capable")),
    est && fit
      ? [
        h("div", null, counter(est.totalGB, "gb", "mcard-number", `Needs about ${fmtGB(est.totalGB)}`), h("small", { class: "panel-sub", style: "margin-left:6px" }, "needed")),
        h("div", { class: `meter ${fit.status}`, role: "img", "aria-label": `${fmtGB(est.totalGB)} ${capLabel}` }, h("i", { style: `width:${Math.min(100, (est.totalGB / capacity) * 100)}%` })),
        h("div", { class: "meter-caption" }, `${fmtGB(est.totalGB)} ${capLabel}`),
        pill(fit, true),
      ]
      : h("div", { class: "panel-sub" }, "Parameter count unknown"),
    h("dl", { class: "kv" },
      h("dt", null, "Parameters"), h("dd", null, fmtParams(m.parameters)),
      h("dt", null, "Downloads"), h("dd", null, fmtCount(m.downloads)),
      h("dt", null, "Likes"), h("dd", null, fmtCount(m.likes)),
      h("dt", null, "License"), h("dd", null, (m.license ?? "unknown") + (m.gated ? " · gated" : "")),
      h("dt", null, "Updated"), h("dd", null, relativeDate(m.lastModified))),
    h("div", { class: "mcard-actions" },
      h("button", { class: "btn", onclick: open }, "Open card"),
      h("button", { class: "btn primary", onclick: () => askDeploy(m) }, icon("cloud"), "Deploy")),
  );
}

function compareTable(p: WidgetPayload) {
  const row = (label: string, cells: (string | Node)[]) => h("tr", null, h("th", { scope: "row" }, label), cells.map((c) => h("td", null, c)));
  return h("section", { class: "panel", "aria-labelledby": "ctitle" },
    h("div", { class: "panel-head" },
      h("h2", { class: "panel-title", id: "ctitle" }, icon("grid"), "Full comparison"),
      h("span", { class: "panel-sub" }, `Estimates at ${findQuant(state.quant).label}, ${fmtTokens(state.context)} context`)),
    h("div", { class: "scroll-x" },
        h("table", { class: "ctable" },
          h("thead", null, h("tr", null, h("th", null, ""), p.models.map((m) => h("th", { scope: "col" }, shortName(m))))),
          h("tbody", null,
            row("Memory needed", p.models.map((m) => { const e = estimateFor(m); return e ? fmtGB(e.totalGB) : "unknown"; })),
            row("Parameters", p.models.map((m) => fmtParams(m.parameters))),
            row("Size on disk", p.models.map((m) => fmtBytes(m.weightsSizeBytes))),
            row("Downloads (30 days)", p.models.map((m) => fmtCount(m.downloads))),
            row("Likes", p.models.map((m) => fmtCount(m.likes))),
            row("License", p.models.map((m) => (m.license ?? "unknown") + (m.gated ? " · gated" : ""))),
            row("Task", p.models.map((m) => m.task ?? "unknown")),
            row("Max context", p.models.map((m) => (m.maxContext ? fmtTokens(m.maxContext) : "unknown"))),
            row("GGUF files", p.models.map((m) => (m.ggufFiles.length ? m.ggufFiles.map((f) => f.quant).slice(0, 6).join(", ") : "none"))),
            row("Updated", p.models.map((m) => relativeDate(m.lastModified)))))));
}

function footer(p: WidgetPayload) {
  return h("footer", { class: "foot" },
    h("div", null, "How the estimate works: ", h("code", null, FORMULA_TEXT), ". Real usage depends on the runtime (llama.cpp, Ollama, vLLM, MLX) and settings."),
    h("div", { class: "foot-row" },
      h("span", null, `Data: Hugging Face Hub · fetched ${new Date(p.fetchedAt).toLocaleString()}`),
      h("span", null, "Estimates only · Model Scout")));
}

// ---------- formatting ----------

function fmtTokens(n: number): string {
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : n.toLocaleString("en-US");
}

function relativeDate(iso: string | null): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  const years = days / 365;
  return `${years.toFixed(years < 10 ? 1 : 0)} yr ago`;
}

// ---------- tooltip ----------

function setupTooltip() {
  const tip = document.getElementById("tooltip")!;
  const show = (target: HTMLElement, x: number, y: number) => {
    tip.textContent = target.dataset.tip ?? "";
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
    const top = y + 16 + r.height > window.innerHeight ? y - r.height - 12 : y + 16;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  };
  document.addEventListener("mousemove", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (t) show(t, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener("focusin", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (t) { const r = t.getBoundingClientRect(); show(t, r.left, r.bottom - 8); }
  });
  document.addEventListener("focusout", () => (tip.hidden = true));
  document.addEventListener("mouseleave", () => (tip.hidden = true));
}

setupTooltip();
void connectHost();
