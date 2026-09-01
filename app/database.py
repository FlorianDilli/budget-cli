import os
import sqlite3
import tempfile
import secrets
from pathlib import Path
from typing import List, Tuple, Any, Optional

from app.crypto import derive_key, generate_salt


class DatabaseManager:
    """A wrapper for an AES-GCM encrypted SQLite database."""

    def __init__(self, db_path: str):
        if not isinstance(db_path, str):
            raise TypeError("Database path must be a string.")
        self.db_path = Path(db_path)
        self._conn = None
        self._tmpdir = None
        self._tmp_db = None
        self._encryption_key = None
        self._salt = None

    def connect(self, password: str) -> None:
        if self._conn:
            self.close()

        if not isinstance(password, str) or not password:
            raise ValueError("A valid password must be provided.")

        salt_file = self.db_path.with_suffix(".salt")
        if salt_file.exists():
            salt = salt_file.read_bytes()
        else:
            salt = generate_salt()
            salt_file.write_bytes(salt)
            os.chmod(salt_file, 0o600)

        self._salt = salt
        self._encryption_key = derive_key(password, salt)

        self._tmpdir = tempfile.TemporaryDirectory(prefix="budget-")
        self._tmp_db = Path(self._tmpdir.name) / "budget.db"

        if self.db_path.exists():
            blob = self.db_path.read_bytes()
            nonce, ct, tag = blob[:12], blob[12:-16], blob[-16:]
            from Crypto.Cipher import AES
            cipher = AES.new(self._encryption_key, AES.MODE_GCM, nonce=nonce)
            try:
                plaintext = cipher.decrypt_and_verify(ct, tag)
            except Exception:
                self.close()
                raise RuntimeError("Failed to connect. Incorrect password or corrupted database file.")
            self._tmp_db.write_bytes(plaintext)
            os.chmod(self._tmp_db, 0o600)
        else:
            sqlite3.connect(self._tmp_db).close()
            os.chmod(self._tmp_db, 0o600)

        self._conn = sqlite3.connect(self._tmp_db, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self.setup_tables()

    def _encrypt_to_disk(self):
        if not self._tmp_db or not self._tmp_db.exists():
            return
        plaintext = self._tmp_db.read_bytes()
        nonce = secrets.token_bytes(12)
        from Crypto.Cipher import AES
        cipher = AES.new(self._encryption_key, AES.MODE_GCM, nonce=nonce)
        ct, tag = cipher.encrypt_and_digest(plaintext)
        tmp = self.db_path.with_suffix(".db.tmp")
        tmp.write_bytes(nonce + ct + tag)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.db_path)

    def is_connected(self) -> bool:
        return self._conn is not None

    def setup_tables(self) -> None:
        if not self._conn:
            raise RuntimeError("Database connection not established.")

        create_transactions_table = """
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_date TEXT NOT NULL,
            description BLOB NOT NULL,
            amount BLOB NOT NULL,
            category BLOB,
            is_recurring INTEGER DEFAULT 0,
            unique_hash TEXT UNIQUE NOT NULL
        );
        """
        create_meta_table = """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
        self._conn.execute(create_transactions_table)
        self._conn.execute(create_meta_table)
        self._conn.commit()

        try:
            cursor = self._conn.cursor()
            cursor.execute("PRAGMA table_info(transactions);")
            columns = [info[1] for info in cursor.fetchall()]

            if 'is_recurring' not in columns:
                self._conn.execute("ALTER TABLE transactions ADD COLUMN is_recurring INTEGER DEFAULT 0;")

            if 'start_date' not in columns:
                self._conn.execute("ALTER TABLE transactions ADD COLUMN start_date TEXT;")

            if 'end_date' not in columns:
                self._conn.execute("ALTER TABLE transactions ADD COLUMN end_date TEXT;")

            if 'account' not in columns:
                self._conn.execute("ALTER TABLE transactions ADD COLUMN account TEXT;")

            self._conn.commit()
        except sqlite3.Error:
            pass

    def execute_query(self, query: str, params: Tuple = ()) -> None:
        if not self._conn:
            raise RuntimeError("Database connection not established.")

        try:
            cursor = self._conn.cursor()
            cursor.execute(query, params)
            self._conn.commit()
            self._encrypt_to_disk()
        except sqlite3.Error as e:
            self._conn.rollback()
            raise RuntimeError(f"Query execution failed: {e}")

    def fetch_all(self, query: str, params: Tuple = ()) -> List[Tuple[Any, ...]]:
        if not self._conn:
            raise RuntimeError("Database connection not established.")

        try:
            cursor = self._conn.cursor()
            cursor.execute(query, params)
            return cursor.fetchall()
        except sqlite3.Error as e:
            raise RuntimeError(f"Failed to fetch data: {e}")

    def set_meta(self, key: str, value: str) -> None:
        query = "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
        self.execute_query(query, (key, value))

    def get_meta(self, key: str) -> Optional[str]:
        query = "SELECT value FROM meta WHERE key = ?"
        result = self.fetch_all(query, (key,))
        return result[0][0] if result else None

    def delete_meta(self, key: str) -> None:
        query = "DELETE FROM meta WHERE key = ?"
        self.execute_query(query, (key,))

    def get_transactions_for_period(self, start_date: str, end_date: str) -> List[Any]:
        query = "SELECT * FROM transactions WHERE transaction_date BETWEEN ? AND ?"

        original_factory = self._conn.row_factory
        self._conn.row_factory = sqlite3.Row

        try:
            cursor = self._conn.cursor()
            cursor.execute(query, (start_date, end_date))
            return cursor.fetchall()
        except sqlite3.Error as e:
            raise RuntimeError(f"Failed to fetch transactions for period: {e}")
        finally:
            if self._conn:
                self._conn.row_factory = original_factory

    def get_transactions(self, limit: int = None, year: str = None, month: str = None, sort_order: str = "DESC") -> List[Any]:
        if not self._conn:
            raise RuntimeError("Database connection not established.")

        original_factory = self._conn.row_factory
        self._conn.row_factory = sqlite3.Row

        query = "SELECT * FROM transactions"
        params = []

        if year and month:
            query += " WHERE strftime('%Y', transaction_date) = ? AND strftime('%m', transaction_date) = ?"
            params.extend([year, month])

        query += f" ORDER BY transaction_date {sort_order}, id {sort_order}"

        if limit:
            query += " LIMIT ?"
            params.append(limit)

        try:
            cursor = self._conn.cursor()
            cursor.execute(query, tuple(params))
            return cursor.fetchall()
        except sqlite3.Error as e:
            raise RuntimeError(f"Failed to fetch transactions: {e}")
        finally:
            if self._conn:
                self._conn.row_factory = original_factory

    def get_account_transactions(self, account: str, start_date: str, end_date: str) -> List[Any]:
        query = """
        SELECT * FROM transactions
        WHERE account = ? AND transaction_date >= ? AND transaction_date <= ?
        ORDER BY transaction_date ASC, id ASC
        """

        original_factory = self._conn.row_factory
        self._conn.row_factory = sqlite3.Row

        try:
            cursor = self._conn.cursor()
            cursor.execute(query, (account, start_date, end_date))
            return cursor.fetchall()
        except sqlite3.Error as e:
            raise RuntimeError(f"Failed to fetch account transactions: {e}")
        finally:
            if self._conn:
                self._conn.row_factory = original_factory

    def get_available_months(self) -> List[Tuple[str, str]]:
        query = """
        SELECT DISTINCT strftime('%Y', transaction_date), strftime('%m', transaction_date)
        FROM transactions
        ORDER BY 1 DESC, 2 DESC
        """
        return self.fetch_all(query)

    def backfill_account(self, account: str) -> int:
        if not self._conn:
            raise RuntimeError("Database connection not established.")

        try:
            cursor = self._conn.cursor()
            cursor.execute(
                "UPDATE transactions SET account = ? WHERE account IS NULL",
                (account,)
            )
            self._conn.commit()
            self._encrypt_to_disk()
            return cursor.rowcount
        except sqlite3.Error as e:
            self._conn.rollback()
            raise RuntimeError(f"Failed to backfill account: {e}")

    def delete_transactions_for_month(self, year: str, month: str) -> int:
        query = """
        DELETE FROM transactions
        WHERE strftime('%Y', transaction_date) = ? AND strftime('%m', transaction_date) = ?
        """

        if not self._conn:
            raise RuntimeError("Database connection not established.")

        try:
            cursor = self._conn.cursor()
            cursor.execute(query, (year, month))
            self._conn.commit()
            self._encrypt_to_disk()
            return cursor.rowcount
        except sqlite3.Error as e:
            self._conn.rollback()
            raise RuntimeError(f"Failed to delete transactions: {e}")

    def delete_all_data(self) -> None:
        if not self._conn:
            raise RuntimeError("Database connection not established.")
        try:
            self._conn.execute("DROP TABLE IF EXISTS transactions;")
            self._conn.execute("DROP TABLE IF EXISTS meta;")
            self._conn.commit()
            self._encrypt_to_disk()
        except sqlite3.Error as e:
            self._conn.rollback()
            raise RuntimeError(f"Failed to delete all data: {e}")

    def close(self) -> None:
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None
        if self._tmpdir:
            try:
                self._tmpdir.cleanup()
            except Exception:
                pass
            self._tmpdir = None
            self._tmp_db = None

    def rekey(self, new_password: str) -> None:
        if not self._conn:
            raise RuntimeError("Database connection not established.")
        if not isinstance(new_password, str) or not new_password:
            raise ValueError("A valid new password must be provided.")

        self._encryption_key = derive_key(new_password, self._salt)
        self._encrypt_to_disk()
