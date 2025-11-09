# Minimal Budget CLI

Minimal Budget CLI is a simple, terminal-based application designed to help you track your finances without the bloat of larger applications. It's built for privacy and simplicity, encrypting all your financial data and storing it locally on your computer. With this tool, you can easily import your bank statements, categorize your spending, and get a clear picture of your budget.

## Installation

### 1. Download
First, download the application files from the source where you obtained them (e.g., clone the repository or download the ZIP file).

### 2. Install Requirements
This application has a few dependencies that need to be installed. Open your terminal, navigate to the project directory, and run the following command to install them:
```bash
pip install -r requirements.txt
```

## Setup

### 1. Create a Password
The first time you run the application, you will be prompted to create a password. This password encrypts your budget file, so choose something secure that you will remember. You will need this password every time you open the application.

### 2. Set Up `config.toml`
The `config.toml` file is where you configure the application to suit your needs. When you first run the app, a `config.toml` file will be created for you from `config.example.toml`. You can edit this file to:
- Set your currency symbol.
- Define rules to automatically categorize your transactions.
- List your recurring income and expenses (like salary or rent).

### 3. Further Information
For more detailed information on how the budget is calculated and how to use the application, please refer to the `FAQ.md` file.

## Menu Explanations

### Dashboard
The main screen of the application. It gives you a quick summary of your financial situation for the current month, including how much you have left to spend and a list of your top spending categories.

### View History
This menu allows you to look at your financial data from previous months. You can select any month for which you have transaction data and see a detailed summary and a list of all transactions for that period.

### Import Statements
Here, you can import your bank statements. The application looks for `.csv` files in the `data/statements` directory. Once you place your CSV files there, this option will import them, categorize the transactions based on your rules, and add them to your budget.

### Apply changes made in config.toml
If you make changes to your `config.toml` file while the application is running, use this option to apply them. The application will reload your configuration and re-categorize all your transactions based on any new rules you've added.

### Delete Data
This menu gives you options to manage your data:
- **Delete a single month's data**: Permanently delete all transactions for a specific month.
- **Delete all data (full reset)**: This will completely wipe all your data and reset the application to its initial state. This action is irreversible.

### Exit
Safely closes the application.