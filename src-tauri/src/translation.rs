use serde_json::Value;
use std::{collections::HashMap, sync::{Mutex, OnceLock}, time::Duration};
use tokio::sync::oneshot;
use std::future::Future;

type Requests = HashMap<String, Option<oneshot::Sender<()>>>;
fn requests() -> &'static Mutex<Requests> {
    static REQUESTS: OnceLock<Mutex<Requests>> = OnceLock::new();
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_endpoint(endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "服务地址无效。".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("云端服务请使用 HTTPS；本机服务可以使用 HTTP。".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !url.path().ends_with("/chat/completions") {
        return Err("请使用兼容的翻译服务地址。".into());
    }
    Ok(url)
}
fn status_error(status: u16) -> String {
    match status {
        401 | 403 => "服务拒绝访问，请检查密钥和模型权限。".into(),
        404 => "服务接口或模型不存在，请检查服务地址和模型名称。".into(),
        429 => "服务调用达到限制或余额不足，请稍后重试或检查额度。".into(),
        456 => "翻译服务免费额度已用完，请更换服务或等待额度恢复。".into(),
        400 | 422 => "服务不支持本次请求，请检查目标语言或文字模型配置；兼容 API 可尝试关闭 JSON 模式。".into(),
        500..=599 => "翻译服务暂时不可用，请稍后重试。".into(),
        _ => format!("翻译请求失败（{status}），请检查服务设置。"),
    }
}
fn service_endpoint(kind: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "服务地址无效。".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("请使用有效的服务地址。".into());
    }
    let valid = match kind {
        "ocr" => local && matches!(url.scheme(), "http" | "https") && url.path().ends_with("/ocr"),
        "health" => local && matches!(url.scheme(), "http" | "https") && url.path().ends_with("/health"),
        "ocr-model" => local && matches!(url.scheme(), "http" | "https") && url.path() == "/models/prepare",
        "mymemory" => url.as_str() == "https://api.mymemory.translated.net/get",
        "deepl" => url.as_str() == "https://api-free.deepl.com/v2/translate",
        "tencent" => url.as_str() == "https://tmt.tencentcloudapi.com/",
        "libretranslate" => (url.scheme() == "https" || (url.scheme() == "http" && local)) && url.path().ends_with("/translate"),
        _ => false,
    };
    if !valid { return Err("服务地址与接口类型不匹配；OCR 必须使用本机地址。".into()); }
    Ok(url)
}
fn service_client(url: &reqwest::Url, timeout: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(timeout)).connect_timeout(Duration::from_secs(timeout.min(20))).redirect(reqwest::redirect::Policy::none());
    if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1")) { builder = builder.no_proxy(); }
    builder.build().map_err(|_| "无法初始化服务连接。".to_string())
}
async fn service_json(mut response: reqwest::Response, local: bool) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(if local { "本地 OCR 未就绪。请启动服务、检查模型下载或缩小框选范围。".into() } else { status_error(response.status().as_u16()) });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取服务结果失败，请重试。".to_string())? {
        if bytes.len() + chunk.len() > 2_000_000 { return Err("服务结果过大，请缩小翻译范围。".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "服务未返回有效的 JSON 响应。".into())
}
async fn send_service(kind: String, mut endpoint: reqwest::Url, payload: String, api_key: String, extra: Value) -> Result<Value, String> {
    let body: Value = serde_json::from_str(&payload).map_err(|_| "服务请求格式无效。".to_string())?;
    let client = service_client(&endpoint, 120)?;
    let mut request = if kind == "mymemory" {
        let query: Vec<(&str, &str)> = ["q", "langpair", "de"].iter().filter_map(|key| body.get(key).and_then(Value::as_str).map(|value| (*key, value))).collect();
        endpoint.query_pairs_mut().extend_pairs(query);
        client.get(endpoint)
    } else {
        client.post(endpoint).header("Content-Type", if kind == "tencent" { "application/json; charset=utf-8" } else { "application/json" }).body(payload)
    };
    if kind == "deepl" {
        if api_key.is_empty() { return Err("请填写 DeepL API Free 密钥。".into()); }
        request = request.header("Authorization", format!("DeepL-Auth-Key {api_key}"));
    }
    if kind == "tencent" {
        let authorization = extra.get("authorization").and_then(Value::as_str).filter(|value| value.starts_with("TC3-HMAC-SHA256 ") && value.len() < 4096).ok_or("腾讯云签名无效。")?;
        let timestamp = extra.get("timestamp").and_then(Value::as_str).filter(|value| value.parse::<u64>().is_ok()).ok_or("腾讯云时间戳无效。")?;
        let region = extra.get("region").and_then(Value::as_str).filter(|value| value.len() < 80 && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'-')).ok_or("腾讯云地域无效。")?;
        request = request.header("Authorization", authorization).header("X-TC-Action", "TextTranslate").header("X-TC-Version", "2018-03-21").header("X-TC-Timestamp", timestamp).header("X-TC-Region", region);
    }
    let local = kind == "ocr" || kind == "ocr-model";
    let response = request.send().await.map_err(|_| if local { "无法连接本地 OCR，请先启动本地 OCR 服务。".to_string() } else { "无法连接翻译服务，请检查地址和网络。".to_string() })?;
    service_json(response, local).await
}

