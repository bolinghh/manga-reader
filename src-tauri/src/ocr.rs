use std::{path::PathBuf, process::{Child, Command, Stdio}, sync::{Mutex, OnceLock}};
use tauri::Manager;
fn child() -> &'static Mutex<Option<(Child, u16)>> {
    static CHILD: OnceLock<Mutex<Option<(Child, u16)>>> = OnceLock::new();
    CHILD.get_or_init(|| Mutex::new(None))
}
fn local_port(endpoint: &str) -> Result<u16, String> {
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "OCR 地址无效。")?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/" | "/ocr") {
        return Err("自动启动仅支持本机 HTTP OCR 地址。".into());
    }
    let port = url.port_or_known_default().filter(|port| *port > 0).ok_or("OCR 端口无效。")?;
    Ok(port)
}
#[tauri::command]
pub fn start_local_ocr(app: tauri::AppHandle, endpoint: String) -> Result<(), String> {
    let port = local_port(&endpoint)?;
    let mut running = child().lock().map_err(|_| "无法检查 OCR 进程。")?;
    if let Some((process, active_port)) = running.as_mut() {
        if process.try_wait().map_err(|_| "无法检查 OCR 进程。")?.is_none() {
            return if *active_port == port { Ok(()) } else { Err(format!("OCR 已在本机 {active_port} 端口运行，请使用原地址或重新启动应用后更换端口。")) };
        }
    }
    let root = if cfg!(debug_assertions) { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ocr") } else { app.path().resource_dir().map_err(|_| "无法定位 OCR 文件。")?.join("ocr") };
    let data_root = app.path().app_data_dir().map_err(|_| "无法定位 OCR 运行环境。")?.join("ocr");
    let python = [root.join(".venv/Scripts/python.exe"), data_root.join(".venv/Scripts/python.exe")].into_iter().find(|path| path.is_file()).ok_or("尚未安装 OCR 运行环境，请先运行 OCR 安装脚本。")?;
    let script = root.join("ocr_server.py");
    if !script.is_file() { return Err("缺少 OCR 服务文件，请重新安装应用。".into()) }
    let mut command = Command::new(python);
    command.arg(script).arg("--port").arg(port.to_string()).current_dir(&root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if !cfg!(debug_assertions) { command.env("MANGAREADER_OCR_MODELS", data_root.join("models")); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    *running = Some((command.spawn().map_err(|_| "无法启动 OCR，请检查 Python 运行环境。")?, port));
    Ok(())
}
pub fn stop_owned_ocr() { if let Ok(mut value) = child().lock() { if let Some((mut process, _port)) = value.take() { let _ = process.kill(); let _ = process.wait(); } } }
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_accepts_only_local_root_addresses_with_a_valid_port() {
        assert_eq!(local_port("http://127.0.0.1:8876").unwrap(), 8876);
        assert_eq!(local_port("http://localhost:8877/ocr").unwrap(), 8877);
        for endpoint in ["http://127.0.0.1:0", "https://example.com", "http://127.0.0.1.attacker.com:8876", "http://user:secret@localhost:8876", "http://localhost:8876/arbitrary-script", "http://localhost:8876?command=run"] { assert!(local_port(endpoint).is_err()); }
    }
}
