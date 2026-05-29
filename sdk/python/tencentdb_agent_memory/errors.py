"""TencentDB Agent Memory SDK error types."""

from __future__ import annotations


class TDAMError(Exception):
    """Raised when the API returns a non-zero business code."""

    def __init__(self, code: int, message: str, request_id: str = "") -> None:
        super().__init__()
        self.code = code
        self.message = message
        self.request_id = request_id

    def __str__(self) -> str:
        if self.request_id:
            return (
                f"<TDAMError: (code={self.code}, "
                f"message={self.message}, request_id={self.request_id})>"
            )
        return f"<TDAMError: (code={self.code}, message={self.message})>"


class ParamError(Exception):
    """Raised when caller-supplied parameters are invalid."""
