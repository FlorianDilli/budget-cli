import os
import csv
import shutil
import hashlib
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import List, Dict, Any

from app.core import BudgetEngine

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
    
    discovered_files = []
    for f in os.listdir(directory):
        if f.lower().endswith('.csv'):
            filepath = os.path.join(directory, f)
            # Security check: ensure the path is within the intended directory
            if os.path.abspath(filepath).startswith(os.path.abspath(directory)):
                discovered_files.append(filepath)
    return discovered_files

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
    
    # Security check: ensure the file is not excessively large
    if os.path.getsize(filepath) > 10_000_000:  # 10 MB limit
        raise RuntimeError(f"File '{filepath}' is too large to process.")

    try:
        with open(filepath, mode='r', encoding='utf-8-sig') as csvfile:  # Use utf-8-sig to handle BOM
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
        if date_column not in record or not record[date_column]:
            raise ValueError(f"Date column '{date_column}' not found or is empty in record.")
        raw_date = record[date_column]

        normalized_date = None
        # Extended list of common date formats
        for fmt in ('%Y-%m-%d', '%m/%d/%Y', '%d-%m-%Y', '%Y/%m/%d', '%d/%m/%Y', '%b %d, %Y'):
            try:
                normalized_date = datetime.strptime(raw_date, fmt).strftime('%Y-%m-%d')
                break
            except (ValueError, TypeError):
                continue
        
        if not normalized_date:
            raise ValueError(f"Date '{raw_date}' is not in a recognized format.")

        # --- Amount Normalization ---
        amount_column = engine.config['importer']['amount_column']
        if amount_column not in record or not record[amount_column]:
            raise ValueError(f"Amount column '{amount_column}' not found or is empty in record.")
        raw_amount = record[amount_column]

        # Basic security check: disallow common non-numeric characters except for decimal points and signs
        if any(c in raw_amount for c in ['$', ',', '€', '£', ' ']):
             raw_amount = raw_amount.replace('$', '').replace(',', '').replace('€', '').replace('£', '').replace(' ', '')

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

def delete_file(filepath: str, allowed_directory: str) -> None:
    """
    Deletes a file from the filesystem, with a security check.

    Args:
        filepath: The path to the file to be deleted.
        allowed_directory: The directory where deletions are permitted.
    """
    # Security check: Ensure we are only deleting files in the designated import folder
    if not os.path.abspath(filepath).startswith(os.path.abspath(allowed_directory)):
        raise RuntimeError(f"Security violation: Attempted to delete a file outside the import directory: {filepath}")

    try:
        os.remove(filepath)
    except OSError as e:
        raise RuntimeError(f"Error deleting file {filepath}: {e}")

def import_transactions(engine: BudgetEngine, csv_path: str, import_dir: str) -> int:
    """
    Full pipeline for importing transactions from a CSV file.

    Args:
        engine: An instance of the BudgetEngine.
        csv_path: The full path to the CSV file to import.
        import_dir: The directory where the csv file is located.

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
            normalized_record = normalize_transaction(record, engine)
            
            # The updated add_expense returns False for duplicates
            was_added = engine.add_expense(
                date=normalized_record['transaction_date'],
                description=normalized_record['description'],
                amount=normalized_record['amount'],
                category=normalized_record['category']
            )
            
            if was_added:
                new_transactions_count += 1
            else:
                # This is now the specific check for a duplicate
                skipped_transactions_count += 1

        except ValueError as e:
            # Catches normalization errors
            print(f"Skipping record due to normalization error: {record} -> {e}")
            skipped_transactions_count += 1
            continue
        except RuntimeError as e:
            # Catches database or encryption errors from the engine
            print(f"Skipping record due to a critical error: {record} -> {e}")
            skipped_transactions_count += 1
            continue

    # After successful import, show a summary
    print(f"\nImport Summary for '{os.path.basename(csv_path)}':")
    print(f"  - Successfully imported: {new_transactions_count} transactions")
    print(f"  - Skipped (duplicates): {skipped_transactions_count} transactions")

    # Finally, delete the imported CSV file
    try:
        # Pass the directory from the engine's config to ensure safe deletion
        delete_file(csv_path, import_dir)
        print(f"  - Deleted source file: '{os.path.basename(csv_path)}'")
    except RuntimeError as e:
        print(f"  - Warning: Could not delete source file: {e}")

    return new_transactions_count