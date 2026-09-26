use image::{io::{Limits as ImageLimits, Reader as ImageReader}, ImageFormat};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{Cursor, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
mod translation;
mod ocr;

const CACHE_LIMIT_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_PAGE_BYTES: u64 = 128 * 1024 * 1024;
const SESSION_TTL_MS: u128 = 30 * 60 * 1000;

#[derive(Clone)]
struct NativeState {
    inner: Arc<NativeStateInner>,
}

struct NativeStateInner {
    sessions: Mutex<HashMap<String, ReaderSession>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    next_token: AtomicU64,
    cache_root: PathBuf,
    last_cache_sweep: Mutex<Instant>,
}

#[derive(Clone)]
struct ReaderSession {
    path: PathBuf,
    cache_key: String,
    kind: SessionKind,
    pages: Arc<Vec<PageSource>>,
    read_lock: Arc<Mutex<()>>,
    last_access: u128,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SessionKind {
    Images,
    Archive,
    Pdf,
}

#[derive(Clone)]
enum PageSource {
    Direct(PathBuf),
    Zip { entry_index: usize, name: String },
    Rar { name: PathBuf },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReaderPageMeta {
    index: usize,
    name: String,
    mime: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReaderSourceSession {
    token: String,
    kind: SessionKind,
    pages: Vec<ReaderPageMeta>,
    document_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStats {
    bytes: u64,
    files: u64,
    limit_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySourceChange {
    root: String,
    paths: Vec<String>,
}

impl NativeState {
    fn new() -> Self {
        let cache_root = std::env::temp_dir().join("mangareader-page-cache-v1");
        let _ = fs::create_dir_all(&cache_root);
        Self {
            inner: Arc::new(NativeStateInner {
                sessions: Mutex::new(HashMap::new()),
                watchers: Mutex::new(HashMap::new()),
                next_token: AtomicU64::new(1),
                cache_root,
                last_cache_sweep: Mutex::new(Instant::now() - Duration::from_secs(10)),
            }),
        }
    }

    fn token(&self) -> String {
        format!(
            "s{:x}{:x}",
            now_millis(),
            self.inner.next_token.fetch_add(1, Ordering::Relaxed)
        )
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn prune_sessions(sessions: &mut HashMap<String, ReaderSession>) {
    let now = now_millis();
    sessions.retain(|_, session| now.saturating_sub(session.last_access) <= SESSION_TTL_MS);
}

fn active_session(state: &NativeState, token: &str) -> Result<ReaderSession, String> {
    let mut sessions = state
        .inner
        .sessions
        .lock()
        .map_err(|_| "reader source state is unavailable".to_string())?;
    prune_sessions(&mut sessions);
    let session = sessions
        .get_mut(token)
        .ok_or_else(|| "reader source session has expired".to_string())?;
    session.last_access = now_millis();
    Ok(session.clone())
}

fn is_image_name(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif" | "bmp"
    )
}

fn mime_for(name: &str) -> String {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        _ => "image/jpeg",
    }
    .to_string()
}

fn source_cache_key(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().to_ascii_lowercase().hash(&mut hasher);
    if let Ok(meta) = fs::metadata(path) {
        meta.len().hash(&mut hasher);
        if let Ok(modified) = meta.modified() {
            modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .hash(&mut hasher);
        }
    }
    format!("{:016x}", hasher.finish())
}

fn sort_page_metadata(pages: &mut Vec<(String, u64, PageSource)>) {
    pages.sort_by(|a, b| natord::compare(&a.0, &b.0));
}

fn list_zip(path: &Path) -> Result<Vec<(String, u64, PageSource)>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut pages = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if !entry.is_file() || !is_image_name(entry.name()) {
            continue;
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("archive entry has an unsafe path: {}", entry.name()))?;
        let name = enclosed.to_string_lossy().replace('\\', "/");
        pages.push((name.clone(), entry.size(), PageSource::Zip { entry_index: index, name }));
    }
    sort_page_metadata(&mut pages);
    Ok(pages)
}

fn list_rar(path: &Path) -> Result<Vec<(String, u64, PageSource)>, String> {
    let archive = unrar::Archive::new(path)
        .open_for_listing()
        .map_err(|error| error.to_string())?;
    let mut pages = Vec::new();
    for entry in archive {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.filename.to_string_lossy().replace('\\', "/");
        if !is_image_name(&name) {
            continue;
        }
        pages.push((
            name,
            entry.unpacked_size,
            PageSource::Rar {
                name: entry.filename,
            },
        ));
    }
    sort_page_metadata(&mut pages);
    Ok(pages)
}

#[tauri::command]
fn open_reader_source(
    state: tauri::State<'_, NativeState>,
    path: String,
    page_paths: Option<Vec<String>>,
) -> Result<ReaderSourceSession, String> {
    let source_path = PathBuf::from(&path);
    let meta = fs::metadata(&source_path).map_err(|error| error.to_string())?;
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut listed: Vec<(String, u64, PageSource)> = Vec::new();
    let kind = if extension == "pdf" {
        SessionKind::Pdf
    } else if meta.is_dir() || page_paths.as_ref().is_some_and(|pages| !pages.is_empty()) {
        let canonical_root = source_path.canonicalize().map_err(|error| error.to_string())?;
        if !canonical_root.is_dir() {
            return Err("native image source root is not a directory".to_string());
        }
        for page in page_paths.unwrap_or_default() {
            let page_path = PathBuf::from(&page);
            let canonical_page = page_path.canonicalize().map_err(|error| error.to_string())?;
            if !canonical_page.starts_with(&canonical_root) || !is_image_name(&canonical_page.to_string_lossy()) {
                return Err("image page is outside the selected source root".to_string());
            }
            let page_meta = fs::metadata(&canonical_page).map_err(|error| error.to_string())?;
            let name = page_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&page)
                .to_string();
            listed.push((name, page_meta.len(), PageSource::Direct(canonical_page)));
        }
        sort_page_metadata(&mut listed);
        SessionKind::Images
    } else if matches!(extension.as_str(), "cbz" | "zip") {
        listed = list_zip(&source_path)?;
        SessionKind::Archive
    } else if matches!(extension.as_str(), "cbr" | "rar") {
        listed = list_rar(&source_path)?;
        SessionKind::Archive
    } else {
        return Err("unsupported native reader source".to_string());
    };
    if !matches!(kind, SessionKind::Pdf) && listed.is_empty() {
        return Err("no supported image pages were found".to_string());
    }
    let token = state.token();
    let cache_key = source_cache_key(&source_path);
    let pages = Arc::new(listed.iter().map(|(_, _, source)| source.clone()).collect());
    let page_meta = listed
        .into_iter()
        .enumerate()
        .map(|(index, (name, size, _))| ReaderPageMeta {
            index,
            mime: mime_for(&name),
            name,
            size,
        })
        .collect();
    let mut sessions = state.inner.sessions.lock().map_err(|_| "reader source state is unavailable".to_string())?;
    prune_sessions(&mut sessions);
    let read_lock = sessions.values().find(|session| session.cache_key == cache_key).map(|session| session.read_lock.clone()).unwrap_or_else(|| Arc::new(Mutex::new(())));
    sessions.insert(
            token.clone(),
            ReaderSession {
                path: source_path,
                cache_key,
                kind,
                pages,
                read_lock,
                last_access: now_millis(),
            },
        );
    drop(sessions);
    let document_url = matches!(kind, SessionKind::Pdf)
        .then(|| format!("http://manga-resource.localhost/{token}/document"));
    Ok(ReaderSourceSession {
        token,
        kind,
        pages: page_meta,
        document_url,
    })
}

#[tauri::command]
fn close_reader_source(state: tauri::State<'_, NativeState>, token: String) {
    if let Ok(mut sessions) = state.inner.sessions.lock() {
        sessions.remove(&token);
    }
}

fn cache_path(state: &NativeState, session: &ReaderSession, name: &str) -> PathBuf {
    state
        .inner
        .cache_root
        .join(&session.cache_key)
        .join(name)
}

fn read_page(session: &ReaderSession, page: usize) -> Result<Vec<u8>, String> {
    let source = session
        .pages
        .get(page)
        .ok_or_else(|| "page index is out of range".to_string())?;
    let bytes = match source {
        PageSource::Direct(path) => fs::read(path).map_err(|error| error.to_string())?,
        PageSource::Zip { entry_index, .. } => {
            let file = File::open(&session.path).map_err(|error| error.to_string())?;
            let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
            let mut entry = archive
                .by_index(*entry_index)
                .map_err(|error| error.to_string())?;
            if entry.size() > MAX_PAGE_BYTES {
                return Err("archive page exceeds the 128 MB safety limit".to_string());
            }
            let mut data = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut data).map_err(|error| error.to_string())?;
            data
        }
        PageSource::Rar { name } => {
            let mut archive = unrar::Archive::new(&session.path)
                .open_for_processing()
                .map_err(|error| error.to_string())?;
            loop {
                let Some(header) = archive.read_header().map_err(|error| error.to_string())? else {
                    return Err("RAR page entry was not found".to_string());
                };
                if header.entry().filename == *name {
                    if header.entry().unpacked_size > MAX_PAGE_BYTES {
                        return Err("archive page exceeds the 128 MB safety limit".to_string());
                    }
                    let (data, _) = header.read().map_err(|error| error.to_string())?;
                    break data;
                }
                archive = header.skip().map_err(|error| error.to_string())?;
            }
        }
    };
    if bytes.len() as u64 > MAX_PAGE_BYTES {
        return Err("page exceeds the 128 MB safety limit".to_string());
    }
    Ok(bytes)
}

fn read_rar_through(state: &NativeState, session: &ReaderSession, target: usize) -> Result<Vec<u8>, String> {
    let page_indices: HashMap<_, _> = session.pages.iter().enumerate().filter_map(|(index, source)| match source { PageSource::Rar { name } => Some((name, index)), _ => None }).collect();
    let target_name = match session.pages.get(target) {
        Some(PageSource::Rar { name }) => name.clone(),
        _ => return Err("RAR page index is out of range".to_string()),
    };
    let mut archive = unrar::Archive::new(&session.path)
        .open_for_processing()
        .map_err(|error| error.to_string())?;
    loop {
        let Some(header) = archive.read_header().map_err(|error| error.to_string())? else {
            return Err("RAR page entry was not found".to_string());
        };
        let entry_name = header.entry().filename.clone();
        let page_index = page_indices.get(&entry_name).copied();
        if let Some(index) = page_index {
            if header.entry().unpacked_size > MAX_PAGE_BYTES {
                return Err("archive page exceeds the 128 MB safety limit".to_string());
            }
            let path = cache_path(state, session, &format!("page-{index}.bin"));
            if path.exists() && entry_name != target_name {
                archive = header.skip().map_err(|error| error.to_string())?;
                continue;
            }
            let (data, next) = header.read().map_err(|error| error.to_string())?;
            if data.len() as u64 > MAX_PAGE_BYTES {
                return Err("archive page exceeds the 128 MB safety limit".to_string());
            }
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&path, &data);
            if entry_name == target_name {
                maybe_enforce_cache_limit(state);
                return Ok(data);
            }
            archive = next;
        } else {
            archive = header.skip().map_err(|error| error.to_string())?;
        }
    }
}

fn read_cached_page(state: &NativeState, session: &ReaderSession, page: usize) -> Result<Vec<u8>, String> {
    // Solid RAR archives must be traversed once, even when several pages are requested together.
    let _guard = if matches!(session.pages.first(), Some(PageSource::Rar { .. })) { Some(session.read_lock.lock().map_err(|_| "archive is unavailable")?) } else { None };
    let path = cache_path(state, session, &format!("page-{page}.bin"));
    if let Ok(data) = fs::read(&path) {
        if let Ok(file) = File::open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        return Ok(data);
    }
    if matches!(session.pages.get(page), Some(PageSource::Rar { .. })) {
        return read_rar_through(state, session, page);
    }
    let data = read_page(session, page)?;
    Ok(data)
}

fn thumbnail_bytes(state: &NativeState, session: &ReaderSession, page: usize) -> Result<Vec<u8>, String> {
    let filename = match session.pages.get(page) {
        Some(PageSource::Direct(path)) => format!("thumb-{page}-{}.webp", source_cache_key(path)),
        _ => format!("thumb-{page}.webp"),
    };
    let path = cache_path(state, session, &filename);
    if let Ok(data) = fs::read(&path) {
        if let Ok(file) = File::open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        return Ok(data);
    }
    let original = read_cached_page(state, session, page)?;
    let mut reader = ImageReader::new(Cursor::new(&original));
    reader = reader.with_guessed_format().map_err(|error| error.to_string())?;
    let mut limits = ImageLimits::default();
    limits.max_image_width = Some(50_000);
    limits.max_image_height = Some(50_000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|error| error.to_string())?;
    let thumb = image.thumbnail(240, 240);
    let mut cursor = Cursor::new(Vec::new());
    thumb
        .write_to(&mut cursor, ImageFormat::WebP)
        .map_err(|error| error.to_string())?;
    let bytes = cursor.into_inner();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, &bytes);
    maybe_enforce_cache_limit(state);
    Ok(bytes)
}

