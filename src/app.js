const { invoke } = window.__TAURI__.core;

const state = {
  analysis: null,
  currentView: "overview",
  selectedNode: null,
  graph: {
    scale: 1,
    tx: 0,
    ty: 0,
    positions: new Map(),
    visibleIds: new Set(),
    draggingNode: null,
    panning: false,
    pointerStart: null,
  },
};

const LANG_COLORS = {
  Rust: "#f39a72",
  Python: "#5ea6ff",
  JavaScript: "#f2d45c",
  TypeScript: "#6d9cff",
  JSX: "#61d9ef",
  TSX: "#77a8ff",
  C: "#83a7ff",
  "C++": "#a98cff",
  "C/C++ Header": "#8f7dff",
  PHP: "#9b93e7",
  HTML: "#ff775f",
  CSS: "#6b91ff",
  SCSS: "#ef72ae",
  JSON: "#b4ba68",
  TOML: "#d58b64",
  YAML: "#d8687d",
  Markdown: "#69b7ff",
  Java: "#f0a15b",
  Kotlin: "#b36cff",
  Go: "#5dd8e6",
  "C#": "#7bc96f",
  Shell: "#72d98e",
  SQL: "#e6a45d",
  Vue: "#58d4a3",
  Svelte: "#ff735e",
  XML: "#d5a55a",
  SVG: "#f7a546",
  Text: "#8c96aa",
  Config: "#9fa7b8",
  Build: "#de8bff",
  Lockfile: "#7b8497",
};

const els = {
  openProject: document.querySelector("#open-project"),
  emptyOpen: document.querySelector("#empty-open"),
  rescan: document.querySelector("#rescan"),
  openFolder: document.querySelector("#open-folder"),
  openVscode: document.querySelector("#open-vscode"),
  exportReport: document.querySelector("#export-report"),
  scanPill: document.querySelector("#scan-pill"),
  pageTitle: document.querySelector("#page-title"),
  emptyState: document.querySelector("#empty-state"),
  content: document.querySelector("#content"),
  sidebarProject: document.querySelector("#sidebar-project"),
  sidebarPath: document.querySelector("#sidebar-path"),
  statGrid: document.querySelector("#stat-grid"),
  languageList: document.querySelector("#language-list"),
  languageDonut: document.querySelector("#language-donut"),
  donutValue: document.querySelector("#donut-value"),
  languageCount: document.querySelector("#language-count"),
  healthList: document.querySelector("#health-list"),
  hotspotList: document.querySelector("#hotspot-list"),
  recentCommits: document.querySelector("#recent-commits"),
  graphSearch: document.querySelector("#graph-search"),
  graphLanguage: document.querySelector("#graph-language"),
  graphSummary: document.querySelector("#graph-summary"),
  graphFit: document.querySelector("#graph-fit"),
  graphSvg: document.querySelector("#graph-svg"),
  graphViewport: document.querySelector("#graph-viewport"),
  graphEdges: document.querySelector("#graph-edges"),
  graphNodes: document.querySelector("#graph-nodes"),
  graphLimitNote: document.querySelector("#graph-limit-note"),
  nodeInspector: document.querySelector("#node-inspector"),
  fileSearch: document.querySelector("#file-search"),
  fileLanguage: document.querySelector("#file-language"),
  fileTableBody: document.querySelector("#file-table-body"),
  fileHeadingCount: document.querySelector("#file-heading-count"),
  previewName: document.querySelector("#preview-name"),
  previewMeta: document.querySelector("#preview-meta"),
  codePreview: document.querySelector("#code-preview code"),
  todoSearch: document.querySelector("#todo-search"),
  todoList: document.querySelector("#todo-list"),
  gitBanner: document.querySelector("#git-banner"),
  gitCommits: document.querySelector("#git-commits"),
  toastContainer: document.querySelector("#toast-container"),
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString();
}

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function colorFor(language) {
  return LANG_COLORS[language] || "#8d96aa";
}

function setScanStatus(kind, text) {
  els.scanPill.className = `status-pill ${kind}`;
  els.scanPill.innerHTML = `<span class="dot"></span><span>${escapeHtml(text)}</span>`;
}

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  els.toastContainer.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(7px)";
    setTimeout(() => node.remove(), 220);
  }, 3500);
}

