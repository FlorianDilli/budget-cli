import os
from typing import Any, Dict

from rich.theme import Theme


THEME_LEGACY_KEYS = {
    "accent_color": "heading",
    "main_color": "text",
    "positive": "income",
    "negative": "expense",
    "recurring_transaction_highlight": "recurring",
}

THEME_DEFAULTS: Dict[str, str] = {
    "text":     "#FBF6E2",
    "text_muted": "#9A9382",
    "border":   "#4F4A3E",
    "heading":    "bold #FFCF71",
    "income":   "bold #A1C398",
    "expense":  "bold #FA7070",
    "recurring":"#E2B59A",
    "warning":    "bold #E89B3C",
    "danger":   "bold #FA7070",
    "info":     "#8FB8C9",
}


def build_theme(config: Dict[str, Any]) -> Theme:
    theme_cfg = config.get("theme", {})

    merged = dict(THEME_DEFAULTS)
    # Legacy keys map onto the new semantic tokens, but must not override an
    # explicit new-token value if both are present in the same config.
    for key, value in theme_cfg.items():
        if key in THEME_LEGACY_KEYS:
            merged[THEME_LEGACY_KEYS[key]] = value
    # New token keys take precedence over the legacy aliases above.
    for key, value in theme_cfg.items():
        if key not in THEME_LEGACY_KEYS:
            merged[key] = value

    return Theme(merged)


def get_theme_console(config: Dict[str, Any]):
    from rich.console import Console
    return Console(theme=build_theme(config))
