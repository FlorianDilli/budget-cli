import os
import toml
import shutil
from datetime import datetime
from decimal import Decimal
from typing import Dict, Any, List, Tuple

from app.database import DatabaseManager
from app.crypto import derive_key, encrypt, decrypt, generate_salt

class BudgetEngine:
    """Manages the application's core logic, state, and business rules."""

    def __init__(self, db_path: str, password: str, config_path: str = "userdata/config.toml"):
        """
        Initializes the core engine.

        Args:
            db_path: Path to the SQLite database file.
            password: The user's master password.
            config_path: Path to the configuration file.
        """
        self.db_path = db_path
        self.password = password
        self.config_path = config_path
        
        self.db = DatabaseManager(self.db_path)
        self._encryption_key = None
        self.config = self._load_config()

        self._connect_to_db()
        self._verify_password()

    def _load_config(self) -> Dict[str, Any]:
        """Loads the user's configuration from a TOML file."""
        if not os.path.exists(self.config_path):
            # If config.toml doesn't exist, copy it from the example file.
            example_path = "config.example.toml"
            if not os.path.exists(example_path):
                # This is a fallback in case the example file is missing.
                # Creates a minimal, functional config.
                default_config = {
                    "user": {"currency_symbol": "USD", "round_amounts": False},
                    "theme": {
                        "accent_color": "#00FFFF", "positive": "#00FF00",
                        "negative": "#FF0000", "main_color": "#00FFFF",
                        "recurring_transaction_highlight": "#E2B59A"
                    },
                    "importer": {
                        "date_column": "Date", "description_column": "Description",
                        "amount_column": "Amount"
                    },
                    "category_rules": {},
                    "recurring_transactions": []
                }
                with open(self.config_path, "w") as f:
                    toml.dump(default_config, f)
            else:
                shutil.copy(example_path, self.config_path)
        
        config = toml.load(self.config_path)
        if "user" not in config:
            config["user"] = {"currency_symbol": "USD", "round_amounts": False}
        # Ensure theme settings exist, providing defaults if they don't
        if "theme" not in config:
            config["theme"] = {
                "accent_color": "#00FFFF",
                "positive": "#00FF00",
                "negative": "#FF0000",
                "main_color": "#00FFFF"
            }
        return config

    def _connect_to_db(self) -> None:
        """Derives the DB key and connects to the database."""
        # The key for the database is derived from the user's password and a salt.
        # This salt is stored in the database itself in the 'meta' table.
        #
        # 1. Connect to the database *without* a key to check if it's encrypted
        #    and to retrieve the salt if it exists.
        #
        # The initial connection is made to an empty or existing database file.
        # SQLCipher will transparently handle creating the file if it doesn't exist.
        
        self.db.connect(self.password, initial_setup=True)


        # 2. Retrieve the salt. If it doesn't exist, create it.
        db_salt_hex = self.db.get_meta('db_salt')
        if db_salt_hex:
            db_salt = bytes.fromhex(db_salt_hex)
        else:
            # This is a fresh database, so we create a new salt.
            db_salt = os.urandom(16)
            self.db.set_meta('db_salt', db_salt.hex())

        # 3. Now that the salt is guaranteed to exist, connect to the database
        # using the user's password. SQLCipher will handle the key derivation
        # internally using the salt from the database.
        self.db.connect(self.password)

        # 4. Derive a separate key for field-level encryption.
        encryption_salt_hex = self.db.get_meta('encryption_salt')
        if encryption_salt_hex:
            encryption_salt = bytes.fromhex(encryption_salt_hex)
        else:
            encryption_salt = self._get_or_create_encryption_salt()

        self._encryption_key = derive_key(self.password, encryption_salt)
        self.password = None # Clear password from memory after use

    def _get_or_create_encryption_salt(self) -> bytes:
        """
        Retrieves the encryption salt or creates a new one.
        If a new salt is created, it also clears the old password verifier.
        """
        salt = self.db.get_meta('encryption_salt')
        if salt:
            return bytes.fromhex(salt)
        
        # If no salt exists, it's a fresh setup or a reset.
        # Ensure the old password verifier is gone.
        self.db.delete_meta('password_verifier')
        
        new_salt = generate_salt()
        self.db.set_meta('encryption_salt', new_salt.hex())
        return new_salt

    def _verify_password(self) -> None:
        """Verifies the master password by checking a stored verifier."""
        verifier = self.db.get_meta('password_verifier')
        
        # If no verifier exists, this is a fresh setup.
        # Create a new verifier and store it.
        if not verifier:
            plaintext_verifier = b'master_password_check'
            encrypted_verifier = encrypt(plaintext_verifier, self._encryption_key)
            self.db.set_meta('password_verifier', encrypted_verifier.hex())
            return

        try:
            # Attempt to decrypt the verifier with the derived key
            decrypted_verifier = decrypt(bytes.fromhex(verifier), self._encryption_key)
            if decrypted_verifier != b'master_password_check':
                raise ValueError("Password verification failed.")
        except Exception:
            # This will catch decryption errors or failed checks
            raise RuntimeError("Incorrect password.")
    def _get_recurring_transactions(self) -> List[Dict[str, Any]]:
        """
        Parses the recurring transactions from the config file.

        Returns:
            A list of recurring transaction dictionaries.
        """
        transactions = self.config.get('recurring_transactions', [])
        
        # Enhanced validation for recurring transactions
        for t in transactions:
            description = t.get('description', 'N/A')
            if not isinstance(t.get('amount'), (int, float)):
                raise ValueError(f"Invalid or missing 'amount' for recurring transaction: '{description}'")
            
            # This validation is now more flexible. It ensures that if 'recurrence_months' is present, it's a positive integer.
            # This avoids crashing if a transaction is no longer recurring but is still marked as such in the db.
            recurrence = t.get('recurrence_months')
            if recurrence is not None and (not isinstance(recurrence, int) or recurrence <= 0):
                raise ValueError(f"Invalid 'recurrence_months' for recurring transaction: '{description}'")
            
            start_date = t.get('start_date')
            parsed_start = None
            if start_date:
                try:
                    parsed_start = datetime.strptime(start_date, '%Y-%m-%d')
                except ValueError:
                    raise ValueError(f"Invalid 'start_date' format for recurring transaction: '{description}'. Use YYYY-MM-DD.")

            end_date = t.get('end_date')
            if end_date:
                try:
                    parsed_end = datetime.strptime(end_date, '%Y-%m-%d')
                except ValueError:
                    raise ValueError(f"Invalid 'end_date' format for recurring transaction: '{description}'. Use YYYY-MM-DD.")

                if parsed_start and parsed_end < parsed_start:
                    raise ValueError(
                        f"'end_date' must not be before 'start_date' for recurring transaction: '{description}'."
                    )

        return transactions

    def _get_normalized_budget(self, effective_date: datetime = None) -> Decimal:
        """
        Calculates a normalized monthly budget from recurring transactions,
        considering their start dates.

        Args:
            effective_date: The date to check against for active transactions.
                            If None, defaults to the current date.
        """
        if effective_date is None:
            effective_date = datetime.now()

        total_monthly_flow = Decimal('0')
        
        recurring_transactions = self._get_recurring_transactions()
        
        for t in recurring_transactions:
            # Check if the transaction is active based on its start/end dates
            start_date_str = t.get('start_date')
            if start_date_str:
                start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
                if start_date > effective_date:
                    continue  # Skip this transaction if it hasn't started yet

            end_date_str = t.get('end_date')
            if end_date_str:
                end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
                if effective_date > end_date:
                    continue  # Skip if it has already ended

            amount = Decimal(t['amount'])
            recurrence_months = t.get('recurrence_months', 1)
            
            if recurrence_months > 0:
                total_monthly_flow += amount / recurrence_months
        
        return total_monthly_flow



    def get_dashboard_summary(self) -> Dict[str, Any]:
        """
        Calculates and returns the main dashboard metrics for the most recent month with transactions.
        If no transactions exist, it defaults to the current month.
        """
        # Determine the most recent month with transactions
        available_months = self.get_available_months()
        today = datetime.now()

        if available_months:
            latest_year, latest_month = available_months[0]
            start_of_month = datetime(int(latest_year), int(latest_month), 1)
            # Use the actual today's date for the end date if it's the current month,
            # otherwise, use the end of that month.
            if int(latest_year) == today.year and int(latest_month) == today.month:
                end_of_period = today
            else:
                import calendar
                _, last_day = calendar.monthrange(int(latest_year), int(latest_month))
                end_of_period = datetime(int(latest_year), int(latest_month), last_day)
            
            latest_month_str = start_of_month.strftime('%B %Y')
        else:
            # Default to the current month if no transactions are available
            latest_year, latest_month = str(today.year), str(today.month).zfill(2)
            end_of_period = today
            start_of_month = today.replace(day=1)
            latest_month_str = today.strftime('%B %Y')
        
        normalized_monthly_flow = self._get_normalized_budget(effective_date=start_of_month)

        # Fetch transactions for the determined period
        transactions_for_period = self.db.get_transactions(year=latest_year, month=latest_month)
        decrypted_transactions = self._decrypt_transactions(transactions_for_period)
        
        # Get the descriptions of recurring transactions

        monthly_expenses = Decimal('0')
        recurring_transactions_map = {rt['description'].lower(): rt for rt in self._get_recurring_transactions()}
        for t in decrypted_transactions:
            if not t['is_recurring']:
                monthly_expenses += t['amount']
            else:
                # It's a recurring transaction, check for amount deviation
                if t['description'].lower() in recurring_transactions_map:
                    rec_trans_config = recurring_transactions_map[t['description'].lower()]
                    
                    # This check ensures that an outdated recurring transaction (which might still be marked
                    # as `is_recurring` in the DB) doesn't cause a crash if its config has been removed.
                    if rec_trans_config.get('recurrence_months') == 1:
                        defined_amount = Decimal(rec_trans_config['amount'])
                        actual_amount = t['amount']
                        difference = actual_amount - defined_amount
                        
                        if difference != 0:
                            monthly_expenses += difference
        
        available_to_spend = normalized_monthly_flow + monthly_expenses

        surplus = available_to_spend - normalized_monthly_flow
        return {
            "allowed_monthly_spend": normalized_monthly_flow,
            "monthly_expenses": monthly_expenses,
            "available_to_spend": available_to_spend,
            "currency": self.config['user']['currency_symbol'],
            "latest_month": latest_month_str,
            "surplus": surplus
        }

    def get_monthly_summary(self, year: str, month: str) -> Dict[str, Any]:
        """
        Calculates and returns the main dashboard metrics for a specific month.
        """
        # Fetch transactions for the specified month
        transactions_for_period = self.db.get_transactions(year=year, month=month)
        
        # Calculate budget based on the start of the selected month
        effective_date = datetime(int(year), int(month), 1)
        normalized_monthly_flow = self._get_normalized_budget(effective_date=effective_date)

        decrypted_transactions = self._decrypt_transactions(transactions_for_period)
        
        # Get the descriptions of recurring transactions
        
        monthly_expenses = Decimal('0')
        recurring_transactions_map = {rt['description'].lower(): rt for rt in self._get_recurring_transactions()}
        for t in decrypted_transactions:
            if not t['is_recurring']:
                monthly_expenses += t['amount']
            else:
                # It's a recurring transaction, check for amount deviation
                if t['description'].lower() in recurring_transactions_map:
                    rec_trans_config = recurring_transactions_map[t['description'].lower()]
                    if rec_trans_config and rec_trans_config.get('recurrence_months') == 1:
                        defined_amount = Decimal(rec_trans_config['amount'])
                        actual_amount = t['amount']
                        difference = actual_amount - defined_amount
                        
                        if difference != 0:
                            monthly_expenses += difference
        
        available_to_spend = normalized_monthly_flow + monthly_expenses
        
        # --- New: Calculate the simple sum of all transactions for the month ---
        total_transactions_sum = sum(t['amount'] for t in decrypted_transactions)

        surplus = available_to_spend - normalized_monthly_flow
        return {
            "allowed_monthly_spend": normalized_monthly_flow,
            "monthly_expenses": monthly_expenses,
            "available_to_spend": available_to_spend,
            "total_transactions_sum": total_transactions_sum,
            "currency": self.config['user']['currency_symbol'],
            "surplus": surplus
        }
    def _get_category_from_rules(self, description: str) -> str:
        """Assigns a category based on keywords in the description."""
        # Ensure 'category_rules' exists in the config, default to empty dict
        rules = self.config.get('category_rules', {})
        
        # Make the search case-insensitive
        lower_desc = description.lower()
        
        for category, keywords in rules.items():
            # Ensure keywords is a list to avoid errors with invalid config
            if isinstance(keywords, list):
                for keyword in keywords:
                    # More robust substring check, still case-insensitive
                    if keyword.lower() in lower_desc.lower():
                        return category
        
        # Default category if no rules match
        return "Uncategorized"

    def add_expense(self, date: str, description: str, amount: float, category: str) -> bool:
        """
        Adds a new expense to the database after checking for duplicates.
        Encrypts sensitive fields before storing.

        Returns:
            True if the transaction was added successfully, False otherwise.
        """
        import hashlib

        # Create a unique hash to prevent duplicates
        unique_string = f"{date}-{description}-{amount}"
        unique_hash = hashlib.sha256(unique_string.encode('utf-8')).hexdigest()

        # Check for duplicates before inserting
        existing = self.db.fetch_all("SELECT 1 FROM transactions WHERE unique_hash = ?", (unique_hash,))
        if existing:
            return False  # Duplicate found

        # Determine if recurring
        recurring_descriptions = {trans['description'].lower() for trans in self._get_recurring_transactions()}
        is_recurring = 1 if any(rec_desc in description.lower() for rec_desc in recurring_descriptions) else 0

        # Encrypt sensitive fields
        try:
            encrypted_desc = encrypt(description.encode('utf-8'), self._encryption_key)
            encrypted_amount = encrypt(str(amount).encode('utf-8'), self._encryption_key)
            encrypted_category = encrypt(category.encode('utf-8'), self._encryption_key)
        except Exception as e:
            # Handle potential encryption errors without crashing
            raise RuntimeError(f"Encryption failed: {e}")

        # Insert the new transaction
        try:
            self.db.execute_query(
                """
                INSERT INTO transactions (transaction_date, description, amount, category, unique_hash, is_recurring)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (date, encrypted_desc.hex(), encrypted_amount.hex(), encrypted_category.hex(), unique_hash, is_recurring)
            )
            return True
        except Exception as e:
            # Handle potential database errors
            raise RuntimeError(f"Database insertion failed: {e}")

    def get_recent_transactions(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Retrieves and decrypts the most recent transactions."""
        transactions = self.db.get_transactions(limit=limit)
        return self._decrypt_transactions(transactions)

    def get_top_spending_for_current_month(self, year: str = None, month: str = None, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Calculates and returns a top view of spending for a given month, or the current month if not specified.
        """
        if not year or not month:
            today = datetime.now()
            year = str(today.year)
            month = str(today.month).zfill(2)
        
        transactions = self.db.get_transactions(year=year, month=month)
        decrypted_transactions = self._decrypt_transactions(transactions)
        return self._calculate_top_spending(decrypted_transactions, limit)

    def get_top_spending_for_month(self, year: str, month: str, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Calculates and returns a top 10 view of spending for a specific month.
        """
        transactions = self.db.get_transactions(year=year, month=month)
        decrypted_transactions = self._decrypt_transactions(transactions)
        return self._calculate_top_spending(decrypted_transactions, limit)

    def _calculate_top_spending(self, transactions: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
        """
        Helper function to calculate top spending from a list of transactions.
        
        Args:
            transactions: A list of decrypted transaction dictionaries.
            limit: The number of items to return.

        Returns:
            A list of dictionaries, sorted by the absolute amount.
        """
        uncategorized = []
        categorized = {}

        for t in transactions:
            amount = t['amount']
            
            if t['category'] == "Uncategorized":
                uncategorized.append({
                    "name": t['description'],
                    "amount": amount,
                    "type": "Transaction",
                    "is_recurring": t.get('is_recurring', False)
                })
            else:
                category_name = t['category']
                if category_name not in categorized:
                    categorized[category_name] = Decimal('0')
                categorized[category_name] += t['amount']
        
        category_totals = [
            {"name": cat, "amount": total, "type": "Category"}
            for cat, total in categorized.items()
        ]

        combined_view = uncategorized + category_totals
        combined_view.sort(key=lambda x: abs(x['amount']), reverse=True)
        
        return combined_view[:limit]

    def get_transactions_for_month(self, year: str, month: str) -> List[Dict[str, Any]]:
        """Retrieves and decrypts all transactions for a given month."""
        transactions = self.db.get_transactions(year=year, month=month)
        return self._decrypt_transactions(transactions)

    def get_available_months(self) -> List[Tuple[str, str]]:
        """Returns a list of year-month pairs that have transactions."""
        return self.db.get_available_months()

    def delete_month_data(self, year: str, month: str) -> int:
        """Deletes all transaction data for a specific month."""
        return self.db.delete_transactions_for_month(year, month)

    def full_reset(self) -> None:
        """
        Performs a full reset of the application.
        Deletes all transactions and resets the encryption salt.
        """
        # This is the most critical step: the database file must be deleted.
        if os.path.exists(self.db_path):
            self.db.close() # Ensure the connection is closed before deleting
            os.remove(self.db_path)
            
        # Also delete the config file so it gets recreated from the template on next run
        # Also delete the config file so it gets recreated from the template on next run
        if os.path.exists("userdata/config.toml"):
            os.remove("userdata/config.toml")

    def _reset_state_and_reconnect(self) -> None:
        from datetime import datetime
        """Resets the in-memory state and re-initializes the DB."""
        self._encryption_key = None
        self.config = self._load_config()
        
        # Re-derive keys and reconnect to the DB
        self._connect_to_db()
        self._verify_password()

    def _decrypt_transactions(self, transactions: List[Any]) -> List[Dict[str, Any]]:
        """Helper to decrypt a list of transaction rows."""
        decrypted_list = []

        for t in transactions:
            try:
                # Decrypt all sensitive fields
                desc_bytes = bytes.fromhex(t['description'])
                amount_bytes = bytes.fromhex(t['amount'])
                category_bytes = bytes.fromhex(t['category'])

                decrypted_desc = decrypt(desc_bytes, self._encryption_key).decode('utf-8')
                decrypted_amount = Decimal(decrypt(amount_bytes, self._encryption_key).decode('utf-8'))
                decrypted_category = decrypt(category_bytes, self._encryption_key).decode('utf-8')

                decrypted_list.append({
                    "date": t['transaction_date'],
                    "description": decrypted_desc,
                    "amount": decrypted_amount,
                    "category": decrypted_category,
                    "is_recurring": bool(t['is_recurring'])
                })
            except Exception:
                # If decryption fails, show placeholders for all encrypted fields
                decrypted_list.append({
                    "date": t['transaction_date'],
                    "description": "[DECRYPTION FAILED]",
                    "amount": Decimal("0"),
                    "category": "[REDACTED]",
                    "is_recurring": False
                })
        return decrypted_list

    def reload_config_and_reapply_all(self) -> int:
        """
        Reloads the config file and re-applies all rules and categorizations.
        
        Returns:
            The number of transactions that were updated.
        """
        # Step 1: Reload the configuration
        self.config = self._load_config()
        
        # Step 2: Re-apply user-specific settings
        self.reapply_user_settings()
        
        # Step 3: Re-apply categorization rules
        return self.recategorize_transactions()

    def reapply_user_settings(self) -> None:
        """
        Re-applies user-specific settings from the config file.
        """
        user_config = self.config.get("user", {})
        self.db.set_meta("round_amounts", str(user_config.get("round_amounts", False)))

    def recategorize_transactions(self) -> int:
        """
        Re-applies categorization rules to all existing transactions.
        
        Returns:
            The number of transactions that were updated.
        """
        updated_count = 0
        all_transactions = self.db.get_transactions()  # Gets all transactions

        recurring_descriptions = {trans['description'].lower() for trans in self._get_recurring_transactions()}

        for t in all_transactions:
            try:
                decrypted_desc = decrypt(bytes.fromhex(t['description']), self._encryption_key).decode('utf-8')
                
                # --- 1. Check for Category Changes ---
                old_category_bytes = bytes.fromhex(t['category'])
                old_category = decrypt(old_category_bytes, self._encryption_key).decode('utf-8')
                new_category = self._get_category_from_rules(decrypted_desc)
                
                category_changed = new_category != old_category
                if category_changed:
                    encrypted_new_category = encrypt(new_category.encode('utf-8'), self._encryption_key)
                    self.db.execute_query(
                        "UPDATE transactions SET category = ? WHERE id = ?",
                        (encrypted_new_category.hex(), t['id'])
                    )

                # --- 2. Check for Recurring Status Changes ---
                # --- 2. Check for Recurring Status Changes ---
                old_is_recurring = t['is_recurring']
                
                # A transaction is recurring only if its description matches the list AND it has a valid recurrence config.
                # This prevents an old, recurring transaction from causing a crash if its config is removed.
                is_in_recurring_list = any(rec_desc in decrypted_desc.lower() for rec_desc in recurring_descriptions)
                new_is_recurring = 1 if is_in_recurring_list else 0
                
                recurring_changed = old_is_recurring != new_is_recurring
                if recurring_changed:
                    self.db.execute_query(
                        "UPDATE transactions SET is_recurring = ? WHERE id = ?",
                        (new_is_recurring, t['id'])
                    )

                # --- 3. Increment Counter if any change was made ---
                if category_changed or recurring_changed:
                    updated_count += 1
                    
            except Exception:
                # Skip transactions that fail to decrypt or process
                continue
                
        return updated_count