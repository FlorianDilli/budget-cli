# Frequently Asked Questions (FAQ)

### How is the budget calculated?

Your monthly budget is calculated based on your recurring income and expenses, which you define in the `config.toml` file. The application takes all transactions you've marked as "recurring" and normalizes them into a monthly amount.

For example, if you have a recurring yearly subscription of $120, the application will treat it as a $10 monthly expense. If you receive a salary twice a month, you would add it as a recurring transaction with a positive amount.

The final "monthly budget" is the sum of all these normalized recurring transactions. This represents the amount of money you are expected to have available to spend each month after all regular income and expenses are accounted for.

### How is the "Available to Spend" amount calculated?

Your "Available to Spend" amount starts with your total monthly budget (as calculated above). From this, the application subtracts all of your non-recurring transactions for the current month.

For example, if your monthly budget is $1000 and you spend $50 on groceries and $20 on a coffee (both non-recurring), your "Available to Spend" would be $930. The calculation is simple:

`Available to Spend = Monthly Budget - Sum of Non-Recurring Transactions`

Any recurring transactions that have a different amount than what is defined in your `config.toml` will also be factored in. For instance, if your electricity bill is usually $50 but was $60 this month, the $10 difference will be subtracted from your available balance.

### Is my data secure?

Yes. All your financial data is encrypted and stored locally on your computer in a file called `budget.db`. The application uses strong encryption (AES-GCM) and requires your password to decrypt the data every time you open it. Your password is not stored anywhere in the application; it is used to generate an encryption key in memory. This means that without your password, your financial data is unreadable.
The `config.toml` is not encrypted. Any data you store there is stored in plain text. Keep that in mind.

### How can I delete my data?

You have two options for deleting your data, both available under the "Delete Data" menu:
1.  **Delete a single month's data**: This allows you to select a specific month and permanently remove all transaction data associated with it.
2.  **Delete all data (full reset)**: This option will completely wipe all your data, including all transactions and your encryption salt. The application will be reset to a clean state, as if you were running it for the first time. **This action cannot be undone.**

### The transactions weren’t correctly imported, how to fix that?

If transactions are not imported correctly, it is usually due to one of the following reasons:

1.  **Incorrect column names**: The importer expects specific column names for the date, description, and amount. You can configure these in your `config.toml` file to match the headers in your CSV file. For example:
    ```toml
    [importer]
    date_column = "Transaction Date"
    description_column = "Details"
    amount_column = "Value"
    ```

2.  **Unsupported date format**: The importer recognizes common date formats like `YYYY-MM-DD`, `MM/DD/YYYY`, and `DD-MM-YYYY`. If your bank uses a different format, you may need to edit the CSV file before importing.

3.  **File Location**: Make sure your bank statement CSV file is placed inside the `data/statements` directory. The importer only looks for files in this location.

If you have fixed the configuration, you can delete the incorrectly imported month's data using the "Delete Data" menu and then try importing the CSV file again.
### How can I back up and restore my data?

Since all your financial data is stored in a single `budget.db` file, backing up and restoring is simple.

**To back up your data:**
1.  Locate the `budget.db` file in the `data` directory inside the application folder.
2.  Copy this file to a secure location, such as an external hard drive, a USB stick, or a cloud storage service (like Google Drive or Dropbox).

**To restore your data:**
1.  Make sure the application is closed.
2.  Copy your backed-up `budget.db` file back into the `data` directory.
3.  If a `budget.db` file already exists in the `data` directory, you will be asked if you want to replace it. Confirm that you want to replace the existing file with your backup.
4.  The next time you open the application, it will load your restored data.