async function openProject() {
  try {
    const path = await invoke("pick_project");
    if (!path) return;
    await scan(path);
  } catch (error) {
    toast(String(error), "bad");
  }
}

async function scan(path) {
  setScanStatus("scanning", "Scanning…");
  [els.rescan, els.openFolder, els.openVscode, els.exportReport].forEach(button => button.disabled = true);

  try {
    const analysis = await invoke("scan_project", { path });
    state.analysis = analysis;
    state.selectedNode = null;
    state.graph.positions.clear();
    els.emptyState.classList.add("hidden");
    els.content.classList.remove("hidden");
    els.sidebarProject.textContent = analysis.projectName;
    els.sidebarPath.textContent = analysis.projectPath;
    [els.rescan, els.openFolder, els.openVscode, els.exportReport].forEach(button => button.disabled = false);
    setScanStatus("ready", "Ready");
    renderAll();
    toast(`Scanned ${analysis.stats.fileCount} source files.`, "good");
  } catch (error) {
    setScanStatus("error", "Scan failed");
    toast(String(error), "bad");
  }
}

function renderAll() {
  populateLanguageFilters();
  renderOverview();
  renderFiles();
  renderTodos();
  renderGit();
  renderGraph();
  showView(state.currentView);
}

function populateLanguageFilters() {
  const options = [`<option value="all">All languages</option>`]
    .concat(state.analysis.languages.map(item => `<option value="${escapeHtml(item.language)}">${escapeHtml(item.language)}</option>`))
    .join("");
  els.graphLanguage.innerHTML = options;
  els.fileLanguage.innerHTML = options;
}