fn directory_stats(root: &Path) -> (u64, u64) {
    let mut bytes = 0;
    let mut files = 0;
    let Ok(entries) = fs::read_dir(root) else { return (0, 0) };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let (nested_bytes, nested_files) = directory_stats(&path);
            bytes += nested_bytes;
            files += nested_files;
        } else if let Ok(meta) = entry.metadata() {
            bytes += meta.len();
            files += 1;
        }
    }
    (bytes, files)
}

fn cache_files(root: &Path, out: &mut Vec<(SystemTime, u64, PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            cache_files(&path, out);
        } else if let Ok(meta) = entry.metadata() {
            out.push((meta.modified().unwrap_or(UNIX_EPOCH), meta.len(), path));
        }
    }
}

fn enforce_cache_limit(root: &Path) {
    let mut files = Vec::new();
    cache_files(root, &mut files);
    let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
    if total <= CACHE_LIMIT_BYTES {
        return;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in files {
        let _ = fs::remove_file(path);
        total = total.saturating_sub(size);
        if total <= CACHE_LIMIT_BYTES {
            break;
        }
    }
}
fn maybe_enforce_cache_limit(state: &NativeState) {
    if let Ok(mut last) = state.inner.last_cache_sweep.try_lock() {
        if last.elapsed() >= Duration::from_secs(10) {
            enforce_cache_limit(&state.inner.cache_root);
            *last = Instant::now();
        }
    }
}

#[tauri::command]
fn get_cache_stats(state: tauri::State<'_, NativeState>) -> CacheStats {
    let (bytes, files) = directory_stats(&state.inner.cache_root);
    CacheStats {
        bytes,
        files,
        limit_bytes: CACHE_LIMIT_BYTES,
    }
}

#[tauri::command]
fn clear_reader_cache(state: tauri::State<'_, NativeState>, scope: Option<String>) -> Result<(), String> {
    if let Some(value) = scope.filter(|value| !value.trim().is_empty()) {
        let source = PathBuf::from(&value);
        let mut keys = vec![source_cache_key(&source)];
        if let Ok(sessions) = state.inner.sessions.lock() {
            keys.extend(sessions.values().filter(|session| session.path == source).map(|session| session.cache_key.clone()));
        }
        keys.sort();
        keys.dedup();
        for key in keys {
            let target = state.inner.cache_root.join(key);
            if target.exists() {
                fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
            }
        }
    } else if state.inner.cache_root.exists() {
        fs::remove_dir_all(&state.inner.cache_root).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&state.inner.cache_root).map_err(|error| error.to_string())
}

#[tauri::command]
fn watch_library_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
    path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("watch root is not a directory".to_string());
    }
    let event_root = path.clone();
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            let _ = app_handle.emit(
                "library-source-change",
                LibrarySourceChange {
                    root: event_root.clone(),
                    paths: event
                        .paths
                        .into_iter()
                        .map(|value| value.to_string_lossy().to_string())
                        .collect(),
                },
            );
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    state
        .inner
        .watchers
        .lock()
        .map_err(|_| "watch state is unavailable".to_string())?
        .insert(path, watcher);
    Ok(())
}

