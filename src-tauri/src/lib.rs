use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_TEXT_FILE_BYTES: u64 = 1_500_000;
const MAX_PREVIEW_BYTES: u64 = 400_000;
const MAX_TODOS: usize = 800;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub id: usize,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub language: String,
    pub size: u64,
    pub lines: usize,
    pub folder: String,
    pub imports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub source: usize,
    pub target: usize,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageStat {
    pub language: String,
    pub files: usize,
    pub lines: usize,
    pub bytes: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub path: String,
    pub line: usize,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub relative_time: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub available: bool,
    pub is_repo: bool,
    pub branch: String,
    pub dirty_files: usize,
    pub commits: Vec<GitCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    pub file_count: usize,
    pub total_lines: usize,
    pub total_bytes: u64,
    pub edge_count: usize,
    pub todo_count: usize,
    pub largest_file: String,
    pub largest_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAnalysis {
    pub project_path: String,
    pub project_name: String,
    pub files: Vec<FileNode>,
    pub edges: Vec<Edge>,
    pub languages: Vec<LanguageStat>,
    pub todos: Vec<TodoItem>,
    pub git: GitInfo,
    pub stats: ProjectStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
fn pick_project() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Open repository in CodeAtlas")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_project(path: String) -> Result<ProjectAnalysis, String> {
    analyze_project(Path::new(&path))
}

#[tauri::command]
fn read_file(project_path: String, relative_path: String) -> Result<FilePreview, String> {
    let root = fs::canonicalize(&project_path)
        .map_err(|e| format!("Could not open project path: {e}"))?;
    let requested = root.join(&relative_path);
    let canonical = fs::canonicalize(&requested)
        .map_err(|e| format!("Could not open file: {e}"))?;

    if !canonical.starts_with(&root) {
        return Err("That file is outside the selected project.".into());
    }

    let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    let truncated = metadata.len() > MAX_PREVIEW_BYTES;
    let bytes = fs::read(&canonical).map_err(|e| e.to_string())?;
    let slice = if truncated {
        &bytes[..MAX_PREVIEW_BYTES as usize]
    } else {
        &bytes[..]
    };

    Ok(FilePreview {
        path: relative_path,
        content: String::from_utf8_lossy(slice).to_string(),
        truncated,
    })
}

#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    Command::new("code")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not start the VS Code 'code' command. Install VS Code and enable its command-line launcher.".to_string())
}

#[tauri::command]
fn open_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(&path).spawn();

    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open").arg(&path).spawn();

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&path).spawn();

    result
        .map(|_| ())
        .map_err(|e| format!("Could not open the file manager: {e}"))
}