function renderOverview() {
  const a = state.analysis;
  const s = a.stats;
  const gitDetail = a.git.available ? (a.git.isRepo ? `${a.git.dirtyFiles} changed file${a.git.dirtyFiles === 1 ? "" : "s"}` : "Not a Git repository") : "Git not installed";

  const cards = [
    ["Source files", fmtNumber(s.fileCount), `${a.languages.length} detected languages`],
    ["Lines", fmtNumber(s.totalLines), "Across readable source files"],
    ["Connections", fmtNumber(s.edgeCount), "Internal imports / includes"],
    ["TODOs", fmtNumber(s.todoCount), "TODO · FIXME · HACK · XXX"],
    ["Git branch", a.git.isRepo ? (a.git.branch || "detached") : "—", gitDetail],
  ];

  els.statGrid.innerHTML = cards.map(([label, value, detail]) => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      <div class="stat-detail">${escapeHtml(detail)}</div>
    </div>
  `).join("");

  const topLanguages = a.languages.slice(0, 7);
  els.languageCount.textContent = `${a.languages.length} languages`;
  els.donutValue.textContent = fmtNumber(s.fileCount);

  const gradient = [];
  let cursor = 0;
  for (const lang of topLanguages) {
    const start = cursor;
    cursor += lang.percent;
    gradient.push(`${colorFor(lang.language)} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`);
  }
  if (cursor < 100) gradient.push(`#262c3b ${cursor.toFixed(2)}% 100%`);
  els.languageDonut.style.background = `conic-gradient(${gradient.join(",")})`;

  els.languageList.innerHTML = topLanguages.map(lang => `
    <div class="lang-row">
      <div class="lang-name"><span class="lang-dot" style="background:${colorFor(lang.language)}"></span><span>${escapeHtml(lang.language)}</span></div>
      <div class="lang-bar"><i style="width:${Math.max(2, lang.percent)}%;background:${colorFor(lang.language)}"></i></div>
      <div class="lang-percent">${lang.percent.toFixed(1)}%</div>
    </div>
  `).join("") || `<div class="empty-inline">No source languages detected.</div>`;

  const health = [
    ["◇", "Largest file", s.largestFile || "None", fmtBytes(s.largestSize)],
    ["⌘", "Dependency density", `${s.edgeCount} internal links`, s.fileCount ? (s.edgeCount / s.fileCount).toFixed(2) : "0.00"],
    ["✓", "Code notes", `${s.todoCount} markers found`, s.todoCount === 0 ? "Clean" : "Review"],
    ["⑂", "Git status", a.git.isRepo ? (a.git.branch || "Detached HEAD") : "Not a repo", a.git.isRepo ? `${a.git.dirtyFiles} changed` : "—"],
  ];
  els.healthList.innerHTML = health.map(([icon, title, text, value]) => `
    <div class="health-row">
      <div class="health-icon">${icon}</div>
      <div class="health-main"><b>${escapeHtml(title)}</b><span>${escapeHtml(text)}</span></div>
      <div class="health-value">${escapeHtml(value)}</div>
    </div>
  `).join("");

  const degrees = new Map(a.files.map(file => [file.id, 0]));
  for (const edge of a.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }
  const hotspots = [...a.files]
    .map(file => ({ file, degree: degrees.get(file.id) || 0 }))
    .sort((x, y) => y.degree - x.degree || y.file.lines - x.file.lines)
    .slice(0, 6);

  els.hotspotList.innerHTML = hotspots.map((item, index) => `
    <div class="rank-row" data-file-id="${item.file.id}">
      <div class="rank-number">${String(index + 1).padStart(2, "0")}</div>
      <div class="rank-path" title="${escapeHtml(item.file.path)}">${escapeHtml(item.file.path)}</div>
      <div class="rank-meta">${item.degree} links</div>
    </div>
  `).join("") || `<div class="empty-inline">No files to rank yet.</div>`;

  renderCommitList(els.recentCommits, a.git.commits.slice(0, 5));
}

function renderCommitList(container, commits) {
  if (!state.analysis.git.available) {
    container.innerHTML = `<div class="empty-inline">Git is not installed or not available in PATH.</div>`;
    return;
  }
  if (!state.analysis.git.isRepo) {
    container.innerHTML = `<div class="empty-inline">This folder is not a Git repository.</div>`;
    return;
  }
  if (!commits.length) {
    container.innerHTML = `<div class="empty-inline">No commits found.</div>`;
    return;
  }
  container.innerHTML = commits.map(commit => `
    <div class="commit-row">
      <div class="commit-hash">${escapeHtml(commit.shortHash)}</div>
      <div><div class="commit-subject" title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</div><div class="commit-author">${escapeHtml(commit.author)}</div></div>
      <div class="commit-time">${escapeHtml(commit.relativeTime)}</div>
    </div>
  `).join("");
}

function renderFiles() {
  if (!state.analysis) return;
  const query = els.fileSearch.value.trim().toLowerCase();
  const language = els.fileLanguage.value;
  const files = state.analysis.files.filter(file => {
    const queryOk = !query || file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query);
    const languageOk = language === "all" || file.language === language;
    return queryOk && languageOk;
  });

  els.fileHeadingCount.textContent = `${fmtNumber(files.length)} file${files.length === 1 ? "" : "s"}`;
  els.fileTableBody.innerHTML = files.map(file => `
    <tr data-file-id="${file.id}">
      <td class="file-path-cell">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-path-muted">${escapeHtml(file.path)}</div>
      </td>
      <td><span class="lang-pill"><i style="background:${colorFor(file.language)}"></i>${escapeHtml(file.language)}</span></td>
      <td>${fmtNumber(file.lines)}</td>
      <td>${fmtBytes(file.size)}</td>
    </tr>
  `).join("") || `<tr><td colspan="4"><div class="empty-inline">No files match your filters.</div></td></tr>`;
}

async function previewFile(file) {
  if (!state.analysis || !file) return;
  els.previewName.textContent = file.name;
  els.previewMeta.textContent = `${file.language} · ${fmtNumber(file.lines)} lines · ${fmtBytes(file.size)}`;
  els.codePreview.textContent = "Loading…";
  try {
    const preview = await invoke("read_file", {
      projectPath: state.analysis.projectPath,
      relativePath: file.path,
    });
    els.codePreview.textContent = `${preview.content}${preview.truncated ? "\n\n… preview truncated …" : ""}`;
  } catch (error) {
    els.codePreview.textContent = `Could not preview this file.\n\n${error}`;
  }
}

function renderTodos() {
  if (!state.analysis) return;
  const query = els.todoSearch.value.trim().toLowerCase();
  const items = state.analysis.todos.filter(item => !query || `${item.kind} ${item.path} ${item.text}`.toLowerCase().includes(query));

  els.todoList.innerHTML = items.map(item => `
    <div class="todo-row">
      <div><span class="todo-kind ${item.kind.toLowerCase()}">${escapeHtml(item.kind)}</span></div>
      <div class="todo-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</div>
      <div class="todo-line">L${item.line}</div>
      <div class="todo-text" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</div>
    </div>
  `).join("") || `<div class="empty-inline">${query ? "No code notes match your search." : "No TODO, FIXME, HACK or XXX markers found."}</div>`;
}

