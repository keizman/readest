use axum::{
    extract::{DefaultBodyLimit, Host, Multipart, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use if_addrs::get_if_addrs;
use rand::{thread_rng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
    net::TcpListener,
    sync::{oneshot, Mutex},
};

pub const WIFI_TRANSFER_PORT: u16 = 52381;
const MAX_FILES: usize = 100;
const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "epub", "mobi", "azw", "azw3", "fb2", "zip", "cbz", "pdf", "txt", "md",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiTransferInfo {
    port: u16,
    urls: Vec<String>,
    supported_extensions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiTransferFile {
    path: String,
    name: String,
    size: u64,
}

#[derive(Clone, Serialize)]
struct WifiTransferUploaded {
    files: Vec<WifiTransferFile>,
}

#[derive(Clone)]
struct UploadState {
    app: AppHandle,
    token: String,
    upload_dir: PathBuf,
}

struct RunningServer {
    info: WifiTransferInfo,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct WifiTransferState {
    running: Mutex<Option<RunningServer>>,
}

#[derive(Deserialize)]
struct UploadQuery {
    token: String,
}

#[derive(Serialize)]
struct UploadResponse {
    files: Vec<WifiTransferFile>,
}

fn random_token() -> String {
    let mut bytes = [0_u8; 24];
    thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_filename(raw: &str) -> Result<String, &'static str> {
    if raw.is_empty()
        || raw.len() > 255
        || raw.chars().any(|character| {
            matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        })
        || raw.chars().any(char::is_control)
        || raw == "."
        || raw == ".."
    {
        return Err("Invalid filename");
    }
    let extension = Path::new(raw)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("Unsupported file format")?;
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Unsupported file format");
    }
    Ok(raw.to_string())
}

fn format_transfer_url(ip: &str, port: u16) -> String {
    if ip.contains(':') {
        format!("http://[{ip}]:{port}")
    } else {
        format!("http://{ip}:{port}")
    }
}

fn is_allowed_host(host: &str) -> bool {
    let authority = match host.parse::<axum::http::uri::Authority>() {
        Ok(authority) => authority,
        Err(_) => return false,
    };
    let hostname = authority.host().trim_matches(['[', ']']);
    hostname.eq_ignore_ascii_case("localhost") || hostname.parse::<IpAddr>().is_ok()
}

fn local_urls(port: u16) -> Vec<String> {
    let mut addresses = get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip.to_string()),
            _ => None,
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|ip| format_transfer_url(&ip, port))
        .collect::<Vec<_>>();
    addresses.sort();
    if addresses.is_empty() {
        addresses.push(format_transfer_url("127.0.0.1", port));
    }
    addresses
}

fn supported_formats_label() -> String {
    SUPPORTED_EXTENSIONS
        .iter()
        .map(|extension| format!(".{extension}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn transfer_page(token: &str) -> String {
    let formats = supported_formats_label();
    let accept = SUPPORTED_EXTENSIONS
        .iter()
        .map(|extension| format!(".{extension}"))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wi-Fi Transfer</title>
  <style nonce="{token}">
    :root {{ color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; background: #f3f3f3; color: #1a1a1a; min-height: 100vh; padding: 40px 18px; }}
    main {{ width: min(720px, 100%); margin: auto; }}
    h1 {{ font-size: 32px; margin: 0 0 8px; }}
    .lead, .hint {{ color: #5d5d5d; line-height: 1.55; }}
    .status {{ display: inline-flex; align-items: center; gap: 8px; margin: 18px 0; font-weight: 600; }}
    .dot {{ width: 10px; height: 10px; border-radius: 50%; background: #2f9e62; }}
    .card {{ background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px #00000012; }}
    .row {{ display: flex; align-items: center; justify-content: space-between; gap: 16px; }}
    .badge {{ color: #26794d; background: #e8f6ee; border-radius: 999px; padding: 5px 10px; font-size: 13px; }}
    input[type=file] {{ width: 100%; margin: 18px 0 12px; padding: 18px; background: #fafafa; border: 1px dashed #8a8a8a; border-radius: 8px; }}
    input[type=file]:focus-visible, button:focus-visible {{ outline: 3px solid #005fb8; outline-offset: 2px; }}
    button {{ border: 1px solid #005a9e; border-radius: 6px; padding: 10px 22px; background: #0067c0; color: white; font-weight: 600; cursor: pointer; transition: background-color 160ms ease; }}
    button:hover:not(:disabled) {{ background: #005a9e; }}
    button:disabled {{ opacity: .45; cursor: default; }}
    ul {{ padding: 0; list-style: none; }}
    li {{ padding: 9px 0; border-bottom: 1px solid #ece9e5; overflow-wrap: anywhere; }}
    .error {{ color: #b42318; }}
    footer {{ margin-top: 20px; text-align: center; }}
    @media (prefers-color-scheme: dark) {{
      body {{ background: #202020; color: #f5f5f5; }} .card {{ background: #2b2b2b; border-color: #454545; }}
      .lead, .hint {{ color: #c7c7c7; }} li {{ border-color: #454545; }}
      input[type=file] {{ background: #252525; border-color: #858585; }}
    }}
    @media (prefers-reduced-motion: reduce) {{ * {{ transition: none !important; }} }}
  </style>
</head>
<body>
  <main>
    <h1>Wi-Fi Transfer</h1>
    <p class="lead">Choose files, then add them to the device from this browser.</p>
    <div class="status"><span class="dot"></span>Connected to your bookshelf</div>
    <p class="hint">This local address works only while the device stays on the same Wi-Fi and the transfer screen remains open.</p>
    <section class="card">
      <div class="row"><div><h2>Books</h2><span class="hint">Upload books, PDFs, text files, and comics.</span></div><span class="badge">Available</span></div>
      <p class="hint">Supported: {formats}</p>
      <p class="hint">Up to 100 files per upload.</p>
      <form id="upload-form" action="/upload?token={token}" method="post" enctype="multipart/form-data">
        <input id="files" name="files" type="file" accept="{accept}" multiple>
        <button id="add" type="submit" disabled>Add</button>
      </form>
      <p id="message" class="hint">No files added yet.</p>
      <ul id="results"></ul>
    </section>
    <footer class="hint">Keep the Wi-Fi transfer screen open during transfer.</footer>
  </main>
  <script nonce="{token}">
    const form = document.getElementById('upload-form');
    const input = document.getElementById('files');
    const button = document.getElementById('add');
    const message = document.getElementById('message');
    const results = document.getElementById('results');
    input.addEventListener('change', () => {{ button.disabled = input.files.length === 0 || input.files.length > 100; }});
    form.addEventListener('submit', async event => {{
      event.preventDefault();
      if (!input.files.length || input.files.length > 100) return;
      button.disabled = true; message.className = 'hint'; message.textContent = 'Uploading…';
      try {{
        const response = await fetch(form.action, {{ method: 'POST', body: new FormData(form) }});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Upload failed');
        for (const file of body.files) {{ const item = document.createElement('li'); item.textContent = file.name + ' — Added'; results.prepend(item); }}
        message.textContent = body.files.length + ' file(s) added.'; form.reset();
      }} catch (error) {{ message.className = 'error'; message.textContent = error.message || 'Upload failed'; }}
      finally {{ button.disabled = input.files.length === 0; }}
    }});
  </script>
</body>
</html>"#
    )
}

fn with_security_headers(mut response: Response, token: &str) -> Response {
    let csp = format!(
        "default-src 'none'; style-src 'nonce-{token}'; script-src 'nonce-{token}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    if let Ok(value) = HeaderValue::from_str(&csp) {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, value);
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

async fn index(Host(host): Host, State(state): State<Arc<UploadState>>) -> Response {
    if !is_allowed_host(&host) {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    with_security_headers(
        Html(transfer_page(&state.token)).into_response(),
        &state.token,
    )
}

async fn remove_files(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path).await;
    }
}

async fn create_upload_file(dir: &Path, name: &str) -> Result<(PathBuf, fs::File), String> {
    for _ in 0..10 {
        let prefix = random_token();
        let file_dir = dir.join(&prefix[..12]);
        fs::create_dir(&file_dir)
            .await
            .map_err(|_| "Could not allocate uploaded file".to_string())?;
        let path = file_dir.join(name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let _ = fs::remove_dir(&file_dir).await;
                continue;
            }
            Err(_) => return Err("Could not save uploaded file".to_string()),
        }
    }
    Err("Could not allocate uploaded file".to_string())
}

async fn upload(
    Host(host): Host,
    State(state): State<Arc<UploadState>>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, (StatusCode, Json<serde_json::Value>)> {
    let fail =
        |status, message: &'static str| (status, Json(serde_json::json!({ "error": message })));
    if !is_allowed_host(&host) {
        return Err(fail(
            StatusCode::MISDIRECTED_REQUEST,
            "Invalid transfer host",
        ));
    }
    if query.token != state.token {
        return Err(fail(StatusCode::FORBIDDEN, "Invalid transfer session"));
    }

    let mut files = Vec::new();
    let mut saved_paths = Vec::new();
    let mut total_bytes = 0_u64;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "Invalid upload data"))?
    {
        if field.name() != Some("files") {
            continue;
        }
        if files.len() >= MAX_FILES {
            remove_files(&saved_paths).await;
            return Err(fail(StatusCode::BAD_REQUEST, "Up to 100 files are allowed"));
        }
        let filename = match field
            .file_name()
            .and_then(|name| validate_filename(name).ok())
        {
            Some(name) => name,
            None => {
                remove_files(&saved_paths).await;
                return Err(fail(
                    StatusCode::BAD_REQUEST,
                    "Unsupported or invalid filename",
                ));
            }
        };
        let (path, mut output) = match create_upload_file(&state.upload_dir, &filename).await {
            Ok(value) => value,
            Err(_) => {
                remove_files(&saved_paths).await;
                return Err(fail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not save uploaded file",
                ));
            }
        };
        let mut file_bytes = 0_u64;
        loop {
            let chunk = match field.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => {
                    let _ = fs::remove_file(&path).await;
                    remove_files(&saved_paths).await;
                    return Err(fail(StatusCode::BAD_REQUEST, "Upload was interrupted"));
                }
            };
            file_bytes += chunk.len() as u64;
            total_bytes += chunk.len() as u64;
            if file_bytes > MAX_FILE_BYTES || total_bytes > MAX_TOTAL_BYTES {
                let _ = fs::remove_file(&path).await;
                remove_files(&saved_paths).await;
                return Err(fail(StatusCode::PAYLOAD_TOO_LARGE, "Upload is too large"));
            }
            if output.write_all(&chunk).await.is_err() {
                let _ = fs::remove_file(&path).await;
                remove_files(&saved_paths).await;
                return Err(fail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not save uploaded file",
                ));
            }
        }
        if output.flush().await.is_err() || file_bytes == 0 {
            let _ = fs::remove_file(&path).await;
            remove_files(&saved_paths).await;
            return Err(fail(
                StatusCode::BAD_REQUEST,
                "Empty files are not supported",
            ));
        }
        saved_paths.push(path.clone());
        files.push(WifiTransferFile {
            path: path.to_string_lossy().to_string(),
            name: filename,
            size: file_bytes,
        });
    }
    if files.is_empty() {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "Choose at least one supported file",
        ));
    }

    if state
        .app
        .emit(
            "wifi-transfer-uploaded",
            WifiTransferUploaded {
                files: files.clone(),
            },
        )
        .is_err()
    {
        remove_files(&saved_paths).await;
        return Err(fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not import uploaded files",
        ));
    }
    Ok(Json(UploadResponse { files }))
}

#[tauri::command]
pub async fn start_wifi_transfer(
    app: AppHandle,
    state: TauriState<'_, WifiTransferState>,
) -> Result<WifiTransferInfo, String> {
    let mut running = state.running.lock().await;
    if let Some(server) = running.as_ref() {
        return Ok(server.info.clone());
    }

    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], WIFI_TRANSFER_PORT)))
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {WIFI_TRANSFER_PORT} is already in use")
            } else {
                "Could not start Wi-Fi transfer".to_string()
            }
        })?;
    let token = random_token();
    let upload_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Could not access the app cache".to_string())?
        .join("wifi-transfer")
        .join(&token);
    fs::create_dir_all(&upload_dir)
        .await
        .map_err(|_| "Could not create the upload directory".to_string())?;
    crate::allow_dir_in_scopes(&app, &upload_dir);

    let info = WifiTransferInfo {
        port: WIFI_TRANSFER_PORT,
        urls: local_urls(WIFI_TRANSFER_PORT),
        supported_extensions: SUPPORTED_EXTENSIONS
            .iter()
            .map(|extension| (*extension).to_string())
            .collect(),
    };
    let upload_state = Arc::new(UploadState {
        app,
        token,
        upload_dir,
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/upload", post(upload))
        .layer(DefaultBodyLimit::max(MAX_TOTAL_BYTES as usize))
        .with_state(upload_state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
        {
            log::warn!("Wi-Fi transfer server stopped unexpectedly: {error}");
        }
    });
    *running = Some(RunningServer {
        info: info.clone(),
        shutdown: Some(shutdown_tx),
    });
    Ok(info)
}

#[tauri::command]
pub async fn stop_wifi_transfer(state: TauriState<'_, WifiTransferState>) -> Result<(), String> {
    if let Some(mut server) = state.running.lock().await.take() {
        if let Some(shutdown) = server.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cleanup_wifi_transfer_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Could not access the app cache".to_string())?
        .join("wifi-transfer");
    let canonical_root = match fs::canonicalize(&root).await {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Could not access the transfer cache".to_string()),
    };
    for raw in paths {
        let path = PathBuf::from(raw);
        let canonical_path = match fs::canonicalize(&path).await {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Could not access an uploaded file".to_string()),
        };
        if !canonical_path.starts_with(&canonical_root) {
            return Err("Refusing to remove a file outside the transfer cache".to_string());
        }
        match fs::remove_file(&canonical_path).await {
            Ok(()) => {
                if let Some(parent) = canonical_path.parent() {
                    let _ = fs::remove_dir(parent).await;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Could not clean up an uploaded file".to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_formats_supported_by_the_library_importer() {
        for name in [
            "book.epub",
            "paper.PDF",
            "notes.txt",
            "comic.cbz",
            "book.azw3",
        ] {
            assert!(validate_filename(name).is_ok(), "{name} should be accepted");
        }
        for name in ["track.mp3", "archive.exe", "cover.png", "no-extension"] {
            assert!(
                validate_filename(name).is_err(),
                "{name} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_path_traversal_and_hidden_control_names() {
        for name in [
            "../book.epub",
            "..\\book.epub",
            "/tmp/book.epub",
            "bad\nname.epub",
            "bad:name.epub",
        ] {
            assert!(
                validate_filename(name).is_err(),
                "{name:?} should be rejected"
            );
        }
    }

    #[test]
    fn transfer_page_contains_the_scoped_upload_form_and_supported_formats() {
        let html = transfer_page("abc123");
        assert!(html.contains("Wi-Fi Transfer"));
        assert!(html.contains("/upload?token=abc123"));
        assert!(html.contains(".epub"));
        assert!(html.contains(".txt"));
        assert!(html.contains("Up to 100 files per upload"));
        assert!(!html.contains("Aurader"));
    }

    #[test]
    fn formats_ipv4_and_ipv6_urls() {
        assert_eq!(
            format_transfer_url("192.168.100.108", 52381),
            "http://192.168.100.108:52381"
        );
        assert_eq!(
            format_transfer_url("fe80::1", 52381),
            "http://[fe80::1]:52381"
        );
    }

    #[test]
    fn accepts_ip_hosts_but_rejects_dns_rebinding_hosts() {
        assert!(is_allowed_host("192.168.100.108:52381"));
        assert!(is_allowed_host("[fe80::1]:52381"));
        assert!(is_allowed_host("localhost:52381"));
        assert!(!is_allowed_host("attacker.example:52381"));
        assert!(!is_allowed_host("192.168.100.108.attacker.example:52381"));
    }
}
