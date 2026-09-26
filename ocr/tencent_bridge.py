"""Forward signed text requests to one fixed Tencent endpoint, without CORS."""
import json
import re
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

ENDPOINT = "https://tmt.tencentcloudapi.com/"
AUTHORIZATION = re.compile(r"TC3-HMAC-SHA256 Credential=[A-Za-z0-9_-]{1,160}/\d{4}-\d{2}-\d{2}/tmt/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}")


class BridgeError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def tencent_request(body):
    payload, headers = body.get("payload"), body.get("headers")
    if not isinstance(payload, str) or len(payload.encode("utf-8")) > 64_000 or not isinstance(headers, dict):
        raise BridgeError("invalid_request")
    try:
        data = json.loads(payload)
    except (ValueError, TypeError):
        raise BridgeError("invalid_request")
    if not isinstance(data, dict) or set(data) != {"SourceText", "Source", "Target", "ProjectId"}:
        raise BridgeError("invalid_request")
    if not isinstance(data["SourceText"], str) or not 0 < len(data["SourceText"].encode("utf-8")) <= 6000 or data["ProjectId"] != 0:
        raise BridgeError("invalid_request")
    if not all(isinstance(data[key], str) and re.fullmatch(r"(?:auto|[a-z]{2}(?:-TW)?)", data[key]) for key in ("Source", "Target")):
        raise BridgeError("invalid_request")
    authorization, timestamp, region = (headers.get(key) for key in ("authorization", "timestamp", "region"))
    if not isinstance(authorization, str) or not AUTHORIZATION.fullmatch(authorization):
        raise BridgeError("invalid_request")
    if not isinstance(timestamp, str) or not re.fullmatch(r"\d{1,12}", timestamp) or not isinstance(region, str) or not re.fullmatch(r"[a-z-]{1,80}", region):
        raise BridgeError("invalid_request")
    # Send exactly the signed bytes. Re-serializing JSON would invalidate TC3.
    return Request(ENDPOINT, payload.encode("utf-8"), {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": authorization,
        "X-TC-Action": "TextTranslate",
        "X-TC-Version": "2018-03-21",
        "X-TC-Timestamp": timestamp,
        "X-TC-Region": region,
    }, method="POST")


def forward_tencent(body, opener=None):
    request = tencent_request(body)
    opener = opener or build_opener(NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=45)
        except HTTPError as error:
            if 300 <= error.code < 400:
                raise BridgeError("upstream_connection")
            response = error
        with response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise BridgeError("upstream_response")
        value = json.loads(raw)
        result = value.get("Response") if isinstance(value, dict) else None
        if not isinstance(result, dict):
            raise BridgeError("upstream_response")
        if isinstance(result.get("Error"), dict):
            code = result["Error"].get("Code")
            if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", code):
                raise BridgeError("upstream_response")
            safe = {"Error": {"Code": code}}
        elif isinstance(result.get("TargetText"), str):
            safe = {"TargetText": result["TargetText"]}
        else:
            raise BridgeError("upstream_response")
        request_id = result.get("RequestId")
        if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9-]{1,128}", request_id):
            safe["RequestId"] = request_id
        return {"Response": safe}
    except BridgeError:
        raise
    except (URLError, OSError):
        raise BridgeError("upstream_connection")
    except (ValueError, TypeError):
        raise BridgeError("upstream_response")
