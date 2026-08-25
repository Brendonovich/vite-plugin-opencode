import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

import {
  transformAsync,
  types,
  type NodePath,
  type PluginObj,
  type TransformOptions,
} from "@babel/core";
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import clientCss from "./client.css?raw";
import clientHtml from "./client.html?raw";
import globalCss from "./global.css?raw";

const virtualId = "virtual:vite-opencode-picker/client";
const resolvedVirtualId = `\0${virtualId}`;

export interface OpenCodePickerOptions {
  readonly workspaceRoot?: string;
  readonly skills?: ReadonlyArray<string>;
  readonly agent?: string;
}

interface PickerPlugin {
  readonly name: string;
  readonly apply: "serve";
  readonly enforce: "pre";
  readonly configResolved: (config: { readonly root: string; readonly base: string }) => void;
  readonly resolveId: (id: string) => string | undefined;
  readonly load: (id: string) => string | undefined;
  readonly transformIndexHtml: {
    readonly order: "post";
    readonly handler: () => Array<{
      readonly tag: string;
      readonly attrs: Readonly<Record<string, string>>;
      readonly injectTo: "body";
    }>;
  };
  readonly transform: (
    code: string,
    id: string,
  ) => Promise<{ readonly code: string; readonly map: string | null } | undefined>;
  readonly configureServer: (server: {
    readonly middlewares: {
      use: (
        path: string,
        handler: (request: IncomingMessage, response: ServerResponse) => void,
      ) => void;
    };
  }) => void;
}

const findWorkspaceRoot = (start: string) => {
  let directory = resolve(start);
  while (!existsSync(resolve(directory, ".git"))) {
    const parent = dirname(directory);
    if (parent === directory) return resolve(start);
    directory = parent;
  }
  return directory;
};

const sourceMarkerPlugin = (source: string) => (): PluginObj =>
  ({
    visitor: {
      JSXOpeningElement(path: NodePath<types.JSXOpeningElement>) {
        if (!types.isJSXIdentifier(path.node.name) || !/^[a-z]/.test(path.node.name.name)) return;
        if (
          path.node.attributes.some(
            (attribute) =>
              types.isJSXAttribute(attribute) &&
              types.isJSXIdentifier(attribute.name, { name: "data-opencode-picker-source" }),
          )
        )
          return;
        const line = path.node.loc?.start.line ?? 1;
        path.node.attributes.push(
          types.jsxAttribute(
            types.jsxIdentifier("data-opencode-picker-source"),
            types.stringLiteral(`${source}:${line}`),
          ),
        );
      },
    },
  }) satisfies PluginObj;

