import os
import sys
import getpass
from datetime import datetime
from decimal import Decimal
from simple_term_menu import TerminalMenu
from typing import Tuple

from rich.console import Console
from rich.table import Table
from rich.progress_bar import ProgressBar
from rich.panel import Panel
from rich.text import Text
from rich.prompt import Prompt, Confirm
from rich.rule import Rule

from app.core import BudgetEngine
from app.importer import discover_csv_files, import_transactions

# --- Constants ---
USER_DATA_BASE = os.getenv("BUDGET_DATA_PATH", "userdata")
DB_PATH = os.path.join(USER_DATA_BASE, "budget.db")
STATEMENTS_DIR = os.path.join(USER_DATA_BASE, "statements")
CONFIG_PATH = os.path.join(USER_DATA_BASE, "config.toml")

# --- TUI components ---
console = Console()


def clear_terminal_full():
    """Completely clear the terminal, including scrollback."""
    if os.name == "nt":
        os.system("cls")
    else:
        sys.stdout.write("\033c")
        sys.stdout.flush()

def show_password_prompt(is_initial_setup: bool = False, theme: dict = None) -> str:
    """Prompts the user for their master password."""
    
    # Use default theme if not provided
    if theme is None:
        theme = {"accent_color": "cyan", "main_color": "cyan"}
    
    if is_initial_setup:
        prompt_message = "Please set a password for your budget file: "
        info_text = "This password will be used to encrypt your new budget file."
    else:
        prompt_message = "Please enter your password: "
        info_text = "The app is currently locked"

    console.print(
        Panel(
            Text(info_text, justify="center"),
            title=f"[bold {theme['accent_color']}]Budget CLI[/bold {theme['accent_color']}]",
            border_style=theme['main_color']
        )
    )
    console.print()
    console.print()
    password = getpass.getpass(prompt_message)
    return password

def format_amount(amount: Decimal, currency: str, theme: dict, round_amounts: bool, is_recurring: bool = False) -> Text:
    """Formats a transaction amount with appropriate color."""
    style = f"bold {theme['positive']}" if amount >= 0 else f"bold {theme['negative']}"
    if round_amounts:
        amount = round(amount)
        return Text(f"{amount:.0f} {currency}", style=style, justify="right")
    return Text(f"{amount:.2f} {currency}", style=style, justify="right")

def format_summary_amount(amount: Decimal, currency: str, theme: dict, round_amounts: bool) -> Text:
    """Formats a summary amount with appropriate color."""
    style = f"bold {theme['positive']}" if amount >= 0 else f"bold {theme['negative']}"
    if round_amounts:
        amount = round(amount)
        return Text(f"{amount:.0f} {currency}", style=style, justify="right")
    return Text(f"{amount:.2f} {currency}", style=style, justify="right")

