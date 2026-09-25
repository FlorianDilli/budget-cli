import os
import shutil
import signal
import sys
import getpass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Tuple, Optional

from rich.console import Console, Group
from rich.panel import Panel
from rich.text import Text
from rich.align import Align
from rich.box import ASCII
from rich.columns import Columns
from rich.theme import Theme

from app.theme import build_theme, THEME_DEFAULTS

# --- Dependency-safe imports ---
# If a required third-party package is missing, show a friendly panel
# instead of a raw stack trace.
try:
    from simple_term_menu import TerminalMenu
    from rich.table import Table
    from rich.prompt import Prompt, Confirm
    from rich.rule import Rule

    from app.core import BudgetEngine
    from app.importer import discover_csv_files, import_transactions
    from app.banner import render_banner, BANNER_ART

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
SCRIPT_DIR = Path(__file__).resolve().parent
USER_DATA_BASE = os.getenv("BUDGET_DATA_PATH", str(SCRIPT_DIR / "userdata"))
DB_PATH = os.path.join(USER_DATA_BASE, "budget.db")
STATEMENTS_DIR = os.path.join(USER_DATA_BASE, "statements")
CONFIG_PATH = os.path.join(USER_DATA_BASE, "settings.toml")

# --- TUI components ---
# console is created with a default theme; engine init replaces it with the
# user's configured theme via console.push_theme(build_theme(engine.config)).
console = Console(theme=Theme(THEME_DEFAULTS))


def _login_theme() -> Theme:
    return Theme(THEME_DEFAULTS)


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
            menu_cursor_style=("fg_red", "bold"),
            menu_highlight_style=("standout",),
            shortcut_key_highlight_style=("fg_blue",),
        )
        return menu
    except (FileNotFoundError, NotImplementedError, OSError):
        return _FallbackMenu(items, title)


def build_categorized_menu(categories):
    """Builds a TerminalMenu with categorized sections using the title.

    categories: dict mapping section header -> list of item strings,
    or an iterable of (header, items) pairs.
    Returns (menu, flat_items) where flat_items is the concatenated
    list of all items and menu is the TerminalMenu instance.
    """
    flat_items = []
    title_lines = []
    if isinstance(categories, dict):
        iterator = categories.items()
    else:
        iterator = categories
    for header, items in iterator:
        title_lines.append(header)
        flat_items.extend(items)
        title_lines.append("")
    title = "\n".join(title_lines)
    menu = build_menu(flat_items, title=title)
    return menu, flat_items


def clear_terminal_full():
    """Completely clear the terminal, including scrollback."""
    if os.name == "nt":
        os.system("cls")
    else:
        sys.stdout.write("\033c")
        sys.stdout.flush()

def _render_login_screen(theme, info_text, prompt_label, mask, footer):
    """Renders the complete login screen to the console."""
    display_mask = mask[:20]

    banner_text = render_banner_text(theme)
    status_line = Text.from_markup(f"[bold]{info_text}[/bold]", justify="center")

    inner = Group(
        Text(""),
        Text(""),
        banner_text,
        Text(""),
        status_line,
        Text(""),
    )

    bordered_panel = Panel(
        inner,
        border_style="border",
        box=ASCII,
        padding=(0, 2),
    )

    footer_text = Text(footer, style="text_muted") if footer else Text("")

    screen = Group(
        Align.center(bordered_panel),
        Text(""),
        footer_text,
    )

    cap = Console(
        theme=theme,
        color_system=console.color_system,
        highlight=False,
        force_terminal=True,
    )
    cap.print(screen)



def read_masked_password(render_fn, prompt_label="Password:", theme=None) -> str:
    """Reads a password from the terminal without echoing it."""
    clear_terminal_full()
    render_fn("")
    return getpass.getpass(prompt_label)


def show_password_prompt(is_initial_setup: bool = False, theme=None, footer: str = "") -> str:
    """Prompts the user for their master password with a redesigned login layout."""
    if theme is None:
        theme = _login_theme()

    info_text = "Set a password to encrypt your new budget file." if is_initial_setup else "The app is currently locked."
    prompt_label = "Password:"

    password = read_masked_password(
        lambda mask: _render_login_screen(theme, info_text, prompt_label, mask, footer),
        prompt_label=prompt_label,
        theme=theme,
    )
    return password


def render_banner_text(theme) -> Text:
    """Returns the Budget CLI ASCII banner as centered Text."""
    from app.banner import BANNER_ART
    return Text(BANNER_ART, style="heading", justify="center")


def format_amount(amount: Decimal, currency: str, theme, round_amounts: bool, is_recurring: bool = False) -> Text:
    """Formats a transaction amount with the appropriate color."""
    style = "income" if amount >= 0 else "expense"
    if round_amounts:
        amount = round(amount)
        return Text(f"{amount:.0f} {currency}", style=style, justify="right")
    return Text(f"{amount:.2f} {currency}", style=style, justify="right")