const clientModule = (endpoint: string) => `
const host = document.createElement("div");
host.dataset.opencodePickerUi = "";
document.documentElement.append(host);
const cursorStyle = document.createElement("style");
cursorStyle.textContent = ${JSON.stringify(globalCss)};
document.head.append(cursorStyle);
const root = host.attachShadow({ mode: "open" });
const sheet = new CSSStyleSheet();
sheet.replaceSync(${JSON.stringify(clientCss)});
root.adoptedStyleSheets = [sheet];
root.innerHTML = ${JSON.stringify(clientHtml)};

const outline = root.querySelector("#outline");
const pickerCursor = root.querySelector("#picker-cursor");
const dialog = root.querySelector("#dialog");
const form = root.querySelector("form");
const textarea = root.querySelector("textarea");
const modeTrigger = root.querySelector("#mode-trigger");
const modelTrigger = root.querySelector("#model-trigger");
const modelTriggerLabel = root.querySelector("#model-trigger-label");
const modelMenu = root.querySelector("#model-menu");
const modelSearch = root.querySelector("#model-search");
const modelOptions = root.querySelector("#model-options");
const status = root.querySelector("#status");
const sessionsElement = root.querySelector("#sessions");
for (const eventName of ["pointerdown", "mousedown", "touchstart", "click", "dblclick", "contextmenu"])
  root.addEventListener(eventName, (event) => event.stopPropagation());
for (const eventName of ["pointerdown", "mousedown"])
  sessionsElement.addEventListener(eventName, (event) => {
    if (!(event.target instanceof Element) || !event.target.matches(".session-prompt textarea"))
      event.preventDefault();
  });
let active = false;
let selected;
let selectedElement;
let suppressClick = false;
let sessions = [];
try {
  const storedSessions = JSON.parse(localStorage.getItem("vite-opencode-picker:sessions") || "[]");
  if (Array.isArray(storedSessions)) sessions = storedSessions;
} catch {}
let models = [];
let defaultModelName;
let selectedModel;
let requestMode = localStorage.getItem("vite-opencode-picker:mode") === "designs" ? "designs" : "direct";
let activeDesignSessionID;
let refiningSessionID;
modeTrigger.dataset.mode = requestMode;
modeTrigger.textContent = requestMode === "designs" ? "3 approaches" : "Direct";
modeTrigger.setAttribute("aria-pressed", String(requestMode === "designs"));
modeTrigger.title = "Toggle request mode (Cmd/Ctrl+Shift+D)";
try {
  const storedModel = JSON.parse(localStorage.getItem("vite-opencode-picker:model") || "null");
  if (storedModel && typeof storedModel.id === "string" && typeof storedModel.providerID === "string")
    selectedModel = storedModel;
} catch {}
const sessionElements = new Map();
const dismissedSessions = new Set();
try {
  for (const id of JSON.parse(localStorage.getItem("vite-opencode-picker:dismissed") || "[]"))
    dismissedSessions.add(id);
} catch {}
sessions = sessions.filter((session) => !dismissedSessions.has(session.id));
const persistSessions = () =>
  localStorage.setItem("vite-opencode-picker:sessions", JSON.stringify(sessions));

const marker = (element) => {
  const marked = element.closest("[data-opencode-picker-source]");
  return marked?.getAttribute("data-opencode-picker-source");
};
const normalizedText = (value, limit = 120) =>
  (value || "").trim().replace(/\\s+/g, " ").slice(0, limit);
const tableSummary = (table) => {
  const caption = normalizedText(table.querySelector("caption")?.textContent, 50);
  let headers = [...table.querySelectorAll("thead th")];
  if (headers.length === 0) headers = [...(table.querySelector("tr")?.querySelectorAll("th") || [])];
  const columns = [...new Set(headers.map((header) => normalizedText(header.textContent, 30)).filter(Boolean))]
    .slice(0, 5);
  return normalizedText([
    caption ? "Table: " + caption : "Table",
    columns.length > 0 ? "columns: " + columns.join(", ") : "",
  ].filter(Boolean).join("; "), 180);
};
const primaryText = (element) => {
  if (element.matches("table")) return tableSummary(element);
  if (element.matches("h1, h2, h3, h4, h5, h6, [role=heading]"))
    return normalizedText(element.textContent) || undefined;

  const notable = [];
  const headings = [...element.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")]
    .map((heading) => normalizedText(heading.textContent, 50))
    .filter(Boolean)
    .slice(0, 2);
  if (headings.length > 0) notable.push("Heading: " + headings.join(" / "));
  const paragraphs = [...element.querySelectorAll("p")]
    .filter((paragraph) => !paragraph.closest("table"))
    .map((paragraph) => normalizedText(paragraph.textContent, 140))
    .filter(Boolean)
    .slice(0, 2);
  if (paragraphs.length > 0) notable.push("Copy: " + paragraphs.join(" / "));
  const table = element.querySelector("table");
  if (table) notable.push(tableSummary(table));
  if (notable.length > 0) return normalizedText(notable.join("; "), 320) || undefined;

  const direct = normalizedText(
    [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" "),
  );
  if (direct) return direct;
  if (element.matches("button, a, label, legend, summary, th, td, option"))
    return normalizedText(element.textContent) || undefined;
  if (element.childElementCount === 0) return normalizedText(element.textContent) || undefined;
  if (element.childElementCount === 1) {
    const compact = normalizedText(element.textContent, 121);
    if (compact.length <= 120) return compact || undefined;
  }
  return undefined;
};
const elementDescription = (element) => {
  const described = element.closest("[data-opencode-picker-description], [data-picker-description]");
  const tag = element.tagName.toLowerCase();
  return described?.getAttribute("data-opencode-picker-description") ||
    described?.getAttribute("data-picker-description") ||
    element.getAttribute("aria-label") ||
    element.getAttribute("name") ||
    element.getAttribute("title") ||
    "<" + tag + ">" + (element.id ? "#" + element.id : "") + " selected element";
};
const describe = (element) => ({
  tag: element.tagName.toLowerCase(),
  description: elementDescription(element),
  id: element.id || undefined,
  classes: [...element.classList].slice(0, 8),
  role: element.getAttribute("role") || undefined,
  ariaLabel: element.getAttribute("aria-label") || undefined,
  text: primaryText(element),
  url: location.href,
});
const setActive = (value) => {
  active = value;
  document.documentElement.classList.toggle("vite-opencode-picker-active", value);
  pickerCursor.classList.toggle("active", value);
  if (!value) outline.style.display = "none";
};
const highlight = (element) => {
  const rect = element.getBoundingClientRect();
  Object.assign(outline.style, { display: "block", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
};
const closeRefinement = () => {
  if (refiningSessionID) {
    const panel = sessionElements.get(refiningSessionID);
    panel?.classList.remove("refining");
    panel?.querySelector(".session-refine")?.setAttribute("aria-expanded", "false");
  }
  refiningSessionID = undefined;
};
const close = () => {
  closeRefinement();
  dialog.classList.remove("open");
  modelMenu.classList.remove("open", "closing");
  modelTrigger.setAttribute("aria-expanded", "false");
  outline.style.display = "none";
  status.textContent = "";
  form.reset();
  textarea.style.height = "";
  selected = undefined;
  selectedElement = undefined;
};
const placeDialog = (element) => {
  const rect = element.getBoundingClientRect();
  const width = Math.min(340, innerWidth - 20);
  const estimatedHeight = 72;
  const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
  const below = rect.bottom + estimatedHeight + 12 <= innerHeight;
  const top = below ? rect.bottom + 8 : Math.max(12, rect.top - estimatedHeight - 8);
  dialog.dataset.placement = below ? "below" : "above";
  Object.assign(dialog.style, { left: left + "px", top: top + "px", right: "auto", bottom: "auto" });
};
const renderSessions = () => {
  const visibleIds = new Set(sessions.map((session) => session.id));
  for (const [id, element] of sessionElements) {
    if (visibleIds.has(id)) continue;
    element.remove();
    sessionElements.delete(id);
  }
  let index = 0;
  for (const session of sessions) {
    let element = sessionElements.get(session.id);
    if (!element) {
      element = document.createElement("div");
      element.className = "session entering";
      element.innerHTML = '<button class="session-copy" type="button"><span class="session-dot"></span><span class="session-content"><span class="session-summary"></span><span class="session-path"><span class="session-path-prefix"></span><span class="session-path-file"></span></span></span></button><div class="session-comment"></div><div class="session-controls"><button class="session-variant" type="button" data-design="original">Original</button><button class="session-variant" type="button" data-design="design-1">1</button><button class="session-variant" type="button" data-design="design-2">2</button><button class="session-variant" type="button" data-design="design-3">3</button><button class="session-action session-refine" type="button">Prompt</button><button class="session-action session-revert" type="button">Undo</button><button class="session-action session-dismiss" type="button">Close</button><button class="session-cancel" type="button">Cancel</button><button class="session-accept" type="button">Accept</button></div><div class="session-prompt"><textarea placeholder="How should this result be refined?"></textarea><span class="session-prompt-status"></span><div class="session-prompt-actions"><button class="session-prompt-submit" type="button">Submit</button></div></div>';
      const copyButton = element.querySelector(".session-copy");
      const refineButton = element.querySelector(".session-refine");
      const promptTextarea = element.querySelector(".session-prompt textarea");
      const promptSubmit = element.querySelector(".session-prompt-submit");
      const promptStatus = element.querySelector(".session-prompt-status");
      const dismissButton = element.querySelector(".session-dismiss");
      const revertButton = element.querySelector(".session-revert");
      const acceptButton = element.querySelector(".session-accept");
      const cancelButton = element.querySelector(".session-cancel");
      const variantButtons = [...element.querySelectorAll(".session-variant")];
      let drag;
      let suppressCopy = false;
      const dismiss = () => {
        if (refiningSessionID === element.dataset.id) closeRefinement();
        dismissedSessions.add(element.dataset.id);
        localStorage.setItem("vite-opencode-picker:dismissed", JSON.stringify([...dismissedSessions]));
        sessions = sessions.filter((session) => session.id !== element.dataset.id);
        persistSessions();
        element.style.transform = "scale(.98)";
        element.style.opacity = "0";
        setTimeout(() => {
          sessionElements.delete(element.dataset.id);
          element.remove();
        }, 150);
      };
      const undoApproaches = async (button) => {
        button.disabled = true;
        let failureStatus = "completed";
        const trackedSession = sessions.find((session) => session.id === element.dataset.id);
        if (trackedSession) {
          trackedSession.status = "running";
          trackedSession.actionPending = "Restoring original...";
          persistSessions();
          renderSessions();
        }
        try {
          const response = await fetch(
            ${JSON.stringify(endpoint)} + "?change=" + encodeURIComponent(element.dataset.id) + "&state=completed",
            { method: "POST" },
          );
          const result = await response.json();
          failureStatus = result.status || failureStatus;
          if (!response.ok) throw new Error(result.error || "Could not cancel approaches");
          dismiss();
        } catch (error) {
          element.title = error instanceof Error ? error.message : String(error);
          if (trackedSession) {
            trackedSession.status = failureStatus;
            trackedSession.actionPending = undefined;
            persistSessions();
            renderSessions();
          }
        } finally {
          button.disabled = false;
        }
      };
      copyButton.addEventListener("click", async () => {
        if (suppressCopy) {
          suppressCopy = false;
          return;
        }
        await navigator.clipboard.writeText(element.dataset.id);
        element.classList.add("copied");
        element.querySelector(".session-summary").textContent = "Session ID copied";
        setTimeout(() => {
          element.classList.remove("copied");
          element.querySelector(".session-summary").textContent = element.dataset.summary;
        }, 1000);
      });
      copyButton.addEventListener("pointerdown", (event) => {
        const rect = element.getBoundingClientRect();
        drag = {
          pointerID: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          left: rect.left,
          top: rect.top,
          moved: false,
        };
        copyButton.setPointerCapture(event.pointerId);
        element.style.zIndex = "2147483645";
      });
      copyButton.addEventListener("pointermove", (event) => {
        if (!drag || drag.pointerID !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        const left = Math.max(8, Math.min(innerWidth - element.offsetWidth - 8, drag.left + dx));
        const top = Math.max(8, Math.min(innerHeight - element.offsetHeight - 8, drag.top + dy));
        element.style.left = left + "px";
        element.style.top = top + "px";
      });
      const finishDrag = (event) => {
        if (!drag || drag.pointerID !== event.pointerId) return;
        suppressCopy = drag.moved;
        const trackedSession = sessions.find((session) => session.id === element.dataset.id);
        if (trackedSession && drag.moved) {
          trackedSession.position = {
            left: parseFloat(element.style.left),
            top: parseFloat(element.style.top),
          };
          persistSessions();
        }
        drag = undefined;
        element.style.zIndex = "2147483644";
      };
      copyButton.addEventListener("pointerup", finishDrag);
      copyButton.addEventListener("pointercancel", finishDrag);
      refineButton.addEventListener("click", () => {
        const trackedSession = sessions.find((session) => session.id === element.dataset.id);
        if (!trackedSession) return;
        if (refiningSessionID === trackedSession.id) {
          closeRefinement();
          return;
        }
        close();
        refiningSessionID = trackedSession.id;
        element.classList.add("refining");
        refineButton.setAttribute("aria-expanded", "true");
        promptStatus.textContent = "";
        promptTextarea.focus();
      });
      const submitRefinement = async () => {
        const trackedSession = sessions.find((session) => session.id === element.dataset.id);
        if (!trackedSession) return;
        const comment = promptTextarea.value.trim();
        if (!comment) return;
        promptSubmit.disabled = true;
        promptStatus.textContent = "Sending...";
        try {
          const response = await fetch(
            ${JSON.stringify(endpoint)} + "?refine=" + encodeURIComponent(trackedSession.id),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                comment,
                source: trackedSession.source,
                summary: trackedSession.summary,
                mode: trackedSession.mode,
                selectedDesign: trackedSession.selectedDesign,
              }),
            },
          );
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Could not prompt session");
          trackedSession.status = "running";
          trackedSession.comment = comment;
          promptTextarea.value = "";
          closeRefinement();
          persistSessions();
          renderSessions();
        } catch (error) {
          promptStatus.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          promptSubmit.disabled = false;
        }
      };
      promptSubmit.addEventListener("click", () => void submitRefinement());
      promptTextarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
          event.preventDefault();
          void submitRefinement();
        }
      });
      promptTextarea.addEventListener("input", () => {
        promptTextarea.style.height = "auto";
        promptTextarea.style.height = Math.min(promptTextarea.scrollHeight, 140) + "px";
      });
      for (const variantButton of variantButtons) {
        variantButton.addEventListener("click", () => {
          const trackedSession = sessions.find((session) => session.id === element.dataset.id);
          if (!trackedSession) return;
          activeDesignSessionID = trackedSession.id;
          trackedSession.selectedDesign = variantButton.dataset.design;
          persistSessions();
          renderSessions();
          window.dispatchEvent(new CustomEvent("vite-opencode-picker:design-change", {
            detail: {
              sessionID: element.dataset.id,
              design: trackedSession.selectedDesign,
            },
          }));
        });
      }
      acceptButton.addEventListener("click", async () => {
        acceptButton.disabled = true;
        const trackedSession = sessions.find((session) => session.id === element.dataset.id);
        let failureStatus = "completed";
        try {
          const design = trackedSession?.selectedDesign || "original";
          if (design === "original") {
            await undoApproaches(acceptButton);
            return;
          }
          if (trackedSession) {
            trackedSession.status = "running";
            trackedSession.actionPending = "Applying approach...";
            persistSessions();
            renderSessions();
          }
          const response = await fetch(
            ${JSON.stringify(endpoint)} + "?selectDesign=" + encodeURIComponent(element.dataset.id),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                design,
                source: trackedSession?.source,
                summary: trackedSession?.summary,
              }),
            },
          );
          const result = await response.json();
          failureStatus = result.status || failureStatus;
          if (!response.ok) throw new Error(result.error || "Could not select design");
          dismiss();
        } catch (error) {
          element.title = error instanceof Error ? error.message : String(error);
          if (trackedSession) {
            trackedSession.status = failureStatus;
            trackedSession.actionPending = undefined;
            persistSessions();
            renderSessions();
          }
        } finally {
          acceptButton.disabled = false;
        }
      });
      cancelButton.addEventListener("click", () => void undoApproaches(cancelButton));
      revertButton.addEventListener("click", async () => {
        revertButton.disabled = true;
        let failureStatus = element.dataset.status;
        try {
          const response = await fetch(${JSON.stringify(endpoint)} + "?change=" + encodeURIComponent(element.dataset.id) + "&state=" + element.dataset.status, { method: "POST" });
          const result = await response.json();
          failureStatus = result.status || failureStatus;
          if (!response.ok) throw new Error(result.error || "Could not revert session");
          const session = sessions.find((session) => session.id === element.dataset.id);
          if (session) session.status = result.status;
          persistSessions();
          renderSessions();
        } catch (error) {
          element.title = error instanceof Error ? error.message : String(error);
          const session = sessions.find((session) => session.id === element.dataset.id);
          if (session) session.status = failureStatus;
          persistSessions();
          renderSessions();
        } finally {
          revertButton.disabled = false;
        }
      });
      dismissButton.addEventListener("click", () => dismiss());
      element.addEventListener("animationend", () => element.classList.remove("entering"), { once: true });
      sessionElements.set(session.id, element);
    }
    const slash = session.source.lastIndexOf("/");
    element.dataset.id = session.id;
    element.dataset.status = session.status;
    element.dataset.mode = session.mode || "direct";
    element.dataset.summary = session.summary || "Selected element";
    element.title = session.error || session.id;
    element
      .querySelector(".session-refine")
      .setAttribute("aria-expanded", String(refiningSessionID === session.id));
    element.querySelector(".session-copy").setAttribute("aria-label", (session.summary || "Selected element") + ", " + session.status + ", copy session ID");
    const revert = element.querySelector(".session-revert");
    const redo = session.status === "reverted";
    revert.title = redo ? "Redo changes" : "Undo changes";
    revert.setAttribute("aria-label", revert.title);
    revert.textContent = redo ? "Redo" : "Undo";
    if (session.mode === "designs" && !session.selectedDesign) session.selectedDesign = "original";
    for (const button of element.querySelectorAll(".session-variant"))
      button.classList.toggle("selected", button.dataset.design === session.selectedDesign);
    if (!element.classList.contains("copied"))
      element.querySelector(".session-summary").textContent =
        session.actionPending || element.dataset.summary;
    element.querySelector(".session-comment").textContent = session.comment || "";
    element.querySelector(".session-path-prefix").textContent = slash < 0 ? "" : session.source.slice(0, slash + 1);
    element.querySelector(".session-path-file").textContent = session.source.slice(slash + 1);
    const current = sessionsElement.children[index];
    if (current !== element) sessionsElement.insertBefore(element, current ?? null);
    const defaultPosition = {
      left: Math.max(10, innerWidth - Math.min(340, innerWidth - 20) - 10 - index * 8),
      top: 12 + index * 10,
    };
    const position = session.position || defaultPosition;
    const left = Math.max(8, Math.min(innerWidth - element.offsetWidth - 8, position.left));
    const top = Math.max(8, Math.min(innerHeight - element.offsetHeight - 8, position.top));
    element.style.left = left + "px";
    element.style.top = top + "px";
    session.position = { left, top };
    index += 1;
  }
};
const morphComposerToSession = (sessionID, start) => {
  const panel = sessionElements.get(sessionID);
  if (!panel || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    close();
    return;
  }
  panel.classList.remove("entering");
  const finalWidth = panel.offsetWidth;
  const finalHeight = panel.offsetHeight;
  panel.classList.add("morphing");
  Object.assign(panel.style, {
    left: start.left + "px",
    top: start.top + "px",
    width: start.width + "px",
    height: start.height + "px",
    overflow: "hidden",
    transition: "width 180ms cubic-bezier(.2,.8,.2,1), height 180ms cubic-bezier(.2,.8,.2,1)",
  });
  dialog.style.transition = "opacity 120ms ease, transform 180ms cubic-bezier(.2,.8,.2,1)";
  dialog.style.transformOrigin = "top left";
  dialog.style.pointerEvents = "none";
  panel.offsetHeight;
  requestAnimationFrame(() => {
    panel.classList.add("morph-visible");
    panel.style.width = finalWidth + "px";
    panel.style.height = finalHeight + "px";
    dialog.style.opacity = "0";
    dialog.style.transform = "scale(.985)";
  });
  setTimeout(() => {
    close();
    Object.assign(dialog.style, {
      opacity: "",
      transform: "",
      transformOrigin: "",
      transition: "",
      pointerEvents: "",
    });
    panel.classList.remove("morphing", "morph-visible");
    Object.assign(panel.style, {
      width: "",
      height: "",
      overflow: "",
      transition: "",
    });
  }, 190);
};
const refreshSessions = async () => {
  try {
    const recover = sessions
      .filter(
        (session) =>
          session.status === "running" ||
          session.status === "interrupted" ||
          session.status === "failed" ||
          session.status === "completed",
      )
      .map((session) => session.id)
      .join(",");
    const response = await fetch(
      ${JSON.stringify(endpoint)} + (recover ? "?recover=" + encodeURIComponent(recover) : ""),
    );
    if (!response.ok) return;
    const payload = await response.json();
    const incoming = payload.sessions.filter(
      (session) => !dismissedSessions.has(session.id),
    );
    const incomingById = new Map(incoming.map((session) => [session.id, session]));
    const existingIds = new Set(sessions.map((session) => session.id));
    sessions = [
      ...incoming.filter((session) => !existingIds.has(session.id)),
      ...sessions.map((session) => {
        const update = incomingById.get(session.id);
        return update
          ? {
              ...update,
              comment: session.comment,
              position: session.position,
              selectedDesign: session.selectedDesign,
              actionPending: session.actionPending,
            }
          : session;
      }),
    ];
    for (const session of sessions) {
      const recovered = payload.statuses?.[session.id];
      if (recovered) session.status = recovered;
    }
    persistSessions();
    renderSessions();
  } catch {}
};
let modelCloseTimer;
const placeModelMenu = () => {
  const rect = form.getBoundingClientRect();
  const above = rect.top - 8;
  const below = innerHeight - rect.bottom - 8;
  const placement = above >= 245 ? "above" : "below";
  modelMenu.dataset.placement = placement;
  modelOptions.style.maxHeight = Math.max(80, Math.min(190, (placement === "above" ? above : below) - 52)) + "px";
};
const closeModelMenu = () => {
  if (!modelMenu.classList.contains("open")) return;
  modelMenu.classList.remove("open");
  modelMenu.classList.add("closing");
  modelTrigger.setAttribute("aria-expanded", "false");
  clearTimeout(modelCloseTimer);
  modelCloseTimer = setTimeout(() => modelMenu.classList.remove("closing"), 110);
};
const renderModelOptions = () => {
  const query = modelSearch.value.trim().toLowerCase();
  const available = models.filter((model) =>
    (model.name + " " + model.providerID).toLowerCase().includes(query)
  );
  const makeOption = (model, isDefault = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-option";
    const isSelected = isDefault ? selectedModel === undefined : selectedModel?.id === model.id && selectedModel?.providerID === model.providerID;
    if (isSelected) button.classList.add("selected");
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(isSelected));
    button.innerHTML = '<span class="model-option-name"></span><span class="model-option-provider"></span>';
    button.querySelector(".model-option-name").textContent = model.name;
    button.querySelector(".model-option-provider").textContent = isDefault ? "" : model.providerID;
    button.addEventListener("click", () => {
      selectedModel = isDefault ? undefined : { id: model.id, providerID: model.providerID };
      if (selectedModel === undefined) localStorage.removeItem("vite-opencode-picker:model");
      else localStorage.setItem("vite-opencode-picker:model", JSON.stringify(selectedModel));
      modelTriggerLabel.textContent = model.name;
      closeModelMenu();
    });
    return button;
  };
  const children = [];
  if (query === "" || ("default " + (defaultModelName || "")).toLowerCase().includes(query)) {
    const header = document.createElement("div");
    header.className = "model-provider-header";
    header.textContent = "Default";
    children.push(header, makeOption({
      id: "",
      providerID: "",
      name: defaultModelName ? "Default (" + defaultModelName + ")" : "Default model",
    }, true));
  }
  const providers = new Map();
  for (const model of available) {
    const group = providers.get(model.providerID) || [];
    group.push(model);
    providers.set(model.providerID, group);
  }
  for (const [provider, providerModels] of [...providers].sort(([left], [right]) => left.localeCompare(right))) {
    const header = document.createElement("div");
    header.className = "model-provider-header";
    header.textContent = provider;
    children.push(header);
    for (const model of providerModels.sort((left, right) => left.name.localeCompare(right.name)))
      children.push(makeOption(model));
  }
  modelOptions.replaceChildren(...children);
};
const refreshOptions = async () => {
  try {
    const response = await fetch(${JSON.stringify(endpoint)} + "?options=1");
    if (!response.ok) return;
    const options = await response.json();
    models = options.models;
    defaultModelName = options.defaultModel;
    const restoredModel = selectedModel === undefined
      ? undefined
      : models.find((model) => model.id === selectedModel.id && model.providerID === selectedModel.providerID);
    if (selectedModel !== undefined && restoredModel === undefined) {
      selectedModel = undefined;
      localStorage.removeItem("vite-opencode-picker:model");
    }
    if (restoredModel !== undefined) modelTriggerLabel.textContent = restoredModel.name;
    else
      modelTriggerLabel.textContent = defaultModelName ? "Default (" + defaultModelName + ")" : "Default model";
    renderModelOptions();
  } catch {}
};

const toggleRequestMode = () => {
  requestMode = requestMode === "direct" ? "designs" : "direct";
  localStorage.setItem("vite-opencode-picker:mode", requestMode);
  modeTrigger.dataset.mode = requestMode;
  modeTrigger.textContent = requestMode === "designs" ? "3 approaches" : "Direct";
  modeTrigger.setAttribute("aria-pressed", String(requestMode === "designs"));
};
modeTrigger.addEventListener("click", toggleRequestMode);
modelTrigger.addEventListener("click", () => {
  if (modelMenu.classList.contains("open")) {
    closeModelMenu();
    return;
  }
  clearTimeout(modelCloseTimer);
  modelMenu.classList.remove("closing");
  modelSearch.value = "";
  renderModelOptions();
  placeModelMenu();
  modelMenu.classList.add("open");
  modelTrigger.setAttribute("aria-expanded", "true");
  modelSearch.focus();
});
modelSearch.addEventListener("input", renderModelOptions);
modelSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.preventDefault();
});
root.addEventListener("pointerdown", (event) => {
  const path = event.composedPath();
  if (modelMenu.classList.contains("open") && !path.includes(modelMenu) && !path.includes(modelTrigger)) {
    closeModelMenu();
  }
});
textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey)
    form.requestSubmit();
});
textarea.addEventListener("input", () => {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
});
window.addEventListener("keydown", (event) => {
  if (
    dialog.classList.contains("open") &&
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.code === "KeyD"
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleRequestMode();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyD") {
    event.preventDefault();
    event.stopImmediatePropagation();
    const designSession =
      sessions.find(
        (session) =>
          session.id === activeDesignSessionID &&
          session.mode === "designs" &&
          session.status === "completed",
      ) ??
      sessions.find(
        (session) => session.mode === "designs" && session.status === "completed",
      );
    if (!designSession) {
      toggleRequestMode();
      return;
    }
    const variants = ["original", "design-1", "design-2", "design-3"];
    const current = variants.indexOf(designSession.selectedDesign || "original");
    designSession.selectedDesign = variants[(current + 1) % variants.length];
    activeDesignSessionID = designSession.id;
    persistSessions();
    renderSessions();
    window.dispatchEvent(new CustomEvent("vite-opencode-picker:design-change", {
      detail: { sessionID: designSession.id, design: designSession.selectedDesign },
    }));
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyK") {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActive(!active);
  }
  if (event.key === "Escape") {
    if (!active && !dialog.classList.contains("open") && !refiningSessionID) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (modelMenu.classList.contains("open")) {
      closeModelMenu();
      textarea.focus();
    } else active ? setActive(false) : close();
  }
}, true);
window.addEventListener("pointermove", (event) => {
  if (!active || !(event.target instanceof Element) || event.target.closest("[data-opencode-picker-ui]")) return;
  pickerCursor.style.left = event.clientX + "px";
  pickerCursor.style.top = event.clientY + "px";
  highlight(event.target);
}, true);
window.addEventListener("scroll", () => {
  if (selectedElement) highlight(selectedElement);
}, true);
window.addEventListener("resize", () => {
  if (selectedElement) highlight(selectedElement);
  if (modelMenu.classList.contains("open")) placeModelMenu();
  renderSessions();
  persistSessions();
});
window.addEventListener("pointerdown", (event) => {
  suppressClick = false;
  if (!active || !(event.target instanceof Element) || event.target.closest("[data-opencode-picker-ui]")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  suppressClick = true;
  const source = marker(event.target);
  if (!source) {
    console.warn("OpenCode picker: no source marker found for selected element");
    return;
  }
  selected = { source, element: describe(event.target) };
  selectedElement = event.target;
  setActive(false);
  highlight(event.target);
  placeDialog(event.target);
  dialog.classList.add("open");
  textarea.focus();
}, true);
window.addEventListener("pointercancel", () => suppressClick = false, true);
window.addEventListener("click", (event) => {
  if (!suppressClick) return;
  suppressClick = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected) return;
  const submit = form.querySelector('[type="submit"]');
  const comment = textarea.value;
  const composerRect = dialog.getBoundingClientRect();
  submit.disabled = true;
  status.textContent = "Creating session...";
  try {
    const response = await fetch(${JSON.stringify(endpoint)}, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...selected,
        comment,
        model: selectedModel,
        mode: requestMode,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "OpenCode request failed");
    sessions = [{
      id: result.sessionID,
      source: selected.source,
      summary: selected.element.text || selected.element.description || selected.element.tag,
      comment,
      position: { left: composerRect.left, top: composerRect.top },
      mode: requestMode,
      ...(requestMode === "designs" ? { selectedDesign: "original" } : {}),
      status: "running",
    }, ...sessions];
    persistSessions();
    renderSessions();
    morphComposerToSession(result.sessionID, composerRect);
    void refreshOptions();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    submit.disabled = false;
  }
});
renderSessions();
persistSessions();
void refreshSessions();
void refreshOptions();
setInterval(refreshSessions, 1500);
`;

