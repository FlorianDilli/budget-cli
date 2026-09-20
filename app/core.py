import os
import toml
import shutil
import calendar
import math
import random
from pathlib import Path
from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Dict, Any, List, Tuple, Optional

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
            project_root = Path(__file__).resolve().parent.parent
            user_data_base = os.getenv("BUDGET_DATA_PATH", str(project_root / "userdata"))
            self.config_path = os.path.join(user_data_base, "config.toml")
        else:
            self.config_path = config_path

        # finance.toml holds the data that grows over time (category rules,
        # recurring transactions, cash) and lives next to config.toml.
        config_dir = os.path.dirname(self.config_path)
        self.finance_path = os.path.join(config_dir, "finance.toml")

        self.db = DatabaseManager(self.db_path)
        self._encryption_key = None
        self.config = self._load_config()
        self._config_mtime = os.path.getmtime(self.config_path)
        self._finance_mtime = os.path.getmtime(self.finance_path)

        self._get_recurring_transactions() # Validate recurring transactions on init
        self._get_account_snapshots()       # Validate account balance snapshots on init
        self._get_cash_entries()            # Validate cash entries on init

        self._connect_to_db()
        self._verify_password()
        self._backfill_accounts()           # Attribute untagged transactions to accounts

    def check_and_reload_config_if_changed(self) -> Dict[str, Any]:
        """
        Checks if the config file has been modified since last load.
        If so, reloads the config and re-applies rules.
        
        Returns:
            A dict with 'count' (updated transactions) if reloaded, None otherwise.
        """
        try:
            current_config_mtime = os.path.getmtime(self.config_path)
            current_finance_mtime = os.path.getmtime(self.finance_path)
        except OSError:
            return None
        
        if current_config_mtime != self._config_mtime or current_finance_mtime != self._finance_mtime:
            self._config_mtime = current_config_mtime
            self._finance_mtime = current_finance_mtime
            updated_count = self.reload_config_and_reapply_all()
            return {"count": updated_count}
        return None

    def _load_config(self) -> Dict[str, Any]:
        """Loads the user's configuration.

        Stable, app-wide settings (user, theme, importer) come from
        config.toml, while the data that grows over time (category_rules,
        recurring_transactions, cash) comes from finance.toml. The two are
        merged into a single dict so the rest of the engine is unchanged.
        """
        self._ensure_config_files_exist()

        try:
            with open(self.config_path, "r") as f:
                config = toml.load(f)
            with open(self.finance_path, "r") as f:
                finance = toml.load(f)
        except Exception as e:
            raise RuntimeError(
                f"Failed to load configuration from '{self.config_path}' or '{self.finance_path}': {e}"
            ) from e

        # Merge the growing data file into the main settings config. The two
        # files are designed to be disjoint, so this won't clobber settings.
        config.update(finance)

        if "user" not in config:
            config["user"] = {"currency_symbol": "USD", "round_amounts": False}
        # Ensure theme settings exist, providing defaults if they don't
        if "theme" not in config:
            config["theme"] = {
                "text":       "#FBF6E2",
                "text_muted": "#9A9382",
                "border":     "#4F4A3E",
                "heading":    "#FFCF71",
                "income":     "bold #A1C398",
                "expense":    "bold #FA7070",
                "recurring":  "#E2B59A",
                "warning":    "#E89B3C",
                "danger":     "#FA7070",
                "info":       "#8FB8C9",
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

    def _ensure_config_files_exist(self) -> None:
        """Creates config.toml and finance.toml from their examples if missing."""
        if not os.path.exists(self.config_path):
            example_path = "config.example.toml"
            if not os.path.exists(example_path):
                # Fallback in case the example file is missing.
                with open(self.config_path, "w") as f:
                    toml.dump(self._default_config(), f)
            else:
                shutil.copy(example_path, self.config_path)

        if not os.path.exists(self.finance_path):
            finance_example = "finance.example.toml"
            if not os.path.exists(finance_example):
                with open(self.finance_path, "w") as f:
                    toml.dump(self._default_finance(), f)
            else:
                shutil.copy(finance_example, self.finance_path)

    def _default_config(self) -> Dict[str, Any]:
        """Minimal fallback settings config, used only if the example is missing."""
        return {
            "user": {"currency_symbol": "USD", "round_amounts": False},
            "theme": {
                "text":       "#FBF6E2",
                "text_muted": "#9A9382",
                "border":     "#4F4A3E",
                "heading":    "#FFCF71",
                "income":     "bold #A1C398",
                "expense":    "bold #FA7070",
                "recurring":  "#E2B59A",
                "warning":    "#E89B3C",
                "danger":     "#FA7070",
                "info":       "#8FB8C9",
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
        }

    def _default_finance(self) -> Dict[str, Any]:
        """Minimal fallback finance config, used only if the example is missing."""
        return {
            "category_rules": {},
            "recurring_transactions": [],
        }

    def _connect_to_db(self) -> None:
        """Derives the DB key and connects to the database."""
        self.db.connect(self.password)

        encryption_salt_hex = self.db.get_meta('encryption_salt')
        if encryption_salt_hex:
            encryption_salt = bytes.fromhex(encryption_salt_hex)
        else:
            encryption_salt = self._get_or_create_encryption_salt()

        self._encryption_key = derive_key(self.password, encryption_salt)
        self.password = None

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
    @staticmethod
    def _resolve_date(date_str: str) -> datetime:
        """
        Resolve a date string into a datetime object.

        Supports:
            - Exact dates: "YYYY-MM-DD" (e.g. "2025-12-31")
            - "YYYY-MM-end": Last day of that month/year
            - "YYYY-MM-start": First day of that month/year

        Args:
            date_str: The date expression to resolve.

        Returns:
            The resolved datetime.

        Raises:
            ValueError: If the date string is not a recognized format.
        """
        # Exact date: YYYY-MM-DD
        try:
            return datetime.strptime(date_str, '%Y-%m-%d')
        except (ValueError, TypeError):
            pass

        # Month-relative: YYYY-MM-end / YYYY-MM-start
        match = re.match(r'^(\d{4})-(\d{2})-(end|start)$', date_str)
        if match:
            year = int(match.group(1))
            month = int(match.group(2))
            suffix = match.group(3)
            if not (1 <= month <= 12):
                raise ValueError(f"Invalid month in '{date_str}'.")
            if suffix == 'end':
                _, last_day = calendar.monthrange(year, month)
                return datetime(year, month, last_day)
            return datetime(year, month, 1)

        raise ValueError(
            f"Invalid date '{date_str}'. Use YYYY-MM-DD or YYYY-MM-end."
        )

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
                    parsed_start = self._resolve_date(start_date)
                except ValueError:
                    raise ValueError(f"Invalid 'start_date' for recurring transaction: '{description}'.")

            end_date = t.get('end_date')
            parsed_end = None
            if end_date:
                try:
                    parsed_end = self._resolve_date(end_date)
                except ValueError:
                    raise ValueError(f"Invalid 'end_date' for recurring transaction: '{description}'.")

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
                start_date = self._resolve_date(start_date_str)
                if start_date > effective_date:
                    continue  # Skip this transaction if it hasn't started yet

            end_date_str = t.get('end_date')
            if end_date_str:
                end_date = self._resolve_date(end_date_str)
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
            start_date = self._resolve_date(start_date_str)
            if year < start_date.year or (year == start_date.year and month < start_date.month):
                return False
            
        end_date_str = rt.get('end_date')
        if end_date_str:
            end_date = self._resolve_date(end_date_str)
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

    # ╭───────────────────────────────────────────────────────────────────────╮
    # │ TOTAL MONEY / ACCOUNT BALANCE TRACKING                                 │
    # │                                                                       │
    # │ The user records, per bank account, the balance at one known moment    │
    # │ in time (`balance_snapshot` + `balance_snapshot_date`) in the toml file  │
    # │ next to the CSV format definition. From that snapshot, the balance at  │
    # │ any other moment is reconstructed by adding all transactions of that   │
    # │ account that occurred after the snapshot. Cash is tracked separately    │
    # │ as a list of (date, amount) entries.                                    │
    # ╰───────────────────────────────────────────────────────────────────────╯

    def _get_account_snapshots(self) -> List[Dict[str, Any]]:
        """
        Parses and validates the per-account balance snapshots from the config.

        Each `[[importer.formats]]` may define:
            balance_snapshot       = 1234.56   # Account balance at the snapshot date
            balance_snapshot_date  = "2025-01-01"  # YYYY-MM-DD

        Both fields are required together. The returned balance ignores any
        transactions that happened *on* the snapshot date (the snapshot is
        treated as the closing balance of that day), so only transactions dated
        strictly after it are added.

        Returns:
            A list of {name, balance_snapshot (Decimal), balance_snapshot_date (datetime)}.
        """
        formats = self.config.get('importer', {}).get('formats', [])
        snapshots = []
        for fmt in formats:
            name = fmt.get('name', 'Unknown')
            if 'balance_snapshot' not in fmt:
                continue

            balance = fmt.get('balance_snapshot')
            date_str = fmt.get('balance_snapshot_date')

            if balance is None or date_str is None:
                raise ValueError(
                    f"Account '{name}' defines an `balance_snapshot` but is missing "
                    f"`balance_snapshot_date` (or vice versa). Both are required."
                )

            try:
                snapshot_date = datetime.strptime(date_str, '%Y-%m-%d')
            except (ValueError, TypeError):
                raise ValueError(
                    f"Invalid `balance_snapshot_date` for account '{name}': '{date_str}'. "
                    f"Use YYYY-MM-DD."
                )

            if not isinstance(balance, (int, float)):
                raise ValueError(
                    f"Invalid `balance_snapshot` for account '{name}': must be a number."
                )

            snapshots.append({
                'name': name,
                'balance_snapshot': Decimal(str(balance)),
                'balance_snapshot_date': snapshot_date,
            })

        return snapshots

    def _get_cash_entries(self) -> List[Dict[str, Any]]:
        """
        Parses and validates the cash tracking entries from the config.

        The `[cash]` section may define:
            [[cash.entries]]
            date   = "2025-01-01"   # YYYY-MM-DD
            amount = 120.00         # Cash on hand at that date

        Returns:
            A list of {date (datetime), amount (Decimal)} sorted by date.
        """
        cash_cfg = self.config.get('cash')
        if not cash_cfg:
            return []

        entries = cash_cfg.get('entries', []) if isinstance(cash_cfg, dict) else []

        result = []
        for entry in entries:
            amount = entry.get('amount')
            date_str = entry.get('date')

            if amount is None or date_str is None:
                raise ValueError(
                    "Each cash entry must define both `date` (YYYY-MM-DD) and `amount`."
                )

            try:
                entry_date = datetime.strptime(date_str, '%Y-%m-%d')
            except (ValueError, TypeError):
                raise ValueError(
                    f"Invalid date in cash entry: '{date_str}'. Use YYYY-MM-DD."
                )

            if not isinstance(amount, (int, float)):
                raise ValueError(
                    f"Invalid amount in cash entry dated '{date_str}': must be a number."
                )

            result.append({'date': entry_date, 'amount': Decimal(str(amount))})

        result.sort(key=lambda e: e['date'])
        return result

    def _backfill_accounts(self) -> int:
        """
        Attributes existing untagged transactions to an account.

        Transactions imported before account tagging existed have `account = NULL`
        and are therefore invisible to balance reconstruction. When it is safe to
        do so, we assign them all to a single target account:

        - If the config defines exactly one importer format, that format is the
          target.
        - If multiple formats exist but only one has a `balance_snapshot`, that
          account is the target (the other accounts aren't part of the total
          money calculation anyway).

        When several accounts with snapshots exist, we cannot know which untagged
        transaction belongs to which, so we leave them untagged.

        Returns the number of transactions that were attributed.
        """
        formats = self.config.get('importer', {}).get('formats', [])
        if not formats:
            return 0

        target = None
        if len(formats) == 1:
            target = formats[0].get('name')
        else:
            snapshot_names = [f.get('name') for f in formats if 'balance_snapshot' in f]
            if len(snapshot_names) == 1:
                target = snapshot_names[0]

        if not target:
            return 0

        return self.db.backfill_account(target)

    def get_cash_at(self, as_of_date: datetime, entries: List[Dict[str, Any]] = None) -> Decimal:
        """
        Returns the cash on hand as of a given date.

        Uses the most recent cash entry whose date is on or before `as_of_date`.
        If no such entry exists, returns 0 (no cash has been recorded yet).

        Args:
            as_of_date: The date for which the cash amount is requested.
            entries: Optional pre-parsed cash entries (avoids re-parsing).

        Returns:
            The cash amount as a Decimal.
        """
        if entries is None:
            entries = self._get_cash_entries()

        best = None
        for entry in entries:
            if entry['date'] <= as_of_date:
                best = entry['amount']

        return best if best is not None else Decimal('0')

    def _sum_account_transactions(
        self, account: str, snapshot_date: datetime, as_of_date: datetime
    ) -> Decimal:
        """
        Net transaction flow for an account between the snapshot and `as_of_date`.

        The snapshot is the closing balance of `snapshot_date`, so transactions on
        that day are treated as already included in it (excluded from the flow).

        - If `as_of_date` is AFTER the snapshot: returns the sum of transactions
          strictly after the snapshot up to and including `as_of_date` (going
          forward in time).
        - If `as_of_date` is BEFORE the snapshot: returns the NEGATIVE sum of
          transactions strictly after `as_of_date` up to and including the snapshot
          (unwinding the balance backwards in time). This makes a "current" snapshot
          usable to reconstruct the balance of any past date.
        """
        one_day = self._one_day()

        if as_of_date >= snapshot_date:
            # Forward: sum of transactions in (snapshot_date, as_of_date]
            start_str = (snapshot_date + one_day).strftime('%Y-%m-%d')
            end_str = as_of_date.strftime('%Y-%m-%d')
            negate = False
        else:
            # Backward: sum of transactions in (as_of_date, snapshot_date], negated
            start_str = (as_of_date + one_day).strftime('%Y-%m-%d')
            end_str = snapshot_date.strftime('%Y-%m-%d')
            negate = True

        rows = self.db.get_account_transactions(account, start_str, end_str)
        decrypted = self._decrypt_transactions(rows)
        flow = sum(t['amount'] for t in decrypted)
        return -flow if negate else flow

    @staticmethod
    def _one_day():
        from datetime import timedelta
        return timedelta(days=1)

    def get_total_money_at(self, as_of_date: datetime) -> Dict[str, Any]:
        """
        Calculates the total amount of money the user has as of a given date.

        This is the sum of every configured bank account's balance (reconstructed
        from its snapshot plus subsequent transactions) plus the cash on hand.

        Args:
            as_of_date: The date for which the total should be calculated.

        Returns:
            A dict with:
                configured: bool  – whether any account or cash is configured
                accounts:   list  – [{name, balance}] per configured account
                cash:       Decimal
                total:      Decimal
        """
        snapshots = self._get_account_snapshots()
        cash_entries = self._get_cash_entries()
        configured = bool(snapshots) or bool(cash_entries)

        accounts = []
        total = Decimal('0')
        for snap in snapshots:
            balance = snap['balance_snapshot'] + self._sum_account_transactions(
                snap['name'], snap['balance_snapshot_date'], as_of_date
            )
            accounts.append({'name': snap['name'], 'balance': balance})
            total += balance

        cash = self.get_cash_at(as_of_date, cash_entries)
        total += cash

        return {
            'configured': configured,
            'accounts': accounts,
            'cash': cash,
            'total': total,
        }


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

        # Total money (accounts + cash) as of the end of the displayed period.
        total_money = self.get_total_money_at(end_of_period)

        return {
            "allowed_monthly_spend": normalized_monthly_flow,
            "monthly_expenses": monthly_expenses,
            "available_to_spend": available_to_spend,
            "total_transactions_sum": total_transactions_sum,
            "currency": self.config['user']['currency_symbol'],
            "latest_month": latest_month_str,
            "surplus": surplus,
            "alerts": alerts,
            "total_money": total_money,
        }

    def get_total_money_as_of_day(self) -> Optional[int]:
        """
        Reads the optional `user.total_money_as_of_day` config setting.

        This lets the user pick a fixed day-of-month at which "Total money I have"
        is measured in the Monthly Overview, so months are compared at the same
        point in the income/expense cycle.

        Returns:
            An int between 1 and 31, or None if unset/invalid (meaning: use the
            default behaviour of today for the current month and month-end for
            past months).
        """
        raw = self.config.get('user', {}).get('total_money_as_of_day')
        if raw is None:
            return None
        try:
            day = int(raw)
        except (ValueError, TypeError):
            return None
        if day < 1 or day > 31:
            return None
        return day

    def get_total_money_as_of_date(self, year: int, month: int) -> datetime:
        """
        Determines the date used to measure "Total money I have" for a given month
        in the Monthly Overview.

        Honours the optional `user.total_money_as_of_day` config. For the current
        month, the configured day is never in the future: if it hasn't occurred
        yet, today is used instead.
        """
        today = datetime.now()
        is_current_month = (year == today.year and month == today.month)
        _, last_day = calendar.monthrange(year, month)

        configured_day = self.get_total_money_as_of_day()
        if configured_day is None:
            # Default: today for the current month, last day of month otherwise.
            return today if is_current_month else datetime(year, month, last_day)

        day = min(configured_day, last_day)
        target = datetime(year, month, day)
        if is_current_month and target > today:
            return today
        return target

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

        # Total money (accounts + cash) as of the configured overview date for
        # this month (today for the current month if unset, else the configured
        # day-of-month, defaulting to month-end for past months).
        end_of_period = self.get_total_money_as_of_date(int(year), int(month))

        total_money = self.get_total_money_at(end_of_period)

        return {
            "allowed_monthly_spend": normalized_monthly_flow,
            "monthly_expenses": monthly_expenses,
            "available_to_spend": available_to_spend,
            "total_transactions_sum": total_transactions_sum,
            "currency": self.config['user']['currency_symbol'],
            "surplus": surplus,
            "alerts": alerts,
            "total_money": total_money,
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
                "total_spent": summary['monthly_expenses'],
                "available": summary['available_to_spend'],
                "total_money": summary['total_money'],
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

    def add_expense(self, date: str, description: str, amount: float, category: str, unique_hash: str = None, account: str = None) -> bool:
        """
        Adds a new expense to the database after checking for duplicates.
        Encrypts sensitive fields before storing.

        Args:
            account: An optional identifier (the importer format name) linking the
                     transaction to a specific bank account for balance tracking.

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
        existing = self.db.fetch_all(
            "SELECT id, account FROM transactions WHERE unique_hash = ?", (unique_hash,)
        )
        if existing:
            # Duplicate found. If this import knows which account the transaction
            # belongs to but the stored row is still untagged (e.g. it was imported
            # before account tagging existed), backfill that single column. This
            # lets a re-import attribute historical transactions to their bank so
            # the "Total money I have" reconstruction can use them.
            if account is not None and existing[0][1] is None:
                self.db.execute_query(
                    "UPDATE transactions SET account = ? WHERE unique_hash = ?",
                    (account, unique_hash),
                )
            return False  # Duplicate found (no new row inserted)

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
                INSERT INTO transactions (transaction_date, description, amount, category, unique_hash, is_recurring, account)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (date, encrypted_desc.hex(), encrypted_amount.hex(), encrypted_category.hex(), unique_hash, is_recurring, account)
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
                start_date = self._resolve_date(start_date_str)
                if transaction_date < start_date:
                    continue
            
            end_date_str = rt.get('end_date')
            if end_date_str:
                end_date = self._resolve_date(end_date_str)
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
        if os.path.exists(self.db_path):
            self.db.close()
            os.remove(self.db_path)
        salt_file = Path(self.db_path).with_suffix(".salt")
        if salt_file.exists():
            os.remove(salt_file)
        # Also delete the config files so they get recreated from the templates on next run
        if os.path.exists(self.config_path):
            os.remove(self.config_path)
        if os.path.exists(self.finance_path):
            os.remove(self.finance_path)

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

                # 8. Rekey the database file encryption
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
            # but the file rekey and our transaction should protect us.
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

        # Step 3: Attribute untagged transactions to accounts (balance tracking)
        self._backfill_accounts()

        # Step 4: Re-apply categorization rules
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

    def predict_runway(
        self,
        mc_runs: int = 2000,
        horizon_months: int = 24,
        annual_inflation: float = 0.03,
        alpha: float = 0.25,
        spend_floor: float = 10.0
    ) -> dict:
        """Runs a Monte Carlo simulation to predict when the user might run out of money."""
        today = datetime.now()
        total_money = self.get_total_money_at(today)
        current_balance = float(total_money['total'])

        if current_balance <= 0:
            return {
                "status": "No Money",
                "detail": "Current balance is zero or negative."
            }

        recurring_rules = []
        for rt in self._get_recurring_transactions():
            start_date_str = rt.get('start_date')
            end_date_str = rt.get('end_date')

            start_dt = self._resolve_date(start_date_str).date() if start_date_str else date(1970, 1, 1)
            end_dt = self._resolve_date(end_date_str).date() if end_date_str else date(2099, 12, 31)

            if not (start_dt <= today.date() <= end_dt):
                continue

            amount = float(self._get_effective_amount(rt, today))
            dir_val = 1 if amount >= 0 else -1
            amount_abs = abs(amount)

            recurrence = rt.get('recurrence_months', 1)
            if recurrence == 1:
                freq = 'monthly'
            elif recurrence == 3:
                freq = 'quarterly'
            elif recurrence == 12:
                freq = 'annual'
            else:
                freq = 'monthly'

            if start_date_str:
                start_dt_parsed = self._resolve_date(start_date_str)
                day = start_dt_parsed.day
            else:
                day = 1

            recurring_rules.append({
                'amount': amount_abs,
                'dir': dir_val,
                'day': day,
                'start': start_dt,
                'end': end_dt,
                'freq': freq
            })

        one_off_events = []

        historical_spend = []
        available_months = self.get_available_months()
        past_months = []
        for year, month in available_months:
            y, m = int(year), int(month)
            if datetime(y, m, 1) <= today:
                past_months.append((y, m))

        past_months.sort()
        past_months = past_months[-12:]

        for y, m in past_months:
            transactions = self.db.get_transactions(year=str(y), month=str(m).zfill(2))
            decrypted = self._decrypt_transactions(transactions)
            monthly_spend = sum(abs(float(t['amount'])) for t in decrypted if not t['is_recurring'] and t['amount'] < 0)
            historical_spend.append(monthly_spend)

        return self._simulate_runway(
            current_balance=current_balance,
            start_date=today.date(),
            recurring_rules=recurring_rules,
            one_off_events=one_off_events,
            historical_spend=historical_spend,
            horizon_months=horizon_months,
            mc_runs=mc_runs,
            annual_inflation=annual_inflation,
            alpha=alpha,
            spend_floor=spend_floor
        )

    def _simulate_runway(
        self,
        current_balance: float,
        start_date: date,
        recurring_rules: list,
        one_off_events: list,
        historical_spend: list,
        horizon_months: int = 24,
        mc_runs: int = 2000,
        annual_inflation: float = 0.03,
        alpha: float = 0.25,
        spend_floor: float = 10.0
    ) -> dict:
        horizon_months = max(2, horizon_months)
        K = len(historical_spend)

        for i in range(K):
            historical_spend[i] = max(spend_floor, historical_spend[i])

        mean_spend = sum(historical_spend) / K if K > 0 else spend_floor
        use_lognormal = K < 6

        if use_lognormal:
            if K >= 2:
                mean_val = mean_spend
                s2 = sum((x - mean_val) ** 2 for x in historical_spend) / (K - 1)
                sigma2 = math.log(1.0 + (s2 / (mean_val ** 2))) if mean_val > 0 else 0.04
            else:
                sigma2 = 0.04
            mu = math.log(max(mean_spend, spend_floor)) - 0.5 * sigma2
            sigma = math.sqrt(sigma2)

        y = start_date.year
        m_cur = start_date.month

        months_info = []
        for m in range(1, horizon_months + 1):
            num_days = calendar.monthrange(y, m_cur)[1]
            start_d = start_date.day if m == 1 else 1
            months_info.append({
                'm_idx': m, 'year': y, 'month': m_cur,
                'days': num_days, 'start_day': start_d
            })
            m_cur += 1
            if m_cur > 12:
                m_cur = 1
                y += 1

        net_det_cumulative = []
        net_det_full = []
        net_det_recur_full = []

        for info in months_info:
            m = info['m_idx']
            days = info['days']
            start_d = info['start_day']
            daily_total = [0.0] * (days + 1)
            daily_recur = [0.0] * (days + 1)

            for d in range(start_d, days + 1):
                cur_d = date(info['year'], info['month'], d)

                for r in recurring_rules:
                    if not (r['start'] <= cur_d <= r['end']):
                        continue
                    freq = r['freq']
                    fires = False
                    if freq == 'monthly':
                        fires = (d == min(r['day'], days))
                    elif freq == 'weekly':
                        fires = ((cur_d - r['start']).days % 7 == 0)
                    elif freq == 'biweekly':
                        fires = ((cur_d - r['start']).days % 14 == 0)
                    elif freq == 'quarterly':
                        month_diff = (cur_d.year - r['start'].year) * 12 + (cur_d.month - r['start'].month)
                        fires = (month_diff % 3 == 0) and (d == min(r['day'], days))
                    elif freq == 'annual':
                        fires = (cur_d.month == r['start'].month) and (d == min(r['day'], days))

                    if fires:
                        flow = r['dir'] * r['amount']
                        daily_total[d] += flow
                        daily_recur[d] += flow

                for e in one_off_events:
                    if e['date'] == cur_d:
                        daily_total[d] += e['dir'] * e['amount']

            cum = [0.0] * (days + 1)
            running = 0.0
            for d in range(start_d, days + 1):
                running += daily_total[d]
                cum[d] = running

            net_det_cumulative.append(cum)
            net_det_full.append(cum[days] if days >= start_d else 0.0)
            net_det_recur_full.append(sum(daily_recur))

        monthly_inflation = annual_inflation / 12.0
        tau = [float('inf')] * mc_runs

        for r_idx in range(mc_runs):
            balance = current_balance
            for m_idx, info in enumerate(months_info):
                m = m_idx + 1
                days = info['days']
                start_d = info['start_day']
                active_days = days - start_d + 1

                if use_lognormal:
                    u = random.lognormvariate(mu, sigma)
                else:
                    u = random.choice(historical_spend)
                u = max(spend_floor, u) * ((1.0 + monthly_inflation) ** (m - 1))

                u_eff = u * (active_days / days) if m == 1 else u

                cum_det = net_det_cumulative[m_idx]
                insolvent = False
                for d in range(start_d, days + 1):
                    day_balance = balance + cum_det[d] - ((d - start_d + 1) / active_days * u_eff)
                    if day_balance <= 0:
                        tau[r_idx] = m
                        insolvent = True
                        break

                if insolvent:
                    break

                balance = balance + net_det_full[m_idx] - u_eff

        insolvent_runs = [t for t in tau if t <= horizon_months]
        p_insolvency = len(insolvent_runs) / mc_runs

        mid_inflation = (1.0 + monthly_inflation) ** (horizon_months / 2.0)
        avg_recurring = sum(net_det_recur_full[1:]) / len(net_det_recur_full[1:]) if len(net_det_recur_full) > 1 else 0.0
        structural_drift = avg_recurring - (mean_spend * mid_inflation)

        if p_insolvency < alpha:
            if structural_drift >= 0:
                return {
                    "status": "Sustainable",
                    "structural_monthly_drift": round(structural_drift, 2),
                    "detail": f"Structurally positive cash flow. Low risk (< {int(alpha*100)}%) of depletion within {horizon_months} months."
                }
            else:
                return {
                    "status": "Slow Depletion (Runway > H Months)",
                    "structural_monthly_drift": round(structural_drift, 2),
                    "detail": f"Negative recurring drift, but reserves are projected to last beyond {horizon_months} months with ≥ {int((1-alpha)*100)}% confidence."
                }
        else:
            sorted_tau = sorted(tau)
            k = int(math.ceil(alpha * mc_runs)) - 1
            m_star = int(sorted_tau[k])

            p_depletion = sum(1 for t in tau if t <= m_star) / mc_runs

            depletion_info = months_info[m_star - 1]
            depletion_month_str = f"{depletion_info['year']}-{depletion_info['month']:02d}"

            if m_star > 1:
                safe_info = months_info[m_star - 2]
                last_safe_month_str = f"{safe_info['year']}-{safe_info['month']:02d}"
                safe_runway = m_star - 1
            else:
                last_safe_month_str = "None"
                safe_runway = 0

            return {
                "status": "Depletion Predicted",
                "depletion_month": depletion_month_str,
                "last_safe_month": last_safe_month_str,
                "safe_runway_months": safe_runway,
                "depletion_risk_pct": round(p_depletion * 100, 1),
                "detail": f"Account reaches zero in or before {depletion_month_str} with {round(p_depletion*100, 1)}% probability. Safe runway is {safe_runway} months."
            }