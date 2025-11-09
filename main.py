import os
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

from core import BudgetEngine
from importer import discover_csv_files, import_transactions

# --- Constants ---
DB_PATH = "data/budget.db"
STATEMENTS_DIR = "data/statements"

# --- TUI components ---
console = Console()

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
            title=f"[bold {theme['accent_color']}]Minimal Budget Tracker[/bold {theme['accent_color']}]",
            border_style=theme['main_color']
        )
    )
    password = getpass.getpass(prompt_message)
    return password

def format_amount(amount: Decimal, currency: str, theme: dict, is_recurring: bool = False) -> Text:
    """Formats a transaction amount with appropriate color."""
    style = f"bold {theme['positive']}" if amount >= 0 else f"bold {theme['negative']}"
    return Text(f"{amount:.2f} {currency}", style=style, justify="right")

def format_summary_amount(amount: Decimal, currency: str, theme: dict) -> Text:
    """Formats a summary amount with appropriate color."""
    style = f"bold {theme['positive']}" if amount >= 0 else f"bold {theme['negative']}"
    return Text(f"{amount:.2f} {currency}", style=style, justify="right")

def show_main_dashboard(engine: BudgetEngine):
    """Displays the main dashboard with a summary and recent transactions."""
    summary = engine.get_dashboard_summary()
    theme = engine.config.get("theme", {})
    
    # The top spending view should also be for the latest month
    latest_month = summary.get("latest_month", datetime.now().strftime('%B %Y'))
    month_str, year = latest_month.split()
    month = datetime.strptime(month_str, "%B").strftime("%m")
    
    top_spending_view = engine.get_top_spending_for_month(year, month, limit=10)
    
    console.clear()
    
    # Header
    console.print(Panel(f"[bold {theme['accent_color']}]Minimalist Budget Tracker[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']))

    # Summary table
    summary_table = Table(show_header=False, box=None, padding=(0, 2))
    summary_table.add_column(style=theme['main_color'])
    summary_table.add_column(style=f"bold {theme['positive']}", justify="right")
    
    summary_table.add_row("Available to Spend:", format_summary_amount(summary['available_to_spend'], summary['currency'], theme))
    summary_table.add_row("Monthly Budget:", format_summary_amount(summary['allowed_monthly_spend'], summary['currency'], theme))
    summary_table.add_row("Sum of non-recurring transactions:", format_summary_amount(summary['monthly_expenses'], summary['currency'], theme))
    
    console.print(Panel(summary_table, title=f"[bold {theme['accent_color']}]Summary for {latest_month}[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']), justify="center")
    
    # Show the progress bar
    show_budget_progress(
        summary['allowed_monthly_spend'],
        summary['available_to_spend'],
        theme
    )

    # Top 10 Spending View

    top_spending_table = Table(title=f"[bold {theme['accent_color']}]Where does my money go in {latest_month}[/bold {theme['accent_color']}]", expand=True, border_style=theme['main_color'])
    top_spending_table.add_column("Name", style=theme['main_color'])
    top_spending_table.add_column("Amount", justify="right")
    top_spending_table.add_column("Type", style=theme['main_color'])

    for item in top_spending_view:
        amount_text = format_amount(item['amount'], summary['currency'], theme, item.get('is_recurring', False))
        name = f"[{theme.get('recurring_transaction_highlight', 'yellow')}]{item['name']}[/{theme.get('recurring_transaction_highlight', 'yellow')}]" if item.get('is_recurring') else item['name']
        top_spending_table.add_row(name, amount_text, item['type'])
        
    console.print("")
    console.print(top_spending_table)
def show_budget_progress(allowed_spend: Decimal, available_to_spend: Decimal, theme: dict):
    """Renders a progress bar for the monthly budget."""
    
    # Avoid division by zero if budget is zero
    if allowed_spend <= 0:
        # If there's no budget, show a full bar if there are expenses, empty otherwise
        progress = 100 if available_to_spend < 0 else 0
        remaining_percent = 0
    else:
        # Calculate the percentage of the budget that is left
        remaining_percent = (available_to_spend / allowed_spend) * 100
        
        # The progress bar should show how much is *spent*, so we calculate 100 - remaining
        progress = 100 - remaining_percent

    # Ensure progress is between 0 and 100 for the bar display
    progress_display = max(0, min(progress, 100))
    
    # Ensure remaining percent is not negative for display
    remaining_percent_display = max(0, remaining_percent)


    bar_color = theme.get("positive", "green")
    background_color = theme.get("negative", "red")

    # The progress bar will now show the remaining budget, not the spent amount
    progress_bar = ProgressBar(
        total=100,
        completed=remaining_percent_display,
        style=background_color,
        complete_style=bar_color,
        width=50,
    )

    # Create a table to display the progress bar and the remaining percentage
    progress_table = Table.grid(expand=True)
    progress_table.add_column()
    progress_table.add_column(justify="right")
    
    progress_table.add_row(
        progress_bar,
        Text(f" {remaining_percent_display:.1f}% remaining", style=theme['main_color'])
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
    
    while True:
        available_months = engine.get_available_months()
        if not available_months:
            console.clear()
            console.print("[yellow]No transactions found.[/yellow]")
            Prompt.ask("\nPress Enter to return to the main menu.")
            return

        # --- Month Selection Menu ---
        # Format "YYYY-MM" for display and map to (year, month)
        month_map = {f"{year}-{month}": (year, month) for year, month in available_months}
        month_menu_items = sorted(month_map.keys(), reverse=True) + ["[ Back to Main Menu ]"]
        
        console.clear()
        console.print(Panel(f"[bold {engine.config['theme']['accent_color']}]Transaction History[/bold {engine.config['theme']['accent_color']}]", expand=False, border_style=engine.config['theme']['main_color']))
        
        terminal_menu = TerminalMenu(
            month_menu_items,
            title="Select a month to view transactions:",
        )
        menu_index = terminal_menu.show()

        if menu_index is None or month_menu_items[menu_index] == "[ Back to Main Menu ]":
            return

        # --- Display Transactions for Selected Month ---
        selected_month_str = month_menu_items[menu_index]
        year, month = month_map[selected_month_str]
        
        summary = engine.get_monthly_summary(year, month)
        transactions = engine.get_transactions_for_month(year, month)
        theme = engine.config.get("theme", {})

        console.clear()
        
        month_title = datetime.strptime(f"{year}-{month}-01", "%Y-%m-%d").strftime("%B %Y")

        # --- Summary View ---
        summary_table = Table(show_header=False, box=None, padding=(0, 2))
        summary_table.add_column(style=theme['main_color'])
        summary_table.add_column(style=f"bold {theme['positive']}", justify="right")
        
        summary_table.add_row("Available to Spend:", format_summary_amount(summary['available_to_spend'], summary['currency'], theme))
        summary_table.add_row("Monthly Budget:", format_summary_amount(summary['allowed_monthly_spend'], summary['currency'], theme))
        summary_table.add_row("Sum of non-recurring transactions:", format_summary_amount(summary['monthly_expenses'], summary['currency'], theme))
        
        console.print(Panel(summary_table, title=f"[bold {theme['accent_color']}]Summary for {month_title}[/bold {theme['accent_color']}]", expand=False, border_style=theme['main_color']), justify="center")

        # --- Progress Bar ---
        show_budget_progress(
            summary['allowed_monthly_spend'],
            summary['available_to_spend'],
            theme
        )

        # --- Top 10 Spending View for the Month ---
        top_spending_view = engine.get_top_spending_for_month(year, month, limit=10)
        
        if top_spending_view:

            top_spending_table = Table(title=f"[bold {engine.config['theme']['accent_color']}]Where does my money go in {month_title}[/bold {engine.config['theme']['accent_color']}]", expand=True, border_style=engine.config['theme']['main_color'])
            top_spending_table.add_column("Name", style=engine.config['theme']['main_color'])
            top_spending_table.add_column("Amount", justify="right")
            top_spending_table.add_column("Type", style=engine.config['theme']['main_color'])
            
            for item in top_spending_view:
                amount_text = format_amount(item['amount'], summary['currency'], engine.config['theme'], item.get('is_recurring', False))
                name = f"[{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]{item['name']}[/{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]" if item.get('is_recurring') else item['name']
                top_spending_table.add_row(name, amount_text, item['type'])
                
            console.print("")
            console.print(top_spending_table)

        # --- Full Transaction Table ---
        trans_table = Table(title=f"[bold {theme['accent_color']}]All Transactions for {month_title}[/bold {theme['accent_color']}]", expand=True, border_style=theme['main_color'])
        trans_table.add_column("Date", style="dim")
        trans_table.add_column("Description", style=engine.config['theme']['main_color'])
        trans_table.add_column("Amount", justify="right")
        trans_table.add_column("Category", style=engine.config['theme']['main_color'])

        if not transactions:
            console.print("[dim]No transactions for this month.[/dim]")
        else:
            for t in transactions:
                amount_text = format_amount(t['amount'], summary['currency'], theme, t.get('is_recurring', False))
                description = f"[{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]{t['description']}[/{engine.config['theme'].get('recurring_transaction_highlight', 'yellow')}]" if t.get('is_recurring') else t['description']
                category = t['category'] if t['category'] else "Uncategorized"
                trans_table.add_row(t['date'], description, amount_text, category)
            console.print(trans_table)

        # Wait for user to continue
        Prompt.ask("\nPress Enter to select another month.")

def run_importer(engine: BudgetEngine):
    """Handles the logic for importing transactions from CSV files."""
    console.clear()
    console.print(Panel(f"[bold {engine.config['theme']['accent_color']}]Import Transactions from Statements[/bold {engine.config['theme']['accent_color']}]", expand=False, border_style=engine.config['theme']['main_color']))

    csv_files = discover_csv_files(STATEMENTS_DIR)
    if not csv_files:
        console.print(f"[yellow]No CSV files found in '{STATEMENTS_DIR}'.[/yellow]")
        Prompt.ask("\nPress Enter to return to the main menu.")
        return

    console.print("Found the following statement files:")
    for f in csv_files:
        console.print(f"- {os.path.basename(f)}")
    
    if Confirm.ask("\nDo you want to import these transactions?"):
        total_imported = 0
        with console.status("[bold green]Importing...[/bold green]"):
            for f in csv_files:
                # The importer needs the full engine to handle encryption
                count = import_transactions(engine, f)
                total_imported += count
        
        console.print(f"\n[bold green]Import complete! Added {total_imported} new transactions.[/bold green]")
    
    Prompt.ask("\nPress Enter to return to the main menu.")


def show_delete_data_view(engine: BudgetEngine):
    """Handles the UI for deleting data."""
    console.clear()
    console.print(Panel(f"[bold {engine.config['theme']['negative']}]Delete Data[/bold {engine.config['theme']['negative']}]", expand=False, border_style=engine.config['theme']['main_color']))

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


def main():
    """The main entry point of the application."""
    
    # Ensure data directories exist
    os.makedirs("data", exist_ok=True)
    os.makedirs(STATEMENTS_DIR, exist_ok=True)
    
    
    # --- Initialization ---
    engine = None
    while not engine:
        # If the database file doesn't exist, it's the initial setup
        is_initial_setup = not os.path.exists(DB_PATH)
        
        # Temporarily load config to get theme for password prompt
        temp_config = {}
        if os.path.exists("config.toml"):
            import toml
            temp_config = toml.load("config.toml")
        theme = temp_config.get("theme", {"accent_color": "#00FFFF", "main_color": "#00FFFF"})

        password = show_password_prompt(is_initial_setup, theme)
        try:
            with console.status("[bold green]Unlocking your budget...[/bold green]"):
                engine = BudgetEngine(DB_PATH, password)
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
            "Import Statements",
            "Apply changes made in config.toml",
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
            run_importer(engine)
        elif menu_index == 2:
            with console.status("[bold green]Reloading config and re-applying rules...[/bold green]"):
                updated_count = engine.reload_config_and_reapply_all()
            console.print(f"\n[bold green]Config reloaded! {updated_count} transactions were updated.[/bold green]")
            Prompt.ask("\nPress Enter to return to the main menu.")
        elif menu_index == 3:
            result = show_delete_data_view(engine)
            if result == "reset_exit":
                break
        elif menu_index == 4 or menu_index is None:
            break

    console.print(f"[bold {engine.config['theme']['accent_color']}]Goodbye![/bold {engine.config['theme']['accent_color']}]")


if __name__ == "__main__":
    main()