export const viteOpenCodePicker = (options: OpenCodePickerOptions = {}): PickerPlugin => {
  let workspaceRoot = "";
  let endpoint = "/__vite_opencode_picker";
  const sessions = new Map<
    string,
    {
      readonly id: string;
      readonly source: string;
      readonly summary: string;
      readonly mode: "direct" | "designs";
      readonly status: "running" | "completed" | "accepted" | "failed" | "interrupted" | "reverted";
      readonly error?: string;
    }
  >();

  const plugin: PickerPlugin = {
    name: "vite-opencode-picker",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      workspaceRoot = options.workspaceRoot ?? findWorkspaceRoot(config.root);
      endpoint = `${config.base.replace(/\/$/, "")}/__vite_opencode_picker`;
    },
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : undefined;
    },
    load(id) {
      return id === resolvedVirtualId ? clientModule(endpoint) : undefined;
    },
    transformIndexHtml: {
      order: "post",
      handler() {
        return [
          {
            tag: "script",
            attrs: {
              type: "module",
              src: `${endpoint.slice(0, -"__vite_opencode_picker".length)}@id/__x00__${virtualId}`,
            },
            injectTo: "body",
          },
        ];
      },
    },
    async transform(code, id) {
      const file = id.split("?", 1)[0];
      if (
        file === undefined ||
        !/\.[jt]sx$/.test(file) ||
        file.includes(`${sep}node_modules${sep}`)
      )
        return;
      const source = relative(workspaceRoot, file).replaceAll(sep, "/");
      if (source.startsWith("../")) return;
      const result = await transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: { plugins: ["jsx", "typescript"] } satisfies TransformOptions["parserOpts"],
        generatorOpts: { retainLines: true },
        plugins: [sourceMarkerPlugin(source)],
      });
      return result?.code == null
        ? undefined
        : { code: result.code, map: result.map == null ? null : JSON.stringify(result.map) };
    },
    configureServer(server) {
      server.middlewares.use(endpoint, (request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET") {
          if (requestUrl.searchParams.has("options")) {
            void (async () => {
              try {
                const service = await Service.discover();
                if (service === undefined)
                  throw new Error("No running OpenCode V2 service could be discovered");
                const client = OpenCode.make({
                  baseUrl: service.url,
                  headers: Service.headers(
                    service.auth === undefined
                      ? { url: service.url }
                      : { url: service.url, auth: service.auth },
                  ),
                });
                const [availableModels, defaultModel] = await Promise.all([
                  client.model.list({ location: { directory: workspaceRoot } }),
                  client.model.default({ location: { directory: workspaceRoot } }),
                ]);
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({
                    models: availableModels.data
                      .filter((model) => model.enabled)
                      .map((model) => ({
                        id: model.id,
                        providerID: model.providerID,
                        name: model.name,
                      })),
                    defaultModel: defaultModel.data?.name,
                  }),
                );
              } catch (error) {
                response.statusCode = 500;
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                );
              }
            })();
            return;
          }
          const recover = (requestUrl.searchParams.get("recover") ?? "")
            .split(",")
            .filter((id) => /^ses/.test(id))
            .slice(0, 50);
          if (recover.length > 0) {
            void (async () => {
              try {
                const statuses: Record<string, string> = {};
                const unresolved = recover.filter((id) => {
                  const tracked = sessions.get(id);
                  if (
                    tracked !== undefined &&
                    tracked.status !== "running" &&
                    tracked.status !== "interrupted" &&
                    tracked.status !== "failed" &&
                    tracked.status !== "completed"
                  ) {
                    statuses[id] = tracked.status;
                    return false;
                  }
                  return true;
                });
                if (unresolved.length > 0) {
                  const service = await Service.discover();
                  if (service === undefined)
                    throw new Error("No running OpenCode V2 service could be discovered");
                  const client = OpenCode.make({
                    baseUrl: service.url,
                    headers: Service.headers(
                      service.auth === undefined
                        ? { url: service.url }
                        : { url: service.url, auth: service.auth },
                    ),
                  });
                  const active = await client.session.active();
                  await Promise.all(
                    unresolved.map(async (sessionID) => {
                      if (sessionID in active) {
                        statuses[sessionID] = "running";
                        return;
                      }
                      const session = await client.session
                        .get({ sessionID })
                        .catch(() => undefined);
                      const tracked = sessions.get(sessionID);
                      const status =
                        session?.outcome === "succeeded"
                          ? "completed"
                          : session?.outcome === "interrupted"
                            ? "interrupted"
                            : session?.outcome === "failed"
                              ? "failed"
                              : (tracked?.status ?? "running");
                      statuses[sessionID] = status;
                      if (tracked !== undefined) sessions.set(sessionID, { ...tracked, status });
                    }),
                  );
                }
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({
                    sessions: [...sessions.values()].reverse(),
                    statuses,
                  }),
                );
              } catch (error) {
                response.statusCode = 500;
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                );
              }
            })();
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ sessions: [...sessions.values()].reverse(), statuses: {} }),
          );
          return;
        }
        const designSessionID = requestUrl.searchParams.get("selectDesign");
        if (request.method === "POST" && designSessionID !== null) {
          let designBody = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            designBody += chunk;
            if (designBody.length > 16_000) request.destroy();
          });
          request.on("end", () => {
            void (async () => {
              try {
                const input: unknown = JSON.parse(designBody);
                if (
                  typeof input !== "object" ||
                  input === null ||
                  !("design" in input) ||
                  typeof input.design !== "string" ||
                  input.design.trim() === ""
                )
                  throw new Error("Invalid design selection");
                const design = input.design.trim();
                const previous = sessions.get(designSessionID);
                const source =
                  previous?.source ??
                  ("source" in input && typeof input.source === "string"
                    ? input.source
                    : "Design experiment");
                const summary =
                  previous?.summary ??
                  ("summary" in input && typeof input.summary === "string"
                    ? input.summary
                    : design);
                const service = await Service.discover();
                if (service === undefined)
                  throw new Error("No running OpenCode V2 service could be discovered");
                const client = OpenCode.make({
                  baseUrl: service.url,
                  headers: Service.headers(
                    service.auth === undefined
                      ? { url: service.url }
                      : { url: service.url, auth: service.auth },
                  ),
                });
                sessions.set(designSessionID, {
                  id: designSessionID,
                  source,
                  summary,
                  mode: "designs",
                  status: "running",
                });
                try {
                  await client.session.prompt({
                    sessionID: designSessionID,
                    text: `The user selected this approach: ${design}\n\nKeep and finish only the selected approach. Remove every alternative implementation and the vite-opencode-picker:design-change event listener. Make the selected implementation production-ready and leave no experiment scaffolding behind. This ends the three-approach experiment: treat every subsequent user prompt as a direct modification to the finalized implementation, not as a request to alter or recreate the alternatives.`,
                  });
                  await client.session.wait({ sessionID: designSessionID });
                  const finished = await client.session.get({ sessionID: designSessionID });
                  const finalStatus =
                    finished.outcome === "succeeded"
                      ? "accepted"
                      : finished.outcome === "interrupted"
                        ? "interrupted"
                        : "failed";
                  sessions.set(designSessionID, {
                    id: designSessionID,
                    source,
                    summary,
                    mode: finalStatus === "accepted" ? "direct" : "designs",
                    status: finalStatus,
                  });
                  response.statusCode = finalStatus === "accepted" ? 200 : 409;
                  response.setHeader("content-type", "application/json");
                  response.end(
                    JSON.stringify(
                      finalStatus === "accepted"
                        ? { ok: true, status: finalStatus }
                        : { error: "Session was interrupted", status: finalStatus },
                    ),
                  );
                } catch (error) {
                  const finished = await client.session
                    .get({ sessionID: designSessionID })
                    .catch(() => undefined);
                  const finalStatus =
                    finished?.outcome === "interrupted" ? "interrupted" : "failed";
                  sessions.set(designSessionID, {
                    id: designSessionID,
                    source,
                    summary,
                    mode: "designs",
                    status: finalStatus,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  response.statusCode = 500;
                  response.setHeader("content-type", "application/json");
                  response.end(
                    JSON.stringify({
                      error: error instanceof Error ? error.message : String(error),
                      status: finalStatus,
                    }),
                  );
                }
              } catch (error) {
                response.statusCode = 500;
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                );
              }
            })();
          });
          return;
        }
        const refineSessionID = requestUrl.searchParams.get("refine");
        if (request.method === "POST" && refineSessionID !== null) {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 64_000) request.destroy();
          });
          request.on("end", () => {
            void (async () => {
              try {
                const input: unknown = JSON.parse(body);
                if (
                  typeof input !== "object" ||
                  input === null ||
                  !("comment" in input) ||
                  typeof input.comment !== "string" ||
                  input.comment.trim() === "" ||
                  !("source" in input) ||
                  typeof input.source !== "string" ||
                  !("summary" in input) ||
                  typeof input.summary !== "string"
                )
                  throw new Error("Invalid refinement request");
                const comment = input.comment.trim();
                const requestedMode =
                  "mode" in input && input.mode === "designs" ? "designs" : "direct";
                const existing = sessions.get(refineSessionID);
                const mode =
                  existing?.status === "accepted" ? "direct" : (existing?.mode ?? requestedMode);
                const selectedDesign =
                  "selectedDesign" in input && typeof input.selectedDesign === "string"
                    ? input.selectedDesign
                    : "original";
                const tracked = existing ?? {
                  id: refineSessionID,
                  source: input.source,
                  summary: input.summary,
                  mode,
                  status: "completed" as const,
                };
                const service = await Service.discover();
                if (service === undefined)
                  throw new Error("No running OpenCode V2 service could be discovered");
                const client = OpenCode.make({
                  baseUrl: service.url,
                  headers: Service.headers(
                    service.auth === undefined ? { url: service.url } : service,
                  ),
                });
                sessions.set(refineSessionID, { ...tracked, status: "running" });
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ status: "running" }));
                void (async () => {
                  try {
                    await client.session.prompt({
                      sessionID: refineSessionID,
                      text:
                        mode === "designs"
                          ? `Refine the existing three-approach UI experiment based on this follow-up feedback. Preserve the pre-change Original exactly and keep three meaningfully distinct alternatives plus the existing vite-opencode-picker:design-change listener and session filtering. Do not finalize an approach or remove the experiment controls. The currently previewed approach is ${selectedDesign}. Apply the feedback to the relevant alternatives, keeping all four options usable and switchable.\n\nFollow-up feedback: ${comment}\n\nMinimize time to completion: implement first, then run necessary time-consuming verification once at the end.`
                          : `Refine your existing implementation for this UI picker request based on the follow-up feedback below. Modify only the scoped work from this session and preserve unrelated or concurrent changes.\n\nFollow-up feedback: ${comment}\n\nMinimize time to completion: implement first, then run necessary time-consuming verification once at the end.`,
                    });
                    await client.session.wait({ sessionID: refineSessionID });
                    const finished = await client.session.get({ sessionID: refineSessionID });
                    const status =
                      finished.outcome === "succeeded"
                        ? "completed"
                        : finished.outcome === "interrupted"
                          ? "interrupted"
                          : finished.outcome === "failed"
                            ? "failed"
                            : "running";
                    sessions.set(refineSessionID, { ...tracked, status });
                  } catch (error) {
                    sessions.set(refineSessionID, {
                      ...tracked,
                      status: "failed",
                      error: error instanceof Error ? error.message : String(error),
                    });
                  }
                })();
              } catch (error) {
                response.statusCode = 500;
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                );
              }
            })();
          });
          return;
        }
        const changeSessionID = requestUrl.searchParams.get("change");
        if (request.method === "POST" && changeSessionID !== null) {
          void (async () => {
            const tracked = sessions.get(changeSessionID);
            try {
              const requestedState = requestUrl.searchParams.get("state");
              if (requestedState !== "completed" && requestedState !== "reverted")
                throw new Error("Only completed or reverted picker sessions can be toggled");
              const service = await Service.discover();
              if (service === undefined)
                throw new Error("No running OpenCode V2 service could be discovered");
              const client = OpenCode.make({
                baseUrl: service.url,
                headers: Service.headers(
                  service.auth === undefined ? { url: service.url } : service,
                ),
              });
              const nextStatus = requestedState === "completed" ? "reverted" : "completed";
              const task = tracked
                ? `${tracked.summary} in ${tracked.source}`
                : "the UI picker feedback from this session";
              if (tracked !== undefined)
                sessions.set(changeSessionID, { ...tracked, status: "running" });
              await client.session.prompt({
                sessionID: changeSessionID,
                text:
                  requestedState === "completed"
                    ? `Undo only the changes you made for ${task}. Work from the current files and carefully remove only your implementation for this picker request. Preserve every unrelated change, including concurrent edits made before or after your work. Do not use session, history, Git, or whole-file revert/restore commands. Keep the current working tree intact apart from the specific changes you introduced.`
                    : `Reapply only the changes you previously made for ${task} and then undid. Work from the current files and preserve every unrelated or concurrent change. Do not use session, history, Git, or whole-file revert/restore commands. Reintroduce only the scoped implementation for this picker request.`,
              });
              await client.session.wait({ sessionID: changeSessionID });
              const finished = await client.session.get({ sessionID: changeSessionID });
              const finalStatus =
                finished.outcome === "succeeded"
                  ? nextStatus
                  : finished.outcome === "interrupted"
                    ? "interrupted"
                    : finished.outcome === "failed"
                      ? "failed"
                      : "running";
              if (tracked !== undefined)
                sessions.set(changeSessionID, {
                  ...tracked,
                  mode:
                    tracked.mode === "designs" && finalStatus === nextStatus
                      ? "direct"
                      : tracked.mode,
                  status: finalStatus,
                });
              response.statusCode = finalStatus === nextStatus ? 200 : 409;
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify(
                  finalStatus === nextStatus
                    ? { status: finalStatus }
                    : { error: `Session ${finalStatus}`, status: finalStatus },
                ),
              );
            } catch (error) {
              if (tracked !== undefined && sessions.get(changeSessionID)?.status === "running")
                sessions.set(changeSessionID, {
                  ...tracked,
                  status: "failed",
                  error: error instanceof Error ? error.message : String(error),
                });
              response.statusCode = 500;
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            }
          })();
          return;
        }
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end();
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64_000) request.destroy();
        });
        request.on("end", () => {
          void (async () => {
            try {
              const input: unknown = JSON.parse(body);
              if (
                typeof input !== "object" ||
                input === null ||
                !("source" in input) ||
                typeof input.source !== "string" ||
                !("comment" in input) ||
                typeof input.comment !== "string" ||
                input.comment.trim() === "" ||
                !("element" in input)
              )
                throw new Error("Invalid picker request");
              const source = input.source;
              const comment = input.comment.trim();
              const element = input.element;
              const mode = "mode" in input && input.mode === "designs" ? "designs" : "direct";
              const requestedModel = (() => {
                if (!("model" in input) || typeof input.model !== "object" || input.model === null)
                  return undefined;
                if (
                  !("id" in input.model) ||
                  typeof input.model.id !== "string" ||
                  !("providerID" in input.model) ||
                  typeof input.model.providerID !== "string"
                )
                  throw new Error("Invalid model selection");
                return { id: input.model.id, providerID: input.model.providerID };
              })();
              const summary = (() => {
                if (typeof element !== "object" || element === null) return "Selected element";
                if ("text" in element && typeof element.text === "string" && element.text !== "")
                  return element.text;
                if (
                  "description" in element &&
                  typeof element.description === "string" &&
                  element.description !== ""
                )
                  return element.description;
                return "Selected element";
              })();
              const selectedDescription =
                typeof element === "object" &&
                element !== null &&
                "description" in element &&
                typeof element.description === "string"
                  ? element.description
                  : "Selected element";
              const selectedContent =
                typeof element === "object" &&
                element !== null &&
                "text" in element &&
                typeof element.text === "string"
                  ? element.text
                  : "No notable text content";
              const selectedMetadata = JSON.stringify(
                typeof element === "object" && element !== null
                  ? {
                      tag:
                        "tag" in element && typeof element.tag === "string"
                          ? element.tag
                          : undefined,
                      id:
                        "id" in element && typeof element.id === "string" ? element.id : undefined,
                      role:
                        "role" in element && typeof element.role === "string"
                          ? element.role
                          : undefined,
                      classes:
                        "classes" in element && Array.isArray(element.classes)
                          ? element.classes
                          : undefined,
                    }
                  : {},
                null,
                2,
              );
              const match = /^(.*):(\d+)$/.exec(source);
              if (match === null || match[1] === undefined)
                throw new Error("Invalid source marker");
              const sourcePath = match[1];
              const file = resolve(workspaceRoot, sourcePath);
              if (!file.startsWith(`${workspaceRoot}${sep}`) || !existsSync(file))
                throw new Error("The selected source file could not be resolved");

              const service = await Service.discover();
              if (service === undefined)
                throw new Error("No running OpenCode V2 service could be discovered");
              const client = OpenCode.make({
                baseUrl: service.url,
                headers: Service.headers(
                  service.auth === undefined
                    ? { url: service.url }
                    : { url: service.url, auth: service.auth },
                ),
              });
              const promptSkills =
                options.skills === undefined || options.skills.length === 0
                  ? []
                  : (await client.skill.list({ location: { directory: workspaceRoot } })).data
                      .filter((skill) => options.skills?.includes(skill.id))
                      .map((skill) => ({ id: skill.id }));
              const session = await client.session.create({
                title: `UI feedback: ${sourcePath}`,
                agent: options.agent ?? "build",
                location: { directory: workspaceRoot },
                ...(requestedModel === undefined ? {} : { model: requestedModel }),
              });
              for (const skill of promptSkills)
                await client.session.skill({
                  sessionID: session.id,
                  skill: skill.id,
                  resume: false,
                });
              const executionPriority =
                "Minimize time to completion: make the focused change first and defer time-consuming verification such as full typechecks, builds, or broad test suites until the implementation is complete. Run the necessary final checks once at the end; use earlier targeted checks only when needed to unblock the implementation.";
              const prompt =
                mode === "designs"
                  ? `The selected DOM element boundary is the authoritative target. Address the selected element or container as a whole; headings and other descendants listed below are context, not automatically the sole target. If feedback concerns copy in a container, consider all notable copy in that selected container rather than changing only its heading.\n\nPreserve the current implementation exactly as the original option, then address this exact UI feedback in three meaningfully distinct, narrowly scoped ways. Implement three alternatives that are each observably and materially different from the original and from one another; an unchanged or near-identical implementation never counts as an alternative. Match the kind of variation to the request: if the feedback is about copy, provide three genuinely different wording approaches without redesigning unrelated visuals; if it is about behavior, provide three distinct interactions; use visual alternatives only when the feedback is visual. Do not broaden the task beyond the comment. Do not add any switcher, Accept, Apply, or Finalize UI; the Vite plugin provides that UI. Default to original. Add a browser listener for vite-opencode-picker:design-change, ignore events whose detail.sessionID is not ${JSON.stringify(session.id)}, and switch the rendered implementation according to detail.design: original, design-1, design-2, or design-3. The original must reproduce the pre-change behavior and appearance exactly. Keep the listener, original, and all three alternatives until a follow-up message identifies the selected approach. Ensure the app remains usable while the plugin switches among variants.\n\n${executionPriority}\n\nFeedback: ${comment}\nSelected element: ${selectedDescription}\nSelected content overview: ${selectedContent}\nSource: ${source}\nSelected element metadata: ${selectedMetadata}`
                  : `Implement this UI feedback for the selected DOM element. The selected DOM element boundary is the authoritative target: address the selected element or container as a whole. Headings and other descendants listed below are context, not automatically the sole target. If feedback concerns copy in a container, consider all notable copy in that selected container rather than changing only its heading.\n\n${executionPriority}\n\nFeedback: ${comment}\nSelected element: ${selectedDescription}\nSelected content overview: ${selectedContent}\nSource: ${source}\nSelected element metadata: ${selectedMetadata}`;
              sessions.set(session.id, {
                id: session.id,
                source,
                summary,
                mode,
                status: "running",
              });
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ sessionID: session.id }));
              void (async () => {
                try {
                  await client.session.prompt({
                    sessionID: session.id,
                    text: prompt,
                    skills: promptSkills,
                    files: [
                      {
                        uri: pathToFileURL(file).href,
                        name: sourcePath,
                        description: `Source file for the selected element at line ${match[2]}`,
                      },
                    ],
                  });
                  await client.session.wait({ sessionID: session.id });
                  const finished = await client.session.get({ sessionID: session.id });
                  sessions.set(session.id, {
                    id: session.id,
                    source,
                    summary,
                    mode,
                    status:
                      finished.outcome === "succeeded"
                        ? "completed"
                        : finished.outcome === "interrupted"
                          ? "interrupted"
                          : "failed",
                  });
                } catch (error) {
                  const finished = await client.session
                    .get({ sessionID: session.id })
                    .catch(() => undefined);
                  sessions.set(session.id, {
                    id: session.id,
                    source,
                    summary,
                    mode,
                    status: finished?.outcome === "interrupted" ? "interrupted" : "failed",
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })();
            } catch (error) {
              response.statusCode = 500;
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            }
          })();
        });
      });
    },
  };
  return plugin satisfies Plugin;
};

export default viteOpenCodePicker;