def render_dashboard_title(console: Console, text: str, theme) -> None:
    """Prints the dashboard title as a large visual heading."""
    if pyfiglet is not None:
        figlet = pyfiglet.Figlet(font='small', width=console.width or 80)
        art = figlet.renderText(text)
        console.print(Align.center(Text(art.rstrip('\n'), style="heading")))
    else:
        console.print(Align.center(Text.from_markup(
            f"[bold heading]Summary for {text}[/bold heading]", justify="center"
        )))


def build_total_money_panel(summary: dict, round_amounts: bool) -> Optional[Panel]:
    """Builds the right-hand 'Total money' panel."""
    total_money = summary.get('total_money')
    if not total_money or not total_money.get('configured'):
        return None

    currency = summary['currency']

    money_table = Table(show_header=False, box=None, padding=(0, 1), width=34)
    money_table.add_column(style="text", width=20)
    money_table.add_column(style="income", justify="right", width=12)

    money_table.add_row(Text("Accounts", style="bold text"), "")
    for acc in total_money['accounts']:
        money_table.add_row(
            f"  {acc['name']}",
            format_amount(Decimal(str(acc['balance'])), currency, None, round_amounts)
        )
    money_table.add_row(
        "  Cash",
        format_amount(Decimal(str(total_money['cash'])), currency, None, round_amounts)
    )

    total_table = Table(show_header=False, box=None, padding=(0, 1), width=34)
    total_table.add_column(style="heading", width=20)
    total_table.add_column(style="income", justify="right", width=12)
    total_table.add_row(
        Text("TOTAL:", style="bold heading"),
        format_amount(total_money['total'], currency, None, round_amounts)
    )

    content = Group(money_table, Rule(style="text_muted"), total_table)

    return Panel(
        content,
        title="[bold heading]Total money[/bold heading]",
        expand=False,
        border_style="border",
        width=38
    )


def build_budget_panel(engine: BudgetEngine, summary: dict, round_amounts: bool) -> Panel:
    """Builds the left-hand 'Budget' panel."""
    currency = summary['currency']

    inputs_table = Table(show_header=False, box=None, padding=(0, 1), width=42)
    inputs_table.add_column(style="text", width=26)
    inputs_table.add_column(style="income", justify="right", width=14)
    inputs_table.add_row("This month's Budget:", format_amount(summary['allowed_monthly_spend'], currency, None, round_amounts))
    inputs_table.add_row("Budget Impact (Non recurring transactions):", format_amount(summary['monthly_expenses'], currency, None, round_amounts))

    headline_table = Table(show_header=False, box=None, padding=(0, 1), width=42)
    headline_table.add_column(style="text", width=26)
    headline_table.add_column(style="heading", justify="right", width=14)
    headline_table.add_row(
        Text("Available to Spend:", style="bold heading"),
        format_amount(summary['available_to_spend'], currency, None, round_amounts)
    )

    content = Group(
        inputs_table,
        Rule(style="text_muted"),
        headline_table,
    )

    return Panel(
        content,
        title="[bold heading]Budget[/bold heading]",
        expand=False,
        border_style="border",
        width=46
    )


def build_summary_columns(engine: BudgetEngine, summary: dict, round_amounts: bool) -> Columns:
    """Builds the side-by-side summary: budget panel (left) and total-money panel (right)."""
    left = build_budget_panel(engine, summary, round_amounts)
    right = build_total_money_panel(summary, round_amounts)

    boxes = [left]
    if right is not None:
        boxes.append(right)

    return Columns(boxes, expand=False, equal=False)


def check_config_and_notify(engine: BudgetEngine) -> dict:
    """Checks if config changed and prints notification."""
    reload_info = engine.check_and_reload_config_if_changed()
    if reload_info:
        count = reload_info['count']
        if count > 0:
            console.print(
                Panel(
                    Text.from_markup(
                        f"[income]✔ Your changes to [info]settings.toml[/info] / [info]financials.toml[/info] were applied automatically.[/income]\n"
                        f"[text_muted]{count} transaction{'s' if count != 1 else ''} "
                        f"{'were' if count != 1 else 'was'} re-categorized and re-checked.[/text_muted]"
                    ),
                    border_style="income",
                    expand=False,
                    padding=(0, 2),
                )
            )
        else:
            console.print(
                Panel(
                    Text.from_markup(
                        "[income]✔ Your [info]settings.toml[/info] / [info]financials.toml[/info] changes were picked up.[/income]\n"
                        "[text_muted]No transactions needed updating this time.[/text_muted]"
                    ),
                    border_style="income",
                    expand=False,
                    padding=(0, 2),
                )
            )
    return reload_info