function renderGit() {
  const git = state.analysis.git;
  if (!git.available) {
    els.gitBanner.innerHTML = `<div class="git-icon">⑂</div><div class="git-banner-main"><div class="eyebrow">GIT</div><h3>Git is not available</h3><div class="subtle">Install Git and make sure it is available in PATH to enable repository history.</div></div>`;
  } else if (!git.isRepo) {
    els.gitBanner.innerHTML = `<div class="git-icon">⑂</div><div class="git-banner-main"><div class="eyebrow">GIT</div><h3>Not a Git repository</h3><div class="subtle">CodeAtlas can still scan the project; initialize Git to see branch and commit information.</div></div>`;
  } else {
    els.gitBanner.innerHTML = `
      <div class="git-icon">⑂</div>
      <div class="git-banner-main">
        <div class="eyebrow">GIT REPOSITORY</div>
        <h3>${escapeHtml(git.branch || "Detached HEAD")}</h3>
        <div class="git-meta">
          <span class="git-chip">${git.dirtyFiles} changed file${git.dirtyFiles === 1 ? "" : "s"}</span>
          <span class="git-chip">${git.commits.length} recent commit${git.commits.length === 1 ? "" : "s"}</span>
        </div>
      </div>`;
  }
  renderCommitList(els.gitCommits, git.commits);
}

function graphFilteredFiles() {
  const query = els.graphSearch.value.trim().toLowerCase();
  const language = els.graphLanguage.value;
  return state.analysis.files.filter(file => {
    const queryOk = !query || file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query);
    const languageOk = language === "all" || file.language === language;
    return queryOk && languageOk;
  });
}