#[tauri::command]
fn unwatch_library_root(state: tauri::State<'_, NativeState>, path: String) {
    if let Ok(mut watchers) = state.inner.watchers.lock() {
        watchers.remove(&path);
    }
}

fn range_response(path: &Path, range: Option<&str>) -> Result<tauri::http::Response<Vec<u8>>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let total = file.metadata().map_err(|error| error.to_string())?.len();
    let (start, end, partial) = if let Some(value) = range.and_then(|value| value.strip_prefix("bytes=")) {
        let (start, end) = value.split_once('-').unwrap_or((value, ""));
        let start = start.parse::<u64>().unwrap_or(0).min(total.saturating_sub(1));
        let end = end
            .parse::<u64>()
            .unwrap_or_else(|_| (start + 1024 * 1024 - 1).min(total.saturating_sub(1)))
            .min(total.saturating_sub(1));
        (start, end.max(start), true)
    } else {
        (0, total.saturating_sub(1), false)
    };
    let length = end.saturating_sub(start) + 1;
    file.seek(SeekFrom::Start(start)).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    let mut builder = tauri::http::Response::builder()
        .status(if partial { 206 } else { 200 })
        .header("Content-Type", "application/pdf")
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", length.to_string())
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
        .header("Cross-Origin-Resource-Policy", "cross-origin");
    if partial {
        builder = builder.header("Content-Range", format!("bytes {start}-{end}/{total}"));
    }
    builder.body(bytes).map_err(|error| error.to_string())
}