def format_reload_time(timestamp: float) -> str:
    """Formats a file modification timestamp relative to now."""
    if not timestamp:
        return "unknown"

    reloaded = datetime.fromtimestamp(timestamp)
    now = datetime.now()
    delta = now - reloaded

    if delta.total_seconds() < 0:
        return "just now"

    total_seconds = delta.total_seconds()

    if total_seconds < 3600:
        minutes = int(total_seconds // 60)
        if minutes <= 0:
            return "just now"
        return f"{minutes} minute{'s' if minutes != 1 else ''} ago"

    if total_seconds < 86400:
        hours = int(total_seconds // 3600)
        return f"{hours} hour{'s' if hours != 1 else ''} ago"

    days_diff = int(total_seconds // 86400)
    return f"{days_diff} day{'s' if days_diff != 1 else ''} ago"


def show_status_footer(engine: BudgetEngine):
    """Renders a footer line showing the data path and last modification times of settings.toml and financials.toml."""
    data_path = os.path.abspath(USER_DATA_BASE)
    settings_display = format_reload_time(getattr(engine, "_config_mtime", None))
    finance_display = format_reload_time(getattr(engine, "_finance_mtime", None))

    footer = Text(justify="center")
    footer.append("Data: ", style="text_muted")
    footer.append(data_path, style="info")
    footer.append("   •   ", style="text_muted")
    footer.append("settings.toml last modified ", style="text_muted")
    footer.append(settings_display, style="info")
    footer.append("   •   ", style="text_muted")
    footer.append("financials.toml last modified ", style="text_muted")
    footer.append(finance_display, style="info")

    console.print()
    console.print(footer)


def show_main_dashboard(engine: BudgetEngine):
    """Displays the main dashboard with a summary and recent transactions."""
    check_config_and_notify(engine)
    summary = engine.get_dashboard_summary()

    latest_month = summary.get("latest_month", datetime.now().strftime('%B %Y'))
    month_str, year = latest_month.split()
    month = datetime.strptime(month_str, "%B").strftime("%m")

    top_spending_view = engine.get_top_spending_for_month(year, month, limit=10)

    clear_terminal_full()

    console.print(Align.center(render_banner_text(None)))
    console.print()

    if not engine.get_available_months():
        welcome = (
            "[bold income]Welcome to Budget CLI![/bold income]\n\n"
            "Your budget file is set up and encrypted. There is no transaction "
            "data yet, so there is nothing to summarize.\n\n"
            "[bold]Get started in three steps:[/bold]\n"
            "  1.  Open [info]financials.toml[/info] and add your recurring income and expenses\n"
            "      (e.g. salary, rent) under [info][[recurring_transactions]][/info].\n"
            "  2.  Export a bank statement as CSV and drop it into the\n"
            "      [info]statements[/info] folder.\n"
            "  3.  Choose [bold]Import Statements[/bold] from the main menu.\n\n"
            "[text_muted]Tip: the FAQ.md explains every setting in detail.[/text_muted]"
        )
        console.print(
            Panel(
                Text.from_markup(welcome),
                title="[bold heading]Nothing here yet[/bold heading]",
                border_style="border",
                expand=False,
                padding=(1, 2),
            ),
            justify="center",
        )
        show_status_footer(engine)
        return

    round_amounts = engine.config.get('user', {}).get('round_amounts', False)
    render_dashboard_title(console, latest_month, None)
    console.print()
    console.print(Align.center(build_summary_columns(engine, summary, round_amounts)))

    if summary.get('alerts'):
        console.print()
        console.print()
        alert_table = Table(show_header=False, box=None, padding=(0, 1))
        alert_table.add_column(style="warning")
        for alert in summary['alerts']:
            alert_table.add_row(f"⚠ {alert}")

        console.print(Panel(alert_table, title="[bold warning]Budget Alerts[/bold warning]", expand=False, border_style="warning"), justify="center")

    top_spending_table = Table(
        title="[bold heading]Top 10 Transactions & Categories in {latest_month}[/bold heading]".format(latest_month=latest_month),
        expand=True, border_style="border", show_lines=True)
    top_spending_table.add_column("Name", style="text")
    top_spending_table.add_column("Amount", justify="right")
    top_spending_table.add_column("Type", style="text")

    for item in top_spending_view:
        amount_text = format_amount(item['amount'], summary['currency'], None, engine.config.get('user', {}).get('round_amounts', False), item.get('is_recurring', False))
        name = f"[recurring]↻ {item['name']}[/recurring]" if item.get('is_recurring') else item['name']
        if item['type'] == "Category":
            type_label = "[bold heading]Category (Σ)[/bold heading]"
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
            clear_terminal_full()
            console.print(
                Panel(
                    f"[bold heading]Budget CLI[/bold heading]",
                    expand=False,
                    border_style="border"
                )
            )
            console.print()
            console.print()
            console.print("[warning]No transactions found.[/warning]")
            Prompt.ask("\n[ Back to Main Menu ]")
            return

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

        clear_terminal_full()
        console.print(Panel(f"[bold heading]Transaction History[/bold heading]", expand=False, border_style="border"))
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

        clear_terminal_full()

        console.print(
            Panel(
                f"[bold heading]Budget CLI[/bold heading]",
                expand=False,
                border_style="border"
            )
        )
        console.print()
        console.print()

        month_title = datetime.strptime(f"{year}-{month}-01", "%Y-%m-%d").strftime("%B %Y")

        round_amounts = engine.config.get('user', {}).get('round_amounts', False)
        render_dashboard_title(console, month_title, None)
        console.print()
        console.print(Align.center(build_summary_columns(engine, summary, round_amounts)))

        if summary.get('alerts'):
            console.print()
            console.print()
            alert_table = Table(show_header=False, box=None, padding=(0, 1))
            alert_table.add_column(style="warning")
            for alert in summary['alerts']:
                alert_table.add_row(f"⚠ {alert}")

            console.print(Panel(alert_table, title="[bold warning]Budget Alerts[/bold warning]", expand=False, border_style="warning"), justify="center")

        top_spending_view = engine.get_top_spending_for_month(year, month, limit=10)

        if top_spending_view:

            top_spending_table = Table(
                title="[bold heading]Top 10 Transactions & Categories in {month_title}[/bold heading]".format(month_title=month_title),
                expand=True, border_style="border", show_lines=True)
            top_spending_table.add_column("Name", style="text")
            top_spending_table.add_column("Amount", justify="right")
            top_spending_table.add_column("Type", style="text")

            for item in top_spending_view:
                amount_text = format_amount(item['amount'], summary['currency'], None, engine.config.get('user', {}).get('round_amounts', False), item.get('is_recurring', False))
                name = f"[recurring]↻ {item['name']}[/recurring]" if item.get('is_recurring') else item['name']
                if item['type'] == "Category":
                    type_label = "[bold heading]Category (Σ)[/bold heading]"
                else:
                    type_label = "Single Transaction"
                top_spending_table.add_row(name, amount_text, type_label)

            console.print()
            console.print()
            console.print(top_spending_table)

        console.print()
        trans_table = Table(
            title="[bold heading]All Transactions for {month_title}[/bold heading]".format(month_title=month_title),
            expand=True, border_style="border", show_lines=True)
        trans_table.add_column("Date", style="text_muted")
        trans_table.add_column("Description", style="text")
        trans_table.add_column("Amount", justify="right")
        trans_table.add_column("Category", style="text")
        trans_table.add_column("Status", justify="center")

        if not transactions:
            console.print("[text_muted]No transactions for this month.[/text_muted]")
        else:
            for t in transactions:
                amount_text = format_amount(t['amount'], summary['currency'], None, engine.config.get('user', {}).get('round_amounts', False), t.get('is_recurring', False))
                description = f"[recurring]↻ {t['description']}[/recurring]" if t.get('is_recurring') else t['description']
                category = t['category'] if t['category'] else "Uncategorized"

                status_parts = []
                error_codes = t.get('error_codes', [])
                for error_code in error_codes:
                    if error_code == "AMOUNT_MISMATCH":
                        status_parts.append("[bold danger]⚠ Amount Mismatch[/bold danger]")
                    elif error_code == "WRONG_MONTH":
                        status_parts.append("[bold warning]⚠ Wrong Month[/bold warning]")
                    elif error_code == "VERIFIED":
                        status_parts.append("[income]✔ Matched[/income]")
                status = " | ".join(status_parts) if status_parts else "[text_muted]—[/text_muted]"

                trans_table.add_row(t['date'], description, amount_text, category, status)
            console.print(trans_table)
            console.print("[text_muted]↻ = recurring · ✔ Matched = amount matches planned recurring amount · — = no flags[/text_muted]")

        Prompt.ask("\nPress Enter to select another month.")


def run_importer(engine: BudgetEngine):
    """Handles the logic for importing transactions from CSV files."""
    check_config_and_notify(engine)
    clear_terminal_full()

    console.print(Panel("[bold heading]Import Transactions[/bold heading]", expand=False, border_style="border"))
    console.print()

    csv_files = discover_csv_files(STATEMENTS_DIR)
    if not csv_files:
        console.print("[warning]No CSV files found in '{dir}'.[/warning]".format(dir=STATEMENTS_DIR))
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    file_list = ""
    for f in csv_files:
        basename = os.path.basename(f)
        if len(basename) > 40:
            basename = basename[:37] + "..."
        file_list += f" [warning]●[/warning] {basename}\n"

    selection_content = f"\n [text_muted]Found {len(csv_files)} statement file{'s' if len(csv_files) != 1 else ''}[/text_muted]\n\n{file_list}"

    console.print(Panel(
        selection_content,
        title="[bold heading]Statement Detection[/bold heading]",
        border_style="border",
        expand=False,
        padding=(0, 1)
    ))

    if Confirm.ask("\n [text_muted]Do you want to proceed with the import? [y/N][/text_muted]"):
        total_imported = 0
        for f in csv_files:
            basename = os.path.basename(f)
            with console.status(f"[bold heading]Importing {basename}…[/bold heading]", spinner="dots"):
                result = import_transactions(engine, f, STATEMENTS_DIR)

            console.print()
            console.print(Rule(f"[bold] {result.get('filename', os.path.basename(f))} [/bold]", style="heading"))

            if "error" in result:
                console.print(f" [bold danger]Error:[/bold danger] {result['error']}")
            else:
                console.print(f" [text_muted]Format detected:[/text_muted] [info]{result['format_name']}[/info]")
                console.print()

                imported = result['imported_count']
                skipped = result['skipped_count']
                archived = result.get('archived', False)

                results_text = f"  [income]✓[/income]  {imported} [text_muted]new transactions[/text_muted]\n"
                results_text += f"  [warning]◌[/warning]  {skipped} [text_muted]duplicates skipped[/text_muted]\n"
                if archived:
                    results_text += f"  [info]▸[/info]  [text_muted]Source file archived[/text_muted]"
                else:
                    results_text += f"  [danger]⚠[/danger]  [danger]Archive failed[/danger]"

                console.print(Panel(
                    results_text,
                    border_style="border",
                    expand=False,
                    padding=(1, 2)
                ))
                total_imported += imported

        console.print()
        summary_box = "[income]✓[/income] [bold]Import complete[/bold]"
        if total_imported > 0:
            summary_box += f"\n[text_muted]Added[/text_muted] [income]{total_imported}[/income] [text_muted]new transactions to your history[/text_muted]"
        else:
            summary_box += f"\n[text_muted]No new transactions were added[/text_muted]"

        console.print(Panel(
            summary_box,
            border_style="income",
            expand=False,
            padding=(1, 4)
        ))

    Prompt.ask("\n[ Back to Main Menu ]")


def show_monthly_overview(engine: BudgetEngine):
    """Displays a summary table for all months with transactions."""
    check_config_and_notify(engine)
    summaries = engine.get_all_months_summary()
    round_amounts = engine.config.get('user', {}).get('round_amounts', False)

    clear_terminal_full()
    console.print(Panel("[bold heading]Months at a glance[/bold heading]", expand=False, border_style="border"))
    console.print()

    if not summaries:
        console.print("[warning]No transactions found.[/warning]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    now = datetime.now()
    finished_summaries = [
        s for s in summaries
        if not (int(s['year']) == now.year and int(s['month']) == now.month)
    ]

    if finished_summaries:
        currency = finished_summaries[0]['currency']

        insights_grid = Table.grid(padding=(0, 1))
        insights_grid.add_column(style="text")
        insights_grid.add_column()

        recent_summaries = finished_summaries[:3]
        recent_total = sum(s['total_spent'] for s in recent_summaries)
        recent_average = recent_total / len(recent_summaries)
        recent_average_text = format_amount(recent_average, currency, None, round_amounts)
        insights_grid.add_row(
            f"Average total in the last 3 finished months:",
            recent_average_text,
        )

        total_of_finished = sum(s['total_spent'] for s in finished_summaries)
        average_per_month = total_of_finished / len(finished_summaries)
        average_text = format_amount(average_per_month, currency, None, round_amounts)
        insights_grid.add_row(
            f"Average total of all {len(finished_summaries)} finished months:",
            average_text,
        )
        console.print(Panel(
            insights_grid,
            title="[bold heading]Insights[/bold heading]",
            title_align="center",
            border_style="border",
            expand=False,
        ), justify="center")
        console.print()

    has_total_money = any(s.get('total_money', {}).get('configured') for s in summaries)

    table = Table(expand=True, border_style="border", show_lines=True)
    table.add_column("Month", style="heading")
    table.add_column("This month's budget", justify="right")
    table.add_column("Budget Impact (Non recurring transactions)", justify="right")
    table.add_column("Available to Spend", justify="right")
    if has_total_money:
        configured_day = engine.get_total_money_as_of_day()
        if configured_day:
            money_header = f"Total money (as of day {configured_day})"
        else:
            money_header = "Total money"
        table.add_column(money_header, justify="right")

    for s in summaries:
        is_current_month = (int(s['year']) == now.year and int(s['month']) == now.month)
        date_str = datetime.strptime(f"{s['year']}-{s['month']}-01", "%Y-%m-%d").strftime("%B %Y")
        if is_current_month:
            month_title = f"{date_str} [text_muted](incomplete)[/text_muted]"
        else:
            month_title = date_str

        budget_text = format_amount(s['budget'], s['currency'], None, round_amounts)
        spent_text = format_amount(s['total_spent'], s['currency'], None, round_amounts)
        remaining_text = format_amount(s['available'], s['currency'], None, round_amounts)

        if has_total_money:
            total_money_text = format_amount(
                s['total_money']['total'], s['currency'], None, round_amounts
            )
            table.add_row(month_title, budget_text, spent_text, remaining_text, total_money_text)
        else:
            table.add_row(month_title, budget_text, spent_text, remaining_text)

    console.print(table)
    Prompt.ask("\n[ Back to Main Menu ]")


def show_delete_data_view(engine: BudgetEngine):
    """Handles the UI for deleting data."""
    clear_terminal_full()
    console.print(Panel("[bold danger]Delete Data[/bold danger]", expand=False, border_style="border"))
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
        available_months = engine.get_available_months()
        if not available_months:
            console.print("[warning]No transaction data found to delete.[/warning]")
            Prompt.ask("\n[ Back to Main Menu ]")
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

            if Confirm.ask(f"[bold danger]Are you sure you want to permanently delete all data for {month_title}?[/bold danger]"):
                try:
                    deleted_count = engine.delete_month_data(year, month)
                    console.print(f"\n[bold income]Successfully deleted {deleted_count} transactions for {month_title}.[/bold income]")
                except Exception as e:
                    console.print(f"\n[bold danger]Error:[/bold danger] {e}")
            else:
                console.print("\nDeletion cancelled.")

        Prompt.ask("\n[ Back to Main Menu ]")

    elif menu_index == 1:
        console.print("\n[bold danger]This will permanently delete all your data, including transactions and your password salt.[/bold danger]")
        console.print("[bold danger]The application will be reset to a clean state. This action cannot be undone.[/bold danger]")

        if Confirm.ask("\n[bold warning]Are you absolutely sure you want to proceed with a full reset?[/bold warning]"):
            try:
                engine.full_reset()
                console.print("\n[bold income]Application has been reset. Please restart the application.[/bold income]")
                Prompt.ask("\nPress Enter to exit.")
                return "reset_exit"
            except Exception as e:
                console.print(f"\n[bold danger]Error during reset:[/bold danger] {e}")
                Prompt.ask("\n[ Back to Main Menu ]")
        else:
            console.print("\nFull reset cancelled.")
            Prompt.ask("\n[ Back to Main Menu ]")

    elif menu_index == 2 or menu_index is None:
        return


def show_change_password_view(engine: BudgetEngine):
    """Handles the UI for changing the master password."""
    clear_terminal_full()
    console.print(Panel("[bold heading]Change Master Password[/bold heading]", expand=False, border_style="border"))
    console.print()
    console.print("Changing your password will re-encrypt all your data.")
    console.print("A backup of your database will be created automatically.")
    console.print()

    current_password = getpass.getpass("Enter current password: ")
    new_password = getpass.getpass("Enter new password: ")
    confirm_password = getpass.getpass("Confirm new password: ")

    if new_password != confirm_password:
        console.print(f"\n[bold danger]Error: New passwords do not match.[/bold danger]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    if not new_password:
        console.print(f"\n[bold danger]Error: Password cannot be empty.[/bold danger]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    if Confirm.ask("\nAre you sure you want to change your password?"):
        try:
            with console.status("[bold income]Changing password and re-encrypting data...[/bold income]", spinner="dots"):
                engine.change_password(current_password, new_password)
            console.print(f"\n[bold income]Password changed successfully![/bold income]")
        except Exception as e:
            console.print(f"\n[bold danger]Error changing password:[/bold danger] {e}")

    Prompt.ask("\n[ Back to Main Menu ]")


def show_prediction_view(engine: BudgetEngine):
    check_config_and_notify(engine)
    clear_terminal_full()

    console.print(Panel("[bold heading]Simulate the future[/bold heading]", expand=False, border_style="border"))
    console.print()

    today = datetime.now()
    total_money = engine.get_total_money_at(today)
    if not total_money.get('configured'):
        console.print("[warning]No account balances or cash entries are configured.[/warning]")
        console.print("[text_muted]Please configure at least one account with a balance snapshot in settings.toml,[/text_muted]")
        console.print("[text_muted]or add cash entries in financials.toml.[/text_muted]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    with console.status("[bold heading]Running Monte Carlo simulation...[/bold heading]", spinner="dots"):
        prediction = engine.predict_runway()

    currency = engine.config['user']['currency_symbol']
    round_amounts = engine.config.get('user', {}).get('round_amounts', False)
    current_balance_text = format_amount(Decimal(str(total_money['total'])), currency, None, round_amounts)

    hist_months = prediction.get('historical_months_used', 12)
    mc_runs = prediction.get('mc_runs', 2000)
    horizon = prediction.get('horizon_months', 24)

    console.print(f"[text_muted]The following prediction is based on the past {hist_months} months of transactions "
                  f"and {mc_runs} simulated possible futures over the next {horizon} months.[/text_muted]")
    console.print()

    if prediction['status'] == 'No Money':
        console.print(f"[danger]{prediction['detail']}[/danger]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    if prediction['status'] == 'Sustainable':
        console.print(Panel(
            f"[income]✔ Sustainable[/income]\n\n"
            f"Your recurring income exceeds expenses by [income]{prediction['structural_monthly_drift']} {currency}[/income] per month.\n\n"
            f"[text_muted]{prediction['detail']}[/text_muted]",
            title="[bold heading]Prediction Result[/bold heading]",
            border_style="income",
            expand=False,
            padding=(1, 2)
        ))
        console.print(f"Current balance: {current_balance_text}")
    elif prediction['status'] == 'Slow depletion expected':
        console.print(Panel(
            f"[warning]⚠ Slow depletion expected[/warning]\n\n"
            f"Your balance may run out after the {horizon}-month simulation horizon.\n\n"
            f"[text_muted]{prediction['detail']}[/text_muted]",
            title="[bold heading]Prediction Result[/bold heading]",
            border_style="warning",
            expand=False,
            padding=(1, 2)
        ))
        console.print(f"Current balance: {current_balance_text}")
    else:
        depletion_month = prediction['depletion_month']
        risk_pct = prediction['depletion_risk_pct']

        console.print(Panel(
            f"[danger]⚠ Depletion likely in {depletion_month}[/danger]\n\n"
            f"[text_muted]{prediction['detail']}[/text_muted]\n\n"
            f"Likelihood of this prediction: [danger]{risk_pct}%[/danger]\n"
            f"Current balance: {current_balance_text}",
            title="[bold heading]Prediction Result[/bold heading]",
            border_style="danger",
            expand=False,
            padding=(1, 2)
        ))

    Prompt.ask("\n[ Back to Main Menu ]")


def show_plot_view(engine: BudgetEngine):
    """Displays a terminal-native line plot of historical total money."""
    check_config_and_notify(engine)
    summaries = engine.get_all_months_summary()
    round_amounts = engine.config.get('user', {}).get('round_amounts', False)

    clear_terminal_full()
    console.print(Panel("[bold heading]Total Money Over Time[/bold heading]", expand=False, border_style="border"))
    console.print()

    if not summaries:
        console.print("[warning]No transactions found.[/warning]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    has_total_money = any(s.get('total_money', {}).get('configured') for s in summaries)
    if not has_total_money:
        console.print("[warning]No account balances or cash entries are configured.[/warning]")
        console.print("[text_muted]Configure balance_snapshot in settings.toml or cash entries in financials.toml.[/text_muted]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    labels = []
    totals = []
    for s in reversed(summaries):
        tm = s['total_money']
        if tm.get('configured'):
            date_label = datetime.strptime(f"{s['year']}-{s['month']}-01", "%Y-%m-%d").strftime("%b %Y")
            labels.append(date_label)
            totals.append(float(tm['total']))

    if not labels:
        console.print("[warning]No total money data to plot.[/warning]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    configured_day = engine.get_total_money_as_of_day()
    day_info = f"Total money measured as of day {configured_day} of each month" if configured_day else "Total money measured at month-end"

    try:
        import plotille
    except ImportError:
        console.print("[bold danger]plotille is not installed.[/bold danger]")
        console.print("[text_muted]Install it with: pip install plotille[/text_muted]")
        Prompt.ask("\n[ Back to Main Menu ]")
        return

    console.print()
    console.print("[bold heading]Total Money (accounts + cash)[/bold heading]")
    console.print(f"[text_muted]{day_info}[/text_muted]")
    fig = plotille.Figure()

    term_width, term_height = shutil.get_terminal_size()
    plot_width = max(40, min(term_width - 14, 100))
    plot_height = max(8, min(term_height - 10, 15))

    y_min, y_max = min(totals), max(totals)
    if y_min > 0:
        fig.set_y_limits(min_=y_min * 0.9, max_=y_max * 1.1)

    fig.width = plot_width
    fig.height = plot_height
    fig.set_x_limits(min_=0, max_=len(labels) - 1)
    fig.x_label = 'Month'
    fig.y_label = 'Amount'
    fig.color_mode = 'rgb'

    def format_x_tick(current, next_val):
        idx = int(round(current))
        if 0 <= idx < len(labels):
            return labels[idx]
        return str(int(current))

    def format_y_tick(current, next_val):
        return f"{current:,.0f}"

    fig.x_ticks_fkt = format_x_tick
    fig.y_ticks_fkt = format_y_tick

    x = list(range(len(labels)))
    fig.plot(x, totals, lc=(255, 207, 113), marker='o')

    print(fig.show())

    console.print()
    Prompt.ask("\n[ Back to Main Menu ]")


def show_budget_forecast_view(engine):
    check_config_and_notify(engine)
    clear_terminal_full()

    console.print(Panel('[bold heading]Budget Forecast[/bold heading]', expand=False, border_style='border'))
    console.print()

    forecast = engine.get_budget_forecast(12)
    currency = engine.config['user']['currency_symbol']
    round_amounts = engine.config.get('user', {}).get('round_amounts', False)

    if not forecast:
        console.print('[warning]No budget data available.[/warning]')
        Prompt.ask('\n[ Back to Main Menu ]')
        return

    table = Table(expand=True, border_style='border', show_lines=True)
    table.add_column('Month', style='heading')
    table.add_column('Budget', justify='right')

    for item in forecast:
        month_str = datetime(item['year'], item['month'], 1).strftime('%B %Y')
        budget_text = format_amount(Decimal(str(item['budget'])), currency, None, round_amounts)
        table.add_row(month_str, budget_text)

    console.print()
    console.print(table)
    Prompt.ask('\n[ Back to Main Menu ]')


def main():
    """The main entry point of the application."""

    if sys.stdout.isatty():
        clear_terminal_full()
    else:
        clear_terminal_full()
    debug_footer = "" if os.getenv("BUDGET_DATA_PATH") is None else f"Using custom data path: {USER_DATA_BASE}"

    os.makedirs(USER_DATA_BASE, exist_ok=True)
    os.makedirs(STATEMENTS_DIR, exist_ok=True)

    engine = None

    def _save_and_exit():
        """Save encrypted DB to disk and clean up."""
        if engine and engine.db and engine.db.is_connected():
            try:
                engine.db.close()
            except Exception:
                pass

    def _signal_handler(signum, frame):
        """Handle termination signals gracefully."""
        _save_and_exit()
        sys.exit(0)

    try:
        signal.signal(signal.SIGINT, _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)
    except (ValueError, OSError):
        pass  # Signals not supported on all platforms (e.g. Windows)

    try:
        while not engine:
            is_initial_setup = not os.path.exists(DB_PATH)

            config_path = CONFIG_PATH if os.path.exists(CONFIG_PATH) else "settings.example.toml"

            try:
                import toml
                temp_config = toml.load(config_path)
                theme = build_theme(temp_config)
            except Exception as e:
                console.print(f"[bold danger]Error loading theme from {config_path}: {e}[/bold danger]")
                theme = _login_theme()

            password = show_password_prompt(is_initial_setup, theme, footer=debug_footer)
            try:
                engine = BudgetEngine(DB_PATH, password, config_path=config_path)
                console.push_theme(build_theme(engine.config))

                updated_count = engine.recategorize_transactions()
                if updated_count > 0:
                    console.print(f"\n[bold income]Config updated! {updated_count} transactions were updated on startup.[/bold income]")

            except RuntimeError as e:
                if "Incorrect password" in str(e):
                    console.print(f"\n[bold danger]Wrong password, please try again.[/bold danger]\n")
                else:
                    console.print(f"\n[bold danger]Error:[/bold danger] {e}")
                    return
            except ValueError as e:
                console.print(f"\n[bold danger]Invalid configuration in {CONFIG_PATH} or financials.toml:[/bold danger]")
                console.print(f"[text_muted]{e}[/text_muted]")
                console.print(f"[warning]Please fix your settings.toml or financials.toml and try again.[/warning]\n")
                return
            except Exception as e:
                console.print(f"\n[bold danger]Error:[/bold danger] Failed to initialize. Corrupted data?")
                console.print(f"[text_muted]{e}[/text_muted]")
                return

        while True:
            show_main_dashboard(engine)

            categories = [
                ("📊  View & Analysis", [
                    "View History",
                    "Months at a glance",
                    "Budget Forecast",
                    "Plot Total Money",
                    "Simulate the future",
                ]),
                ("💾  Data Management", [
                    "Import Statements",
                    "Delete Data",
                ]),
                ("🔐  Account", [
                    "Change Master Password",
                ]),
                ("🚪  System", [
                    "Exit",
                ]),
            ]
            terminal_menu, flat_items = build_categorized_menu(categories)
            menu_index = terminal_menu.show()

            if menu_index is None:
                continue

            if flat_items[menu_index] == "View History":
                clear_terminal_full()
                show_history_view(engine)
            elif flat_items[menu_index] == "Months at a glance":
                clear_terminal_full()
                show_monthly_overview(engine)
            elif flat_items[menu_index] == "Budget Forecast":
                clear_terminal_full()
                show_budget_forecast_view(engine)
            elif flat_items[menu_index] == "Plot Total Money":
                clear_terminal_full()
                show_plot_view(engine)
            elif flat_items[menu_index] == "Simulate the future":
                clear_terminal_full()
                show_prediction_view(engine)
            elif flat_items[menu_index] == "Import Statements":
                clear_terminal_full()
                run_importer(engine)
            elif flat_items[menu_index] == "Change Master Password":
                clear_terminal_full()
                show_change_password_view(engine)
            elif flat_items[menu_index] == "Delete Data":
                clear_terminal_full()
                result = show_delete_data_view(engine)
                if result == "reset_exit":
                    clear_terminal_full()
                    break
            elif flat_items[menu_index] == "Exit":
                clear_terminal_full()
                break

    finally:
        _save_and_exit()

    clear_terminal_full()
    console.print(f"[bold heading]Goodbye![/bold heading]")


if __name__ == "__main__":
    main()