function seededUnit(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function buildGraphPositions(files, edges) {
  const positions = new Map();
  const folders = new Map();
  for (const file of files) {
    if (!folders.has(file.folder)) folders.set(file.folder, []);
    folders.get(file.folder).push(file);
  }

  const groups = [...folders.entries()];
  const centerX = 600;
  const centerY = 350;
  const clusterRadius = Math.min(300, 160 + groups.length * 9);

  groups.forEach(([folder, members], groupIndex) => {
    const angle = (groupIndex / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2;
    const gx = groups.length === 1 ? centerX : centerX + Math.cos(angle) * clusterRadius;
    const gy = groups.length === 1 ? centerY : centerY + Math.sin(angle) * clusterRadius * .72;
    const localRadius = Math.min(115, 24 + Math.sqrt(members.length) * 19);

    members.forEach((file, index) => {
      const localAngle = (index / Math.max(1, members.length)) * Math.PI * 2 + seededUnit(file.path) * .9;
      const jitter = .45 + seededUnit(`${file.path}:r`) * .55;
      positions.set(file.id, {
        x: gx + Math.cos(localAngle) * localRadius * jitter,
        y: gy + Math.sin(localAngle) * localRadius * jitter,
      });
    });
  });

  const visible = new Set(files.map(file => file.id));
  const relevantEdges = edges.filter(edge => visible.has(edge.source) && visible.has(edge.target));

  for (let iteration = 0; iteration < 50; iteration += 1) {
    for (const edge of relevantEdges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const force = (dist - 105) * .0035;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.x += fx;
      a.y += fy;
      b.x -= fx;
      b.y -= fy;
    }
  }
  return positions;
}

function renderGraph() {
  if (!state.analysis) return;

  const allFiltered = graphFilteredFiles();
  const MAX_GRAPH_NODES = 260;
  const files = allFiltered.slice(0, MAX_GRAPH_NODES);
  const visibleIds = new Set(files.map(file => file.id));
  const edges = state.analysis.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  state.graph.visibleIds = visibleIds;

  if (!state.graph.positions.size || files.some(file => !state.graph.positions.has(file.id))) {
    state.graph.positions = buildGraphPositions(files, state.analysis.edges);
  }

  els.graphSummary.textContent = `${files.length} nodes · ${edges.length} links`;
  if (allFiltered.length > MAX_GRAPH_NODES) {
    els.graphLimitNote.classList.remove("hidden");
    els.graphLimitNote.textContent = `Showing ${MAX_GRAPH_NODES} of ${allFiltered.length} files — filter to narrow the graph`;
  } else {
    els.graphLimitNote.classList.add("hidden");
  }

  els.graphEdges.innerHTML = edges.map(edge => {
    const a = state.graph.positions.get(edge.source);
    const b = state.graph.positions.get(edge.target);
    if (!a || !b) return "";
    const highlight = state.selectedNode != null && (edge.source === state.selectedNode || edge.target === state.selectedNode);
    return `<line class="graph-edge${highlight ? " highlight" : ""}" data-source="${edge.source}" data-target="${edge.target}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"></line>`;
  }).join("");

  els.graphNodes.innerHTML = files.map(file => {
    const p = state.graph.positions.get(file.id) || { x: 600, y: 350 };
    const degree = state.analysis.edges.reduce((count, edge) => count + (edge.source === file.id || edge.target === file.id ? 1 : 0), 0);
    const radius = Math.min(13, 5.4 + Math.sqrt(degree + 1) * 1.45);
    const selected = state.selectedNode === file.id ? " selected" : "";
    const label = file.name.length > 24 ? `${file.name.slice(0, 21)}…` : file.name;
    return `<g class="graph-node${selected}" data-file-id="${file.id}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">
      <circle r="${radius.toFixed(1)}" fill="${colorFor(file.language)}"></circle>
      <text x="${(radius + 4).toFixed(1)}" y="3">${escapeHtml(label)}</text>
    </g>`;
  }).join("");

  applyGraphTransform();
}

function applyGraphTransform() {
  const g = state.graph;
  els.graphViewport.setAttribute("transform", `translate(${g.tx} ${g.ty}) scale(${g.scale})`);
}

function fitGraph() {
  state.graph.scale = 1;
  state.graph.tx = 0;
  state.graph.ty = 0;
  applyGraphTransform();
}

async function inspectNode(fileId) {
  const file = state.analysis.files.find(item => item.id === fileId);
  if (!file) return;
  state.selectedNode = file.id;
  renderGraph();

  const connected = state.analysis.edges.filter(edge => edge.source === file.id || edge.target === file.id).length;
  els.nodeInspector.innerHTML = `
    <div class="eyebrow">NODE INSPECTOR</div>
    <h3>${escapeHtml(file.name)}</h3>
    <div class="inspector-path">${escapeHtml(file.path)}</div>
    <div class="inspector-grid">
      <div class="inspector-metric"><span>Language</span><b>${escapeHtml(file.language)}</b></div>
      <div class="inspector-metric"><span>Links</span><b>${connected}</b></div>
      <div class="inspector-metric"><span>Lines</span><b>${fmtNumber(file.lines)}</b></div>
      <div class="inspector-metric"><span>Size</span><b>${fmtBytes(file.size)}</b></div>
    </div>
    <div class="eyebrow" style="margin:12px 0 7px">SOURCE PREVIEW</div>
    <pre class="inspector-code">Loading…</pre>`;

  const pre = els.nodeInspector.querySelector(".inspector-code");
  try {
    const preview = await invoke("read_file", {
      projectPath: state.analysis.projectPath,
      relativePath: file.path,
    });
    pre.textContent = preview.content.slice(0, 12000) + (preview.truncated ? "\n\n… truncated …" : "");
  } catch (error) {
    pre.textContent = `Could not preview file.\n${error}`;
  }
}

function showView(view) {
  state.currentView = view;
  const titles = { overview: "Overview", graph: "Dependency Graph", files: "Files", todos: "TODOs", git: "Git" };
  els.pageTitle.textContent = titles[view] || "CodeAtlas";
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".view").forEach(node => node.classList.remove("active-view"));
  const viewNode = document.querySelector(`#view-${view}`);
  if (viewNode) viewNode.classList.add("active-view");
  if (view === "graph" && state.analysis) renderGraph();
}

async function doExportReport() {
  if (!state.analysis) return;
  try {
    const saved = await invoke("export_report", { analysis: state.analysis });
    if (saved) toast(`Report saved: ${saved}`, "good");
  } catch (error) {
    toast(String(error), "bad");
  }
}

function screenToSvg(event) {
  const rect = els.graphSvg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * 1200,
    y: ((event.clientY - rect.top) / rect.height) * 720,
  };
}

