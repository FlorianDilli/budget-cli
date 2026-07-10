import os
import hashlib
from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
import argon2.low_level
from argon2.exceptions import HashingError

# Constants for Argon2id
ARGON2_SALT_LEN = 16
# Parameters for Argon2id, OWASP recommendations as of October 2023
# Use at least 19 MiB memory, 2 iterations, and 1 degree of parallelism.
# For more sensitive files or less powerful systems, adjust accordingly.
# Note: These parameters significantly impact performance.
ARGON2_TIME_COST = 2
ARGON2_MEMORY_COST = 19 * 1024  # 19 MiB
ARGON2_PARALLELISM = 1
ARGON2_HASH_LEN = 32  # For AES-256
ARGON2_TYPE = "id"  # Argon2id is the recommended variant


# Constants for AES-GCM
AES_KEY_LEN = 32 # 256-bit
AES_NONCE_LEN = 12 # 96-bit is recommended for GCM
AES_TAG_LEN = 16 # 128-bit


def derive_key(password: str, salt: bytes) -> bytes:
    """
    Derives a key from a password and salt using Argon2.

    Args:
        password: The master password.
        salt: A cryptographically secure salt.

    Returns:
        The derived 32-byte key.
    """


    if not isinstance(password, str):
        raise TypeError("Password must be a string.")
    if not isinstance(salt, bytes) or len(salt) != ARGON2_SALT_LEN:
        raise ValueError(f"Salt must be a {ARGON2_SALT_LEN}-byte byte string.")


    try:
        # Use the low-level raw hash function for key derivation
        key = argon2.low_level.hash_secret_raw(
            secret=password.encode('utf-8'),
            salt=salt,
            time_cost=ARGON2_TIME_COST,
            memory_cost=ARGON2_MEMORY_COST,
            parallelism=ARGON2_PARALLELISM,
            hash_len=ARGON2_HASH_LEN,
            type=argon2.low_level.Type.ID
        )
        return key
    except HashingError as e:
        raise RuntimeError(f"Key derivation failed: {e}")
    except Exception as e:
        # Broader exception for other potential issues
        raise RuntimeError(f"An unexpected error occurred during key derivation: {e}")


def encrypt(plaintext: bytes, key: bytes) -> bytes:
    """
    Encrypts data using AES-GCM.

    Args:
        plaintext: The data to encrypt.
        key: The 32-byte encryption key.

    Returns:
        The encrypted data in the format: nonce || ciphertext || tag
    """
    if not isinstance(plaintext, bytes):
        raise TypeError("Plaintext must be bytes.")
    if not isinstance(key, bytes) or len(key) != AES_KEY_LEN:
        raise ValueError(f"Key must be a {AES_KEY_LEN}-byte byte string.")

    nonce = get_random_bytes(AES_NONCE_LEN)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext)

    return nonce + ciphertext + tag

def decrypt(ciphertext: bytes, key: bytes) -> bytes:
    """
    Decrypts data using AES-GCM.

    Args:
        ciphertext: The encrypted data in the format: nonce || ciphertext || tag
        key: The 32-byte encryption key.

    Returns:
        The decrypted plaintext.
    """
    if not isinstance(ciphertext, bytes):
        raise TypeError("Ciphertext must be bytes.")
    if len(ciphertext) < AES_NONCE_LEN + AES_TAG_LEN:
        raise ValueError("Invalid ciphertext length.")
    if not isinstance(key, bytes) or len(key) != AES_KEY_LEN:
        raise ValueError(f"Key must be a {AES_KEY_LEN}-byte byte string.")


    nonce = ciphertext[:AES_NONCE_LEN]
    tag = ciphertext[-AES_TAG_LEN:]
    encrypted_data = ciphertext[AES_NONCE_LEN:-AES_TAG_LEN]

    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)

    try:
        plaintext = cipher.decrypt_and_verify(encrypted_data, tag)
        return plaintext
    except (ValueError, KeyError) as e:
        raise RuntimeError(f"Decryption failed: {e}")

def generate_salt() -> bytes:
    """
    Generates a cryptographically secure salt.

    Returns:
        A new 16-byte salt.
    """
    return get_random_bytes(ARGON2_SALT_LEN)

def generate_transaction_hash(date: str, description: str, amount: float, occurrence: int) -> str:
    """
    Generates a unique SHA-256 hash for a transaction.
    """
    unique_string = f"{date}-{description}-{amount}-{occurrence}"
    return hashlib.sha256(unique_string.encode('utf-8')).hexdigest()