#[tauri::command]
fn export_report(analysis: ProjectAnalysis) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Export CodeAtlas report")
        .set_file_name("codeatlas-report.html")
        .add_filter("HTML report", &["html"])
        .save_file()
    else {
        return Ok(None);
    };

    let json = serde_json::to_string(&analysis).map_err(|e| e.to_string())?;
    let escaped_json = json.replace("</script>", "<\\/script>");
    let html = report_html(&analysis.project_name, &escaped_json);
    fs::write(&path, html).map_err(|e| format!("Could not save report: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

pub fn analyze_project(root: &Path) -> Result<ProjectAnalysis, String> {
    if !root.exists() || !root.is_dir() {
        return Err("Choose a valid project folder.".into());
    }

    let canonical_root = fs::canonicalize(root)
        .map_err(|e| format!("Could not access project folder: {e}"))?;
    let project_name = canonical_root
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("Project")
        .to_string();

    let mut files = Vec::<FileNode>::new();
    let mut todos = Vec::<TodoItem>::new();
    let mut path_to_id = HashMap::<String, usize>::new();

    let walker = WalkBuilder::new(&canonical_root)
        .standard_filters(true)
        .hidden(true)
        .follow_links(false)
        .build();

    for entry in walker.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let relative = match path.strip_prefix(&canonical_root) {
            Ok(p) => normalize_path(p),
            Err(_) => continue,
        };

        if should_skip_path(&relative) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let language = detect_language(path);
        if language == "Binary" || language == "Unknown" {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();

        let folder = path
            .parent()
            .and_then(|p| p.strip_prefix(&canonical_root).ok())
            .map(normalize_path)
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ".".into());

        let mut lines = 0usize;
        let mut imports = Vec::new();

        if metadata.len() <= MAX_TEXT_FILE_BYTES {
            if let Ok(text) = fs::read_to_string(path) {
                lines = text.lines().count();
                imports = extract_imports(&language, &text);
                if todos.len() < MAX_TODOS {
                    collect_todos(&relative, &text, &mut todos);
                }
            }
        }

        let id = files.len();
        let name = path
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or(&relative)
            .to_string();

        path_to_id.insert(relative.clone(), id);
        files.push(FileNode {
            id,
            path: relative,
            name,
            extension,
            language,
            size: metadata.len(),
            lines,
            folder,
            imports,
        });
    }

    let edges = build_edges(&canonical_root, &files, &path_to_id);
    let languages = language_stats(&files);
    let git = git_info(&canonical_root);

    let (largest_file, largest_size) = files
        .iter()
        .max_by_key(|f| f.size)
        .map(|f| (f.path.clone(), f.size))
        .unwrap_or_default();

    let stats = ProjectStats {
        file_count: files.len(),
        total_lines: files.iter().map(|f| f.lines).sum(),
        total_bytes: files.iter().map(|f| f.size).sum(),
        edge_count: edges.len(),
        todo_count: todos.len(),
        largest_file,
        largest_size,
    };

    Ok(ProjectAnalysis {
        project_path: canonical_root.to_string_lossy().to_string(),
        project_name,
        files,
        edges,
        languages,
        todos,
        git,
        stats,
    })
}

fn should_skip_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        "/node_modules/",
        "/target/",
        "/dist/",
        "/build/",
        "/vendor/",
        "/.venv/",
        "/venv/",
        "/__pycache__/",
        "/.git/",
    ]
    .iter()
    .any(|needle| format!("/{lower}/").contains(needle))
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn detect_language(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let language = match ext.as_str() {
        "rs" => "Rust",
        "py" => "Python",
        "js" | "mjs" | "cjs" => "JavaScript",
        "ts" | "mts" | "cts" => "TypeScript",
        "jsx" => "JSX",
        "tsx" => "TSX",
        "c" => "C",
        "h" => "C/C++ Header",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "C++",
        "php" | "phtml" => "PHP",
        "html" | "htm" => "HTML",
        "css" => "CSS",
        "scss" | "sass" => "SCSS",
        "json" => "JSON",
        "toml" => "TOML",
        "yaml" | "yml" => "YAML",
        "md" | "mdx" => "Markdown",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "go" => "Go",
        "cs" => "C#",
        "sh" | "bash" | "zsh" => "Shell",
        "sql" => "SQL",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "xml" => "XML",
        "svg" => "SVG",
        "txt" => "Text",
        "lock" => "Lockfile",
        "ini" | "cfg" | "conf" => "Config",
        "env" => "Config",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "pdf" | "zip" | "exe" | "dll" | "so" | "a" | "o" => "Binary",
        _ => {
            if matches!(name.as_str(), "dockerfile" | "makefile" | "cmakelists.txt") {
                "Build"
            } else if name.starts_with("readme") || name.starts_with("license") {
                "Markdown"
            } else {
                "Unknown"
            }
        }
    };

    language.to_string()
}

fn extract_imports(language: &str, text: &str) -> Vec<String> {
    let mut found = Vec::<String>::new();

    match language {
        "JavaScript" | "TypeScript" | "JSX" | "TSX" | "Vue" | "Svelte" => {
            let patterns = [
                r#"(?m)\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?[\"']([^\"']+)[\"']"#,
                r#"(?m)\brequire\s*\(\s*[\"']([^\"']+)[\"']\s*\)"#,
                r#"(?m)\bimport\s*\(\s*[\"']([^\"']+)[\"']\s*\)"#,
            ];
            for pattern in patterns {
                if let Ok(re) = Regex::new(pattern) {
                    for cap in re.captures_iter(text) {
                        found.push(cap[1].to_string());
                    }
                }
            }
        }
        "Python" => {
            if let Ok(re) = Regex::new(r"(?m)^\s*from\s+([\.\w]+)\s+import\s+") {
                for cap in re.captures_iter(text) {
                    found.push(cap[1].to_string());
                }
            }
            if let Ok(re) = Regex::new(r"(?m)^\s*import\s+([\w\.]+)") {
                for cap in re.captures_iter(text) {
                    found.push(cap[1].to_string());
                }
            }
        }
        "C" | "C++" | "C/C++ Header" => {
            if let Ok(re) = Regex::new(r#"(?m)^\s*#\s*include\s*[\"<]([^\">]+)[\">]"#) {
                for cap in re.captures_iter(text) {
                    found.push(cap[1].to_string());
                }
            }
        }
        "Rust" => {
            if let Ok(re) = Regex::new(r"(?m)^\s*mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;") {
                for cap in re.captures_iter(text) {
                    found.push(format!("./{}", &cap[1]));
                }
            }
            if let Ok(re) = Regex::new(r"(?m)^\s*use\s+crate::([A-Za-z0-9_:]+)") {
                for cap in re.captures_iter(text) {
                    found.push(format!("crate:{}", cap[1].replace("::", "/")));
                }
            }
        }
        "PHP" => {
            if let Ok(re) = Regex::new(r#"(?m)\b(?:include|include_once|require|require_once)\s*\(?\s*[\"']([^\"']+)[\"']"#) {
                for cap in re.captures_iter(text) {
                    found.push(cap[1].to_string());
                }
            }
        }
        _ => {}
    }

    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|item| seen.insert(item.clone()))
        .collect()
}

