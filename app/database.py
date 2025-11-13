import sqlite3
from typing import List, Tuple, Any

class DatabaseManager:
    """A wrapper for pysqlcipher3 to manage the encrypted database."""

    def __init__(self, db_path: str):
        """
        Initializes the DatabaseManager.

        Args:
            db_path: The path to the database file.
        """
        if not isinstance(db_path, str):
            raise TypeError("Database path must be a string.")
        self.db_path = db_path
        self.conn = None

    def connect(self, password: str) -> None:
        """
        Establishes a connection to the encrypted database and sets up the schema.

        Args:
            password: The key for the encrypted database.
        """
        if not isinstance(password, str) or not password:
            raise ValueError("A valid password must be provided.")

        try:
            # SQLCipher is not thread-safe, so we disable thread checks
            self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
            
            # Use PRAGMA key to set the encryption key
            self.conn.execute(f"PRAGMA key = '{password}'")
            
            # Verify the key and database integrity
            self.conn.execute("SELECT count(*) FROM sqlite_master;")
            
            self.setup_tables()
        except sqlite3.DatabaseError as e:
            self.close()
            raise RuntimeError(f"Failed to connect to the database. Incorrect password or corrupted file: {e}")
        except Exception as e:
            self.close()
            raise RuntimeError(f"An unexpected error occurred during database connection: {e}")

    def setup_tables(self) -> None:
        """Creates the necessary tables if they don't exist."""
        if not self.conn:
            raise RuntimeError("Database connection not established.")
            
        # Main transactions table
        create_transactions_table = """
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_date TEXT NOT NULL,
            description BLOB NOT NULL, -- Encrypted
            amount BLOB NOT NULL, -- Encrypted
            category BLOB, -- Encrypted
            unique_hash TEXT UNIQUE NOT NULL
        );
        """
        # Key-value store for metadata (e.g., salts)
        create_meta_table = """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
        self.execute_query(create_transactions_table)
        self.execute_query(create_meta_table)

    def execute_query(self, query: str, params: Tuple = ()) -> None:
        """
        Executes a given SQL query (e.g., INSERT, UPDATE, DELETE).

        Args:
            query: The SQL query string.
            params: A tuple of parameters to be used with the query.
        """
        if not self.conn:
            raise RuntimeError("Database connection not established.")
        
        try:
            cursor = self.conn.cursor()
            cursor.execute(query, params)
            self.conn.commit()
        except sqlite3.Error as e:
            self.conn.rollback()
            raise RuntimeError(f"Query execution failed: {e}")

    def fetch_all(self, query: str, params: Tuple = ()) -> List[Tuple[Any, ...]]:
        """
        Fetches all results from a SELECT query.

        Args:
            query: The SQL query string.
            params: A tuple of parameters to be used with the query.
        
        Returns:
            A list of rows, where each row is a tuple.
        """
        if not self.conn:
            raise RuntimeError("Database connection not established.")

        try:
            cursor = self.conn.cursor()
            cursor.execute(query, params)
            return cursor.fetchall()
        except sqlite3.Error as e:
            raise RuntimeError(f"Failed to fetch data: {e}")

    def set_meta(self, key: str, value: str) -> None:
        """Sets a key-value pair in the meta table."""
        query = "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
        self.execute_query(query, (key, value))

    def get_meta(self, key: str) -> str | None:
        """Gets a value from the meta table by key."""
        query = "SELECT value FROM meta WHERE key = ?"
        result = self.fetch_all(query, (key,))
        return result[0][0] if result else None

    def delete_meta(self, key: str) -> None:
        """Deletes a key-value pair from the meta table."""
        query = "DELETE FROM meta WHERE key = ?"
        self.execute_query(query, (key,))

    def get_transactions_for_period(self, start_date: str, end_date: str) -> List[Any]:
        """Fetches all transactions within a given date range."""
        query = "SELECT * FROM transactions WHERE transaction_date BETWEEN ? AND ?"
        
        original_factory = self.conn.row_factory
        self.conn.row_factory = sqlite3.Row
        
        try:
            cursor = self.conn.cursor()
            cursor.execute(query, (start_date, end_date))
            return cursor.fetchall()
        except sqlite3.Error as e:
            raise RuntimeError(f"Failed to fetch transactions for period: {e}")
        finally:
            if self.conn:
                self.conn.row_factory = original_factory

    def get_transactions(self, limit: int = None, year: str = None, month: str = None) -> List[Any]:
        """
        Fetches transactions with flexible filtering.
        - If limit is set, returns the most recent N transactions.
        - If year and month are set, returns all transactions for that month.
        """
        if not self.conn:
            raise RuntimeError("Database connection not established.")

        original_factory = self.conn.row_factory
        self.conn.row_factory = sqlite3.Row
        
        query = "SELECT * FROM transactions"
        params = []

        if year and month:
            query += " WHERE strftime('%Y', transaction_date) = ? AND strftime('%m', transaction_date) = ?"
            params.extend([year, month])
        
        query += " ORDER BY transaction_date DESC, id DESC"

        if limit:
            query += " LIMIT ?"
            params.append(limit)

        try:
            cursor = self.conn.cursor()
            cursor.execute(query, tuple(params))
            return cursor.fetchall()
        except sqlite3.Error as e:
            raise RuntimeError(f"Failed to fetch transactions: {e}")
        finally:
            if self.conn:
                self.conn.row_factory = original_factory
    
    def get_available_months(self) -> List[Tuple[str, str]]:
        """Returns a list of distinct year-month pairs from the transactions."""
        query = """
        SELECT DISTINCT strftime('%Y', transaction_date), strftime('%m', transaction_date)
        FROM transactions
        ORDER BY 1 DESC, 2 DESC
        """
        return self.fetch_all(query)

    def delete_transactions_for_month(self, year: str, month: str) -> int:
        """Deletes all transactions for a given year and month."""
        query = """
        DELETE FROM transactions 
        WHERE strftime('%Y', transaction_date) = ? AND strftime('%m', transaction_date) = ?
        """
        
        if not self.conn:
            raise RuntimeError("Database connection not established.")

        try:
            cursor = self.conn.cursor()
            cursor.execute(query, (year, month))
            self.conn.commit()
            return cursor.rowcount
        except sqlite3.Error as e:
            self.conn.rollback()
            raise RuntimeError(f"Failed to delete transactions: {e}")

    def delete_all_data(self) -> None:
        """Deletes all data by dropping the tables."""
        if not self.conn:
            raise RuntimeError("Database connection not established.")
        
        try:
            self.execute_query("DROP TABLE IF EXISTS transactions;")
            self.execute_query("DROP TABLE IF EXISTS meta;")
            self.conn.commit()
        except sqlite3.Error as e:
            self.conn.rollback()
            raise RuntimeError(f"Failed to delete all data: {e}")

    def close(self) -> None:
        """Closes the database connection."""
        if self.conn:
            self.conn.close()
            self.conn = None
