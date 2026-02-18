# Budget CLI

Budget CLI is a simple command line interface (CLI) designed to help you track your finances. You can import your bank statements (CSV format) and based on the budget criteria you define, calculate how much budget is left for that month. All bank statements are encrypted after import and the app has no internet access.

## 🚀 Prerequisites

Before you begin, ensure you have Git and Python installed on your system.

### Git Installation
You'll need Git to download the application files. You can check if you have Git installed by opening your terminal and running `git --version`. If it's not installed, please visit the official [Git website](https://git-scm.com/install/) for detailed installation instructions. The website provides clear guidance for Windows, macOS, and Linux.

### Python Installation
You'll need Python to run the application.To check if you have python installed, try running `python --version`. If it's not installed, you can download Python from the official [Python website](httpss://www.python.org/downloads/). During installation on Windows, make sure to check the box that says "Add Python to PATH".

## 🛠️ Installation and Setup

Follow these steps to get Budget CLI up and running on your system.

### 📂 Step 1: Clone the Repository
First, you need to clone the repository to your local machine. Open your terminal and run the following command in the directory where you want to store the application:

```bash
git clone https://github.com/FlorianDilli/budget-cli.git
```
This will create a `budget-cli` folder with the application files.

### 📦 Step 2: Install Dependencies
1.  Open your terminal (or Command Prompt on Windows).
2.  Navigate to the directory where you cloned the repository. For example:
    ```bash
    # On macOS or Linux
    cd ~/Documents/budget-cli

    # On Windows
    cd C:\Users\YourUsername\Documents\budget-cli
    ```
3.  Install the required Python packages by running:
    ```bash
    pip install -r requirements.txt
    ```
### ▶️ Step 3: Run the Application
Now you can run the application. You need to set the `BUDGET_DATA_PATH` environment variable to specify where your data should be stored.

In your terminal, run the following commands:

```bash
# On macOS or Linux
export BUDGET_DATA_PATH="/path/to/your/userdata"
python main.py

# On Windows (Command Prompt)
set BUDGET_DATA_PATH="C:\path\to\your\userdata"
python main.py

# On Windows (PowerShell)
$env:BUDGET_DATA_PATH="C:\path\to\your\userdata"
python main.py
```

Replace `/path/to/your/userdata` with the actual directory where you want Budget CLI to store its configuration and database.

## 🔄 Updating

To update the application to the latest version, navigate to the application directory in your terminal and use the following git command.
```bash
git pull origin main
```

## ⚙️ Setup

### 🔑 1. Create a Password
The first time you run the application, you will be prompted to create a password. This password encrypts your budget file, so it's important to choose something secure that you will remember.

You will need this password every time you open the application.

### 📝 2. Set Up `config.toml`
The `config.toml` file is where you configure the application to suit your needs. When you first run the app, a `config.toml` and `budget.db` file will be created for you. These are stored in the `userdata` directory inside the main application folder. You can edit the `config.toml` to:
- Set your currency symbol.
- Define rules to automatically categorize your transactions.
- List your recurring income and expenses (like salary or rent).

### ℹ️ 3. Further Information
For more detailed information on how the budget is calculated and how to use the application, please refer to the [Frequently Asked Questions](FAQ.md) file.

## 🗺️ Menu Explanations

### 📊 Dashboard
The main screen of the application. It gives you a quick summary of your financial situation for the current month, including how much you have left to spend and a list of your top spending categories.

### 📜 View History
This menu allows you to look at your financial data from previous months. You can select any month for which you have transaction data and see a detailed summary and a list of all transactions for that period.

### 🏦 Import Statements
Here, you can import your bank statements. The application looks for `.csv` files in the `userdata/statements` directory. Once you place your CSV files there, this option will import them, categorize the transactions based on your rules, and add them to your budget.

### ⚙️ Apply changes made in config.toml
If you make changes to your `config.toml` file while the application is running, use this option to apply them. The application will reload your configuration and re-categorize all your transactions based on any new rules you've added.

### 🗑️ Delete Data
This menu gives you options to manage your data:
- **Delete a single month's data**: Permanently delete all transactions for a specific month.
- **Delete all data (full reset)**: This will completely wipe all your data and reset the application to its initial state. This action is irreversible.

### 👋 Exit
Safely closes the application.