#[tauri::command]
pub async fn local_ocr_health(endpoint: String) -> Result<Value, String> {
    let url = service_endpoint("health", &endpoint)?;
    let response = service_client(&url, 5)?.get(url).send().await.map_err(|_| "无法连接本地 OCR。".to_string())?;
    service_json(response, true).await
}

#[tauri::command]
pub async fn translation_service_request(request_id: String, kind: String, endpoint: String, payload: String, api_key: String, extra: Value) -> Result<Value, String> {
    let url = service_endpoint(&kind, &endpoint)?;
    if kind == "health" || request_id.len() > 80 || payload.len() > 20_000_000 || api_key.len() > 8192 || extra.to_string().len() > 8192 {
        return Err("服务请求无效或图片过大。".into());
    }
    run_registered(request_id, send_service(kind, url, payload, api_key, extra)).await
}
async fn send(endpoint: reqwest::Url, api_key: String, body: Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "无法初始化翻译连接。".to_string())?;
    let mut request = client.post(endpoint).json(&body);
    if !api_key.is_empty() { request = request.bearer_auth(api_key); }
    let network_error = |error: reqwest::Error| if error.is_timeout() { "翻译请求超时，请稍后重试。".to_string() } else { "无法连接翻译服务，请检查地址和网络。".to_string() };
    let mut response = request.send().await.map_err(network_error)?;
    if !response.status().is_success() { return Err(status_error(response.status().as_u16())); }
    // Never echo provider bodies: they may contain credentials or private image data.
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > 2_000_000 { return Err("服务返回的内容过大，请减少翻译范围。".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "服务未返回有效的 JSON 响应，请检查接口地址。".into())
}

#[tauri::command]
pub async fn translation_request(request_id: String, endpoint: String, api_key: String, body: Value) -> Result<Value, String> {
    let url = validate_endpoint(&endpoint)?;
    if request_id.len() > 80 || api_key.len() > 8192 || body.to_string().len() > 20_000_000 || !body.get("messages").is_some_and(Value::is_array) {
        return Err("翻译请求无效或图片过大。".into());
    }
    run_registered(request_id, send(url, api_key, body)).await
}

async fn run_registered<F: Future<Output = Result<Value, String>>>(request_id: String, operation: F) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    {
        let mut registry = requests().lock().map_err(|_| "翻译状态暂时不可用。".to_string())?;
        if let Some(previous) = registry.remove(&request_id) {
            if previous.is_none() { return Err("已取消".into()); }
            registry.insert(request_id, previous);
            return Err("请求编号重复。".into());
        }
        if registry.len() >= 64 { registry.retain(|_, sender| sender.is_some()); }
        if registry.len() >= 64 { return Err("同时运行的翻译请求过多。".into()); }
        registry.insert(request_id.clone(), Some(sender));
    }
    let result = tokio::select! {
        _ = receiver => Err("已取消".to_string()),
        result = operation => result,
    };
    if let Ok(mut registry) = requests().lock() { registry.remove(&request_id); }
    result
}

