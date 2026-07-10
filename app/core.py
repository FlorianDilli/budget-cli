import os
import toml
import shutil
from datetime import datetime
from decimal import Decimal
from typing import Dict, Any, List, Tuple

from app.database import DatabaseManager
from app.crypto import derive_key, encrypt, decrypt, generate_salt, generate_transaction_hash

class BudgetEngine:
    """Manages the application's core logic, state, and business rules."""

    def __init__(self, db_path: str, password: str, config_path: str = None):
        """
        Initializes the core engine.

        Args:
            db_path: Path to the SQLite database file.
            password: The user's master password.
            config_path: Path to the configuration file.
        """
        self.db_path = db_path
        self.password = password
        
        # Default to userdata/config.toml if not provided, but respect environment variable if set in main.py
        if config_path is None:
            user_data_base = os.getenv("BUDGET_DATA_PATH", "userdata")
            self.config_path = os.path.join(user_data_base, "config.toml")
        else:
            self.config_path = config_path
        
        self.db = DatabaseManager(self.db_path)
        self._encryption_key = None
        self.config = self._load_config()
        self._config_mtime = os.path.getmtime(self.config_path)

        self._get_recurring_transactions() # Validate recurring transactions on init

        self._connect_to_db()
        self._verify_password()

    def check_and_reload_config_if_changed(self) -> Dict[str, Any]:
        """
        Checks if the config file has been modified since last load.
        If so, reloads the config and re-applies rules.
        
        Returns:
            A dict with 'count' (updated transactions) if reloaded, None otherwise.
        """
        try:
            current_mtime = os.path.getmtime(self.config_path)
        except OSError:
            return None
        
        if current_mtime != self._config_mtime:
            self._config_mtime = current_mtime
            updated_count = self.reload_config_and_reapply_all()
            return {"count": updated_count}
        return None

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
                        "formats": [
                            {
                                "name": "Default",
                                "date_column": "Date",
                                "description_column": "Description",
                                "amount_column": "Amount"
                            }
                        ]
                    },
                    "category_rules": {},
                    "recurring_transactions": []
                }
                with open(self.config_path, "w") as f:
                    toml.dump(default_config, f)
            else:
                shutil.copy(example_path, self.config_path)
        
        try:
            with open(self.config_path, "r") as f:
                config = toml.load(f)
        except Exception as e:
            # If we are in __init__, we might want to raise this to prevent partial initialization
            raise RuntimeError(f"Failed to load configuration from '{self.config_path}': {e}") from e

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

        # Backward compatibility and migration for importer config
        if "importer" in config:
            if "formats" not in config["importer"]:
                # Migrate old single-format config to new multi-format structure
                old_importer = config["importer"]
                if all(k in old_importer for k in ["date_column", "description_column", "amount_column"]):
                    config["importer"] = {
                        "formats": [
                            {
                                "name": "Migrated Format",
                                "date_column": old_importer["date_column"],
                                "description_column": old_importer["description_column"],
                                "amount_column": old_importer["amount_column"]
                            }
                        ]
                    }
                else:
                    # If it's broken, set a default
                    config["importer"] = {
                        "formats": [
                            {
                                "name": "Default",
                                "date_column": "Date",
                                "description_column": "Description",
                                "amount_column": "Amount"
                            }
                        ]
                    }
        else:
            config["importer"] = {
                "formats": [
                    {
                        "name": "Default",
                        "date_column": "Date",
                        "description_column": "Description",
                        "amount_column": "Amount"
                    }
                ]
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
            history = t.get('amount_history')
            has_history = isinstance(history, list) and len(history) > 0

            # `amount` is required unless `amount_history` is provided, in which
            # case the most recent history entry acts as the current/default price.
            if not has_history and not isinstance(t.get('amount'), (int, float)):
                raise ValueError(f"Invalid or missing 'amount' for recurring transaction: '{description}'")
            
            # This validation is now more strict. It ensures that 'recurrence_months' is a positive integer.
            recurrence = t.get('recurrence_months')
            if recurrence is None or not isinstance(recurrence, int) or recurrence <= 0:
                raise ValueError(f"Invalid 'recurrence_months' for recurring transaction: '{description}'. Must be a positive integer.")
            
            payment_month = t.get('payment_month')
            if payment_month is not None:
                if isinstance(payment_month, int):
                    if not (1 <= payment_month <= 12):
                        raise ValueError(f"Invalid 'payment_month' for recurring transaction: '{description}'. Must be between 1 and 12.")
                elif isinstance(payment_month, list):
                    if not all(isinstance(m, int) and 1 <= m <= 12 for m in payment_month):
                        raise ValueError(f"Invalid 'payment_month' list for recurring transaction: '{description}'. All values must be integers between 1 and 12.")
                else:
                    raise ValueError(f"Invalid type for 'payment_month' in recurring transaction: '{description}'. Must be an integer or a list of integers.")

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

            # Validate optional amount_history (effective-dated price changes)
            history = t.get('amount_history')
            if history is not None:
                if not isinstance(history, list):
                    raise ValueError(f"Invalid 'amount_history' for recurring transaction: '{description}'. Must be a list of {{from, amount}} tables.")
                for entry in history:
                    if not isinstance(entry, dict):
                        raise ValueError(f"Invalid entry in 'amount_history' for recurring transaction: '{description}'. Each entry must be a table with 'from' and 'amount'.")
                    if 'from' not in entry or 'amount' not in entry:
                        raise ValueError(f"Invalid entry in 'amount_history' for recurring transaction: '{description}'. Each entry must have 'from' (YYYY-MM-DD) and 'amount'.")
                    if not isinstance(entry['amount'], (int, float)):
                        raise ValueError(f"Invalid 'amount' in 'amount_history' for recurring transaction: '{description}'. Must be a number.")
                    try:
                        datetime.strptime(entry['from'], '%Y-%m-%d')
                    except (ValueError, TypeError):
                        raise ValueError(f"Invalid 'from' date in 'amount_history' for recurring transaction: '{description}'. Use YYYY-MM-DD.")

        return transactions

    def _get_effective_amount(self, rt: Dict[str, Any], effective_date: datetime) -> Decimal:
        """
        Resolves the amount of a recurring transaction as of a given date.

        A recurring transaction may define an optional `amount_history`: a list of
        `{ from = "YYYY-MM-DD", amount = X }` entries describing price changes over
        time. The amount in effect on `effective_date` is the entry with the latest
        `from` date that is not after `effective_date`. If no history entry applies
        (e.g. all entries are in the future), the base `amount` is used when present;
        otherwise the most recent history entry is treated as the current price.

        This allows a single recurring-transaction entry to track price changes
        without duplicating the entry with start/end dates. When `amount_history`
        is provided, the base `amount` is optional.

        Args:
            rt: The recurring transaction config dictionary.
            effective_date: The date for which the amount should be resolved.

        Returns:
            The effective amount as a Decimal.
        """
        history = rt.get('amount_history')
        if history:
            applicable_from = None
            applicable_amount = None
            latest_from = None
            latest_amount = None
            for entry in history:
                from_str = entry.get('from')
                if from_str is None:
                    continue
                try:
                    from_date = datetime.strptime(from_str, '%Y-%m-%d')
                except (ValueError, TypeError):
                    continue
                # Track the most recent history entry (used as the default price
                # when `amount` is omitted and no entry applies yet).
                if latest_from is None or from_date > latest_from:
                    latest_from = from_date
                    latest_amount = entry.get('amount')
                if from_date <= effective_date:
                    if applicable_from is None or from_date > applicable_from:
                        applicable_from = from_date
                        applicable_amount = entry.get('amount')

            if applicable_amount is not None:
                return Decimal(str(applicable_amount))

            # No history entry applies yet (e.g. all are in the future). Fall back
            # to the base `amount` if present, otherwise to the most recent entry.
            if 'amount' in rt:
                return Decimal(str(rt['amount']))
            if latest_amount is not None:
                return Decimal(str(latest_amount))

        # Fall back to the base amount (also the default for entries without history)
        return Decimal(str(rt['amount']))

    def _get_normalized_budget(self, effective_date: datetime = None, transactions: List[Dict[str, Any]] = None) -> Decimal:
        """
        Calculates a normalized monthly budget from recurring transactions,
        considering their start dates.

        Args:
            effective_date: The date to check against for active transactions.
                            If None, defaults to the current date.
            transactions: The (decrypted) transactions of the month being summarized.
                          When provided, the effective amount of a recurring
                          transaction is resolved as of the actual transaction's
                          date. This ensures a price change that takes effect
                          mid-month is reflected in that month's budget instead of
                          only from the following month.

        Returns:
            The normalized monthly budget as a Decimal.
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

            # Resolve the reference date for the effective amount. Prefer the
            # actual transaction's date so mid-month price changes are reflected.
            ref_date = effective_date
            if transactions:
                for tr in transactions:
                    if t['description'].lower() in tr['description'].lower():
                        ref_date = datetime.strptime(tr['date'], '%Y-%m-%d')
                        break

            amount = self._get_effective_amount(t, ref_date)
            recurrence_months = t.get('recurrence_months', 1)
            
            if recurrence_months > 0:
                total_monthly_flow += amount / recurrence_months
        
        return total_monthly_flow

    def _is_recurring_active_for_month(self, rt: Dict[str, Any], year: int, month: int) -> bool:
        """
        Check if a recurring transaction config is active for a given year/month.
        
        Args:
            rt: Recurring transaction config dictionary
            year: The year to check
            month: The month to check (1-12)
            
        Returns:
            True if the recurring transaction is active for this month
        """
        start_date_str = rt.get('start_date')
        if start_date_str:
            start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
            if year < start_date.year or (year == start_date.year and month < start_date.month):
                return False
            
        end_date_str = rt.get('end_date')
        if end_date_str:
            end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
            if year > end_date.year or (year == end_date.year and month > end_date.month):
                return False
        
        return True

    def _calculate_expenses_and_alerts(self, transactions: List[Dict[str, Any]], year: int, month: int) -> Tuple[Decimal, List[str], List[Dict[str, Any]]]:
        """
        Calculates monthly expenses, identifying alerts for recurring transaction anomalies.
        """
        monthly_expenses = Decimal('0')
        alerts = []
        recurring_transactions = self._get_recurring_transactions()
        
        # Track which recurring configs have been matched
        matched_recurring_indices = set()
        
        processed_transactions = []

        # Pre-calculate which recurring configs have a perfect match in this month
        # This is used for the "Smart Fallback" logic.
        configs_with_perfect_match = set()
        for t in transactions:
            desc_lower = t['description'].lower()
            for i, rt in enumerate(recurring_transactions):
                if rt['description'].lower() in desc_lower:
                    if not self._is_recurring_active_for_month(rt, year, month):
                        continue
                    rt_amount = self._get_effective_amount(rt, datetime.strptime(t['date'], '%Y-%m-%d'))
                    if t['amount'] == rt_amount:
                        configs_with_perfect_match.add(i)

        for t in transactions:
            t_processed = t.copy()
            
            if not t['is_recurring']:
                monthly_expenses += t['amount']
            else:
                desc_lower = t['description'].lower()
                
                # Find matching config
                matched_config = None
                matched_index = -1
                
                # Find all potential matches based on description
                potential_matches = []
                for i, rt in enumerate(recurring_transactions):
                    if rt['description'].lower() in desc_lower:
                        if not self._is_recurring_active_for_month(rt, year, month):
                            continue
                        potential_matches.append((i, rt))
                
                if potential_matches:
                    # Smart Matching: Find the best fit among potential matches
                    # Priority 1: Match both amount and month
                    for i, rt in potential_matches:
                        rt_amount = self._get_effective_amount(rt, datetime.strptime(t['date'], '%Y-%m-%d'))
                        rt_months = rt.get('payment_month')
                        if isinstance(rt_months, int):
                            rt_months = [rt_months]
                        
                        amount_matches = (t['amount'] == rt_amount)
                        month_matches = (not rt_months or int(month) in rt_months)
                        
                        if amount_matches and month_matches:
                            matched_config = rt
                            matched_index = i
                            break
                    
                    # Priority 2: Match just amount
                    if not matched_config:
                        for i, rt in potential_matches:
                            if t['amount'] == self._get_effective_amount(rt, datetime.strptime(t['date'], '%Y-%m-%d')):
                                matched_config = rt
                                matched_index = i
                                break
                    
                    # Priority 3: Fallback to the first description match
                    # BUT: Only if there isn't a perfect match for this config elsewhere in the month.
                    # This is the "Smart Fallback" logic.
                    if not matched_config:
                        for i, rt in potential_matches:
                            if i not in configs_with_perfect_match:
                                matched_index = i
                                matched_config = rt
                                break
                
                if matched_config:
                    matched_recurring_indices.add(matched_index)
                    recurrence = matched_config.get('recurrence_months', 1)
                    
                    if recurrence == 1:
                        defined_amount = self._get_effective_amount(matched_config, datetime.strptime(t['date'], '%Y-%m-%d'))
                        actual_amount = t['amount']
                        difference = actual_amount - defined_amount
                        if difference != 0:
                            monthly_expenses += difference
                            alerts.append(f"Amount mismatch for '{t['description']}': Expected {defined_amount:.2f}, got {actual_amount:.2f}")
                            if 'error_codes' not in t_processed:
                                t_processed['error_codes'] = []
                            t_processed['error_codes'].append("AMOUNT_MISMATCH")
                        else:
                            if 'error_codes' not in t_processed:
                                t_processed['error_codes'] = []
                            t_processed['error_codes'].append("VERIFIED")
                    else:
                        # Recurring > 1
                        payment_months = matched_config.get('payment_month')
                        # Normalize to list for easier checking
                        if isinstance(payment_months, int):
                            payment_months = [payment_months]
                            
                        if payment_months:
                            if int(month) in payment_months:
                                defined_amount = self._get_effective_amount(matched_config, datetime.strptime(t['date'], '%Y-%m-%d'))
                                actual_amount = t['amount']
                                if actual_amount != defined_amount:
                                    monthly_expenses += (actual_amount - defined_amount)
                                    alerts.append(f"Amount mismatch for '{t['description']}': Expected {defined_amount:.2f}, got {actual_amount:.2f}")
                                    if 'error_codes' not in t_processed:
                                        t_processed['error_codes'] = []
                                    t_processed['error_codes'].append("AMOUNT_MISMATCH")
                                else:
                                    if 'error_codes' not in t_processed:
                                        t_processed['error_codes'] = []
                                    t_processed['error_codes'].append("VERIFIED")
                            else:
                                # Wrong month - treat as full expense
                                monthly_expenses += t['amount']
                                expected_str = ", ".join(map(str, payment_months))
                                alerts.append(f"Recurring payment '{t['description']}' detected in wrong month (expected {expected_str})")
                                if 'error_codes' not in t_processed:
                                    t_processed['error_codes'] = []
                                t_processed['error_codes'].append("WRONG_MONTH")
                        else:
                             # No payment month defined, ignore (assume budgeted)
                             pass
                else:
                    # Fallback if no config matches (or if it was skipped by Smart Fallback)
                    monthly_expenses += t['amount']
                    t_processed['is_recurring'] = False # Treat as non-recurring in the UI too
                    if 'error_codes' not in t_processed:
                        t_processed['error_codes'] = []

            processed_transactions.append(t_processed)

        # Check for missing payments
        for i, rt in enumerate(recurring_transactions):
            if rt.get('recurrence_months', 1) > 1:
                payment_months = rt.get('payment_month')
                if isinstance(payment_months, int):
                    payment_months = [payment_months]
                    
                if payment_months and int(month) in payment_months:
                    if i not in matched_recurring_indices:
                        alerts.append(f"Expected recurring payment for '{rt['description']}' not found")

        return monthly_expenses, alerts, processed_transactions


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
        
        # Fetch transactions for the determined period
        transactions_for_period = self.db.get_transactions(year=latest_year, month=latest_month)
        decrypted_transactions = self._decrypt_transactions(transactions_for_period)

        # Calculate budget based on the start of the selected month, using the
        # actual transactions so mid-month price changes are reflected.
        normalized_monthly_flow = self._get_normalized_budget(effective_date=start_of_month, transactions=decrypted_transactions)
        
        # Calculate expenses and alerts
        monthly_expenses, alerts, _ = self._calculate_expenses_and_alerts(decrypted_transactions, int(latest_year), int(latest_month))
        
        available_to_spend = normalized_monthly_flow + monthly_expenses

        # Calculate the simple sum of all transactions for the month
        total_transactions_sum = sum(t['amount'] for t in decrypted_transactions)

        surplus = available_to_spend - normalized_monthly_flow
        return {
            "allowed_monthly_spend": normalized_monthly_flow,
            "monthly_expenses": monthly_expenses,
            "available_to_spend": available_to_spend,
            "total_transactions_sum": total_transactions_sum,
            "currency": self.config['user']['currency_symbol'],
            "latest_month": latest_month_str,
            "surplus": surplus,
            "alerts": alerts
        }

    def get_monthly_summary(self, year: str, month: str) -> Dict[str, Any]:
        """
        Calculates and returns the main dashboard metrics for a specific month.
        """
        # Fetch transactions for the specified month
        transactions_for_period = self.db.get_transactions(year=year, month=month)
        decrypted_transactions = self._decrypt_transactions(transactions_for_period)

        # Calculate budget based on the start of the selected month, using the
        # actual transactions so mid-month price changes are reflected.
        effective_date = datetime(int(year), int(month), 1)
        normalized_monthly_flow = self._get_normalized_budget(effective_date=effective_date, transactions=decrypted_transactions)
        # Calculate expenses and alerts
        monthly_expenses, alerts, _ = self._calculate_expenses_and_alerts(decrypted_transactions, int(year), int(month))
        
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
            "surplus": surplus,
            "alerts": alerts
        }

    def get_all_months_summary(self) -> List[Dict[str, Any]]:
        """
        Calculates and returns a summary for all months with transactions.
        """
        available_months = self.get_available_months()
        summaries = []
        
        for year, month in available_months:
            summary = self.get_monthly_summary(year, month)
            summaries.append({
                "year": year,
                "month": month,
                "budget": summary['allowed_monthly_spend'],
                "total_spent": summary['total_transactions_sum'],
                "available": summary['available_to_spend'],
                "currency": summary['currency']
            })
        
        return summaries

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

    def add_expense(self, date: str, description: str, amount: float, category: str, unique_hash: str = None) -> bool:
        """
        Adds a new expense to the database after checking for duplicates.
        Encrypts sensitive fields before storing.

        Returns:
            True if the transaction was added successfully, False otherwise.
        """
        if not unique_hash:
            # For manual entries: find how many identical transactions already exist on this date
            transactions_on_date = self.db.get_transactions_for_period(date, date)
            decrypted_transactions = self._decrypt_transactions(transactions_on_date)
            
            occurrence = 0
            for t in decrypted_transactions:
                if t['description'] == description and t['amount'] == Decimal(str(amount)):
                    occurrence += 1
                    
            unique_hash = generate_transaction_hash(date, description, amount, occurrence)

        # Check for duplicates before inserting
        existing = self.db.fetch_all("SELECT 1 FROM transactions WHERE unique_hash = ?", (unique_hash,))
        if existing:
            return False  # Duplicate found

        # Determine if recurring - check all recurring transactions, not just unique descriptions
        is_recurring = self._is_transaction_recurring(description, date)

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

    def _is_transaction_recurring(self, description: str, date_str: str) -> int:
        """
        Check if a transaction matches any recurring transaction config.
        
        Args:
            description: The transaction description
            date_str: The transaction date in YYYY-MM-DD format
            
        Returns:
            1 if the transaction is recurring, 0 otherwise
        """
        recurring_transactions = self._get_recurring_transactions()
        transaction_date = datetime.strptime(date_str, '%Y-%m-%d')
        
        for rt in recurring_transactions:
            if rt['description'].lower() not in description.lower():
                continue
            
            start_date_str = rt.get('start_date')
            if start_date_str:
                start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
                if transaction_date < start_date:
                    continue
            
            end_date_str = rt.get('end_date')
            if end_date_str:
                end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
                if transaction_date > end_date:
                    continue
            
            return 1
        return 0

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
        transactions = self.db.get_transactions(year=year, month=month, sort_order="ASC")
        decrypted = self._decrypt_transactions(transactions)
        _, _, processed_transactions = self._calculate_expenses_and_alerts(decrypted, int(year), int(month))
        return processed_transactions

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
        if os.path.exists(self.config_path):
            os.remove(self.config_path)

    def _reset_state_and_reconnect(self) -> None:
        from datetime import datetime
        """Resets the in-memory state and re-initializes the DB."""
        self._encryption_key = None
        self.config = self._load_config()
        
        # Re-derive keys and reconnect to the DB
        self._connect_to_db()
        self._verify_password()

    def change_password(self, current_password, new_password):
        """
        Changes the master password and re-encrypts all sensitive data.
        """
        # 1. Create a backup of the database file
        backup_path = f"{self.db_path}.bak"
        shutil.copy2(self.db_path, backup_path)

        try:
            # 2. Verify current password (already done by caller, but good to be safe)
            # We use the current encryption key to verify
            verifier = self.db.get_meta('password_verifier')
            if verifier:
                decrypted_verifier = decrypt(bytes.fromhex(verifier), self._encryption_key)
                if decrypted_verifier != b'master_password_check':
                    raise ValueError("Current password verification failed.")

            # 3. Generate new encryption salt and derive new field key
            new_salt = generate_salt()
            new_field_key = derive_key(new_password, new_salt)

            # 4. Fetch all transactions
            all_transactions = self.db.get_transactions()

            # 5. Start a transaction for database updates
            # We'll use a manual transaction since we're doing multiple updates
            self.db.conn.execute("BEGIN TRANSACTION")

            try:
                # 6. Re-encrypt transactions
                for t in all_transactions:
                    # Decrypt with old key
                    desc_bytes = bytes.fromhex(t['description'])
                    amount_bytes = bytes.fromhex(t['amount'])
                    category_bytes = bytes.fromhex(t['category'])

                    decrypted_desc = decrypt(desc_bytes, self._encryption_key).decode('utf-8')
                    decrypted_amount = decrypt(amount_bytes, self._encryption_key).decode('utf-8')
                    decrypted_category = decrypt(category_bytes, self._encryption_key).decode('utf-8')

                    # Encrypt with new key
                    new_encrypted_desc = encrypt(decrypted_desc.encode('utf-8'), new_field_key)
                    new_encrypted_amount = encrypt(decrypted_amount.encode('utf-8'), new_field_key)
                    new_encrypted_category = encrypt(decrypted_category.encode('utf-8'), new_field_key)

                    # Update in DB
                    self.db.conn.execute(
                        "UPDATE transactions SET description = ?, amount = ?, category = ? WHERE id = ?",
                        (new_encrypted_desc.hex(), new_encrypted_amount.hex(), new_encrypted_category.hex(), t['id'])
                    )

                # 7. Update encryption_salt and password_verifier in meta table
                new_verifier = encrypt(b'master_password_check', new_field_key)
                
                # We use execute_query which handles commit, but we are inside a transaction.
                # Actually, DatabaseManager.execute_query calls commit(). 
                # We should use self.db.conn.execute directly to stay in the transaction.
                self.db.conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ('encryption_salt', new_salt.hex()))
                self.db.conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ('password_verifier', new_verifier.hex()))

                # 8. Rekey the database itself (SQLCipher)
                self.db.rekey(new_password)

                # Commit all changes
                self.db.conn.commit()

                # 9. Update instance state
                self._encryption_key = new_field_key
                # self.password is already None from __init__, but if it was stored, we'd update it.
                # The instructions say "Update self.encryption_key and self.password in the BudgetApp instance."
                # In this codebase it's BudgetEngine and it has self._encryption_key.
                
                # Remove backup on success
                if os.path.exists(backup_path):
                    os.remove(backup_path)

            except Exception as e:
                self.db.conn.rollback()
                raise e

        except Exception as e:
            # If anything failed, we might need to restore from backup if the DB is corrupted
            # but SQLCipher rekey and our transaction should protect us.
            # Still, let's inform the user.
            raise RuntimeError(f"Failed to change password: {e}")

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

        for t in all_transactions:
            try:
                decrypted_desc = decrypt(bytes.fromhex(t['description']), self._encryption_key).decode('utf-8')
                transaction_date = t['transaction_date']
                
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
                old_is_recurring = t['is_recurring']
                
                new_is_recurring = self._is_transaction_recurring(decrypted_desc, transaction_date)
                
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