fn protocol_response(state: &NativeState, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let parts: Vec<_> = request.uri().path().trim_start_matches('/').split('/').collect();
    let result = (|| -> Result<tauri::http::Response<Vec<u8>>, String> {
        if parts.len() < 2 {
            return Err("invalid resource URL".to_string());
        }
        let session = active_session(state, parts[0])?;
        if parts[1] == "document" && matches!(session.kind, SessionKind::Pdf) {
            return range_response(
                &session.path,
                request.headers().get("Range").and_then(|value| value.to_str().ok()),
            );
        }
        if parts.len() < 3 {
            return Err("page index is missing".to_string());
        }
        let page = parts[2]
            .parse::<usize>()
            .map_err(|_| "invalid page index".to_string())?;
        let (bytes, content_type) = if parts[1] == "thumb" {
            (thumbnail_bytes(state, &session, page)?, "image/webp".to_string())
        } else if parts[1] == "page" {
            let name = match session.pages.get(page) {
                Some(PageSource::Direct(path)) => path.to_string_lossy().to_string(),
                Some(PageSource::Zip { name, .. }) => name.clone(),
                Some(PageSource::Rar { name }) => name.to_string_lossy().to_string(),
                None => return Err("page index is out of range".to_string()),
            };
            (read_cached_page(state, &session, page)?, mime_for(&name))
        } else {
            return Err("unknown resource variant".to_string());
        };
        tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", content_type)
            .header("Content-Length", bytes.len().to_string())
            .header("Cache-Control", "private, max-age=3600")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .body(bytes)
            .map_err(|error| error.to_string())
    })();
    result.unwrap_or_else(|message| {
        tauri::http::Response::builder()
            .status(400)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .body(message.into_bytes())
            .unwrap()
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = NativeState::new();
    let protocol_state = state.clone();
    let resource_slots = Arc::new(tokio::sync::Semaphore::new(4));
    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .register_asynchronous_uri_scheme_protocol("manga-resource", move |_ctx, request, responder| {
            let state = protocol_state.clone();
            let slots = resource_slots.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(permit) = slots.acquire_owned().await {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        let _permit = permit;
                        responder.respond(protocol_response(&state, request));
                    }).await;
                }
            });
        })
        .invoke_handler(tauri::generate_handler![
            startup_files,
            open_reader_source,
            close_reader_source,
            get_cache_stats,
            clear_reader_cache,
            watch_library_root,
            unwatch_library_root,
            translation::translation_request,
            translation::cancel_translation_request,
            translation::translation_service_request,
            translation::local_ocr_health,
            ocr::start_local_ocr,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MangaReader application")
        .run(|_app, event| { if matches!(event, tauri::RunEvent::Exit) { ocr::stop_owned_ocr(); } });
}

#[tauri::command]
fn startup_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| {
            let lower = arg.to_lowercase();
            [".pdf", ".cbz", ".zip", ".cbr", ".rar"]
                .iter()
                .any(|extension| lower.ends_with(extension))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mangareader-test-{}-{name}", now_millis()))
    }

    #[test]
    fn range_response_reads_only_requested_bytes() {
        let path = temp_path("range.pdf");
        fs::write(&path, b"0123456789").unwrap();
        let response = range_response(&path, Some("bytes=2-5")).unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.body(), b"2345");
        assert_eq!(response.headers().get("Content-Range").unwrap(), "bytes 2-5/10");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn zip_index_rejects_path_traversal_entries() {
        let path = temp_path("unsafe.zip");
        let file = File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive.start_file("../outside.jpg", zip::write::SimpleFileOptions::default()).unwrap();
        archive.write_all(b"not-an-image").unwrap();
        archive.finish().unwrap();
        let result = list_zip(&path);
        assert!(result.is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn page_names_use_natural_order() {
        let mut pages = vec![
            ("10.jpg".to_string(), 0, PageSource::Direct(PathBuf::new())),
            ("2.jpg".to_string(), 0, PageSource::Direct(PathBuf::new())),
            ("1.jpg".to_string(), 0, PageSource::Direct(PathBuf::new())),
        ];
        sort_page_metadata(&mut pages);
        assert_eq!(pages.into_iter().map(|item| item.0).collect::<Vec<_>>(), vec!["1.jpg", "2.jpg", "10.jpg"]);
    }
}
