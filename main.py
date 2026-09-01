import os
import sys
import io
import getpass
import termios
import tty
from datetime import datetime
from decimal import Decimal
from typing import Tuple, Optional

from rich.console import Console, Group
from rich.panel import Panel
from rich.text import Text
from rich.align import Align
from rich.box import SQUARE, DOUBLE
from rich.columns import Columns

# --- Dependency-safe imports ---
# If a required third-party package is missing, show a friendly panel
# instead of a raw stack trace.
try:
    from simple_term_menu import TerminalMenu
    from rich.table import Table
    from rich.progress_bar import ProgressBar
    from rich.prompt import Prompt, Confirm
    from rich.rule import Rule

    from app.core import BudgetEngine
    from app.importer import discover_csv_files, import_transactions
    from app.banner import render_banner

    try:
        import pyfiglet
    except ImportError:
        pyfiglet = None
except ImportError as e:
    _console = Console()
    _missing = getattr(e, "name", None) or str(e).split()[-1] or "a required package"
    _console.print(
        Panel(
            Text.from_markup(
                f"[bold red]Missing dependency:[/bold red] [yellow]{_missing}[/yellow]\n\n"
                "Budget CLI needs a few Python packages to run.\n"
                "Install them with:\n\n"
                "    [bold cyan]pip install -r requirements.txt[/bold cyan]\n\n"
                "If you already did, make sure you are using the same Python\n"
                "environment that you installed the packages into."
            ),
            title="[bold red]Budget CLI could not start[/bold red]",
            border_style="red",
            expand=False,
            padding=(1, 2),
        )
    )
    sys.exit(1)

# --- Constants ---
USER_DATA_BASE = os.getenv("BUDGET_DATA_PATH", "userdata")
DB_PATH = os.path.join(USER_DATA_BASE, "budget.db")
STATEMENTS_DIR = os.path.join(USER_DATA_BASE, "statements")
CONFIG_PATH = os.path.join(USER_DATA_BASE, "config.toml")

# --- TUI components ---
console = Console()


class _FallbackMenu:
    def __init__(self, items, title=""):
        self.items = items
        self.title = title

    def show(self):
        if self.title:
            print(self.title)
        for i, item in enumerate(self.items, 1):
            print(f"  {i}. {item}")
        print()
        try:
            choice = input("Select an option (number, or press Enter to cancel): ").strip()
        except EOFError:
            return None
        if not choice:
            return None
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(self.items):
                return idx
        except ValueError:
            pass
        return None


def build_menu(items, title=""):
    """Constructs a TerminalMenu with a consistent navigation footer.

    Pressing ESC no longer exits the application: a None result is treated
    by the callers as "stay on the current screen".
    """
    try:
        menu = TerminalMenu(
            items,
            title=title,
            quit_keys=("q", "ctrl-g"),
            show_shortcut_hints=True,
        )
        return menu
    except FileNotFoundError:
        return _FallbackMenu(items, title)


def clear_terminal_full():
    """Completely clear the terminal, including scrollback."""
    if os.name == "nt":
        os.system("cls")
    else:
        sys.stdout.write("\033c")
        sys.stdout.flush()

def _render_login_screen(theme, info_text, prompt_label, mask, footer):
    """Renders the complete login screen (outer border, banner, status panel,
    authentication panel with the live masked password, and a dimmed footer)
    to a string.

    The AUTHENTICATION panel is given a fixed, generous size so it never
    resizes while the user types; only the masked line inside it changes.
    """
    # Cap the visible mask length (extra length is simply not shown).
    display_mask = mask[:20]
    # A fixed, generous panel width keeps the box static while typing. The
    # password line is padded with trailing spaces *after* the block cursor so
    # its total width is constant; the block cursor therefore always sits
    # right after the last typed character.
    AUTH_WIDTH = 48
    AUTH_FIELD = 6 + len(prompt_label) + 1 + 20 + 1  # indent + label + space + 20 mask + cursor
    AUTH_INDENT = 6
    status_line = Text.from_markup(f"[bold]STATUS:[/bold] {info_text}")
    trailing = " " * max(0, AUTH_FIELD - (AUTH_INDENT + len(prompt_label) + 1 + len(display_mask) + 1))
    auth_line = (
        f"{' ' * AUTH_INDENT}{prompt_label} [red]{display_mask}[/red]█{trailing}"
    )
    auth_panel = Panel(
        Align.left(Text.from_markup(auth_line, justify="left")),
        title="[bold]AUTHENTICATION[/bold]",
        border_style=theme["main_color"],
        expand=False,
        padding=(1, 4),
        width=AUTH_WIDTH,
    )

    inner = Group(
        Text(""),
        Text(""),
        Text(""),
        render_banner_text(theme),
        Align.center(status_line),
        Text(""),
        Text(""),
        Align.center(auth_panel),
        Text(""),
        Text(""),
        Text(""),
    )

    # Render at the *actual* terminal width so lines never wrap.
    columns = _terminal_width()
    cap = Console(
        width=columns,
        file=io.StringIO(),
        color_system=console.color_system,
        highlight=False,
        force_terminal=True,
    )
    cap.print(
        Panel(inner,         border_style=theme["accent_color"], box=DOUBLE, padding=(1, 2))
    )
    cap.print()
    if footer:
        cap.print(Text(footer, style="dim"))
    cap.print()
    return cap.file.getvalue()


def _terminal_width() -> int:
    """Returns the current terminal width, falling back to a safe default."""
    try:
        return os.get_terminal_size(sys.stdout.fileno()).columns
    except (OSError, ValueError):
        try:
            return os.get_terminal_size().columns
        except (OSError, ValueError):
            return 80


