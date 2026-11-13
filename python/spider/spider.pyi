from typing import Any, Callable, Dict, List, Optional
from spider_types import RequestParamsDict
from spider_browser import SpiderBrowser

class RateLimitState:
    limit: int
    remaining: int
    reset_seconds: int
    def update_from_headers(self, headers: Any) -> None: ...

class RateLimitExhaustedError(Exception):
    endpoint: str
    attempts: int
    last_retry_after: float
    status_code: int
    message: str

class StreamResult:
    processed: int
    failed: int
    errors: List[str]
    @property
    def total(self) -> int: ...
    @property
    def ok(self) -> bool: ...
    @property
    def error_summary(self) -> str: ...

class Spider:
    api_key: str
    rate_limit: RateLimitState
    max_rate_limit_retries: int

    def __init__(
        self,
        api_key: Optional[str] = None,
        ai_studio_tier: str = "starter",
        max_rate_limit_retries: Optional[int] = None,
    ) -> None: ...
    def api_post(
        self,
        endpoint: str,
        data: dict,
        stream: bool,
        content_type: str = "application/json",
    ) -> Any: ...
    def api_get(
        self, endpoint: str, stream: bool, content_type: str = "application/json"
    ) -> Any: ...
    def api_delete(
        self, endpoint: str, stream: bool, content_type: str = "application/json"
    ) -> Any: ...
    def scrape_url(
        self,
        url: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def crawl_url(
        self,
        url: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def links(
        self,
        url: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def screenshot(
        self,
        url: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def search(
        self,
        q: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def transform(
        self,
        data: Any,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def get_credits(self) -> Any: ...
    def ai_crawl(
        self,
        url: str,
        prompt: str,
        params: Optional[RequestParamsDict] = None,
    ) -> Any: ...
    def ai_scrape(
        self,
        url: str,
        prompt: str,
        params: Optional[RequestParamsDict] = None,
    ) -> Any: ...
    def ai_search(
        self,
        prompt: str,
        params: Optional[RequestParamsDict] = None,
    ) -> Any: ...
    def ai_browser(
        self,
        url: str,
        prompt: str,
        params: Optional[RequestParamsDict] = None,
    ) -> Any: ...
    def ai_links(
        self,
        url: str,
        prompt: str,
        params: Optional[RequestParamsDict] = None,
    ) -> Any: ...
    def unlimited_scrape(
        self,
        url: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def unlimited_crawl(
        self,
        url: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def unlimited_links(
        self,
        url: str,
        params: Optional[RequestParamsDict] = None,
        stream: bool = False,
        content_type: str = "application/json",
    ) -> Any: ...
    def stream_reader(
        self, response: Any, callback: Callable[[Dict[str, Any]], None]
    ) -> StreamResult: ...
    def browser(self, **options: Any) -> SpiderBrowser: ...
    def data_post(
        self, table: str, data: Optional[RequestParamsDict] = None
    ) -> Any: ...
    def data_get(
        self,
        table: str,
        params: Optional[RequestParamsDict] = None,
    ) -> Any: ...
    def _request_with_rate_limit_retries(
        self, endpoint: str, send: Callable[[], Any]
    ) -> Any: ...
    @staticmethod
    def _parse_retry_after(headers: Any) -> float: ...
    @staticmethod
    def _iter_stream_lines(response: Any) -> Any: ...
    def _prepare_headers(
        self, content_type: str = "application/json"
    ) -> Dict[str, str]: ...
    def _post_request(
        self, url: str, data: Any, headers: Dict[str, str], stream: bool = False
    ) -> Any: ...
    def _get_request(
        self, url: str, headers: Dict[str, str], stream: bool = False
    ) -> Any: ...
    def _delete_request(
        self, url: str, headers: Dict[str, str], stream: bool = False
    ) -> Any: ...
    def _handle_error(self, response: Any, action: str) -> None: ...