function wireEvents() {
  els.openProject.addEventListener("click", openProject);
  els.emptyOpen.addEventListener("click", openProject);
  els.rescan.addEventListener("click", () => state.analysis && scan(state.analysis.projectPath));
  els.exportReport.addEventListener("click", doExportReport);
  els.openFolder.addEventListener("click", async () => {
    if (!state.analysis) return;
    try { await invoke("open_in_file_manager", { path: state.analysis.projectPath }); }
    catch (error) { toast(String(error), "bad"); }
  });
  els.openVscode.addEventListener("click", async () => {
    if (!state.analysis) return;
    try { await invoke("open_in_vscode", { path: state.analysis.projectPath }); }
    catch (error) { toast(String(error), "bad"); }
  });

  document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-go-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.goView)));

  els.fileSearch.addEventListener("input", renderFiles);
  els.fileLanguage.addEventListener("change", renderFiles);
  els.todoSearch.addEventListener("input", renderTodos);
  els.graphSearch.addEventListener("input", () => { state.graph.positions.clear(); renderGraph(); });
  els.graphLanguage.addEventListener("change", () => { state.graph.positions.clear(); renderGraph(); });
  els.graphFit.addEventListener("click", fitGraph);

  els.fileTableBody.addEventListener("click", event => {
    const row = event.target.closest("tr[data-file-id]");
    if (!row) return;
    const file = state.analysis.files.find(item => item.id === Number(row.dataset.fileId));
    previewFile(file);
  });

  els.hotspotList.addEventListener("click", event => {
    const row = event.target.closest("[data-file-id]");
    if (!row) return;
    showView("graph");
    inspectNode(Number(row.dataset.fileId));
  });

  els.graphNodes.addEventListener("pointerdown", event => {
    const node = event.target.closest(".graph-node");
    if (!node) return;
    event.stopPropagation();
    const id = Number(node.dataset.fileId);
    state.graph.draggingNode = id;
    els.graphSvg.setPointerCapture(event.pointerId);
    inspectNode(id);
  });

  els.graphSvg.addEventListener("pointerdown", event => {
    if (event.target.closest(".graph-node")) return;
    state.graph.panning = true;
    state.graph.pointerStart = { x: event.clientX, y: event.clientY, tx: state.graph.tx, ty: state.graph.ty };
    els.graphSvg.classList.add("panning");
    els.graphSvg.setPointerCapture(event.pointerId);
  });

  els.graphSvg.addEventListener("pointermove", event => {
    if (state.graph.draggingNode != null) {
      const point = screenToSvg(event);
      const x = (point.x - state.graph.tx) / state.graph.scale;
      const y = (point.y - state.graph.ty) / state.graph.scale;
      state.graph.positions.set(state.graph.draggingNode, { x, y });
      renderGraph();
      return;
    }
    if (state.graph.panning && state.graph.pointerStart) {
      const rect = els.graphSvg.getBoundingClientRect();
      const dx = (event.clientX - state.graph.pointerStart.x) * (1200 / rect.width);
      const dy = (event.clientY - state.graph.pointerStart.y) * (720 / rect.height);
      state.graph.tx = state.graph.pointerStart.tx + dx;
      state.graph.ty = state.graph.pointerStart.ty + dy;
      applyGraphTransform();
    }
  });

  const endPointer = () => {
    state.graph.draggingNode = null;
    state.graph.panning = false;
    state.graph.pointerStart = null;
    els.graphSvg.classList.remove("panning");
  };
  els.graphSvg.addEventListener("pointerup", endPointer);
  els.graphSvg.addEventListener("pointercancel", endPointer);

  els.graphSvg.addEventListener("wheel", event => {
    event.preventDefault();
    const before = screenToSvg(event);
    const oldScale = state.graph.scale;
    const nextScale = Math.min(3.2, Math.max(.35, oldScale * (event.deltaY < 0 ? 1.12 : .89)));
    const worldX = (before.x - state.graph.tx) / oldScale;
    const worldY = (before.y - state.graph.ty) / oldScale;
    state.graph.scale = nextScale;
    state.graph.tx = before.x - worldX * nextScale;
    state.graph.ty = before.y - worldY * nextScale;
    applyGraphTransform();
  }, { passive: false });
}

wireEvents();
setScanStatus("idle", "Waiting");