def read_masked_password(render_fn) -> str:
    """Reads a password from the terminal without echoing it, rendering
    each typed character as a red asterisk (inside the auth field) followed
    by a solid block cursor.

    The login screen (including the auth box) is drawn exactly once. On each
    keystroke only the masked line inside the auth panel is overwritten in
    place, so the box never redraws or resizes.

    Falls back to getpass when the terminal is not interactive.
    """
    if not sys.stdin.isatty():
        return getpass.getpass("Password: ")

    password_chars: list[str] = []
    mask = ""

    # Draw the screen once and capture the rendered mask line so we can
    # overwrite just that line later.
    screen = render_fn(mask)
    screen_lines = screen.split("\n")
    # The auth mask line is the only line containing the prompt label.
    mask_line_index = next(
        (i for i, ln in enumerate(screen_lines) if "Password:" in ln), None
    )
    if mask_line_index is None:
        # Fallback: redraw the whole screen each time.
        def redraw():
            sys.stdout.write("\033[2J\033[3J\033[H")
            sys.stdout.write(render_fn(mask))
            sys.stdout.write("\033[J")
            sys.stdout.flush()
        redraw()
    else:
        sys.stdout.write(screen)
        sys.stdout.flush()

    def update_mask_line():
        if mask_line_index is None:
            return
        # Re-render only to obtain the new mask line (same width/position).
        new_screen = render_fn(mask)
        new_line = new_screen.split("\n")[mask_line_index]
        # Move to the mask line, clear it, rewrite it.
        sys.stdout.write(f"\033[{mask_line_index + 1};1H\033[K")
        sys.stdout.write(new_line)
        sys.stdout.flush()

    try:
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        tty.setraw(fd)
        try:
            while True:
                ch = sys.stdin.read(1)
                if ch in ("\r", "\n"):
                    break
                elif ch == "\x03":  # Ctrl-C
                    raise KeyboardInterrupt
                elif ch == "\x7f" or ch == "\b":  # backspace
                    if password_chars:
                        password_chars.pop()
                elif ch >= " ":  # printable
                    password_chars.append(ch)
                mask = "*" * len(password_chars)
                update_mask_line()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
    except (termios.error, OSError):
        return getpass.getpass("Password: ")

    return "".join(password_chars)


def show_password_prompt(is_initial_setup: bool = False, theme: dict = None, footer: str = "") -> str:
    """Prompts the user for their master password with a redesigned login layout."""

    if theme is None:
        theme = {"accent_color": "cyan", "main_color": "cyan"}

    if is_initial_setup:
        info_text = "Set a password to encrypt your new budget file."
    else:
        info_text = "The app is currently locked."

    prompt_label = "Password:"

    password = read_masked_password(
        lambda mask: _render_login_screen(theme, info_text, prompt_label, mask, footer)
    )
    return password


def render_banner_text(theme: dict = None) -> Text:
    """Returns the (horizontally centered) Budget CLI ASCII banner as Text."""
    from app.banner import BANNER_ART
    accent = (theme or {}).get("accent_color", "cyan")
    return Text(BANNER_ART, style=accent, justify="center")

def format_amount(amount: Decimal, currency: str, theme: dict, round_amounts: bool, is_recurring: bool = False) -> Text:
    """Formats a transaction amount with appropriate color."""
    style = f"bold {theme['positive']}" if amount >= 0 else f"bold {theme['negative']}"
    if round_amounts:
        amount = round(amount)
        return Text(f"{amount:.0f} {currency}", style=style, justify="right")
    return Text(f"{amount:.2f} {currency}", style=style, justify="right")

def render_dashboard_title(console: Console, text: str, theme: dict) -> None:
    """Prints the dashboard title as a large visual heading.

    Uses pyfiglet (when available) to render the month as big ASCII text so it
    reads as the dashboard's main heading. Falls back to a bold centered line
    if pyfiglet is not installed.
    """
    accent = theme.get('accent_color', 'cyan')
    if pyfiglet is not None:
        # Render the month (e.g. "July 2026") as larger ASCII art.
        figlet = pyfiglet.Figlet(font='small', width=console.width or 80)
        art = figlet.renderText(text)
        # Large month text serves as the dashboard heading.
        console.print(Align.center(Text(art.rstrip('\n'), style=accent)))
    else:
        console.print(Align.center(Text.from_markup(
            f"[bold {accent}][b]Summary for {text}[/b][/bold {accent}]", justify="center"
        )))


def build_total_money_panel(summary: dict, theme: dict, round_amounts: bool) -> Optional[Panel]:
    """Builds the right-hand 'Total money I have' panel (accounts + cash breakdown).

    Returns None when total money is not configured, so callers can skip it.
    """
    total_money = summary.get('total_money')
    if not total_money or not total_money.get('configured'):
        return None

    currency = summary['currency']

    money_table = Table(show_header=False, box=None, padding=(0, 1), width=34)
    money_table.add_column(style=theme['main_color'], width=20)
    money_table.add_column(style=f"bold {theme['positive']}", justify="right", width=12)

    # Section: Accounts (label, then each account indented beneath it)
    money_table.add_row(Text("Accounts", style=f"bold {theme['main_color']}"), "")
    for acc in total_money['accounts']:
        money_table.add_row(
            f"  {acc['name']}",
            format_amount(Decimal(str(acc['balance'])), currency, theme, round_amounts)
        )
    money_table.add_row(
        "  Cash",
        format_amount(Decimal(str(total_money['cash'])), currency, theme, round_amounts)
    )

    # Total sits below the breakdown, separated by a full-width rule and
    # styled slightly stronger so it stands out from the account rows.
    total_table = Table(show_header=False, box=None, padding=(0, 1), width=34)
    total_table.add_column(style=f"bold {theme['accent_color']}", width=20)
    total_table.add_column(style=f"bold {theme['positive']}", justify="right", width=12)
    total_table.add_row(
        Text("TOTAL:", style=f"bold {theme['accent_color']}"),
        format_amount(total_money['total'], currency, theme, round_amounts)
    )

    content = Group(money_table, Rule(style="dim"), total_table)

    return Panel(
        content,
        title=f"[bold {theme['accent_color']}]Total money I have[/bold {theme['accent_color']}]",
        expand=False,
        border_style=theme['main_color'],
        width=38
    )


