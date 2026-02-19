from rich.console import Console
from rich.progress_bar import ProgressBar
from rich.panel import Panel

console = Console()

bar_color = "#A1C398"
background_color = "grey37"

progress_bar = ProgressBar(
    total=100,
    completed=100,
    style=background_color,
    complete_style=bar_color,
    finished_style=bar_color,
    width=50,
)

console.print(Panel(progress_bar, title="Test Progress Bar"))
