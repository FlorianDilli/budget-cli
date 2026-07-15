# Frequently Asked Questions (FAQ)

### How is the budget calculated?

Your monthly budget is calculated based on your recurring income and expenses, which you define in the `config.toml` file. The application takes all transactions you've marked as "recurring" and normalizes them into a monthly amount.

For example, if you have a recurring yearly subscription of $120, the application will treat it as a $10 monthly expense. If you receive a salary twice a month, you would add it as a recurring transaction with a positive amount.

The final "monthly budget" is the sum of all these normalized recurring transactions. This represents the amount of money you are expected to have available to spend each month after all regular income and expenses are accounted for.

### Why does my budget in the history view change when I update my recurring transactions?

The application calculates the budget for any given month—past or present—by looking at your `config.toml` and determining which recurring transactions were active on the **first day** of that specific month. It does not store a historical record of the budget itself.

If a recurring transaction's amount changed over time (for example, your rent increased or a subscription's price went up), you can record the change directly on the same entry using `amount_history` instead of duplicating the entry. This keeps a single entry while still producing accurate historical budgets and avoiding false "amount mismatch" alerts. For example:

```toml
[[recurring_transactions]]
description       = "Netflix"
amount            = 12.99          # Current/default price
recurrence_months = 1
amount_history = [
  { from = "2022-01-01", amount = 7.99 },
  { from = "2024-06-01", amount = 10.99 },
  { from = "2025-03-01", amount = 12.99 },
]
```

Each `from` date marks when a new price took effect. The app uses the most recent price that is not after the month being calculated, so past months automatically reflect their historical price—no need to enter the same subscription twice with `start_date`/`end_date`.

The base `amount` is optional when `amount_history` is provided: if you omit it, the most recent history entry is used as the current price.

Only if you want to fully stop a recurring transaction (rather than change its price) should you still use `end_date` (and optionally start a new entry with a `start_date`).

### How is the "Available to Spend" amount calculated?

Your "Available to Spend" amount starts with your total monthly budget (as calculated above). From this, the application subtracts all of your non-recurring transactions for the current month.

For example, if your monthly budget is $1000 and you spend $50 on groceries and $20 on a coffee (both non-recurring), your "Available to Spend" would be $930. The calculation is simple:

`Available to Spend = Monthly Budget - Sum of Non-Recurring Transactions`

Any recurring transactions that have a different amount than what is defined in your `config.toml` will also be factored in. For instance, if your electricity bill is usually $50 but was $60 this month, the $10 difference will be subtracted from your available balance.

### How are annual or non-monthly payments handled?

If you have a recurring transaction that occurs less than once a month (e.g., `recurrence_months = 12`), the app automatically spreads the cost across the year. This means 1/12 of the amount is deducted from your budget every month.

When the actual large transaction occurs (e.g., you pay the full $120 in January), the app detects it and **ignores it** in the "Available to Spend" calculation. This prevents the full amount from being deducted again, as you've already "saved" for it throughout the year.

### How is the "Total money I have" amount calculated?

The Summary (on the Dashboard and in the History view) can show a **"Total money I have"** figure. This is the sum of all your bank account balances **plus** the cash you have on hand.

Bank accounts have no running balance stored in the app—only individual transactions. So for each account you tell the app the balance at **one known moment in time**, and the app reconstructs the balance at any other date from the transactions of that account.

This works in **both directions**: if the snapshot is *before* the date you're viewing, the app adds the transactions that happened after the snapshot; if the snapshot is *after* (e.g. you recorded today's balance but are looking at a past month), the app subtracts the transactions that happened between that past date and the snapshot. So you can record your current balance once and the app will correctly show your total money for any earlier or later month.

You configure this in `config.toml` next to each bank's CSV format:

```toml
[[importer.formats]]
name               = "N26"
date_column        = "Value Date"
# ... other format fields ...
balance_snapshot      = 1234.56        # The account balance at the snapshot date
balance_snapshot_date = "2025-01-01"   # YYYY-MM-DD (treated as the closing balance)
```

The `balance_snapshot_date` is treated as the **closing balance of that day**, so any transactions dated *on* that day are already included in the snapshot and are not counted twice—only transactions dated strictly after it are added. If you leave these two fields out, that account is simply excluded from the total.