#[tauri::command]
pub fn cancel_translation_request(request_id: String) {
    if request_id.len() > 80 { return; }
    if let Ok(mut registry) = requests().lock() {
        if let Some(Some(sender)) = registry.remove(&request_id) { let _ = sender.send(()); }
        else if registry.len() < 64 { registry.insert(request_id, None); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread};

    fn local_response(status: u16, body: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(header_end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let length = headers.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if bytes.len() >= header_end + 4 + length { break; }
                }
            }
            write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (endpoint, server)
    }
    #[test]
    fn ocr_stays_local_and_provider_urls_are_verified() {
        assert!(service_endpoint("ocr", "http://127.0.0.1:8876/ocr").is_ok());
        assert!(service_endpoint("health", "http://localhost:8876/health").is_ok());
        assert!(service_endpoint("ocr-model", "http://127.0.0.1:8876/models/prepare").is_ok());
        assert!(service_endpoint("ocr-model", "https://example.com/models/prepare").is_err());
        assert!(service_endpoint("ocr", "https://example.com/ocr").is_err());
        assert!(service_endpoint("ocr", "http://127.0.0.1.attacker.com/ocr").is_err());
        assert!(service_endpoint("mymemory", "https://api.mymemory.translated.net/get").is_ok());
        assert!(service_endpoint("deepl", "https://api-free.deepl.com/v2/translate").is_ok());
        assert!(service_endpoint("deepl", "https://example.com/v2/translate").is_err());
        assert!(service_endpoint("tencent", "https://tmt.tencentcloudapi.com/").is_ok());
        assert!(service_endpoint("libretranslate", "http://localhost:5000/translate").is_ok());
    }
    #[tokio::test]
    async fn local_ocr_transport_posts_image_without_any_cloud_credentials() {
        let (endpoint, server) = local_response(200, r#"{"blocks":[]}"#);
        let endpoint = endpoint.replace("/v1/chat/completions", "/ocr");
        let payload = serde_json::json!({"image":"data:image/jpeg;base64,test-only","language":"ja","readingDirection":"rtl"}).to_string();
        let value = translation_service_request("test-local-ocr".into(), "ocr".into(), endpoint, payload, "should-not-be-sent".into(), serde_json::json!({})).await.unwrap();
        assert_eq!(value["blocks"], serde_json::json!([]));
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /ocr HTTP/1.1"));
        assert!(request.contains("data:image/jpeg;base64,test-only"));
        assert!(!request.contains("should-not-be-sent"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
    }
    #[test]
    fn only_secure_or_loopback_endpoints_are_allowed() {
        assert!(validate_endpoint("https://example.com/v1/chat/completions").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:1234/v1/chat/completions").is_ok());
        assert!(validate_endpoint("http://[::1]:1234/v1/chat/completions").is_ok());
        assert!(validate_endpoint("http://example.com/v1/chat/completions").is_err());
        assert!(validate_endpoint("https://user:secret@example.com/v1/chat/completions").is_err());
        assert!(validate_endpoint("https://example.com/v1/chat/completions?key=secret").is_err());
    }
    #[tokio::test]
    async fn cancellation_before_registration_prevents_request() {
        cancel_translation_request("test-pending-cancel".into());
        let result = translation_request("test-pending-cancel".into(), "http://127.0.0.1:1/v1/chat/completions".into(), String::new(), serde_json::json!({"messages":[]})).await;
        assert_eq!(result.unwrap_err(), "已取消");
    }
    #[tokio::test]
    async fn native_transport_posts_authenticated_json_and_returns_response() {
        let (endpoint, server) = local_response(200, r#"{"choices":[{"message":{"content":"{}"}}]}"#);
        let result = translation_request("test-native-success".into(), endpoint, "test-only-key".into(), serde_json::json!({"model":"vision-model","messages":[]})).await.unwrap();
        assert_eq!(result["choices"][0]["message"]["content"], "{}");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains("authorization: bearer test-only-key"));
        assert!(request.contains("vision-model"));
        assert!(!requests().lock().unwrap().contains_key("test-native-success"));
    }
    #[tokio::test]
    async fn native_transport_does_not_expose_provider_error_body() {
        let (endpoint, server) = local_response(401, r#"{"error":"private-provider-content"}"#);
        let error = translation_request("test-native-error".into(), endpoint, String::new(), serde_json::json!({"messages":[]})).await.unwrap_err();
        server.join().unwrap();
        assert_eq!(error, status_error(401));
        assert!(!error.contains("private-provider-content"));
    }
}