def build_progress_table(engine: BudgetEngine, summary: dict, theme: dict, round_amounts: bool) -> Table:
    """Builds the 'How much budget is left' progress bar as a borderless table
    (no nested Panel, so it sits cleanly inside the budget panel)."""
    allowed_spend = summary['allowed_monthly_spend']
    available_to_spend = summary['available_to_spend']
    surplus = summary['surplus']
    currency = summary['currency']
    total_spent = summary.get('total_transactions_sum', Decimal('0'))

    if allowed_spend <= 0:
        remaining_percent = Decimal('0') if available_to_spend >= 0 else Decimal('-100')
        spent_percent = Decimal('100') if available_to_spend < 0 else Decimal('0')
        usage_factor = float(abs(total_spent) / 1) if total_spent is not None and total_spent < 0 else 0.0
    else:
        remaining_percent = (available_to_spend / allowed_spend) * 100
        spent_percent = 100 - remaining_percent
        net_spent = allowed_spend - available_to_spend
        usage_factor = float(net_spent / allowed_spend)

    progress_display = max(0, min(remaining_percent, 100))
    remaining_percent_display = max(0, remaining_percent)

    if remaining_percent >= 100:
        remaining_text = f" {remaining_percent_display:.0f}% remaining"
    elif remaining_percent >= 0:
        remaining_text = f" {remaining_percent_display:.0f}% remaining"
    else:
        remaining_text = f" 0% remaining"

    bar_color = theme.get('positive', "#A1C398")
    background_color = "grey37"

    progress_bar = ProgressBar(
        total=100,
        completed=progress_display,
        style=background_color,
        complete_style=bar_color,
        finished_style=bar_color,
        width=18,
    )

    # Bar + percentage on the SAME line, percentage right-aligned.
    bar_row = Table.grid(expand=False, padding=(0, 0))
    bar_row.add_column(justify="left", width=20)
    bar_row.add_column(justify="right", width=20)
    bar_row.add_row(progress_bar, Text(remaining_text.strip(), style=theme['main_color']))

    progress_block = bar_row

    return progress_block


def build_budget_panel(engine: BudgetEngine, summary: dict, theme: dict, round_amounts: bool) -> Panel:
    """Builds the left-hand 'Budget' panel grouping budget inputs, available
    to spend (headline) and the budget progress bar."""
    currency = summary['currency']
    accent = theme['accent_color']
    dim = "dim"

    # Inputs table (budget + everyday spending)
    inputs_table = Table(show_header=False, box=None, padding=(0, 1), width=42)
    inputs_table.add_column(style=theme['main_color'], width=26)
    inputs_table.add_column(style=f"bold {theme['positive']}", justify="right", width=14)
    inputs_table.add_row("This month's Budget:", format_amount(summary['allowed_monthly_spend'], currency, theme, round_amounts))
    inputs_table.add_row("Everyday spending:", format_amount(summary['monthly_expenses'], currency, theme, round_amounts))

    # Headline row (own table so the amount right-aligns against the divider)
    headline_table = Table(show_header=False, box=None, padding=(0, 1), width=42)
    headline_table.add_column(style=theme['main_color'], width=26)
    headline_table.add_column(style=f"bold {accent}", justify="right", width=14)
    headline_table.add_row(
        Text("Available to Spend:", style=f"bold {accent}"),
        format_amount(summary['available_to_spend'], currency, theme, round_amounts)
    )

    # Full-width divider Rules separate the groups and stretch under the numbers.
    # The divider below "Available to Spend" is intentionally omitted so the
    # progress bar reads as belonging directly to that headline.
    content = Group(
        inputs_table,
        Rule(style=dim),
        headline_table,
        build_progress_table(engine, summary, theme, round_amounts),
    )

    return Panel(
        content,
        title=f"[bold {accent}]Budget[/bold {accent}]",
        expand=False,
        border_style=theme['main_color'],
        width=46
    )


def build_summary_columns(engine: BudgetEngine, summary: dict, theme: dict, round_amounts: bool) -> Columns:
    """Builds the side-by-side summary: a budget panel (left) and a total-money
    panel (right, when configured). Falls back to stacked layout on narrow terminals."""
    left = build_budget_panel(engine, summary, theme, round_amounts)
    right = build_total_money_panel(summary, theme, round_amounts)

    boxes = [left]
    if right is not None:
        boxes.append(right)

    return Columns(boxes, expand=False, equal=False)

def check_config_and_notify(engine: BudgetEngine) -> dict:
    """Checks if config changed and prints notification. Returns reload info or None."""
    reload_info = engine.check_and_reload_config_if_changed()
    if reload_info:
        count = reload_info['count']
        if count > 0:
            console.print(
                Panel(
                    Text.from_markup(
                        f"[green]✔ Your changes to [cyan]config.toml[/cyan] were applied automatically.[/green]\n"
                        f"[dim]{count} transaction{'s' if count != 1 else ''} "
                        f"{'were' if count != 1 else 'was'} re-categorized and re-checked.[/dim]"
                    ),
                    border_style="green",
                    expand=False,
                    padding=(0, 2),
                )
            )
        else:
            console.print(
                Panel(
                    Text.from_markup(
                        "[green]✔ Your [cyan]config.toml[/cyan] changes were picked up.[/green]\n"
                        "[dim]No transactions needed updating this time.[/dim]"
                    ),
                    border_style="green",
                    expand=False,
                    padding=(0, 2),
                )
            )
    return reload_info