The app assigns every imported transaction to the account it came from (using the format's `name`), so make sure each `[[importer.formats]]` has a unique `name`.

### How do I track cash?

Cash has no transaction history, so you just write down how much cash you have whenever you think about it. Add a `[cash]` section to `config.toml` with a list of `date`/`amount` entries:

```toml
[cash]
entries = [
  { date = "2025-01-01", amount = 120.00 },
  { date = "2025-02-15", amount = 85.50  },
]
```

For any given date, the app uses the most recent cash entry on or before that date. This cash is added to your accounts' balances to produce the "Total money I have" figure.

### What are "Budget Alerts"?

Budget Alerts appear when the app detects an anomaly in your recurring transactions:
*   **Amount Mismatch**: You paid more or less than what you defined in `config.toml`.
*   **Wrong Month**: You made a payment in a month where it wasn't expected (requires `payment_month` to be set).
*   **Missing Payment**: An expected payment (defined via `payment_month`) was not found in your transactions.

You can configure when these payments are expected by adding `payment_month` (e.g., `1` for January or `[1, 7]` for bi-annual) to your recurring transactions in `config.toml`.

### Is my data secure?

All the transactions you import via CSV files are encrypted and stored locally on your computer in a file called `budget.db`. The application uses strong encryption (AES-GCM) and requires your password to decrypt the data every time you open it. Your password is not stored anywhere in the application; it is used to generate an encryption key in memory. This means that without your password, your financial data is unreadable.
The `config.toml` is NOT encrypted. Any data you store there is stored in plain text. Keep that in mind.

### How can I delete my data?

You have two options for deleting your data, both available under the "Delete Data" menu:
1.  **Delete a single month's data**: This allows you to select a specific month and permanently remove all transaction data associated with it.
2.  **Delete all data (full reset)**: This option will completely wipe all your data, including all transactions and your encryption salt. The application will be reset to a clean state, as if you were running it for the first time. **This action cannot be undone.**

### The transactions weren’t correctly imported, how to fix that?

If transactions are not imported correctly, it is usually due to one of the following reasons:

1.  **Incorrect column names or delimiter**: The importer expects specific column names for the date, description, and amount. You can configure multiple formats in your `config.toml` file to match the headers in your CSV files. The app will automatically detect the correct format. For example:
    ```toml
    [[importer.formats]]
    name = "My Bank"
    date_column = "Transaction Date"
    description_column = "Details"
    amount_column = "Value"
    delimiter = ","
    date_format = "%d.%m.%Y"
    decimal_separator = ","
    thousands_separator = "."
    ```

2.  **Unsupported date format**: The importer recognizes common date formats like `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`, and `DD.MM.YYYY`. If your bank uses a different format, you can specify it in your `config.toml` using the `date_format` option.
    
    You use special codes to describe the date:
    - `%d`: Day of the month (e.g., 01 to 31)
    - `%m`: Month (e.g., 01 to 12)
    - `%Y`: 4-digit year (e.g., 2023)
    - `%y`: 2-digit year (e.g., 23)
    
    **Example**: If your bank uses `31/12/2023`, your `date_format` would be `%d/%m/%Y`.

3.  **File Location**: Make sure your bank statement CSV file is placed inside the `data/statements` directory. The importer only looks for files in this location.

If you have fixed the configuration, you can delete the incorrectly imported month's data using the "Delete Data" menu and then try importing the CSV file again.
### How can I back up and restore my data?

Since all your financial data is stored in the `userdata` folder (or your custom data path), backing up and restoring is simple.

**To back up your data:**
1.  Locate your data folder (default is `userdata` in the main directory).
2.  Copy this folder to a secure location, such as an external hard drive, a USB stick, or a cloud storage service.

**To restore your data:**
1.  Make sure the application is closed.
2.  Copy your backed-up data folder back into the application directory (or your custom path).
3.  The next time you open the application, it will load your restored data.

### How can I keep my data private from AI agents?

If you use AI agents (like GitHub Copilot, ChatGPT, or Kilo Code) to help you with this project, you might want to keep your financial data outside of the project directory so the AI cannot access it.

1.  **Move your data**: Move your `userdata` folder to a location outside of the `budget-cli` directory (e.g., `~/Documents/my-budget-data`).
2.  **Set an environment variable**: Before running the app, set the `BUDGET_DATA_PATH` environment variable:
    ```bash
    # Linux/macOS
    export BUDGET_DATA_PATH="/home/user/Documents/my-budget-data"
    python main.py

    # Windows (PowerShell)
    $env:BUDGET_DATA_PATH="C:\Users\User\Documents\my-budget-data"
    python main.py
    ```
3.  **AI Safety**: Since the data is now outside the project workspace, AI agents will only see the application code and not your private financial records.