fn build_edges(
    root: &Path,
    files: &[FileNode],
    path_to_id: &HashMap<String, usize>,
) -> Vec<Edge> {
    let mut edges = Vec::new();
    let mut seen = HashSet::<(usize, usize)>::new();

    for file in files {
        for import in &file.imports {
            if let Some(target) = resolve_import(root, file, import, path_to_id) {
                if target != file.id && seen.insert((file.id, target)) {
                    edges.push(Edge {
                        source: file.id,
                        target,
                        kind: "import".into(),
                    });
                }
            }
        }
    }

    edges
}

fn resolve_import(
    root: &Path,
    file: &FileNode,
    import: &str,
    path_to_id: &HashMap<String, usize>,
) -> Option<usize> {
    let current_abs = root.join(&file.path);
    let current_dir = current_abs.parent().unwrap_or(root);
    let mut candidates = Vec::<PathBuf>::new();

    let extensions = [
        "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "c", "h", "hpp", "cpp", "php",
    ];

    if import.starts_with("crate:") {
        let module = import.trim_start_matches("crate:");
        let base = root.join("src").join(module);
        candidates.push(base.with_extension("rs"));
        candidates.push(base.join("mod.rs"));
    } else if file.language == "Python" && !import.starts_with('.') {
        let module = import.replace('.', "/");
        candidates.push(root.join(format!("{module}.py")));
        candidates.push(root.join(&module).join("__init__.py"));
    } else {
        let base = if import.starts_with('.') {
            current_dir.join(import)
        } else {
            current_dir.join(import)
        };

        candidates.push(base.clone());
        for ext in extensions {
            candidates.push(base.with_extension(ext));
        }
        for ext in ["js", "ts", "tsx", "jsx", "py", "rs", "php"] {
            candidates.push(base.join(format!("index.{ext}")));
        }

        if !import.starts_with('.') {
            let root_base = root.join(import);
            candidates.push(root_base.clone());
            for ext in extensions {
                candidates.push(root_base.with_extension(ext));
            }
        }
    }

    for candidate in candidates {
        let Ok(canonical) = fs::canonicalize(&candidate) else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(root) else {
            continue;
        };
        let normalized = normalize_path(relative);
        if let Some(id) = path_to_id.get(&normalized) {
            return Some(*id);
        }
    }

    None
}

fn collect_todos(relative: &str, text: &str, output: &mut Vec<TodoItem>) {
    for (index, line) in text.lines().enumerate() {
        if output.len() >= MAX_TODOS {
            return;
        }

        let upper = line.to_ascii_uppercase();
        let kind = ["TODO", "FIXME", "HACK", "XXX"]
            .iter()
            .find(|needle| upper.contains(**needle));

        if let Some(kind) = kind {
            output.push(TodoItem {
                path: relative.to_string(),
                line: index + 1,
                kind: (*kind).to_string(),
                text: line.trim().chars().take(220).collect(),
            });
        }
    }
}

fn language_stats(files: &[FileNode]) -> Vec<LanguageStat> {
    let mut grouped = BTreeMap::<String, (usize, usize, u64)>::new();
    let total_bytes: u64 = files.iter().map(|f| f.size).sum();

    for file in files {
        let entry = grouped.entry(file.language.clone()).or_default();
        entry.0 += 1;
        entry.1 += file.lines;
        entry.2 += file.size;
    }

    let mut stats: Vec<_> = grouped
        .into_iter()
        .map(|(language, (file_count, lines, bytes))| LanguageStat {
            language,
            files: file_count,
            lines,
            bytes,
            percent: if total_bytes == 0 {
                0.0
            } else {
                (bytes as f64 / total_bytes as f64) * 100.0
            },
        })
        .collect();

    stats.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    stats
}