def format_reload_time(timestamp: float) -> str:
    """Formats a config reload timestamp relative to now.

    - Under an hour ago (same day): "X minutes ago"
    - Over an hour ago (same day): "X hours ago"
    - The previous calendar day: "yesterday at HH:MM"
    - Older than that: the date ("YYYY-MM-DD at HH:MM")
    """
    if not timestamp:
        return "unknown"

    reloaded = datetime.fromtimestamp(timestamp)
    now = datetime.now()
    delta = now - reloaded

    # Future timestamps (clock skew) or just now.
    total_seconds = delta.total_seconds()
    if total_seconds < 0:
        return "just now"

    same_day = reloaded.date() == now.date()

    if same_day and total_seconds < 3600:
        minutes = int(total_seconds // 60)
        if minutes <= 0:
            return "just now"
        return f"{minutes} minute{'s' if minutes != 1 else ''} ago"

    if same_day:
        hours = int(total_seconds // 3600)
        return f"{hours} hour{'s' if hours != 1 else ''} ago"

    days_diff = (now.date() - reloaded.date()).days
    if days_diff == 1:
        return f"yesterday at {reloaded.strftime('%H:%M')}"

    return f"on {reloaded.strftime('%Y-%m-%d')} at {reloaded.strftime('%H:%M')}"


def show_status_footer(engine: BudgetEngine):
    """Renders a footer line showing the data path and last config reload."""
    theme = engine.config.get("theme", {})
    main_color = theme.get("main_color", "cyan")

    data_path = os.path.abspath(USER_DATA_BASE)
    reload_display = format_reload_time(getattr(engine, "_config_mtime", None))

    footer = Text(justify="center")
    footer.append("Data: ", style="dim")
    footer.append(data_path, style=main_color)
    footer.append("   •   ", style="dim")
    footer.append("Config reloaded ", style="dim")
    footer.append(reload_display, style=main_color)

    console.print()
    console.print(footer)


def show_main_dashboard(engine: BudgetEngine):
    """Displays the main dashboard with a summary and recent transactions."""
    check_config_and_notify(engine)
    summary = engine.get_dashboard_summary()
    theme = engine.config.get("theme", {})

    # The top spending view should also be for the latest month
    latest_month = summary.get("latest_month", datetime.now().strftime('%B %Y'))
    month_str, year = latest_month.split()
    month = datetime.strptime(month_str, "%B").strftime("%m")

    top_spending_view = engine.get_top_spending_for_month(year, month, limit=10)

    console.clear()

    # Header
    console.print(Align.center(render_banner_text(theme)))
    console.print()

    # --- Empty state: no transactions imported yet ---
    if not engine.get_available_months():
        welcome = (
            "[bold green]Welcome to Budget CLI![/bold green]\n\n"
            "Your budget file is set up and encrypted. There is no transaction "
            "data yet, so there is nothing to summarize.\n\n"
            "[bold]Get started in three steps:[/bold]\n"
            "  1.  Open [cyan]config.toml[/cyan] and add your recurring income and expenses\n"
            "      (e.g. salary, rent) under [cyan][[recurring_transactions]][/cyan].\n"
            "  2.  Export a bank statement as CSV and drop it into the\n"
            "      [cyan]statements[/cyan] folder.\n"
            "  3.  Choose [bold]Import Statements[/bold] from the main menu.\n\n"
            "[dim]Tip: the FAQ.md explains every setting in detail.[/dim]"
        )
        console.print(
            Panel(
                Text.from_markup(welcome),
                title=f"[bold {theme['accent_color']}]Nothing here yet[/bold {theme['accent_color']}]",
                border_style=theme['main_color'],
                expand=False,
                padding=(1, 2),
            ),
            justify="center",
        )
        show_status_footer(engine)
        return

    # Summary: side-by-side budget panel (left) and total-money panel (right)
    round_amounts = engine.config.get('user', {}).get('round_amounts', False)
    render_dashboard_title(console, latest_month, theme)
    console.print()
    console.print(Align.center(build_summary_columns(engine, summary, theme, round_amounts)))

    # --- Alerts Panel ---
    if summary.get('alerts'):
        console.print()
        console.print()
        alert_table = Table(show_header=False, box=None, padding=(0, 1))
        alert_table.add_column(style="bold yellow")
        for alert in summary['alerts']:
            alert_table.add_row(f"⚠ {alert}")
        
        console.print(Panel(alert_table, title=f"[bold yellow]Budget Alerts[/bold yellow]", expand=False, border_style="yellow"), justify="center")

    # Top 10 Spending View

    top_spending_table = Table(title=f"[bold {theme['accent_color']}]Top 10 Transactions & Categories in {latest_month}[/bold {theme['accent_color']}]", expand=True, border_style=theme['main_color'], show_lines=True)
    top_spending_table.add_column("Name", style=theme['main_color'])
    top_spending_table.add_column("Amount", justify="right")
    top_spending_table.add_column("Type", style=theme['main_color'])

    for item in top_spending_view:
        amount_text = format_amount(item['amount'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False), item.get('is_recurring', False))
        name = f"[{theme.get('recurring_transaction_highlight', 'yellow')}]{item['name']}[/{theme.get('recurring_transaction_highlight', 'yellow')}]" if item.get('is_recurring') else item['name']
        if item['type'] == "Category":
            type_label = f"[bold {theme['accent_color']}]Category (Σ)[/]"
        else:
            type_label = "Single Transaction"
        top_spending_table.add_row(name, amount_text, type_label)
        
    console.print()
    console.print()
    console.print(top_spending_table)
    show_status_footer(engine)


def show_history_view(engine: BudgetEngine):
    """Displays the transaction history, allowing filtering by month."""
    check_config_and_notify(engine)
    
    while True:
        available_months = engine.get_available_months()
        if not available_months:
            console.clear()
            console.print(
                Panel(
                    f"[bold {engine.config['theme']['accent_color']}]Budget CLI[/bold {engine.config['theme']['accent_color']}]",
                    expand=False,
                    border_style=engine.config['theme']['main_color']
                )
            )
            console.print()
            console.print()
            console.print("[yellow]No transactions found.[/yellow]")
            Prompt.ask("\nPress Enter to return to the main menu.")
            return

        # --- Month Selection Menu ---
        def format_month_display(year, month):
            name = datetime.strptime(f"{year}-{month}-01", "%Y-%m-%d").strftime("%B")
            return f"{name:<12} {year}"
        
        month_map = {(year, month): format_month_display(year, month) for year, month in available_months}
        month_map_inv = {v: k for k, v in month_map.items()}
        sorted_months = sorted(available_months, key=lambda x: x, reverse=True)
        
        month_menu_items = []
        year_separator = f"{'─' * 20}"
        prev_year = None
        for year, month in sorted_months:
            if prev_year is not None and year != prev_year:
                month_menu_items.append(year_separator)
            month_menu_items.append(month_map[(year, month)])
            prev_year = year
        month_menu_items.append("[ Back to Main Menu ]")
        
        console.clear()
        console.print(Panel(f"[bold {engine.config['theme']['accent_color']}]Transaction History[/bold {engine.config['theme']['accent_color']}]", expand=False, border_style=engine.config['theme']['main_color']))
        console.print()
        console.print()
        
        terminal_menu = build_menu(
            month_menu_items,
            title="Select a month to view transactions:",
        )
        menu_index = terminal_menu.show()
        
        while True:
            if menu_index is None:
                return
            selected = month_menu_items[menu_index]
            if selected == "[ Back to Main Menu ]":
                return
            if selected == year_separator:
                menu_index = terminal_menu.show()
                continue
            break
        
        selected_month_str = month_menu_items[menu_index]
        year, month = month_map_inv[selected_month_str]
        
        summary = engine.get_monthly_summary(year, month)
        transactions = engine.get_transactions_for_month(year, month)
        theme = engine.config.get("theme", {})

        console.clear()

        # --- Header ---
        console.print(
            Panel(
                f"[bold {theme['accent_color']}]Budget CLI[/bold {theme['accent_color']}]",
                expand=False,
                border_style=theme['main_color']
            )
        )
        console.print()
        console.print()
        
        month_title = datetime.strptime(f"{year}-{month}-01", "%Y-%m-%d").strftime("%B %Y")

        # --- Summary View (side-by-side budget + total money) ---
        round_amounts = engine.config.get('user', {}).get('round_amounts', False)
        render_dashboard_title(console, month_title, theme)
        console.print()
        console.print(Align.center(build_summary_columns(engine, summary, theme, round_amounts)))

        # --- Alerts Panel ---
        if summary.get('alerts'):
            console.print()
            console.print()
            alert_table = Table(show_header=False, box=None, padding=(0, 1))
            alert_table.add_column(style="bold yellow")
            for alert in summary['alerts']:
                alert_table.add_row(f"⚠ {alert}")
            
            console.print(Panel(alert_table, title=f"[bold yellow]Budget Alerts[/bold yellow]", expand=False, border_style="yellow"), justify="center")

        # --- Top 10 Spending View for the Month ---
        top_spending_view = engine.get_top_spending_for_month(year, month, limit=10)
        
        if top_spending_view:

            top_spending_table = Table(title=f"[bold {engine.config['theme']['accent_color']}]Top 10 Transactions & Categories in {month_title}[/bold {engine.config['theme']['accent_color']}]", expand=True, border_style=engine.config['theme']['main_color'], show_lines=True)
            top_spending_table.add_column("Name", style=engine.config['theme']['main_color'])
            top_spending_table.add_column("Amount", justify="right")
            top_spending_table.add_column("Type", style=engine.config['theme']['main_color'])
            
            for item in top_spending_view:
                amount_text = format_amount(item['amount'], summary['currency'], engine.config['theme'], engine.config.get('user', {}).get('round_amounts', False), item.get('is_recurring', False))
                name = f"[{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]{item['name']}[/{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]" if item.get('is_recurring') else item['name']
                if item['type'] == "Category":
                    type_label = f"[bold {engine.config['theme']['accent_color']}]Category (Σ)[/]"
                else:
                    type_label = "Single Transaction"
                top_spending_table.add_row(name, amount_text, type_label)
                
            console.print()
            console.print()
            console.print(top_spending_table)

        # --- Full Transaction Table ---
        console.print()
        trans_table = Table(title=f"[bold {theme['accent_color']}]All Transactions for {month_title}[/bold {theme['accent_color']}]", expand=True, border_style=theme['main_color'], show_lines=True)
        trans_table.add_column("Date", style="dim")
        trans_table.add_column("Description", style=engine.config['theme']['main_color'])
        trans_table.add_column("Amount", justify="right")
        trans_table.add_column("Category", style=engine.config['theme']['main_color'])
        trans_table.add_column("Status", justify="center")

        if not transactions:
            console.print("[dim]No transactions for this month.[/dim]")
        else:
            for t in transactions:
                amount_text = format_amount(t['amount'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False), t.get('is_recurring', False))
                description = f"[{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]{t['description']}[/{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]" if t.get('is_recurring') else t['description']
                category = t['category'] if t['category'] else "Uncategorized"
                
                status_parts = []
                error_codes = t.get('error_codes', [])
                for error_code in error_codes:
                    if error_code == "AMOUNT_MISMATCH":
                        status_parts.append("[bold red]⚠ Amount Mismatch[/bold red]")
                    elif error_code == "WRONG_MONTH":
                        status_parts.append("[bold yellow]⚠ Wrong Month[/bold yellow]")
                    elif error_code == "VERIFIED":
                        status_parts.append("[green]✔ Verified[/green]")
                status = " | ".join(status_parts) if status_parts else ""

                trans_table.add_row(t['date'], description, amount_text, category, status)
            console.print(trans_table)

        # Wait for user to continue
        Prompt.ask("\nPress Enter to select another month.")

def run_importer(engine: BudgetEngine):
    """Handles the logic for importing transactions from CSV files."""
    check_config_and_notify(engine)
    console.clear()
    theme = engine.config['theme']

    # Standard Header
    console.print(Panel(f"[bold {theme['accent_color']}]Import Transactions[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']))
    console.print()

    csv_files = discover_csv_files(STATEMENTS_DIR)
    if not csv_files:
        console.print(f"[yellow]No CSV files found in '{STATEMENTS_DIR}'.[/yellow]")
        Prompt.ask("\n[dim][Enter] Back to menu[/dim]")
        return

    # Selection Panel
    file_list = ""
    for f in csv_files:
        basename = os.path.basename(f)
        if len(basename) > 40:
            basename = basename[:37] + "..."
        file_list += f" [yellow]●[/yellow] {basename}\n"

    selection_content = f"\n [dim]Found {len(csv_files)} statement file{'s' if len(csv_files) > 1 else ''}[/dim]\n\n{file_list}"
    
    console.print(Panel(
        selection_content,
        title=f"[bold {theme['accent_color']}]Statement Detection[/bold {theme['accent_color']}]",
        border_style=theme['main_color'],
        expand=False,
        padding=(0, 1)
    ))

    if Confirm.ask("\n [dim]Do you want to proceed with the import? [y/N][/dim]"):
        total_imported = 0
        for f in csv_files:
            basename = os.path.basename(f)
            with console.status(f"[bold {theme['accent_color']}]Importing {basename}…[/bold {theme['accent_color']}]", spinner="dots"):
                result = import_transactions(engine, f, STATEMENTS_DIR)

            console.print()
            console.print(Rule(f"[bold] {result.get('filename', os.path.basename(f))} [/bold]", style=theme['main_color']))
            
            if "error" in result:
                console.print(f" [bold red]Error:[/bold red] {result['error']}")
            else:
                console.print(f" [dim]Format detected:[/dim] [cyan]{result['format_name']}[/cyan]")
                console.print()

                imported = result['imported_count']
                skipped = result['skipped_count']
                archived = result.get('archived', False)

                results_text = f"  [green]✓[/green]  {imported} [dim]new transactions[/dim]\n"
                results_text += f"  [yellow]◌[/yellow]  {skipped} [dim]duplicates skipped[/dim]\n"
                if archived:
                    results_text += f"  [blue]▸[/blue]  [dim]Source file archived[/dim]"
                else:
                    results_text += f"  [red]⚠[/red]  [red]Archive failed[/red]"

                console.print(Panel(
                    results_text,
                    border_style=theme['main_color'],
                    expand=False,
                    padding=(1, 2)
                ))
                total_imported += imported
        
        console.print()
        summary_box = f"[green]✓[/green] [bold]Import complete[/bold]"
        if total_imported > 0:
            summary_box += f"\n[dim]Added[/dim] [green]{total_imported}[/green] [dim]new transactions to your history[/dim]"
        else:
            summary_box += f"\n[dim]No new transactions were added[/dim]"

        console.print(Panel(
            summary_box,
            border_style="green",
            expand=False,
            padding=(1, 4)
        ))
    
    Prompt.ask("\n[dim][Enter] Back to menu[/dim]")


def show_monthly_overview(engine: BudgetEngine):
    """Displays a summary table for all months with transactions."""
    check_config_and_notify(engine)
    summaries = engine.get_all_months_summary()
    theme = engine.config.get("theme", {})
    round_amounts = engine.config.get('user', {}).get('round_amounts', False)

    console.clear()
    console.print(Panel(f"[bold {theme['accent_color']}]Monthly Overview[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']))
    console.print()

    if not summaries:
        console.print("[yellow]No transactions found.[/yellow]")
        Prompt.ask("\nPress Enter to return to the main menu.")
        return

    # --- Insights: average total transaction amount per finished month ---
    # The current month is excluded because it may still be missing some
    # important transactions, which would skew the average.
    now = datetime.now()
    finished_summaries = [
        s for s in summaries
        if not (int(s['year']) == now.year and int(s['month']) == now.month)
    ]

    if finished_summaries:
        # get_available_months() returns months in descending order, so
        # finished_summaries is ordered most-recent-first as well.
        currency = finished_summaries[0]['currency']

        insights_grid = Table.grid(padding=(0, 1))
        insights_grid.add_column(style=theme['main_color'])
        insights_grid.add_column()

        # Average over the past 3 finished months (or fewer if not available).
        recent_summaries = finished_summaries[:3]
        recent_total = sum(s['total_spent'] for s in recent_summaries)
        recent_average = recent_total / len(recent_summaries)
        recent_average_text = format_amount(recent_average, currency, theme, round_amounts)
        insights_grid.add_row(
            f"Average total per month (last {len(recent_summaries)} finished month{'' if len(recent_summaries) == 1 else 's'}):",
            recent_average_text,
        )

        # Average over all finished months.
        total_of_finished = sum(s['total_spent'] for s in finished_summaries)
        average_per_month = total_of_finished / len(finished_summaries)
        average_text = format_amount(average_per_month, currency, theme, round_amounts)
        insights_grid.add_row(
            f"Average total per month (all {len(finished_summaries)} finished month{'' if len(finished_summaries) == 1 else 's'}):",
            average_text,
        )
        console.print(Panel(
            insights_grid,
            title=f"[bold {theme['accent_color']}]Insights[/bold {theme['accent_color']}]",
            title_align="center",
            border_style=theme['main_color'],
            expand=False,
        ), justify="center")
        console.print()

    has_total_money = any(s.get('total_money', {}).get('configured') for s in summaries)

    table = Table(expand=True, border_style=theme['main_color'], show_lines=True)
    table.add_column("Month", style=theme['accent_color'])
    table.add_column("Available to Spend", justify="right")
    table.add_column("How much budget is left")
    table.add_column("Sum of all transactions", justify="right")
    if has_total_money:
        configured_day = engine.get_total_money_as_of_day()
        if configured_day:
            money_header = f"Total money I have (as of day {configured_day})"
        else:
            money_header = "Total money I have"
        table.add_column(money_header, justify="right")

    for s in summaries:
        is_current_month = (int(s['year']) == now.year and int(s['month']) == now.month)
        if is_current_month:
            month_title = datetime.strptime(f"{s['year']}-{s['month']}-01", "%Y-%m-%d").strftime("%B %Y") + " [dim](incomplete)[/dim]"
        else:
            month_title = datetime.strptime(f"{s['year']}-{s['month']}-01", "%Y-%m-%d").strftime("%B %Y")
        
        spent_text = format_amount(s['total_spent'], s['currency'], theme, round_amounts)
        remaining_text = format_amount(s['available'], s['currency'], theme, round_amounts)

        # Calculate progress factor and display
        # Logic aligned with show_budget_progress
        if s['budget'] <= 0:
            remaining_percent = Decimal('0') if s['available'] >= 0 else Decimal('-100')
            usage_factor = float(abs(s['total_spent']) / 1) if s['total_spent'] < 0 else 0.0
        else:
            remaining_percent = (s['available'] / s['budget']) * 100
            # Align with dashboard: usage is (Budget - Available) / Budget
            net_spent = s['budget'] - s['available']
            usage_factor = float(net_spent / s['budget'])
        
        # For the progress bar, clamp the value between 0 and 100
        # Note: show_budget_progress shows REMAINING budget, so we do the same for consistency
        progress_display = float(max(0, min(remaining_percent, 100)))

        # Text display can show the actual percentage
        remaining_percent_display = max(0, remaining_percent)

        # --- Text for the progress bar ---
        # "x% remaining" stays to the right of the bar; the "x% of budget used"
        # detail is moved onto its own line below so the two numbers don't crowd.
        if remaining_percent >= 100:
            # Budget is still fully available (100% remaining). The surplus is
            # already reflected in the "Available to Spend" column, so there is
            # no need to repeat it here.
            remaining_text_line = f" {remaining_percent_display:.0f}% remaining"
            usage_line = ""
        elif remaining_percent >= 0:
            remaining_text_line = f" {remaining_percent_display:.0f}% remaining"
            usage_line = f" {usage_factor:.1f}% of budget used"
        else:
            # Over budget
            remaining_text_line = f" 0% remaining"
            usage_line = f" {usage_factor:.1f}x of budget used"

        # The fill color reflects "money still available", so use the theme's
        # 'positive' color.
        bar_color = theme.get('positive', "#A1C398")
        # Use a neutral background for the progress bar to avoid "two greens" or "red/green" confusion
        # when we want to show "how much is left"
        background_color = "grey37"

        progress_bar = ProgressBar(
            total=100,
            completed=progress_display,
            style=background_color,
            complete_style=bar_color,
            finished_style=bar_color,
            width=20,
        )
        
        usage_grid = Table.grid(padding=(0, 1))
        usage_grid.add_column(justify="left")
        usage_grid.add_column(justify="right")
        if usage_line:
            usage_grid.add_row(progress_bar, Text(remaining_text_line, style=theme['main_color']))
            usage_grid.add_row(Text(usage_line, style="dim"), "")
        else:
            usage_grid.add_row(progress_bar, Text(remaining_text_line, style=theme['main_color']))

        if has_total_money:
            total_money_text = format_amount(
                s['total_money']['total'], s['currency'], theme, round_amounts
            )
            table.add_row(month_title, remaining_text, usage_grid, spent_text, total_money_text)
        else:
            table.add_row(month_title, remaining_text, usage_grid, spent_text)

    console.print(table)
    Prompt.ask("\nPress Enter to return to the main menu.")


def show_delete_data_view(engine: BudgetEngine):
    """Handles the UI for deleting data."""
    console.clear()
    console.print(Panel(f"[bold {engine.config['theme']['negative']}]Delete Data[/bold {engine.config['theme']['negative']}]", expand=False, border_style=engine.config['theme']['main_color']))
    console.print()
    console.print()

    menu_items = [
        "Delete a single month's data",
        "Delete all data (full reset)",
        "[ Back to Main Menu ]"
    ]
    terminal_menu = build_menu(
        menu_items,
        title="Select an option:",
    )
    menu_index = terminal_menu.show()

    if menu_index == 0:
        # --- Delete Single Month ---
        available_months = engine.get_available_months()
        if not available_months:
            console.print("[yellow]No transaction data found to delete.[/yellow]")
            Prompt.ask("\nPress Enter to return.")
            return

        month_map = {f"{year}-{month}": (year, month) for year, month in available_months}
        month_menu_items = sorted(month_map.keys(), reverse=True) + ["[ Cancel ]"]
        
        month_menu = build_menu(
            month_menu_items,
            title="Select a month to delete:",
        )
        selected_index = month_menu.show()

        if selected_index is not None and month_menu_items[selected_index] != "[ Cancel ]":
            selected_month_str = month_menu_items[selected_index]
            year, month = month_map[selected_month_str]
            
            month_title = datetime.strptime(f"{year}-{month}-01", "%Y-%m-%d").strftime("%B %Y")

            if Confirm.ask(f"[bold {engine.config['theme']['negative']}]Are you sure you want to permanently delete all data for {month_title}?[/bold {engine.config['theme']['negative']}]"):
                try:
                    deleted_count = engine.delete_month_data(year, month)
                    console.print(f"\n[bold green]Successfully deleted {deleted_count} transactions for {month_title}.[/bold green]")
                except Exception as e:
                    console.print(f"\n[bold red]Error:[/bold red] {e}")
            else:
                console.print("\nDeletion cancelled.")
        
        Prompt.ask("\nPress Enter to return to the main menu.")
        
    elif menu_index == 1:
        # --- Full Reset ---
        console.print("\n[bold red]This will permanently delete all your data, including transactions and your password salt.[/bold red]")
        console.print("[bold red]The application will be reset to a clean state. This action cannot be undone.[/bold red]")
        
        if Confirm.ask("\n[bold yellow]Are you absolutely sure you want to proceed with a full reset?[/bold yellow]"):
            try:
                engine.full_reset()
                console.print("\n[bold green]Application has been reset. Please restart the application.[/bold green]")
                Prompt.ask("\nPress Enter to exit.")
                return "reset_exit"
            except Exception as e:
                console.print(f"\n[bold red]Error during reset:[/bold red] {e}")
                Prompt.ask("\nPress Enter to return to the main menu.")
        else:
            console.print("\nFull reset cancelled.")
            Prompt.ask("\nPress Enter to return to the main menu.")
            
    elif menu_index == 2 or menu_index is None:
        return


def show_change_password_view(engine: BudgetEngine):
    """Handles the UI for changing the master password."""
    console.clear()
    theme = engine.config.get("theme", {})
    console.print(Panel(f"[bold {theme['accent_color']}]Change Master Password[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']))
    console.print()
    console.print("Changing your password will re-encrypt all your data.")
    console.print("A backup of your database will be created automatically.")
    console.print()

    current_password = getpass.getpass("Enter current password: ")
    new_password = getpass.getpass("Enter new password: ")
    confirm_password = getpass.getpass("Confirm new password: ")

    if new_password != confirm_password:
        console.print(f"\n[bold {theme.get('negative', 'red')}]Error: New passwords do not match.[/bold {theme.get('negative', 'red')}]")
        Prompt.ask("\nPress Enter to return.")
        return

    if not new_password:
        console.print(f"\n[bold {theme.get('negative', 'red')}]Error: Password cannot be empty.[/bold {theme.get('negative', 'red')}]")
        Prompt.ask("\nPress Enter to return.")
        return

    if Confirm.ask("\nAre you sure you want to change your password?"):
        try:
            with console.status("[bold green]Changing password and re-encrypting data...[/bold green]"):
                engine.change_password(current_password, new_password)
            console.print(f"\n[bold green]Password changed successfully![/bold green]")
        except Exception as e:
            console.print(f"\n[bold {theme.get('negative', 'red')}]Error changing password:[/bold {theme.get('negative', 'red')}] {e}")
    
    Prompt.ask("\nPress Enter to return to the main menu.")


def main():
    """The main entry point of the application."""
    
    # Ensure data directories exist (for DB, config, and statements)
    if sys.stdout.isatty():
        sys.stdout.write("\033[2J\033[3J\033[H")
        sys.stdout.flush()
    else:
        console.clear()
    if USER_DATA_BASE != "userdata":
        debug_footer = f"Using custom data path: {USER_DATA_BASE}"
    else:
        debug_footer = ""
    
    os.makedirs(USER_DATA_BASE, exist_ok=True)
    os.makedirs(STATEMENTS_DIR, exist_ok=True)
    
    
    # --- Initialization ---
    engine = None
    while not engine:
        # If the database file doesn't exist, it's the initial setup
        is_initial_setup = not os.path.exists(DB_PATH)
        
        # Temporarily load config to get theme for password prompt
        temp_config = {}
        # Load the example config to get the default theme for the initial setup
        config_path = CONFIG_PATH if os.path.exists(CONFIG_PATH) else "config.example.toml"
        
        try:
            import toml
            temp_config = toml.load(config_path)
            theme = temp_config.get("theme", {"accent_color": "#00FFFF", "main_color": "#00FFFF"})
        except (IOError, toml.TomlDecodeError) as e:
            console.print(f"[bold red]Error loading theme from {config_path}: {e}[/bold red]")
            theme = {"accent_color": "#00FFFF", "main_color": "#00FFFF"}


        password = show_password_prompt(is_initial_setup, theme, footer=debug_footer)
        try:
            engine = BudgetEngine(DB_PATH, password, config_path=CONFIG_PATH)

            # This is a bit of a hack, but we need to get the number of updated transactions
            # from the engine after the startup categorization.
            # We can't do this inside the engine itself, as it would require passing the console object.
            
            updated_count = engine.recategorize_transactions()
            if updated_count > 0:
                console.print(f"\n[bold green]Config updated! {updated_count} transactions were updated on startup.[/bold green]")


        except RuntimeError as e:
            if "Incorrect password" in str(e):
                console.print(f"\n[bold {theme.get('negative', 'red')}]Wrong password, please try again.[/bold {theme.get('negative', 'red')}]\n")
            else:
                console.print(f"\n[bold {theme.get('negative', 'red')}]Error:[/bold {theme.get('negative', 'red')}] {e}")
                return
        except ValueError as e:
            console.print(f"\n[bold {theme.get('negative', 'red')}]Invalid configuration in {CONFIG_PATH}:[/bold {theme.get('negative', 'red')}]")
            console.print(f"[dim]{e}[/dim]")
            console.print(f"[yellow]Please fix your config.toml and try again.[/yellow]\n")
            return
        except Exception as e:
            console.print(f"\n[bold {theme.get('negative', 'red')}]Error:[/bold {theme.get('negative', 'red')}] Failed to initialize. Corrupted data?")
            console.print(f"[dim]{e}[/dim]")
            return

    # --- Main Loop ---
    while True:
        show_main_dashboard(engine)
        
        menu_items = [
            "View History",
            "Monthly Overview",
            "Import Statements",
            "Change Master Password",
            "Delete Data",
            "Exit"
        ]
        terminal_menu = build_menu(
            menu_items,
            title="\nWhat would you like to do?",
        )
        menu_index = terminal_menu.show()

        if menu_index == 0:
            show_history_view(engine)
        elif menu_index == 1:
            show_monthly_overview(engine)
        elif menu_index == 2:
            run_importer(engine)
        elif menu_index == 3:
            show_change_password_view(engine)
        elif menu_index == 4:
            result = show_delete_data_view(engine)
            if result == "reset_exit":
                clear_terminal_full()
                break
        elif menu_index == 5:
            clear_terminal_full()
            break
        # menu_index is None (ESC) -> do nothing, redraw the dashboard

    clear_terminal_full()
    console.print(f"[bold {engine.config['theme']['accent_color']}]Goodbye![/bold {engine.config['theme']['accent_color']}]")


if __name__ == "__main__":
    main()
