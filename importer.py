import os
import csv
import shutil
import hashlib
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import List, Dict, Any

from core import BudgetEngine

def discover_csv_files(directory: str) -> List[str]:
    """
    Finds all CSV files in a given directory.

    Args:
        directory: The path to the directory to scan.

    Returns:
        A list of full paths to any discovered CSV files.
    """
    if not os.path.isdir(directory):
        raise ValueError(f"'{directory}' is not a valid directory.")
    
    return [os.path.join(directory, f) for f in os.listdir(directory) if f.lower().endswith('.csv')]

def parse_csv(filepath: str) -> List[Dict[str, Any]]:
    """
    Parses a CSV file and returns a list of transaction records.
    Assumes a header row and specific column names: 'Date', 'Description', 'Amount'.

    Args:
        filepath: The full path to the CSV file.

    Returns:
        A list of dictionaries, where each dictionary represents a transaction.
    """
    transactions = []
    try:
        with open(filepath, mode='r', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            for row in reader:
                transactions.append(row)
    except FileNotFoundError:
        raise RuntimeError(f"Could not find the file at '{filepath}'.")
    except Exception as e:
        raise RuntimeError(f"Failed to parse CSV file '{filepath}': {e}")
    
    return transactions

def normalize_transaction(record: Dict[str, Any], engine: BudgetEngine) -> Dict[str, Any]:
    """
    Normalizes a single transaction record.
    - Converts date strings to 'YYYY-MM-DD'.
    - Converts amount to a Decimal object and then to integer cents.
    - Generates a unique hash for duplicate detection.
    - Applies categorization rules from the engine.
    """
    try:
        # --- Date Normalization ---
        date_column = engine.config['importer']['date_column']
        if date_column not in record:
            raise ValueError(f"Date column '{date_column}' not found in record.")
        raw_date = record[date_column]

        normalized_date = None
        for fmt in ('%Y-%m-%d', '%m/%d/%Y', '%d-%m-%Y'):
            try:
                normalized_date = datetime.strptime(raw_date, fmt).strftime('%Y-%m-%d')
                break
            except (ValueError, TypeError):
                continue
        
        if not normalized_date:
            raise ValueError(f"Date '{raw_date}' is not in a recognized format.")

        # --- Amount Normalization ---
        amount_column = engine.config['importer']['amount_column']
        if amount_column not in record:
            raise ValueError(f"Amount column '{amount_column}' not found in record.")
        raw_amount = record[amount_column]

        amount_decimal = Decimal(raw_amount.strip())
        amount = float(amount_decimal)

        # --- Description Normalization ---
        description_column = engine.config['importer']['description_column']
        if description_column not in record:
            raise ValueError(f"Description column '{description_column}' not found in record.")
        description = record[description_column].strip()

        # --- Apply Categorization Rules ---
        # The engine's logic is now the source of truth for categories
        category = engine._get_category_from_rules(description)

        # Create a unique hash for the transaction
        unique_string = f"{normalized_date}-{description}-{amount}"
        unique_hash = hashlib.sha256(unique_string.encode('utf-8')).hexdigest()

        return {
            "transaction_date": normalized_date,
            "description": description,
            "amount": amount,
            "category": category,
            "unique_hash": unique_hash
        }

    except (InvalidOperation, ValueError) as e:
        raise ValueError(f"Could not normalize record {record}: {e}")

def delete_file(filepath: str) -> None:
    """
    Deletes a file from the filesystem.

    Args:
        filepath: The path to the file to be deleted.
    """
    try:
        os.remove(filepath)
    except OSError as e:
        raise RuntimeError(f"Error deleting file {filepath}: {e}")

def import_transactions(engine: BudgetEngine, csv_path: str) -> int:
    """
    Full pipeline for importing transactions from a CSV file.

    Args:
        engine: An instance of the BudgetEngine.
        csv_path: The full path to the CSV file to import.

    Returns:
        The number of new transactions successfully imported.
    """
    try:
        raw_records = parse_csv(csv_path)
    except RuntimeError as e:
        print(f"Error: {e}")
        return 0

    new_transactions_count = 0
    skipped_transactions_count = 0  # To count duplicates
    for record in raw_records:
        try:
            # Pass the engine to the normalization function for categorization
            normalized_record = normalize_transaction(record, engine)
            
            # The engine's add_expense handles duplicates and other validation
            engine.add_expense(
                date=normalized_record['transaction_date'],
                description=normalized_record['description'],
                amount=normalized_record['amount'],
                category=normalized_record['category']
            )
            new_transactions_count += 1
        
        except ValueError:
            # Catches normalization errors or duplicate errors from add_expense
            skipped_transactions_count += 1
            continue
        except RuntimeError as e:
            print(f"Database error while importing {record}: {e}")
            skipped_transactions_count += 1
            continue

    # After successful import, show a summary
    print(f"\nImport Summary for '{os.path.basename(csv_path)}':")
    print(f"  - Successfully imported: {new_transactions_count} transactions")
    print(f"  - Skipped (duplicates): {skipped_transactions_count} transactions")

    # Finally, delete the imported CSV file
    try:
        delete_file(csv_path)
        print(f"  - Deleted source file: '{os.path.basename(csv_path)}'")
    except RuntimeError as e:
        print(f"  - Warning: Could not delete source file: {e}")

    return new_transactions_count