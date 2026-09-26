import io
import json
import unittest
from urllib.error import URLError
from tencent_bridge import BridgeError, NoRedirect, forward_tencent, tencent_request


def sample():
    return {"payload": '{"SourceText":"こんにちは！","Source":"ja","Target":"zh","ProjectId":0}', "headers": {
        "authorization": "TC3-HMAC-SHA256 Credential=TESTID/2026-09-26/tmt/tc3_request, SignedHeaders=content-type;host, Signature=" + "a" * 64,
        "timestamp": "1790388000", "region": "ap-guangzhou",
    }}


class FakeOpener:
    def __init__(self, value):
        self.value = value
        self.request = None

    def open(self, request, timeout):
        self.request = request
        return io.BytesIO(json.dumps(self.value).encode())


class TencentBridge(unittest.TestCase):
    def test_preserves_signed_unicode_bytes_and_uses_only_text_translate(self):
        body = sample()
        request = tencent_request(body)
        self.assertEqual(request.full_url, "https://tmt.tencentcloudapi.com/")
        self.assertEqual(request.data, body["payload"].encode("utf-8"))
        self.assertEqual(request.get_header("Content-type"), "application/json; charset=utf-8")
        self.assertEqual(request.get_header("X-tc-action"), "TextTranslate")

    def test_preserves_provider_error_code_without_private_error_message(self):
        opener = FakeOpener({"Response": {"Error": {"Code": "FailedOperation.UserNotRegistered", "Message": "private-provider-echo"}, "RequestId": "test-request-id"}})
        result = forward_tencent(sample(), opener)
        self.assertEqual(result["Response"]["Error"]["Code"], "FailedOperation.UserNotRegistered")
        self.assertEqual(result["Response"]["RequestId"], "test-request-id")
        self.assertNotIn("private-provider-echo", json.dumps(result))

    def test_returns_translation(self):
        result = forward_tencent(sample(), FakeOpener({"Response": {"TargetText": "你好！"}}))
        self.assertEqual(result["Response"]["TargetText"], "你好！")

    def test_rejects_images_and_arbitrary_api_operations(self):
        body = sample()
        body["payload"] = json.dumps({"SourceText": "test", "Source": "en", "Target": "zh", "ProjectId": 0, "Image": "private-image"})
        with self.assertRaises(BridgeError):
            tencent_request(body)

    def test_rejects_header_injection(self):
        body = sample()
        body["headers"]["authorization"] += "\r\nX-Other: secret"
        with self.assertRaises(BridgeError):
            tencent_request(body)

    def test_network_error_contains_no_credentials(self):
        class Unavailable:
            def open(self, *_args, **_kwargs):
                raise URLError("private URL and authorization")
        with self.assertRaises(BridgeError) as error:
            forward_tencent(sample(), Unavailable())
        self.assertEqual(str(error.exception), "upstream_connection")

    def test_redirects_cannot_forward_credentials_to_another_host(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.example"))


if __name__ == "__main__":
    unittest.main()
