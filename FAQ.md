# Frequently Asked Questions (FAQ)

### How is the budget calculated?

Your monthly budget is calculated based on your recurring income and expenses, which you define in the `config.toml` file. The application takes all transactions you've marked as "recurring" and normalizes them into a monthly amount.

For example, if you have a recurring yearly subscription of $120, the application will treat it as a $10 monthly expense. If you receive a salary twice a month, you would add it as a recurring transaction with a positive amount.

The final "monthly budget" is the sum of all these normalized recurring transactions. This represents the amount of money you are expected to have available to spend each month after all regular income and expenses are accounted for.

### Why does my budget in the history view change when I update my recurring transactions?

The application calculates the budget for any given month—past or present—by looking at your `config.toml` and determining which recurring transactions were active on the **first day** of that specific month. It does not store a historical record of the budget itself.

This means if you change the amount of a recurring transaction (e.g., your rent increases), the history for past months will be recalculated based on this new amount. To maintain accurate historical records, you should end the old transaction with an `end_date` and create a new one with a `start_date`.

### How is the "Available to Spend" amount calculated?

Your "Available to Spend" amount starts with your total monthly budget (as calculated above). From this, the application subtracts all of your non-recurring transactions for the current month.

For example, if your monthly budget is $1000 and you spend $50 on groceries and $20 on a coffee (both non-recurring), your "Available to Spend" would be $930. The calculation is simple:

`Available to Spend = Monthly Budget - Sum of Non-Recurring Transactions`

Any recurring transactions that have a different amount than what is defined in your `config.toml` will also be factored in. For instance, if your electricity bill is usually $50 but was $60 this month, the $10 difference will be subtracted from your available balance.

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

Since all your financial data is stored in the `userdate` folder, backing up and restoring is simple.

**To back up your data:**
1.  Locate the `userdata` folder in the main directory of the app.
2.  Copy this folder to a secure location, such as an external hard drive, a USB stick, or a cloud storage service.

**To restore your data:**
1.  Make sure the application is closed.
2.  Copy your backed-up `userdata` folder back into the application directory.
3.  The next time you open the application, it will load your restored data.