fn git_info(root: &Path) -> GitInfo {
    let git_available = Command::new("git").arg("--version").output().is_ok();
    if !git_available {
        return GitInfo {
            available: false,
            is_repo: false,
            branch: String::new(),
            dirty_files: 0,
            commits: vec![],
        };
    }

    let inside = run_git(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|x| x.trim() == "true")
        .unwrap_or(false);

    if !inside {
        return GitInfo {
            available: true,
            is_repo: false,
            branch: String::new(),
            dirty_files: 0,
            commits: vec![],
        };
    }

    let branch = run_git(root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();

    let dirty_files = run_git(root, &["status", "--porcelain"])
        .unwrap_or_default()
        .lines()
        .count();

    let log = run_git(
        root,
        &[
            "log",
            "-n",
            "20",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%s",
        ],
    )
    .unwrap_or_default();

    let commits = log
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() != 5 {
                return None;
            }
            Some(GitCommit {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                relative_time: parts[3].to_string(),
                subject: parts[4].to_string(),
            })
        })
        .collect();

    GitInfo {
        available: true,
        is_repo: true,
        branch,
        dirty_files,
        commits,
    }
}

fn run_git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn report_html(project_name: &str, json: &str) -> String {
    let safe_title = project_name
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeAtlas Report — {safe_title}</title>
<style>
:root{{color-scheme:dark;background:#080a10;color:#f7f7fb;font-family:Inter,system-ui,sans-serif}}
*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(circle at 15% 10%,#241238 0,transparent 34%),radial-gradient(circle at 85% 10%,#102b42 0,transparent 32%),#080a10}}
main{{max-width:1180px;margin:auto;padding:48px 24px 80px}}h1{{font-size:44px;margin:0}}.muted{{color:#9ba3b5}}.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}}.card{{background:#11151f;border:1px solid #242b3b;border-radius:18px;padding:18px}}.value{{font-size:28px;font-weight:800;margin-top:6px}}table{{width:100%;border-collapse:collapse}}td,th{{padding:10px;border-bottom:1px solid #242b3b;text-align:left}}.bar{{height:8px;background:#242b3b;border-radius:10px;overflow:hidden}}.bar>i{{display:block;height:100%;background:linear-gradient(90deg,#ff4fa3,#9b5cff,#4f9dff)}}@media(max-width:800px){{.grid{{grid-template-columns:1fr 1fr}}}}
</style>
</head>
<body><main>
<div class="muted">CODEATLAS STATIC REPORT</div><h1 id="title"></h1><p class="muted" id="path"></p>
<div class="grid" id="stats"></div>
<div class="card"><h2>Languages</h2><div id="languages"></div></div>
<div class="card" style="margin-top:14px"><h2>TODO / FIXME</h2><table><thead><tr><th>Type</th><th>File</th><th>Line</th><th>Text</th></tr></thead><tbody id="todos"></tbody></table></div>
<script>const A={json};
const esc=s=>String(s).replace(/[&<>\"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}}[c]));
document.querySelector('#title').textContent=A.projectName;document.querySelector('#path').textContent=A.projectPath;
const cards=[['Files',A.stats.fileCount.toLocaleString()],['Lines',A.stats.totalLines.toLocaleString()],['Connections',A.stats.edgeCount.toLocaleString()],['TODOs',A.stats.todoCount.toLocaleString()]];
document.querySelector('#stats').innerHTML=cards.map(([k,v])=>`<div class="card"><div class="muted">${{k}}</div><div class="value">${{v}}</div></div>`).join('');
document.querySelector('#languages').innerHTML=A.languages.map(l=>`<div style="margin:16px 0"><div style="display:flex;justify-content:space-between"><b>${{esc(l.language)}}</b><span class="muted">${{l.percent.toFixed(1)}}% · ${{l.files}} files</span></div><div class="bar" style="margin-top:7px"><i style="width:${{Math.max(1,l.percent)}}%"></i></div></div>`).join('');
document.querySelector('#todos').innerHTML=A.todos.slice(0,200).map(t=>`<tr><td>${{esc(t.kind)}}</td><td>${{esc(t.path)}}</td><td>${{t.line}}</td><td>${{esc(t.text)}}</td></tr>`).join('');
</script></main></body></html>"#
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_project,
            scan_project,
            read_file,
            open_in_vscode,
            open_in_file_manager,
            export_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running CodeAtlas");
}