def check_config_and_notify(engine: BudgetEngine) -> dict:
    """Checks if config changed and prints notification. Returns reload info or None."""
    reload_info = engine.check_and_reload_config_if_changed()
    if reload_info:
        console.print(f"\n[dim]✓ Config auto-reloaded: {reload_info['count']} transactions updated[/dim]")
    return reload_info

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
    console.print(Panel(f"[bold {theme['accent_color']}]Budget CLI[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']))
    console.print()
    console.print()

    # Summary table
    summary_table = Table(show_header=False, box=None, padding=(0, 2))
    summary_table.add_column(style=theme['main_color'])
    summary_table.add_column(style=f"bold {theme['positive']}", justify="right")
    
    summary_table.add_row("Available to Spend:", format_summary_amount(summary['available_to_spend'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False)))
    summary_table.add_row("Monthly Budget:", format_summary_amount(summary['allowed_monthly_spend'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False)))
    summary_table.add_row("Sum of non-recurring transactions:", format_summary_amount(summary['monthly_expenses'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False)))
    
    console.print(Panel(summary_table, title=f"[bold {theme['accent_color']}]Summary for {latest_month}[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']), justify="center")
    
    # Show the progress bar
    show_budget_progress(
        summary['allowed_monthly_spend'],
        summary['available_to_spend'],
        summary['surplus'],
        summary['currency'],
        theme,
        engine.config.get('user', {}).get('round_amounts', False),
        summary.get('total_transactions_sum', Decimal('0'))
    )

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
        top_spending_table.add_row(name, amount_text, item['type'])
        
    console.print()
    console.print()
    console.print(top_spending_table)
def show_budget_progress(allowed_spend: Decimal, available_to_spend: Decimal, surplus: Decimal, currency: str, theme: dict, round_amounts: bool, total_spent: Decimal = None):
    """Renders a progress bar for the monthly budget."""
    
    if allowed_spend <= 0:
        remaining_percent = Decimal('0') if available_to_spend >= 0 else Decimal('-100')
        spent_percent = Decimal('100') if available_to_spend < 0 else Decimal('0')
        usage_factor = float(abs(total_spent) / 1) if total_spent is not None and total_spent < 0 else 0.0
    else:
        remaining_percent = (available_to_spend / allowed_spend) * 100
        spent_percent = 100 - remaining_percent
        
        # The user wants to see how much of their budget they have spent.
        # 'available_to_spend' is (Budget + Net Expenses).
        # So (Budget - available_to_spend) is the Net Amount Spent.
        net_spent = allowed_spend - available_to_spend
        usage_factor = float(net_spent / allowed_spend)

    # For the progress bar, clamp the value between 0 and 100
    # We use remaining_percent for the bar itself to show "how much is left"
    progress_display = max(0, min(remaining_percent, 100))

    # Text display can show the actual percentage
    remaining_percent_display = max(0, remaining_percent)

    
    # --- Text for the progress bar ---
    if remaining_percent > 100:
        if round_amounts:
            remaining_text = f" 100% remaining ({surplus:.0f} {currency} surplus)"
        else:
            remaining_text = f" 100% remaining ({surplus:.2f} {currency} surplus)"
    elif remaining_percent >= 0:
        remaining_text = f" {remaining_percent_display:.0f}% remaining"
    else:
        # Over budget
        remaining_text = f" 0% remaining ({usage_factor:.1f}x of budget used)"


    # Use the 'positive' color from theme, but default to a light green if not found
    # The user likes the light green from the partial progress bar
    bar_color = "#A1C398"
    background_color = "grey37"

    progress_bar = ProgressBar(
        total=100,
        completed=progress_display,
        style=background_color,
        complete_style=bar_color,
        finished_style=bar_color,
        width=50,
    )

    progress_table = Table.grid(expand=True)
    progress_table.add_column()
    progress_table.add_column(justify="right")
    
    progress_table.add_row(
        progress_bar,
        Text(remaining_text, style=theme['main_color'])
    )

    console.print(
        Panel(
            progress_table,
            title=f"[bold {theme['accent_color']}]How much budget is left[/bold {theme['accent_color']}]",
            expand=False,
            border_style=theme['main_color']
        ),
        justify="center"
    )


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
        
        terminal_menu = TerminalMenu(
            month_menu_items,
            title="Select a month to view transactions:",
            skip_empty_entries=True,
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

        # --- Summary View ---
        summary_table = Table(show_header=False, box=None, padding=(0, 2))
        summary_table.add_column(style=theme['main_color'])
        summary_table.add_column(style=f"bold {theme['positive']}", justify="right")
        
        summary_table.add_row("Available to Spend:", format_summary_amount(summary['available_to_spend'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False)))
        summary_table.add_row("Monthly Budget:", format_summary_amount(summary['allowed_monthly_spend'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False)))
        summary_table.add_row("Sum of non-recurring transactions:", format_summary_amount(summary['monthly_expenses'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False)))
        if 'total_transactions_sum' in summary:
            summary_table.add_row("Sum of all transactions in month:", format_summary_amount(summary['total_transactions_sum'], summary['currency'], theme, engine.config.get('user', {}).get('round_amounts', False)))
        
        console.print(Panel(summary_table, title=f"[bold {theme['accent_color']}]Summary for {month_title}[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']), justify="center")

        # --- Progress Bar ---
        show_budget_progress(
            summary['allowed_monthly_spend'],
            summary['available_to_spend'],
            summary['surplus'],
            summary['currency'],
            theme,
            engine.config.get('user', {}).get('round_amounts', False),
            summary.get('total_transactions_sum', Decimal('0'))
        )

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
                top_spending_table.add_row(name, amount_text, item['type'])
                
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
        console.print("[yellow]No transaction data found.[/yellow]")
        Prompt.ask("\nPress Enter to return to the main menu.")
        return

    table = Table(expand=True, border_style=theme['main_color'], show_lines=True)
    table.add_column("Month", style=theme['accent_color'])
    table.add_column("Monthly Budget", justify="right")
    table.add_column("Sum of all transactions", justify="right")
    table.add_column("Available to Spend", justify="right")
    table.add_column("How much budget is left")

    for s in summaries:
        month_title = datetime.strptime(f"{s['year']}-{s['month']}-01", "%Y-%m-%d").strftime("%B %Y")
        
        budget_text = format_summary_amount(s['budget'], s['currency'], theme, round_amounts)
        spent_text = format_summary_amount(s['total_spent'], s['currency'], theme, round_amounts)
        remaining_text = format_summary_amount(s['available'], s['currency'], theme, round_amounts)

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
        if remaining_percent > 100:
            surplus = s['available']
            if round_amounts:
                progress_text = f" 100% remaining ({surplus:.0f} {s['currency']} surplus)"
            else:
                progress_text = f" 100% remaining ({surplus:.2f} {s['currency']} surplus)"
        elif remaining_percent >= 0:
            progress_text = f" {remaining_percent_display:.0f}% remaining"
        else:
            # Over budget
            progress_text = f" 0% remaining ({usage_factor:.1f}x of budget used)"

        # Use the 'positive' color from theme, but default to a light green if not found
        # The user likes the light green from the partial progress bar
        bar_color = "#A1C398"
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
        usage_grid.add_row(progress_bar, Text(progress_text, style=theme['main_color']))

        table.add_row(month_title, budget_text, spent_text, remaining_text, usage_grid)

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
    terminal_menu = TerminalMenu(
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
        
        month_menu = TerminalMenu(
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
    if USER_DATA_BASE != "userdata":
        console.print(f"[dim]Using custom data path: {USER_DATA_BASE}[/dim]")
    
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


        password = show_password_prompt(is_initial_setup, theme)
        try:
            with console.status("[bold green]Unlocking your budget...[/bold green]"):
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
            "Apply changes made in config.toml",
            "Change Master Password",
            "Delete Data",
            "Exit"
        ]
        terminal_menu = TerminalMenu(
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
            with console.status("[bold green]Reloading config and re-applying rules...[/bold green]"):
                updated_count = engine.reload_config_and_reapply_all()
            console.print(f"\n[bold green]Config reloaded! {updated_count} transactions were updated in the database.[/bold green]")
            console.print("[dim]Note: Transaction statuses (Amount Mismatch/Verified) are also refreshed based on your new config.[/dim]")
            Prompt.ask("\nPress Enter to return to the main menu.")
        elif menu_index == 4:
            show_change_password_view(engine)
        elif menu_index == 5:
            result = show_delete_data_view(engine)
            if result == "reset_exit":
                clear_terminal_full()
                break
        elif menu_index == 6 or menu_index is None:
            clear_terminal_full()
            break

    clear_terminal_full()
    console.print(f"[bold {engine.config['theme']['accent_color']}]Goodbye![/bold {engine.config['theme']['accent_color']}]")


if __name__ == "__main__":
    main()
