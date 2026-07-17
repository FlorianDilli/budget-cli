from rich.console import Console
from rich.text import Text


BANNER_ART = """\
██████╗ ██╗   ██╗██████╗  ██████╗ ███████╗████████╗    ██████╗██╗     ██╗
██╔══██╗██║   ██║██╔══██╗██╔════╝ ██╔════╝╚══██╔══╝   ██╔════╝██║     ██║
██████╔╝██║   ██║██║  ██║██║  ███╗█████╗     ██║█████╗██║     ██║     ██║
██╔══██╗██║   ██║██║  ██║██║   ██║██╔══╝     ██║╚════╝██║     ██║     ██║
██████╔╝╚██████╔╝██████╔╝╚██████╔╝███████╗   ██║      ╚██████╗███████╗██║
╚═════╝  ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝   ╚═╝       ╚═════╝╚══════╝╚═╝
"""


def render_banner(console: Console, theme: dict = None) -> None:
    """Prints the (horizontally centered) Budget CLI ASCII banner in the accent color."""
    accent = (theme or {}).get("accent_color", "cyan")
    text = Text(BANNER_ART, style=accent, justify="center")
    console.print(text)
    console.print()
